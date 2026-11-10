import fs from 'node:fs';
import path from 'node:path';
import * as ort from 'onnxruntime-node';
import { DATA } from './common.ts';
import { mixAt, readMusic, segment } from './audio.ts';
import { rng } from './common.ts';
import { EMB, OwwFeatures, WINDOW } from './oww.ts';

/** Feature windows of a 16 kHz clip, one every 80 ms, as a real-time detector would see them. */
export async function featureWindows(audio: Float32Array, threads = 2): Promise<Float32Array[]> {
  const feats = await OwwFeatures.create(threads);
  const windows: Float32Array[] = [];
  await feats.push(audio, (w) => windows.push(w()));
  return windows;
}

/** A model's score (0…1) for every window. */
export async function runModel(session: ort.InferenceSession, windows: Float32Array[]): Promise<Float32Array> {
  if (!windows.length) return new Float32Array(0);
  const x = new Float32Array(windows.length * WINDOW * EMB);
  windows.forEach((w, i) => x.set(w, i * WINDOW * EMB));
  const res = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', x, [windows.length, WINDOW, EMB]) });
  return Float32Array.from(res[session.outputNames[0]].data as Float32Array);
}

/** Music genres available for tests (GTZAN), and a song kept out of training for each one. */
export const GTZAN = path.join(DATA, 'gtzan', 'genres');
export function testSong(genre: string): string | null {
  const dir = path.join(GTZAN, genre);
  if (!/^[a-z]+$/.test(genre) || !fs.existsSync(dir)) return null;
  const songs = fs.readdirSync(dir).filter((f) => /\.0009\d\.(wav|au)$/.test(f)).sort();
  return songs.length ? path.join(dir, songs[songs.length - 3] ?? songs[0]) : null;
}
export function genres(): string[] {
  return fs.existsSync(GTZAN) ? fs.readdirSync(GTZAN).filter((g) => fs.statSync(path.join(GTZAN, g)).isDirectory()).sort() : [];
}

/** Pads a clip with `pad` seconds of silence on each side, optionally with music underneath. */
export function prepareClip(clip: Float32Array, opts: { pad?: number; music?: string | null; snr?: number; seed?: number } = {}): Float32Array {
  const pad = Math.round((opts.pad ?? 1) * 16000);
  const audio = new Float32Array(pad + clip.length + pad);
  if (opts.music) {
    audio.set(segment(readMusic(opts.music), audio.length, rng(opts.seed ?? 3)));
    mixAt(audio, clip, pad, opts.snr ?? 5);
  } else audio.set(clip, pad);
  return audio;
}
