import { api } from '../api.ts';
import { encodeWav, peak, play, recorder } from '../audio.ts';
import { fill, h, toast } from '../dom.ts';
import { nextButton, renderNav } from '../main.ts';
import { refreshStatus, state } from '../state.ts';

type Kind = 'pos' | 'neg';
interface Rec {
  file: string;
  seconds: number;
}

const TARGET: Record<Kind, number> = { pos: 30, neg: 20 };
const MAX_SECONDS: Record<Kind, number> = { pos: 3, neg: 5 };

const POS_TIPS = [
  'Say it normally.',
  'A bit faster.',
  'Slowly and clearly.',
  'Quietly, almost whispering.',
  'Louder, as if from the other side of the room.',
  'Step back a couple of metres from the microphone.',
  'As a question.',
  'Tired or bored.',
  'Turn your head away from the microphone.',
  'With some music or TV playing in the background.',
  'Cheerfully.',
  'Like you would say it while busy with something else.',
];

let kind: Kind = 'pos';
let index = { pos: 0, neg: 0 };

export async function recordView() {
  const c = state.word!.config;
  const lang = c.language ?? 'en';
  const negPrompts = [...(c.adversarial[lang] ?? []), ...(c.sentences[lang] ?? [])];
  const wake = c.phrase ?? c.positive[lang]?.[0] ?? c.name;
  let recs: Record<Kind, Rec[]> = await api(`/api/words/${c.name}/recordings`);

  const root = h('div');
  const listEl = h('div', { class: 'rec-list' });
  const prompt = h('div', { class: 'prompt' });
  const counter = h('div', { class: 'counter' });
  const meter = h('div', { class: 'meter' }, h('div', { class: 'meter-fill' }));
  const bar = h('div', { class: 'rec-progress' }, h('div'));
  const recBtn: HTMLButtonElement = h('button', { class: 'record', onclick: () => void toggle() }, '● Record');
  let recording = false;
  let stopTimer: ReturnType<typeof setTimeout> | null = null;

  recorder.onLevel = (rms) => {
    const fill = meter.firstElementChild as HTMLElement;
    fill.style.width = `${Math.min(100, Math.sqrt(rms) * 220)}%`;
  };

  const drawPrompt = () => {
    if (kind === 'pos') {
      prompt.replaceChildren(h('div', { class: 'say' }, 'Say: ', h('strong', null, `“${wake}”`)), h('div', { class: 'tip' }, POS_TIPS[index.pos % POS_TIPS.length]));
    } else {
      const p = negPrompts.length ? negPrompts[index.neg % negPrompts.length] : null;
      prompt.replaceChildren(
        p ? h('div', { class: 'say' }, 'Say: ', h('strong', null, `“${p}”`)) : h('div', { class: 'say' }, 'Say anything that is not the wake word.'),
        h('div', { class: 'tip' }, 'Or anything you might say near the device. Never the wake word itself.'),
      );
    }
    const n = recs[kind].length;
    counter.replaceChildren(h('strong', null, n), ` / ${TARGET[kind]} recommended`, n >= TARGET[kind] ? ' ✓' : '');
  };

  const drawList = () => {
    listEl.replaceChildren(
      ...[...recs[kind]].reverse().map((r) =>
        h(
          'div',
          { class: 'rec' },
          h('button', { class: 'icon', title: 'Play', onclick: () => play(`/api/words/${c.name}/recordings/${kind}/${r.file}`) }, '▶'),
          h('span', { class: 'muted' }, `${r.seconds} s`),
          h('span', { class: 'rec-name' }, r.file),
          h(
            'button',
            {
              class: 'icon ghost',
              title: 'Delete',
              onclick: async () => {
                await api(`/api/words/${c.name}/recordings/${kind}/${r.file}`, { method: 'DELETE' });
                await reload();
              },
            },
            '✕',
          ),
        ),
      ),
    );
    if (!recs[kind].length) listEl.append(h('p', { class: 'muted' }, 'No recordings yet.'));
  };

  const reload = async () => {
    recs = await api(`/api/words/${c.name}/recordings`);
    await refreshStatus();
    renderNav();
    drawPrompt();
    drawList();
    drawTabs();
  };

  const upload = async (blob: Blob, name = '') => {
    await api(`/api/words/${c.name}/recordings/${kind}?name=${encodeURIComponent(name)}`, { body: blob });
  };

  async function toggle() {
    if (recording) return finish();
    try {
      await recorder.start();
    } catch (err) {
      return toast(`Microphone not available: ${(err as Error).message}`, 'error');
    }
    recording = true;
    recBtn.textContent = '■ Stop';
    recBtn.classList.add('on');
    const bf = bar.firstElementChild as HTMLElement;
    bf.style.transition = 'none';
    bf.style.width = '0';
    void bf.offsetWidth;
    bf.style.transition = `width ${MAX_SECONDS[kind]}s linear`;
    bf.style.width = '100%';
    stopTimer = setTimeout(() => void finish(), MAX_SECONDS[kind] * 1000);
  }

  async function finish() {
    if (!recording) return;
    recording = false;
    if (stopTimer) clearTimeout(stopTimer);
    recBtn.textContent = '● Record';
    recBtn.classList.remove('on');
    const bf = bar.firstElementChild as HTMLElement;
    bf.style.transition = 'none';
    bf.style.width = '0';
    const samples = recorder.stop();
    if (samples.length < recorder.rate * 0.4) return;
    if (peak(samples) < 0.02) return toast('That was very quiet — is the right microphone selected? Not saved.', 'error');
    if (peak(samples) > 0.99) toast('That clipped (too loud). Saved anyway; consider moving back a little.', 'error');
    try {
      await upload(encodeWav(samples, recorder.rate));
      index[kind]++;
      await reload();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }

  const fileInput = h('input', {
    type: 'file',
    accept: '.wav,audio/wav',
    multiple: true,
    hidden: true,
    onchange: async () => {
      let ok = 0;
      for (const f of Array.from(fileInput.files ?? [])) {
        try {
          await upload(f, f.name);
          ok++;
        } catch (err) {
          toast(`${f.name}: ${(err as Error).message}`, 'error');
        }
      }
      fileInput.value = '';
      if (ok) toast(`${ok} file${ok > 1 ? 's' : ''} added`);
      await reload();
    },
  });

  const tabs = h('div', { class: 'tabs' });
  const drawTabs = () =>
    tabs.replaceChildren(
      ...(['pos', 'neg'] as Kind[]).map((k) =>
        h(
          'button',
          {
            class: k === kind ? 'tab active' : 'tab',
            onclick: () => {
              kind = k;
              drawTabs();
              drawPrompt();
              drawList();
            },
          },
          k === 'pos' ? 'The wake word' : 'Other phrases',
          h('span', { class: 'badge' }, recs[k].length),
        ),
      ),
    );

  const onKey = (e: KeyboardEvent) => {
    if (e.code !== 'Space' || (e.target as HTMLElement).closest('input, textarea, select, button')) return;
    if (!document.body.contains(root)) return document.removeEventListener('keydown', onKey);
    e.preventDefault();
    void toggle();
  };
  document.addEventListener('keydown', onKey);

  drawTabs();
  drawPrompt();
  drawList();
  fill(
    root,
    h('h1', null, 'Your voice'),
    h(
      'p',
      { class: 'lead' },
      'Optional, but it makes the biggest difference for the people who will actually use it. Your recordings weigh more than the synthetic voices, and one in five is kept aside to measure how well the model recognises you. Record with the microphone you will use, in the room you will use it in. Several people can take turns.',
    ),
    tabs,
    h(
      'section',
      { class: 'card recorder' },
      prompt,
      h('div', { class: 'rec-controls' }, recBtn, h('div', { class: 'rec-side' }, meter, bar, h('div', { class: 'help' }, 'Press Space or the button. It stops by itself after a few seconds.'))),
      counter,
    ),
    h(
      'section',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, kind === 'pos' ? 'Recordings of the wake word' : 'Recordings of other phrases'), h('button', { class: 'ghost small', onclick: () => fileInput.click() }, 'Upload WAV files…'), fileInput),
      listEl,
    ),
    nextButton('record'),
  );
  return root;
}
