import './style.css';
import { api } from './api.ts';
import { fill, h, toast, type Child } from './dom.ts';
import { recorder } from './audio.ts';
import { loadApp, loadWord, save, state, type Job } from './state.ts';
import { setupView } from './views/setup.ts';
import { newWordView, wordView } from './views/word.ts';
import { phrasesView } from './views/phrases.ts';
import { voicesView } from './views/voices.ts';
import { recordView } from './views/record.ts';
import { trainView, jobPanel } from './views/train.ts';
import { resultsView } from './views/results.ts';

export const STEPS = [
  { id: 'word', label: 'Wake word', view: wordView },
  { id: 'phrases', label: 'Phrases', view: phrasesView },
  { id: 'voices', label: 'Voices', view: voicesView },
  { id: 'record', label: 'Your voice', view: recordView },
  { id: 'train', label: 'Train', view: trainView },
  { id: 'results', label: 'Results', view: resultsView },
] as const;
export type StepId = (typeof STEPS)[number]['id'];

export const go = (hash: string) => {
  if (location.hash === hash) void render();
  else location.hash = hash;
};

const main = h('main', { id: 'main' });
const nav = h('nav', { id: 'nav' });
const banner = h('div', { id: 'banner' });
document.querySelector('#app')!.append(h('aside', null, h('a', { class: 'brand', href: '#/' }, h('span', { class: 'logo' }, '◉'), ' Wake Word Trainer'), nav), h('div', { class: 'content' }, banner, main));

// ───────── Live updates from the server ─────────

export const live = {
  logs: [] as string[],
  onLog: new Set<(line: string | null) => void>(),
  onJob: new Set<(job: Job | null) => void>(),
};

function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('job', (e) => {
    const job = JSON.parse((e as MessageEvent).data) as Job | null;
    const was = state.app?.job;
    if (state.app) state.app.job = job;
    renderBanner();
    live.onJob.forEach((fn) => fn(job));
    // When something finishes, reload what it may have changed.
    if (was?.status === 'running' && job && job.status !== 'running') void afterJob(job);
  });
  es.addEventListener('logs', (e) => {
    live.logs = JSON.parse((e as MessageEvent).data) as string[];
    live.onLog.forEach((fn) => fn(null));
  });
  es.addEventListener('reset', () => {
    live.logs = [];
    live.onLog.forEach((fn) => fn(null));
  });
  es.addEventListener('log', (e) => {
    const line = JSON.parse((e as MessageEvent).data) as string;
    live.logs.push(line);
    if (live.logs.length > 2000) live.logs.splice(0, 500);
    live.onLog.forEach((fn) => fn(line));
  });
}

async function afterJob(job: Job) {
  if (job.status === 'done') toast(job.steps.some((s) => s.name === 'train') ? 'Training finished — check the results.' : 'Done.');
  else if (job.status === 'failed') toast(job.error ?? 'Failed', 'error');
  await loadApp();
  if (state.word && job.word === state.word.config.name) await loadWord(job.word);
  void render();
}

function renderBanner() {
  const job = state.app?.job;
  banner.replaceChildren();
  if (!job || job.status !== 'running') return;
  const step = job.steps.find((s) => s.status === 'running');
  const p = step?.progress;
  const title = job.word ? `${state.app?.words.find((w) => w.name === job.word)?.phrase ?? job.word}` : 'Setup';
  banner.append(
    h(
      'a',
      { class: 'banner', href: job.word ? `#/w/${job.word}/train` : '#/setup' },
      h('span', { class: 'spinner' }),
      h('strong', null, title),
      ` · ${STEP_LABEL[step?.name ?? 'setup']}`,
      p && p.total ? ` ${Math.floor((p.done / p.total) * 100)} %` : '',
      step?.etaSeconds ? ` · ~${Math.ceil(step.etaSeconds / 60)} min left` : '',
    ),
  );
}
export const STEP_LABEL: Record<string, string> = { setup: 'Downloading data', generate: 'Generating speech', features: 'Computing features', train: 'Training' };

// ───────── Navigation ─────────

function stepDone(id: StepId): boolean | null {
  const w = state.word;
  if (!w) return false;
  const c = w.config;
  switch (id) {
    case 'word':
      return true;
    case 'phrases':
      return Object.values(c.positive).some((l) => l.length) && Object.values(c.adversarial).flat().length >= 5;
    case 'voices':
      return c.voices.length > 0 && c.holdoutVoices.length > 0;
    case 'record':
      return w.status.recordings.pos >= 20 ? true : null;
    case 'train':
    case 'results':
      return !!w.status.model;
  }
}

export function renderNav() {
  const app = state.app;
  if (!app) return;
  const route = parse();
  const setupOk = app.setup.every((s) => s.ok || !s.required);
  const items: Child[] = [
    h('a', { href: '#/setup', class: route.view === 'setup' ? 'active' : '' }, h('span', { class: `dot ${setupOk ? 'ok' : 'warn'}` }), 'Setup'),
    h('div', { class: 'nav-title' }, 'Wake words'),
  ];
  for (const w of app.words) {
    const active = route.name === w.name;
    items.push(h('a', { href: `#/w/${w.name}/${active ? route.step : w.hasModel ? 'results' : 'phrases'}`, class: `word ${active ? 'current' : ''}` }, h('span', { class: `dot ${w.hasModel ? 'ok' : ''}` }), w.phrase));
    if (active && state.word) {
      const running = app.job?.status === 'running' && app.job.word === w.name;
      items.push(
        h(
          'ol',
          { class: 'steps' },
          STEPS.map((s) => {
            const done = stepDone(s.id);
            const mark = s.id === 'train' && running ? h('span', { class: 'spinner small' }) : h('span', { class: `check ${done ? 'done' : done === null ? 'optional' : ''}` }, done ? '✓' : '');
            return h('li', null, h('a', { href: `#/w/${w.name}/${s.id}`, class: route.step === s.id ? 'active' : '' }, mark, s.label));
          }),
        ),
      );
    }
  }
  items.push(h('a', { href: '#/new', class: `new ${route.view === 'new' ? 'active' : ''}` }, '+ New wake word'));
  fill(nav, ...items);
}

function parse(): { view: string; name?: string; step: StepId } {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  if (parts[0] === 'w' && parts[1]) return { view: 'word', name: parts[1], step: (STEPS.find((s) => s.id === parts[2])?.id ?? 'phrases') as StepId };
  return { view: parts[0] || '', step: 'word' };
}

let rendering = 0;
export async function render() {
  const id = ++rendering;
  await save();
  const route = parse();
  if (!['record', 'results'].includes(route.step) || route.view !== 'word') recorder.close();
  try {
    if (!state.app) await loadApp();
    const app = state.app!;
    if (route.view === '') {
      const setupOk = app.setup.every((s) => s.ok || !s.required);
      const first = app.words[0];
      return go(!setupOk && !app.job ? '#/setup' : first ? `#/w/${first.name}/${first.hasModel ? 'results' : 'phrases'}` : '#/new');
    }
    if (route.view === 'word' && route.name && state.word?.config.name !== route.name) await loadWord(route.name);
    if (route.view !== 'word') state.word = null;
    if (id !== rendering) return;
    renderNav();
    renderBanner();
    let view: Node;
    if (route.view === 'setup') view = await setupView();
    else if (route.view === 'new') view = await newWordView();
    else if (route.view === 'word' && state.word) view = await STEPS.find((s) => s.id === route.step)!.view();
    else view = h('p', null, 'Not found. ', h('a', { href: '#/' }, 'Start over'));
    if (id !== rendering) return;
    main.replaceChildren(view);
    window.scrollTo(0, 0);
  } catch (err) {
    main.replaceChildren(h('div', { class: 'card error' }, h('h2', null, 'Something went wrong'), h('pre', null, (err as Error).message)));
  }
}

/** The "Next" button at the bottom of each step. */
export function nextButton(step: StepId, label?: string) {
  const i = STEPS.findIndex((s) => s.id === step);
  const next = STEPS[i + 1];
  if (!next || !state.word) return null;
  return h('div', { class: 'next' }, h('a', { class: 'button primary', href: `#/w/${state.word.config.name}/${next.id}` }, label ?? `Next: ${next.label} →`));
}

export function jobFor(word: string | null) {
  const job = state.app?.job;
  return job && job.word === word ? job : null;
}
export { jobPanel };

export async function startJob(body: unknown) {
  try {
    const job = await api<Job>('/api/jobs', { body });
    if (state.app) state.app.job = job;
    renderBanner();
    void render();
  } catch (err) {
    toast((err as Error).message, 'error');
  }
}

window.addEventListener('hashchange', () => void render());
window.addEventListener('beforeunload', () => void save());
connect();
void render();
