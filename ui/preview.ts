import { play } from './audio.ts';
import { h, toast } from './dom.ts';
import { state } from './state.ts';

/**
 * Speaks a phrase with a Piper voice, right in this browser, to check pronunciation. The first
 * time, the voice is downloaded (tens of MB) and kept in the browser's storage.
 */
let queue: Promise<unknown> = Promise.resolve();

export function speak(voice: string, text: string, btn?: HTMLButtonElement): Promise<void> {
  const run = async () => {
    const label = btn?.textContent ?? '';
    btn?.classList.add('busy');
    try {
      const { synthesize } = await import('../synth/piper.ts');
      const info = state.voices.find((v) => v.id === voice);
      const speaker = info && info.speakers > 1 ? Math.floor(Math.random() * info.speakers) : 0;
      const blob = await synthesize(voice, text, { speaker }, (loaded, total) => {
        if (btn && total) btn.textContent = `${Math.round((loaded / total) * 100)}%`;
      });
      if (btn) btn.textContent = label;
      if (btn && info && info.speakers > 1) btn.title = `Speaker ${speaker} of ${info.speakers}`;
      await play(blob);
    } catch (err) {
      toast(`Could not play: ${(err as Error).message}`, 'error');
    } finally {
      if (btn) {
        btn.textContent = label;
        btn.classList.remove('busy');
      }
    }
  };
  const p = queue.then(run, run);
  queue = p;
  return p;
}

export function playButton(getVoice: () => string, getText: () => string, title = 'Listen') {
  const btn: HTMLButtonElement = h('button', {
    class: 'icon',
    type: 'button',
    title,
    onclick: () => {
      const text = getText().trim();
      if (text) void speak(getVoice(), text, btn);
    },
  }, '▶');
  return btn;
}
