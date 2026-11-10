import { api } from '../api.ts';
import { fill, fmtMin, h, section } from '../dom.ts';
import { STEP_LABEL, jobFor, live, startJob } from '../main.ts';
import { state, type Job } from '../state.ts';
import { CLIPS_PER_SECOND } from '../../src/catalog.ts';

const opts = { fresh: false, pages: 4, workers: 0, steps: 10000, hidden: '64,32', negWeight: 30 };
const run = { generate: true, features: true, train: true };

/** Live progress of a job: one row per step, and the log. */
export function jobPanel(job: Job) {
  const root = h('div', { class: 'job', 'data-live': '' });
  const stepsEl = h('div', { class: 'job-steps' });
  const logEl = h('pre', { class: 'log' });
  const actions = h('div', { class: 'row' });

  const drawSteps = (j: Job) => {
    stepsEl.replaceChildren(
      ...j.steps.map((s) => {
        const p = s.progress;
        const frac = s.status === 'done' ? 1 : p && p.total ? p.done / p.total : 0;
        const indeterminate = s.status === 'running' && (!p || !p.total);
        return h(
          'div',
          { class: `job-step ${s.status}` },
          h('span', { class: 'job-icon' }, s.status === 'running' ? h('span', { class: 'spinner small' }) : { done: '✓', failed: '✗', cancelled: '–', pending: '○' }[s.status]),
          h('div', { class: 'job-main' }, h('div', null, h('strong', null, STEP_LABEL[s.name]), p?.label && s.status === 'running' ? h('span', { class: 'muted' }, ` · ${p.label}`) : null), h('div', { class: `bar ${indeterminate ? 'indeterminate' : ''}` }, h('div', { style: `width:${(frac * 100).toFixed(1)}%` }))),
          h(
            'span',
            { class: 'muted job-meta' },
            s.status === 'running' && p && p.total ? `${p.done.toLocaleString('en')} / ${p.total.toLocaleString('en')}` : '',
            s.etaSeconds ? ` · ~${fmtMin(s.etaSeconds)} left` : '',
            s.status === 'done' && s.startedAt && s.endedAt ? fmtMin((Date.parse(s.endedAt) - Date.parse(s.startedAt)) / 1000) : '',
          ),
        );
      }),
    );
    fill(
      actions,
      j.status === 'running'
        ? h(
            'button',
            {
              class: 'danger',
              onclick: async () => {
                if (!confirm('Stop the current step? Generated audio is kept; features and training start over next time.')) return;
                await api('/api/jobs/cancel', { method: 'POST' });
              },
            },
            'Cancel',
          )
        : null,
      j.status === 'running' ? h('span', { class: 'help' }, 'You can close this tab: it keeps running as long as the terminal with `npm start` is open.') : null,
      j.status === 'failed' ? h('div', { class: 'error-box' }, j.error ?? 'Failed') : null,
      j.status === 'done' && j.word && j.steps.some((s) => s.name === 'train') ? h('a', { class: 'button primary', href: `#/w/${j.word}/results` }, 'See the results →') : null,
    );
  };

  // Stop listening once the panel is no longer on the page.
  let mounted = false;
  const gone = () => mounted && !root.isConnected;
  const drawLog = (line: string | null) => {
    if (gone()) return void live.onLog.delete(drawLog);
    const atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 30;
    if (line === null) logEl.textContent = live.logs.slice(-500).join('\n');
    else logEl.textContent += (logEl.textContent ? '\n' : '') + line;
    if (logEl.textContent!.length > 200_000) logEl.textContent = live.logs.slice(-500).join('\n');
    if (atBottom) logEl.scrollTop = logEl.scrollHeight;
  };
  const onJob = (j: Job | null) => {
    if (gone()) return void live.onJob.delete(onJob);
    if (j && j.id === job.id) drawSteps(j);
  };
  live.onJob.add(onJob);
  live.onLog.add(drawLog);
  drawSteps(job);
  drawLog(null);
  root.append(stepsEl, actions, h('details', { open: job.status !== 'done' }, h('summary', null, 'Log'), logEl));
  requestAnimationFrame(() => {
    mounted = true;
    logEl.scrollTop = logEl.scrollHeight;
  });
  return root;
}

export async function trainView() {
  const { config: c, status: s } = state.word!;
  const app = state.app!;
  const job = jobFor(c.name);
  const busy = app.job?.status === 'running';
  const otherBusy = busy && app.job?.word !== c.name;
  if (!opts.workers) opts.workers = Math.max(1, app.cpus - 2);
  if (s.tts.outdated) opts.fresh = true;

  const missingSetup = app.setup.filter((x) => x.required && !x.ok);
  const expected = s.tts.expected.pos + s.tts.expected.adv + s.tts.expected.sent;
  const have = s.tts.pos + s.tts.adv + s.tts.sent;
  const toGenerate = opts.fresh ? expected : Math.max(0, expected - have);

  const checks: [boolean | null, string][] = [
    [missingSetup.length === 0, missingSetup.length ? `Setup: ${missingSetup.map((x) => x.label).join(', ')} will be downloaded first.` : 'Setup complete.'],
    [Object.values(c.positive).some((l) => l.length), `${Object.values(c.positive).flat().length} spellings of the wake word, ${Object.values(c.adversarial).flat().length} near-misses, ${Object.values(c.sentences).flat().length} sentences.`],
    [c.voices.length > 0 && c.holdoutVoices.length > 0, `${c.voices.length} voices${c.holdoutVoices.length ? `, held out: ${c.holdoutVoices.join(', ')}` : ', none held out'}.`],
    [s.recordings.pos >= 20 ? true : null, `${s.recordings.pos} recordings of the wake word and ${s.recordings.neg} of other phrases${s.recordings.pos < 20 ? ' (optional; 20+ recommended)' : ''}.`],
  ];
  const canStart = !busy && Object.values(c.positive).some((l) => l.length) && c.voices.length > 0 && (run.generate || run.features || run.train);

  const checkbox = (key: keyof typeof run, label: string, detail: string) =>
    h(
      'label',
      { class: 'check-row' },
      h('input', {
        type: 'checkbox',
        checked: run[key],
        onchange: (e: Event) => {
          run[key] = (e.target as HTMLInputElement).checked;
        },
      }),
      h('span', null, h('strong', null, label), ' — ', detail),
    );
  const num = (key: 'pages' | 'workers' | 'steps' | 'negWeight', label: string, help: string) =>
    h(
      'label',
      null,
      label,
      h('input', { type: 'number', value: opts[key], min: 1, onchange: (e: Event) => (opts[key] = Number((e.target as HTMLInputElement).value)) }),
      h('span', { class: 'help' }, help),
    );

  const start = () => {
    const steps = [...(missingSetup.length ? ['setup'] : []), ...(Object.keys(run) as (keyof typeof run)[]).filter((k) => run[k])];
    if (opts.fresh && run.generate && have > 0 && !confirm(`Delete the ${have.toLocaleString('en')} clips generated so far and start over?`)) return;
    void startJob({ word: c.name, steps, options: { ...opts } });
  };

  return h(
    'div',
    null,
    h('h1', null, 'Train'),
    h(
      'p',
      { class: 'lead' },
      'Three steps, all on this computer: generate speech with the voices, mix it with music, noise and room echo to compute features, then train a small network and export it to ONNX. It takes from tens of minutes to a few hours; you can leave it running.',
    ),
    job && (job.status === 'running' || Date.now() - Date.parse(job.endedAt ?? job.startedAt) < 6 * 3600_000)
      ? section(job.status === 'running' ? 'Running' : 'Last run', null, jobPanel(job))
      : null,
    otherBusy ? h('div', { class: 'card warn' }, 'Something else is running (', h('a', { href: app.job?.word ? `#/w/${app.job.word}/train` : '#/setup' }, app.job?.word ?? 'setup'), '). Wait for it to finish before starting this one.') : null,
    job?.status === 'running'
      ? null
      : [
          section('Ready?', null, h('ul', { class: 'checklist compact' }, checks.map(([ok, text]) => h('li', { class: ok ? 'ok' : ok === null ? 'optional' : 'missing' }, h('span', { class: 'mark' }, ok ? '✓' : ok === null ? '○' : '!'), h('div', null, text))))),
          section(
            'What will run',
            null,
            checkbox('generate', 'Generate speech', toGenerate ? `${toGenerate.toLocaleString('en')} clips to make, about ${fmtMin(toGenerate / CLIPS_PER_SECOND)}${have && !opts.fresh ? ` (${have.toLocaleString('en')} already done are kept)` : ''}.` : `all ${have.toLocaleString('en')} clips are already there.`),
            checkbox('features', 'Compute features', 'mixes every clip with backgrounds and runs it through openWakeWord, using all CPU cores; usually 5–30 min.'),
            checkbox('train', 'Train and evaluate', 'about 20 min with the default settings; writes the model and a report.'),
            s.tts.outdated ? h('div', { class: 'card warn inset' }, 'Phrases or voices changed since the speech was generated. "Start over" below is ticked so every clip matches the current settings.') : null,
            h(
              'details',
              null,
              h('summary', null, 'Advanced options'),
              h(
                'div',
                { class: 'grid2' },
                h(
                  'label',
                  { class: 'check-row' },
                  h('input', { type: 'checkbox', checked: opts.fresh, onchange: (e: Event) => (opts.fresh = (e.target as HTMLInputElement).checked) }),
                  h('span', null, h('strong', null, 'Start over'), ' — delete generated speech and make it again.'),
                ),
                num('pages', 'Browser tabs for speech', 'More is faster if you have cores and memory to spare.'),
                num('workers', 'Feature threads', `This computer has ${app.cpus} cores.`),
                num('steps', 'Training steps', 'Default 10,000. Fewer for a quick test.'),
                h('label', null, 'Hidden layers', h('input', { type: 'text', value: opts.hidden, onchange: (e: Event) => (opts.hidden = (e.target as HTMLInputElement).value) }), h('span', { class: 'help' }, 'Default 64,32. Bigger is not always better.')),
                num('negWeight', 'False alarm penalty', 'Default 30. Higher: fewer false alarms, but it may miss more.'),
              ),
            ),
            h('div', { class: 'row' }, h('button', { class: 'primary big', disabled: !canStart, onclick: start }, s.model ? 'Train again' : 'Start training')),
          ),
        ],
    s.model && !job ? h('div', { class: 'next' }, h('a', { class: 'button', href: `#/w/${c.name}/results` }, 'See the current results →')) : null,
  );
}
