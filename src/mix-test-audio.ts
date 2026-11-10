/**
 * Builds a long test clip: music with your phrases on top, 7 s apart, to play into a
 * microphone (or use as a fake microphone in Chrome) and test a detector end to end.
 *
 *   npm run mix-test-audio -- out.wav <snr dB> clip1.wav clip2.wav … [--music rock]
 */
import { arg, loadClip16k, rng, writeWav } from './common.ts';
import { mixAt, readMusic, segment } from './audio.ts';
import { testSong } from './score.ts';

const [out, snrArg, ...rest] = process.argv.slice(2);
const clips = rest.filter((c) => c.endsWith('.wav'));
if (!out || !clips.length) throw new Error('Usage: npm run mix-test-audio -- out.wav <snr dB> clip1.wav … [--music rock]');
const song = testSong(arg('music', 'rock'));
if (!song) throw new Error('No music found: run npm run setup');
const gap = 16000 * 7;
const loaded = clips.map(loadClip16k);
const len = 16000 * 3 + loaded.reduce((a, c) => a + c.length + gap, 0);
const bg = segment(readMusic(song), len, rng(9));
// Every phrase at the same voice/music ratio (the music is scaled once, for all of them).
let at = 16000 * 3;
const voice = new Float32Array(len);
for (const x of loaded) {
  voice.set(x, at);
  at += x.length + gap;
}
mixAt(bg, voice, 0, Number(snrArg));
for (let i = 0; i < len; i++) bg[i] *= 0.6;
writeWav(out, bg);
console.log(`${out}: ${(len / 16000).toFixed(1)} s`);
