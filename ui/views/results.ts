import { api } from '../api.ts';
import { encodeWav, play, recorder } from '../audio.ts';
import { fill, h, pct, section, svg, toast } from '../dom.ts';
import { state, type Report, type ReportRow } from '../state.ts';

/** The lowest threshold with at most ~1 false alarm every 2 hours (more recall, still quiet). */
export function recommend(report: Report): ReportRow {
  const rows = [...report.report].sort((a, b) => a.threshold - b.threshold);
  const fa = (r: ReportRow) => r.falseAlarmsPerHourValidation ?? r.falseAlarmsPerHourMusic ?? 0;
  return rows.find((r) => fa(r) <= 0.5) ?? rows[rows.length - 1];
}

const COLUMNS: { key: keyof ReportRow; label: string; help: string; kind: 'recall' | 'fa' | 'count' | 'thr' }[] = [
  { key: 'threshold', label: 'Threshold', help: 'Score above which the detector fires.', kind: 'thr' },
  { key: 'recallHeldOutVoice', label: 'Detected: unseen voice', help: 'Share of wake word phrases detected, from the held-out voice (never used in training), on random backgrounds.', kind: 'recall' },
  { key: 'recallYourVoice', label: 'Detected: your voice', help: 'Share of your held-out recordings detected (1 in 5 of them), on random backgrounds.', kind: 'recall' },
  { key: 'falseAlarmsPerHourValidation', label: 'False alarms / h: general', help: "False activations per hour on openWakeWord's 11 h validation set (speech, music, noise).", kind: 'fa' },
  { key: 'falseAlarmsPerHourMusic', label: 'False alarms / h: music', help: 'False activations per hour on test songs never used in training.', kind: 'fa' },
  { key: 'falseAlarmsHeldOutSpeech', label: 'False alarms: near-misses', help: "Activations on the held-out voice saying the near-misses and sentences (total count, not per hour).", kind: 'count' },
];

export async function resultsView() {
  const { config: c, status: s } = state.word!;
  if (!s.model || !s.report) {
    return h(
      'div',
      null,
      h('h1', null, 'Results'),
      h('div', { class: 'card' }, h('p', null, 'No model yet.'), h('a', { class: 'button primary', href: `#/w/${c.name}/train` }, 'Go to Train →')),
    );
  }
  const report = s.report;
  const rec = recommend(report);
  const ev = report.evaluation;

  const cell = (r: ReportRow, col: (typeof COLUMNS)[number]) => {
    const v = r[col.key];
    if (col.kind === 'thr') return h('td', null, h('strong', null, String(v)));
    if (v === null || v === undefined) return h('td', { class: 'muted' }, '—');
    if (col.kind === 'recall') return h('td', { class: Number(v) >= 0.8 ? 'good' : Number(v) >= 0.5 ? '' : 'bad' }, pct(Number(v)));
    if (col.kind === 'fa') return h('td', { class: Number(v) <= 0.5 ? 'good' : Number(v) <= 3 ? '' : 'bad' }, String(v));
    return h('td', null, String(v));
  };

  return h(
    'div',
    null,
    h('h1', null, 'Results'),
    h(
      'section',
      { class: 'card hero' },
      h('div', null, h('div', { class: 'muted' }, 'Suggested threshold'), h('div', { class: 'big-number' }, rec.threshold)),
      h(
        'div',
        { class: 'hero-text' },
        h(
          'p',
          null,
          'At this threshold the model detects ',
          h('strong', null, pct(rec.recallHeldOutVoice)),
          ' of phrases from a voice it never heard',
          rec.recallYourVoice !== null ? [', ', h('strong', null, pct(rec.recallYourVoice)), ' of your held-out recordings'] : null,
          ', with about ',
          h('strong', null, String(rec.falseAlarmsPerHourValidation ?? rec.falseAlarmsPerHourMusic ?? '—')),
          ' false alarms per hour of general audio.',
        ),
        (rec.falseAlarmsPerHourValidation ?? rec.falseAlarmsPerHourMusic ?? 0) > 0.5
          ? h('div', { class: 'card warn inset' }, 'No threshold keeps false alarms under one every two hours: this model needs more work (see "Improving it" below), or it was a quick test run.')
          : null,
        rec.recallHeldOutVoice === null ? h('p', { class: 'help' }, 'Recall on an unseen voice was not measured: pick a held-out voice in Voices (and generate its clips).') : null,
        h('p', { class: 'help' }, 'Recall is measured on random backgrounds, many of them loud music, so it is a pessimistic estimate. Try it below with your own voice.'),
        h(
          'div',
          { class: 'row' },
          h('a', { class: 'button primary', href: `/api/words/${c.name}/model`, download: `${c.name}.onnx` }, `Download ${c.name}.onnx`),
          h('a', { class: 'button ghost', href: `/api/words/${c.name}/report`, download: `${c.name}.report.json` }, 'Report (JSON)'),
          h('span', { class: 'muted' }, `${s.model.sizeKB} KB · trained ${new Date(s.model.createdAt).toLocaleString()}`),
        ),
      ),
    ),
    tester(c.name, rec.threshold),
    section(
      'Full report',
      'Every threshold trades detections against false alarms. Pick one in your application; you can change it without retraining.',
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'report' },
          h('thead', null, h('tr', null, COLUMNS.map((col) => h('th', { title: col.help }, col.label)))),
          h('tbody', null, report.report.map((r) => h('tr', { class: r.threshold === rec.threshold ? 'highlight' : '' }, COLUMNS.map((col) => cell(r, col))))),
        ),
      ),
      h('dl', { class: 'legend' }, COLUMNS.slice(1).map((col) => [h('dt', null, col.label), h('dd', null, col.help)])),
      ev
        ? h(
            'p',
            { class: 'help' },
            `Measured on ${ev.heldOutPhrases} phrases of the held-out voice, ${ev.yourPhrases} of yours, ${ev.musicHours} h of music, ${ev.validationHours ?? 0} h of validation audio. Trained on ${report.data.trainPos.toLocaleString('en')} positive and ${(report.data.trainNeg + report.data.acav).toLocaleString('en')} negative windows (${report.data.trainUser.toLocaleString('en')} of them from your recordings).`,
          )
        : null,
    ),
    samples(c.name),
    section(
      'Use it',
      'The model has the same format as the official openWakeWord models: input [batch, 16, 96] (openWakeWord features), output [batch, 1] (a score from 0 to 1).',
      h(
        'pre',
        { class: 'code' },
        `# pip install openwakeword
import numpy as np, pyaudio
from openwakeword.model import Model

model = Model(wakeword_models=["${c.name}.onnx"], inference_framework="onnx")
mic = pyaudio.PyAudio().open(format=pyaudio.paInt16, channels=1, rate=16000,
                             input=True, frames_per_buffer=1280)
while True:
    frame = np.frombuffer(mic.read(1280), dtype=np.int16)   # 80 ms
    if model.predict(frame)["${c.name}"] > ${rec.threshold}:
        print("Wake word!")`,
      ),
    ),
    section(
      'Improving it',
      null,
      h(
        'ul',
        { class: 'tips' },
        h('li', null, h('strong', null, 'Misses your voice? '), 'Record more of the wake word (different distances, speeds, people), and check the spellings with ▶ in Phrases.'),
        h('li', null, h('strong', null, 'Too many false alarms? '), 'Add near-misses (especially whatever triggered it), record "other phrases", raise the threshold, or raise the false alarm penalty in Train → Advanced.'),
        h('li', null, h('strong', null, 'Odd pronunciations below? '), 'Fix the spelling for that language in Phrases, then train again with "Start over".'),
      ),
    ),
  );
}

// ───────── Try it with the microphone ─────────

function tester(name: string, initialThr: number) {
  let thr = initialThr;
  let last: { scores: number[]; hop: number; pad: number } | null = null;
  let lastAudio: Blob | null = null;
  const chart = h('div', { class: 'chart' }, h('p', { class: 'muted' }, 'Record a few seconds in which you say the wake word (or not), and see the score over time.'));
  const verdict = h('div', { class: 'verdict' });
  const genre = h('select', null, h('option', { value: '' }, 'No background'), (state.app?.genres ?? []).map((g) => h('option', { value: g }, `+ ${g} music`)));
  const snr = h('input', { type: 'range', min: 0, max: 20, step: 1, value: 8 });
  const snrLabel = h('span', { class: 'muted' }, '8 dB');
  snr.oninput = () => (snrLabel.textContent = `${snr.value} dB`);
  const thrInput = h('input', { type: 'range', min: 0.05, max: 0.99, step: 0.01, value: thr });
  const thrLabel = h('strong', null, thr.toFixed(2));
  thrInput.oninput = () => {
    thr = Number(thrInput.value);
    thrLabel.textContent = thr.toFixed(2);
    draw();
  };
  const btn: HTMLButtonElement = h('button', { class: 'record' }, '● Record (up to 6 s)');
  let recording = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const draw = () => {
    if (!last) return;
    const { scores, hop } = last;
    const W = 640;
    const H = 160;
    const x = (i: number) => (i / Math.max(1, scores.length - 1)) * W;
    const y = (v: number) => H - v * H;
    const pts = scores.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const seconds = scores.length * hop;
    const ticks: SVGElement[] = [];
    for (let t = 1; t < seconds; t++) ticks.push(svg('text', { x: x(t / hop), y: H + 14, class: 'tick' }, document.createTextNode(`${t}s`)));
    const fired = scores.findIndex((v) => v >= thr);
    chart.replaceChildren(
      svg(
        'svg',
        { viewBox: `0 -4 ${W} ${H + 20}`, class: 'score-chart', preserveAspectRatio: 'none' },
        svg('line', { x1: 0, x2: W, y1: y(thr), y2: y(thr), class: 'thr' }),
        svg('polyline', { points: pts, class: 'score' }),
        fired >= 0 ? svg('circle', { cx: x(fired), cy: y(scores[fired]), r: 4, class: 'fire' }) : svg('g', {}),
        ...ticks,
      ),
    );
    const max = Math.max(0, ...scores);
    fill(
      verdict,
      fired >= 0
        ? h('span', { class: 'yes' }, `✓ Detected at ${(fired * hop).toFixed(1)} s (peak ${max.toFixed(2)})`)
        : h('span', { class: 'no' }, `✗ Not detected (peak ${max.toFixed(2)})`),
      lastAudio ? h('button', { class: 'ghost small', onclick: () => play(lastAudio!) }, '▶ Listen to what the model heard') : null,
    );
  };

  const finish = async () => {
    if (!recording) return;
    recording = false;
    if (timer) clearTimeout(timer);
    btn.textContent = '● Record (up to 6 s)';
    btn.classList.remove('on');
    const samples = recorder.stop();
    if (samples.length < recorder.rate * 0.5) return;
    const wav = encodeWav(samples, recorder.rate);
    verdict.replaceChildren(h('span', { class: 'muted' }, 'Scoring…'));
    try {
      const q = genre.value ? `?music=${genre.value}&snr=${snr.value}` : '';
      const res = await api<{ scores: number[]; hop: number; pad: number; audio: string | null }>(`/api/words/${name}/test${q}`, { body: wav });
      last = res;
      lastAudio = res.audio ? new Blob([Uint8Array.from(atob(res.audio), (ch) => ch.charCodeAt(0))], { type: 'audio/wav' }) : wav;
      draw();
    } catch (err) {
      toast((err as Error).message, 'error');
      verdict.replaceChildren();
    }
  };

  btn.onclick = async () => {
    if (recording) return void finish();
    try {
      await recorder.start();
    } catch (err) {
      return toast(`Microphone not available: ${(err as Error).message}`, 'error');
    }
    recording = true;
    btn.textContent = '■ Stop';
    btn.classList.add('on');
    timer = setTimeout(() => void finish(), 6000);
  };

  return section(
    'Try it',
    'Uses the same pipeline as a real-time detector. Add music to hear how it copes with a noisy room.',
    h('div', { class: 'row tester-controls' }, btn, genre, h('label', { class: 'inline' }, 'Voice over music ', snr, snrLabel), h('label', { class: 'inline' }, 'Threshold ', thrInput, thrLabel)),
    chart,
    verdict,
  );
}

// ───────── Listen to generated clips ─────────

function samples(name: string) {
  const list = h('div', { class: 'rec-list' });
  let kind: 'pos' | 'adv' | 'sent' = 'pos';
  const load = async () => {
    const res = await api<{ total: number; samples: { file: string; voice: string; speaker: number; text: string }[] }>(`/api/words/${name}/samples?kind=${kind}&n=10`);
    list.replaceChildren(
      ...res.samples.map((x) =>
        h(
          'div',
          { class: 'rec' },
          h('button', { class: 'icon', onclick: () => play(`/api/words/${name}/tts/${kind}/${x.file}`) }, '▶'),
          h('span', null, `“${x.text}”`),
          h('span', { class: 'muted' }, ` ${x.voice}${x.speaker ? ` #${x.speaker}` : ''}`),
        ),
      ),
    );
    if (!res.samples.length) list.append(h('p', { class: 'muted' }, 'No clips of this kind.'));
  };
  const tabs = h('div', { class: 'tabs small' });
  const drawTabs = () =>
    tabs.replaceChildren(
      ...(
        [
          ['pos', 'Wake word'],
          ['adv', 'Near-misses'],
          ['sent', 'Sentences'],
        ] as const
      ).map(([k, label]) =>
        h(
          'button',
          {
            class: k === kind ? 'tab active' : 'tab',
            onclick: () => {
              kind = k;
              drawTabs();
              void load();
            },
          },
          label,
        ),
      ),
      h('button', { class: 'ghost small', onclick: () => void load() }, '↻ Others'),
    );
  drawTabs();
  void load();
  return section('Listen to the training data', 'A random handful of the generated clips. If the wake word sounds wrong in some voices, fix the spelling for that language.', tabs, list);
}
