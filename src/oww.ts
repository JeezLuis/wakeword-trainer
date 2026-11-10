import fs from 'node:fs';
import path from 'node:path';
import * as ort from 'onnxruntime-node';
import { DATA } from './common.ts';

/**
 * openWakeWord features, exactly as in real time (openwakeword/utils.py, AudioFeatures): every
 * 80 ms of 16 kHz audio, the mel spectrogram (76 frames of 32 bands) goes through Google's
 * speech embedding model and a vector of 96 comes out. The wake word model looks at the last
 * 16 of them (1.28 s).
 *
 * They are computed in streaming, chunk by chunk, so training sees exactly what the detector
 * will see.
 */

const CHUNK = 1280;
const MEL_CONTEXT = 480;
const MEL_WINDOW = 76;
const MEL_BANDS = 32;
const MEL_MAX = 970;
export const EMB = 96;
export const WINDOW = 16;
export const FEATURE_DIM = WINDOW * EMB;

export const BASE_DIR = path.join(DATA, 'base');
const BASE_URL = 'https://github.com/dscripka/openWakeWord/releases/download/v0.5.1';

/** openWakeWord's two shared models (downloaded the first time). */
export async function ensureBaseModels() {
  fs.mkdirSync(BASE_DIR, { recursive: true });
  for (const f of ['melspectrogram.onnx', 'embedding_model.onnx']) {
    const file = path.join(BASE_DIR, f);
    if (fs.existsSync(file)) continue;
    const res = await fetch(`${BASE_URL}/${f}`);
    if (!res.ok) throw new Error(`could not download ${f}: HTTP ${res.status}`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
}

export class OwwFeatures {
  #mel: ort.InferenceSession;
  #emb: ort.InferenceSession;
  #pending: number[] = [];
  #raw = new Float32Array(0);
  #melRows: Float32Array[] = Array.from({ length: MEL_WINDOW }, () => new Float32Array(MEL_BANDS).fill(1));
  #feats: Float32Array[] = [];

  private constructor(mel: ort.InferenceSession, emb: ort.InferenceSession) {
    this.#mel = mel;
    this.#emb = emb;
  }

  static async create(threads = 1): Promise<OwwFeatures> {
    await ensureBaseModels();
    const opts: ort.InferenceSession.SessionOptions = { intraOpNumThreads: threads, interOpNumThreads: 1, graphOptimizationLevel: 'all' };
    const [mel, emb] = await Promise.all([
      ort.InferenceSession.create(path.join(BASE_DIR, 'melspectrogram.onnx'), opts),
      ort.InferenceSession.create(path.join(BASE_DIR, 'embedding_model.onnx'), opts),
    ]);
    const f = new OwwFeatures(mel, emb);
    // Like the library: start with features of noise.
    const noise = new Float32Array(16000 * 4).map(() => Math.round(Math.random() * 2000 - 1000) / 32767);
    await f.push(noise, () => {});
    return f;
  }

  /**
   * Audio at 16 kHz (−1…1). For each completed 80 ms chunk it calls `onFrame` with the window
   * of the last 16 features (what the wake word model would see at that moment).
   */
  async push(samples: Float32Array, onFrame: (window: () => Float32Array) => void) {
    for (const s of samples) this.#pending.push(s * 32767);
    while (this.#pending.length >= CHUNK) {
      const chunk = Float32Array.from(this.#pending.splice(0, CHUNK), (v) => Math.trunc(Math.max(-32768, Math.min(32767, v))));
      await this.#step(chunk);
      onFrame(() => this.window());
    }
  }

  window(): Float32Array {
    const x = new Float32Array(FEATURE_DIM);
    this.#feats.slice(-WINDOW).forEach((f, i) => x.set(f, i * EMB));
    return x;
  }

  async #step(chunk: Float32Array) {
    const keep = Math.min(this.#raw.length, MEL_CONTEXT);
    const input = new Float32Array(keep + chunk.length);
    input.set(this.#raw.subarray(this.#raw.length - keep), 0);
    input.set(chunk, keep);
    this.#raw = input.slice(-MEL_CONTEXT);

    const melOut = await this.#mel.run({ [this.#mel.inputNames[0]]: new ort.Tensor('float32', input, [1, input.length]) });
    const spec = melOut[this.#mel.outputNames[0]].data as Float32Array;
    for (let r = 0; r + MEL_BANDS <= spec.length; r += MEL_BANDS) this.#melRows.push(spec.slice(r, r + MEL_BANDS).map((v) => v / 10 + 2));
    if (this.#melRows.length > MEL_MAX) this.#melRows.splice(0, this.#melRows.length - MEL_MAX);

    const win = new Float32Array(MEL_WINDOW * MEL_BANDS);
    this.#melRows.slice(-MEL_WINDOW).forEach((row, i) => win.set(row, i * MEL_BANDS));
    const embOut = await this.#emb.run({ [this.#emb.inputNames[0]]: new ort.Tensor('float32', win, [1, MEL_WINDOW, MEL_BANDS, 1]) });
    this.#feats.push((embOut[this.#emb.outputNames[0]].data as Float32Array).slice(0, EMB));
    if (this.#feats.length > 120) this.#feats.splice(0, this.#feats.length - 120);
  }
}
