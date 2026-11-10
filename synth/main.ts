import { synthesize, type Tuning } from './piper.ts';

/**
 * window.synth(voice, text, tuning) → WAV in base64. Called by src/generate.ts through Playwright.
 */
async function synth(voice: string, text: string, tuning: Tuning): Promise<string> {
  const bytes = new Uint8Array(await (await synthesize(voice, text, tuning)).arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

(window as unknown as { synth: typeof synth }).synth = synth;
(window as unknown as { synthReady: boolean }).synthReady = true;
