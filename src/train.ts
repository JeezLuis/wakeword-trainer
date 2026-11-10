/**
 * Step 3: train, evaluate and export.
 *
 *   npm run train -- --config configs/x.json [--steps 10000] [--hidden 64,32] [--neg-weight 30]
 *
 * A small network (like openWakeWord's) on the feature windows from `npm run features`, plus
 * pre-computed features of ~170 h of varied audio (ACAV100M) as negatives. It is evaluated on
 * what it has not seen: a whole held-out voice, held-out recordings of yours, test music and
 * openWakeWord's 11 h validation set (false alarms per hour).
 *
 * Writes out/<name>.onnx and out/<name>.report.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as ort from 'onnxruntime-node';
import { DATA, OUT, arg, loadConfig, log, progress, rng, wordDir } from './common.ts';
import { exportOnnx, type Dense } from './onnx-export.ts';
import { EMB, FEATURE_DIM, WINDOW } from './oww.ts';

// ───────── Data ─────────

/** Feature windows in Float16, one after the other. */
class Rows {
  data: Float16Array;
  n: number;
  constructor(data: Float16Array, dim = FEATURE_DIM) {
    this.data = data;
    this.n = Math.floor(data.length / dim);
  }
  static file(f: string): Rows {
    if (!fs.existsSync(f)) return new Rows(new Float16Array(0));
    const b = fs.readFileSync(f);
    return new Rows(new Float16Array(b.buffer, b.byteOffset, b.byteLength / 2));
  }
  copy(i: number, out: Float32Array, at: number) {
    const o = i * FEATURE_DIM;
    for (let k = 0; k < FEATURE_DIM; k++) out[at + k] = this.data[o + k];
  }
}

/** numpy .npy: header + data (openWakeWord's, float16 or float32). */
function npy(file: string): { dtype: string; shape: number[]; data: Buffer } | null {
  if (!fs.existsSync(file)) return null;
  const b = fs.readFileSync(file);
  // \x93NUMPY, version (byte 6), and the header length: 2 bytes (v1) or 4 (v2 and v3).
  const major = b.readUInt8(6);
  const start = major === 1 ? 10 : 12;
  const hlen = start + (major === 1 ? b.readUInt16LE(8) : b.readUInt32LE(8));
  const header = b.toString('latin1', start, hlen);
  const dtype = header.match(/'descr': '([^']+)'/)?.[1] ?? '';
  const shape = (header.match(/'shape': \(([^)]*)\)/)?.[1] ?? '').split(',').filter((s) => s.trim()).map(Number);
  return { dtype, shape, data: b.subarray(hlen) };
}

// ───────── Network ─────────

class Net {
  layers: (Dense & { mw: Float32Array; vw: Float32Array; mb: Float32Array; vb: Float32Array })[];
  t = 0;
  constructor(dims: number[], seed: number) {
    const r = rng(seed);
    this.layers = [];
    for (let i = 0; i + 1 < dims.length; i++) {
      const [a, b] = [dims[i], dims[i + 1]];
      const s = Math.sqrt(2 / a);
      this.layers.push({
        inDim: a,
        outDim: b,
        w: Float32Array.from({ length: a * b }, () => r.normal() * s),
        b: new Float32Array(b),
        mw: new Float32Array(a * b),
        vw: new Float32Array(a * b),
        mb: new Float32Array(b),
        vb: new Float32Array(b),
      });
    }
  }

  /** Returns the activations of every layer (the last one before the sigmoid). */
  forward(x: Float32Array, n: number): Float32Array[] {
    const acts = [x];
    let cur = x;
    this.layers.forEach((l, li) => {
      const out = new Float32Array(n * l.outDim);
      for (let s = 0; s < n; s++) {
        const o = out.subarray(s * l.outDim, (s + 1) * l.outDim);
        o.set(l.b);
        const xi = s * l.inDim;
        for (let i = 0; i < l.inDim; i++) {
          const v = cur[xi + i];
          if (v === 0) continue;
          const wr = i * l.outDim;
          for (let j = 0; j < l.outDim; j++) o[j] += v * l.w[wr + j];
        }
        if (li < this.layers.length - 1) for (let j = 0; j < l.outDim; j++) if (o[j] < 0) o[j] = 0;
      }
      acts.push(out);
      cur = out;
    });
    return acts;
  }

  predict(x: Float32Array, n: number): Float32Array {
    const z = this.forward(x, n).at(-1)!;
    return z.map((v) => 1 / (1 + Math.exp(-v)));
  }

  /** One Adam step with weighted logistic loss. Returns the mean loss. */
  step(x: Float32Array, y: Float32Array, wt: Float32Array, n: number, lr: number, decay = 1e-4): number {
    const acts = this.forward(x, n);
    const z = acts.at(-1)!;
    let loss = 0;
    let wsum = 0;
    let delta = new Float32Array(n);
    for (let s = 0; s < n; s++) {
      const p = 1 / (1 + Math.exp(-z[s]));
      loss += wt[s] * -(y[s] * Math.log(p + 1e-7) + (1 - y[s]) * Math.log(1 - p + 1e-7));
      wsum += wt[s];
      delta[s] = wt[s] * (p - y[s]);
    }
    for (let s = 0; s < n; s++) delta[s] /= wsum;
    this.t++;
    const b1 = 0.9,
      b2 = 0.999;
    const c1 = 1 - b1 ** this.t,
      c2 = 1 - b2 ** this.t;
    for (let li = this.layers.length - 1; li >= 0; li--) {
      const l = this.layers[li];
      const a = acts[li];
      const gw = new Float32Array(l.inDim * l.outDim);
      const gb = new Float32Array(l.outDim);
      const prev = li > 0 ? new Float32Array(n * l.inDim) : null;
      for (let s = 0; s < n; s++) {
        const d = delta.subarray(s * l.outDim, (s + 1) * l.outDim);
        for (let j = 0; j < l.outDim; j++) gb[j] += d[j];
        const ai = s * l.inDim;
        for (let i = 0; i < l.inDim; i++) {
          const v = a[ai + i];
          const wr = i * l.outDim;
          if (v !== 0) for (let j = 0; j < l.outDim; j++) gw[wr + j] += v * d[j];
          if (prev && v > 0) {
            let acc = 0;
            for (let j = 0; j < l.outDim; j++) acc += l.w[wr + j] * d[j];
            prev[ai + i] = acc;
          }
        }
      }
      const upd = (w: Float32Array, g: Float32Array, m: Float32Array, v: Float32Array, wd: number) => {
        for (let k = 0; k < w.length; k++) {
          const gk = g[k] + wd * w[k];
          m[k] = b1 * m[k] + (1 - b1) * gk;
          v[k] = b2 * v[k] + (1 - b2) * gk * gk;
          w[k] -= (lr * (m[k] / c1)) / (Math.sqrt(v[k] / c2) + 1e-8);
        }
      };
      upd(l.w, gw, l.mw, l.vw, decay);
      upd(l.b, gb, l.mb, l.vb, 0);
      if (prev) delta = prev;
    }
    return loss / wsum;
  }
}

// ───────── Evaluation ─────────

function scores(net: Net, rows: Rows, limit = Infinity): Float32Array {
  const n = Math.min(rows.n, limit);
  const out = new Float32Array(n);
  const B = 256;
  const x = new Float32Array(B * FEATURE_DIM);
  for (let s = 0; s < n; s += B) {
    const m = Math.min(B, n - s);
    for (let k = 0; k < m; k++) rows.copy(s + k, x, k * FEATURE_DIM);
    out.set(net.predict(x, m).subarray(0, m), s);
  }
  return out;
}

/** Activations in a continuous sequence (with a 2 s cooldown between them, like a typical detector). */
function activations(sc: Float32Array, thr: number): number {
  let n = 0;
  let last = -1e9;
  for (let i = 0; i < sc.length; i++) {
    if (sc[i] >= thr && i - last > 25) {
      n++;
      last = i;
    }
  }
  return n;
}

/** openWakeWord's 11 h validation set: consecutive features (N × 96) → windows of 16. */
function validationScores(net: Net): Float32Array | null {
  const v = npy(path.join(DATA, 'download', 'validation_set_features.npy'));
  if (!v || v.dtype !== '<f4') return null;
  const frames = new Float32Array(v.data.buffer, v.data.byteOffset, v.data.byteLength / 4);
  const n = v.shape[0] - WINDOW + 1;
  const out = new Float32Array(n);
  const B = 256;
  const x = new Float32Array(B * FEATURE_DIM);
  for (let s = 0; s < n; s += B) {
    const m = Math.min(B, n - s);
    for (let k = 0; k < m; k++) x.set(frames.subarray((s + k) * EMB, (s + k + WINDOW) * EMB), k * FEATURE_DIM);
    out.set(net.predict(x, m).subarray(0, m), s);
  }
  return out;
}

// ───────── Main ─────────

async function main() {
  const { config } = loadConfig();
  const dir = path.join(wordDir(config), 'features');
  const steps = Number(arg('steps', '10000'));
  const hidden = arg('hidden', '64,32').split(',').map(Number);
  const negWeight = Number(arg('neg-weight', '30'));

  const trainPos = Rows.file(path.join(dir, 'train_pos.f16'));
  const trainUser = Rows.file(path.join(dir, 'train_pos_user.f16'));
  const trainNeg = Rows.file(path.join(dir, 'train_neg.f16'));
  const testPos = Rows.file(path.join(dir, 'test_pos.f16'));
  const testSpeech = Rows.file(path.join(dir, 'test_neg_speech.f16'));
  const testMusic = Rows.file(path.join(dir, 'test_neg_music.f16'));
  const acavNpy = npy(path.join(DATA, 'download', 'acav_part.npy'));
  const acav = acavNpy && acavNpy.dtype === '<f2' ? new Rows(new Float16Array(acavNpy.data.buffer, acavNpy.data.byteOffset, Math.floor(acavNpy.data.byteLength / 2))) : new Rows(new Float16Array(0));
  log(`windows: train ${trainPos.n} positive (+${trainUser.n} yours) / ${trainNeg.n} negative + ${acav.n} from ACAV100M; test ${testPos.n} positive, ${testSpeech.n} of speech, ${testMusic.n} of music`);
  if (!trainPos.n || !trainNeg.n) throw new Error('Features missing: run `npm run features` first.');
  if (!acav.n) log('(no ACAV100M features in data/download: training without them gives more false alarms; see `npm run setup`)');

  const net = new Net([FEATURE_DIM, ...hidden, 1], 42);
  const r = rng(1234);
  const B = 384;
  const nPos = 96;
  const x = new Float32Array(B * FEATURE_DIM);
  const y = new Float32Array(B);
  const wt = new Float32Array(B);
  const t0 = Date.now();
  let avg = 0;
  // Hard negatives: every so often, find the ones that fool the model the most and practise
  // them more (what lowers false alarms the most).
  let hard: [Rows, number][] = [];
  const mineHard = () => {
    const pool: [Rows, number][] = [];
    for (let i = 0; i < 150_000; i++) {
      const src = acav.n && r.next() < 0.5 ? acav : trainNeg;
      pool.push([src, r.int(src.n)]);
    }
    const sc = new Float32Array(pool.length);
    const MB = 256;
    const xb = new Float32Array(MB * FEATURE_DIM);
    for (let s = 0; s < pool.length; s += MB) {
      const m = Math.min(MB, pool.length - s);
      for (let k = 0; k < m; k++) pool[s + k][0].copy(pool[s + k][1], xb, k * FEATURE_DIM);
      sc.set(net.predict(xb, m).subarray(0, m), s);
    }
    const order = Array.from(sc.keys()).sort((a, b) => sc[b] - sc[a]);
    hard = order.slice(0, 15_000).map((i) => pool[i]);
    log(`  hard negatives: the worst scores ${sc[order[0]].toFixed(3)}, the 15,000th ${sc[order[14_999]].toFixed(3)}`);
  };

  for (let step = 1; step <= steps; step++) {
    if (step >= 1500 && step % 1500 === 0) mineHard();
    // Each batch: a quarter positives and the rest negatives (ours, ACAV's and, once there are
    // some, hard ones). The penalty for false alarms rises gradually.
    const nw = 1 + (negWeight - 1) * Math.min(1, step / (steps * 0.4));
    for (let k = 0; k < B; k++) {
      if (k < nPos) {
        // 30 % of the positives from your recordings: few, but they are your voice and your microphone.
        const src = trainUser.n && k < nPos * 0.3 ? trainUser : trainPos;
        src.copy(r.int(src.n), x, k * FEATURE_DIM);
        y[k] = 1;
        wt[k] = 1;
      } else {
        const p = r.next();
        if (hard.length && p < 0.35) {
          const [src, i] = hard[r.int(hard.length)];
          src.copy(i, x, k * FEATURE_DIM);
        } else {
          const src = acav.n && r.next() < 0.5 ? acav : trainNeg;
          src.copy(r.int(src.n), x, k * FEATURE_DIM);
        }
        y[k] = 0;
        wt[k] = nw;
      }
    }
    const lr = 5e-5 + 0.5 * (1e-3 - 5e-5) * (1 + Math.cos((Math.PI * step) / steps));
    const loss = net.step(x, y, wt, B, lr);
    avg = step === 1 ? loss : 0.98 * avg + 0.02 * loss;
    progress(step, steps);
    if (step % 500 === 0 || step === steps) {
      const sp = scores(net, testPos, 3000);
      const sm = scores(net, testMusic, 20000);
      const rec = sp.filter((v) => v >= 0.5).length / Math.max(1, sp.length);
      const fp = sm.filter((v) => v >= 0.5).length / Math.max(1, sm.length);
      log(
        `step ${step}/${steps} · loss ${avg.toFixed(4)} · recall ${(rec * 100).toFixed(1)} % · music >0.5 in ${(fp * 100).toFixed(2)} % of windows · ${Math.round((Date.now() - t0) / 1000)} s`,
      );
    }
  }

  // Final evaluation with everything held out.
  log('evaluating…');
  const sp = scores(net, testPos);
  const ss = scores(net, testSpeech);
  const sm = scores(net, testMusic);
  const sv = validationScores(net);
  const hours = (n: number) => (n * 0.08) / 3600;
  // Recall per phrase: it fires if any window at the end of the phrase is above the threshold (like a real detector).
  const idsBuf = fs.existsSync(path.join(dir, 'test_pos.ids')) ? fs.readFileSync(path.join(dir, 'test_pos.ids')) : null;
  const ids = idsBuf ? new Uint32Array(idsBuf.buffer, idsBuf.byteOffset, idsBuf.byteLength / 4) : null;
  const episodeMax = new Map<number, { max: number; user: boolean }>();
  if (ids && ids.length === sp.length * 2) {
    for (let i = 0; i < sp.length; i++) {
      const e = episodeMax.get(ids[2 * i]) ?? { max: 0, user: ids[2 * i + 1] === 1 };
      e.max = Math.max(e.max, sp[i]);
      episodeMax.set(ids[2 * i], e);
    }
  }
  const recall = (thr: number, user: boolean) => {
    const eps = [...episodeMax.values()].filter((e) => e.user === user);
    return eps.length ? +(eps.filter((e) => e.max >= thr).length / eps.length).toFixed(3) : null;
  };
  const report: Record<string, unknown>[] = [];
  for (const thr of [0.3, 0.5, 0.7, 0.8, 0.9, 0.95]) {
    const row = {
      threshold: thr,
      recallYourVoice: recall(thr, true),
      recallHeldOutVoice: recall(thr, false),
      falseAlarmsPerHourMusic: sm.length ? +(activations(sm, thr) / hours(sm.length)).toFixed(2) : null,
      falseAlarmsPerHourValidation: sv ? +(activations(sv, thr) / hours(sv.length)).toFixed(2) : null,
      falseAlarmsHeldOutSpeech: activations(ss, thr),
    };
    report.push(row);
  }
  console.table(report);
  const evaluation = {
    yourPhrases: [...episodeMax.values()].filter((e) => e.user).length,
    heldOutPhrases: [...episodeMax.values()].filter((e) => !e.user).length,
    musicHours: +hours(sm.length).toFixed(2),
    validationHours: sv ? +hours(sv.length).toFixed(1) : null,
    heldOutSpeechHours: +hours(ss.length).toFixed(2),
  };
  log(
    `(${evaluation.yourPhrases} phrases of yours and ${evaluation.heldOutPhrases} of the held-out voice, on random backgrounds; test music ${evaluation.musicHours} h, validation ${evaluation.validationHours ?? '—'} h, other speech of the held-out voice ${evaluation.heldOutSpeechHours} h)`,
  );

  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `${config.name}.onnx`);
  exportOnnx(file, net.layers, config.name);

  // Check: the .onnx gives the same output as the network in memory.
  const sess = await ort.InferenceSession.create(file);
  const probe = testPos.n ? testPos : trainPos;
  const k = Math.min(64, probe.n);
  const xs = new Float32Array(k * FEATURE_DIM);
  for (let i = 0; i < k; i++) probe.copy(i, xs, i * FEATURE_DIM);
  const res = await sess.run({ input: new ort.Tensor('float32', xs, [k, WINDOW, EMB]) });
  const onnxOut = res.output.data as Float32Array;
  const mine = net.predict(xs, k);
  const diff = Math.max(...Array.from(onnxOut, (v, i) => Math.abs(v - mine[i])));
  log(`exported ${path.relative(process.cwd(), file)} (${(fs.statSync(file).size / 1024).toFixed(0)} KB) · ONNX/JS difference ${diff.toExponential(1)}`);
  fs.writeFileSync(
    path.join(OUT, `${config.name}.report.json`),
    JSON.stringify({ name: config.name, phrase: config.phrase, hidden, steps, negWeight, data: { trainPos: trainPos.n, trainUser: trainUser.n, trainNeg: trainNeg.n, acav: acav.n }, evaluation, report, createdAt: new Date().toISOString() }, null, 2),
  );
}

await main();
