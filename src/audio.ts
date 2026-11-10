import fs from 'node:fs';
import { readWav, resample, rms, type Rng } from './common.ts';

/**
 * Data augmentation: what turns a clean synthetic voice into something like what a real
 * microphone hears (music, noise, room echo, a worse or more distant microphone).
 */

/** GTZAN music (.wav or .au) → 16 kHz, −1…1. */
export function readMusic(file: string): Float32Array {
  if (file.endsWith('.wav')) {
    const { samples, rate } = readWav(file);
    return resample(samples, rate, 16000);
  }
  return readAu(file);
}

/** .au file (16-bit big-endian PCM) → 16 kHz, −1…1. */
export function readAu(file: string): Float32Array {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== '.snd') throw new Error(`${file}: not an .au file`);
  const offset = b.readUInt32BE(4);
  const encoding = b.readUInt32BE(12);
  const rate = b.readUInt32BE(16);
  const channels = b.readUInt32BE(20);
  if (encoding !== 3) throw new Error(`${file}: unsupported .au encoding ${encoding}`);
  const n = Math.floor((b.length - offset) / 2 / channels);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let c = 0; c < channels; c++) v += b.readInt16BE(offset + (i * channels + c) * 2);
    out[i] = v / channels / 32768;
  }
  return resample(out, rate, 16000);
}

export function noise(kind: 'white' | 'pink' | 'brown', n: number, r: Rng): Float32Array {
  const out = new Float32Array(n);
  let b0 = 0,
    b1 = 0,
    b2 = 0,
    last = 0;
  for (let i = 0; i < n; i++) {
    const w = r.next() * 2 - 1;
    if (kind === 'white') out[i] = w;
    else if (kind === 'pink') {
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      out[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
    } else {
      last = (last + 0.02 * w) / 1.02;
      out[i] = last * 3.5;
    }
  }
  return out;
}

/**
 * Room echo: a synthetic impulse response (direct sound, a few early reflections and a tail
 * that decays according to RT60). Sparse, so the convolution is cheap.
 */
export function reverb(x: Float32Array, rt60: number, r: Rng): Float32Array {
  const taps: [number, number][] = [[0, 1]];
  for (let i = 0; i < 8; i++) taps.push([Math.round(r.range(0.003, 0.03) * 16000), r.range(0.2, 0.6) * (r.next() < 0.5 ? -1 : 1)]);
  const tail = Math.round(rt60 * 16000);
  for (let i = 0; i < 120; i++) {
    const d = Math.round(r.range(0.02, 1) * tail);
    taps.push([d, (r.next() * 2 - 1) * 0.35 * Math.pow(10, (-3 * d) / tail)]);
  }
  const out = new Float32Array(x.length + tail);
  for (const [d, g] of taps) for (let i = 0; i < x.length; i++) out[i + d] += x[i] * g;
  const k = rms(x) / Math.max(1e-6, rms(out.subarray(0, x.length)));
  for (let i = 0; i < out.length; i++) out[i] *= k;
  return out;
}

/** One-pole filters: a cheap microphone (cuts highs) or a distant / small one (cuts lows). */
export function lowpass(x: Float32Array, cutoff: number): Float32Array {
  const a = Math.exp((-2 * Math.PI * cutoff) / 16000);
  const out = new Float32Array(x.length);
  let y = 0;
  for (let i = 0; i < x.length; i++) out[i] = y = (1 - a) * x[i] + a * y;
  return out;
}
export function highpass(x: Float32Array, cutoff: number): Float32Array {
  const lp = lowpass(x, cutoff);
  return x.map((v, i) => v - lp[i]);
}

/** Changes pitch and speed together (like speeding up a tape): more variety of voices. */
export const pitch = (x: Float32Array, factor: number) => resample(x, 16000 * factor, 16000);

/** A piece of `len` samples of a background, starting at a random point (looping if it is short). */
export function segment(bg: Float32Array, len: number, r: Rng): Float32Array {
  const out = new Float32Array(len);
  if (!bg.length) return out;
  let p = r.int(Math.max(1, bg.length - len));
  for (let i = 0; i < len; i++) {
    out[i] = bg[p++];
    if (p >= bg.length) p = 0;
  }
  return out;
}

/** Adds `fg` into `bg` starting at `at`, scaling the background to the requested signal-to-noise ratio. */
export function mixAt(bg: Float32Array, fg: Float32Array, at: number, snrDb: number) {
  const under = bg.subarray(at, at + fg.length);
  const k = rms(fg) / Math.max(1e-6, rms(under)) / Math.pow(10, snrDb / 20);
  // The whole background is scaled (not just under the voice) so there are no volume jumps.
  for (let i = 0; i < bg.length; i++) bg[i] *= k;
  for (let i = 0; i < fg.length && at + i < bg.length; i++) bg[at + i] += fg[i];
}

/** Random final volume, as if closer to or further from the microphone. */
export function level(x: Float32Array, peak: number) {
  let m = 0;
  for (const v of x) m = Math.max(m, Math.abs(v));
  const k = peak / Math.max(1e-6, m);
  for (let i = 0; i < x.length; i++) x[i] *= k;
}
