/**
 * Step 2: from audio clips to labelled features.
 *
 *   npm run features -- --config configs/x.json [--workers 12] [--limit N (trial run)]
 *
 * Builds "episodes" of continuous audio (background, the phrase on top, more background) with
 * data augmentation (music, noise, room echo, filters, pitch, volume) and streams them through
 * the openWakeWord pipeline. Every 80 ms a window of features (16 × 96) comes out, labelled:
 *
 *   positive  the phrase has just ended (what it must detect)
 *   negative  background only, or any other phrase (what it must never detect)
 *   (the moments in the middle of the phrase are not used)
 *
 * Output in data/<name>/features/: train_pos, train_pos_user (your recordings), train_neg,
 * test_pos, test_neg_speech, test_neg_music (Float16, FEATURE_DIM per window) and meta.json.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { DATA, arg, loadClip16k, loadConfig, log, progress, recordingsDir, rng, wordDir, type Rng } from './common.ts';
import { highpass, level, lowpass, mixAt, noise, pitch, readMusic, reverb, segment } from './audio.ts';
import { FEATURE_DIM, OwwFeatures, ensureBaseModels } from './oww.ts';

type Set = 'train' | 'test';
type Episode =
  | { kind: 'pos'; file: string; set: Set; synthetic: boolean; seed: number }
  | { kind: 'speech'; file: string; set: Set; synthetic: boolean; seed: number }
  | { kind: 'music'; file: string; set: Set; seed: number };
type Out = 'train_pos' | 'train_pos_user' | 'train_neg' | 'test_pos' | 'test_neg_speech' | 'test_neg_music';
const OUTS: Out[] = ['train_pos', 'train_pos_user', 'train_neg', 'test_pos', 'test_neg_speech', 'test_neg_music'];

const GTZAN = path.join(DATA, 'gtzan', 'genres');
const SR = 16000;
const HOP = 1280;

// ───────── Plan (main thread) ─────────

function listWav(dir: string): string[] {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.wav') && !f.startsWith('.')).sort().map((f) => path.join(dir, f)) : [];
}

function plan(): { episodes: Episode[]; music: Record<Set, string[]>; babble: Record<Set, string[]> } {
  const { config } = loadConfig();
  const tts = path.join(wordDir(config), 'tts');
  const holdout = (f: string) => config.holdoutVoices.some((v) => path.basename(f).startsWith(`${v}__`));
  const r = rng(7);
  const episodes: Episode[] = [];
  const add = (kind: 'pos' | 'speech', files: string[], synthetic: boolean, trainAug: number, testAug: number, testFraction = 0) => {
    for (const f of files) {
      const set: Set = (synthetic ? holdout(f) : r.next() < testFraction) ? 'test' : 'train';
      for (let i = 0; i < (set === 'train' ? trainAug : testAug); i++) episodes.push({ kind, file: f, set, synthetic, seed: r.int(2 ** 31) });
    }
  };

  add('pos', listWav(path.join(tts, 'pos')), true, 3, 2);
  add('speech', listWav(path.join(tts, 'adv')), true, 2, 1);
  add('speech', listWav(path.join(tts, 'sent')), true, 1, 1);

  // Your recordings weigh more: your voice and your microphone. One in five is kept for testing.
  const rec = recordingsDir(config);
  const userPos = rec ? listWav(path.join(rec, 'pos')) : [];
  const userNeg = rec ? listWav(path.join(rec, 'neg')) : [];
  add('pos', userPos, false, 25, 5, 0.2);
  add('speech', userNeg, false, 6, 3, 0.2);
  log(`your recordings: ${userPos.length} of the wake word, ${userNeg.length} other phrases${rec ? '' : ' (no recordings folder)'}`);

  // Music: from each genre, the first 90 songs for training and the last 10 for testing.
  const music: Record<Set, string[]> = { train: [], test: [] };
  for (const genre of fs.existsSync(GTZAN) ? fs.readdirSync(GTZAN).filter((g) => fs.statSync(path.join(GTZAN, g)).isDirectory()).sort() : []) {
    for (const f of fs.readdirSync(path.join(GTZAN, genre)).filter((x) => /^[^.].*\.(au|wav)$/.test(x)).sort()) {
      const n = Number(f.match(/(\d+)\.(au|wav)$/)?.[1] ?? 0);
      const set: Set = n >= 90 ? 'test' : 'train';
      music[set].push(path.join(GTZAN, genre, f));
      episodes.push({ kind: 'music', file: path.join(GTZAN, genre, f), set, seed: r.int(2 ** 31) });
    }
  }
  if (!music.train.length) throw new Error(`No music in ${GTZAN}: download GTZAN first (npm run setup).`);

  // Background voices (people talking) to mix in: the synthetic phrases that are not the wake word.
  const babbleAll = [...listWav(path.join(tts, 'sent')), ...listWav(path.join(tts, 'adv'))];
  const babble = { train: babbleAll.filter((f) => !holdout(f)), test: babbleAll.filter(holdout) };

  // Shuffled, so every thread gets a bit of everything.
  for (let i = episodes.length - 1; i > 0; i--) {
    const j = r.int(i + 1);
    [episodes[i], episodes[j]] = [episodes[j], episodes[i]];
  }
  return { episodes, music, babble };
}

async function main() {
  const { config } = loadConfig();
  await ensureBaseModels();
  const planned = plan();
  const { music, babble } = planned;
  const limit = arg('limit');
  const episodes = limit ? planned.episodes.slice(0, Number(limit)) : planned.episodes;
  if (!episodes.some((e) => e.kind === 'pos')) throw new Error('No clips of the wake word: run `npm run generate` first.');
  const nWorkers = Number(arg('workers', String(Math.max(1, os.cpus().length - 2))));
  const count = (k: string, s: Set) => episodes.filter((e) => e.kind === k && e.set === s).length;
  log(
    `${episodes.length} episodes: wake word ${count('pos', 'train')}+${count('pos', 'test')}, other speech ${count('speech', 'train')}+${count('speech', 'test')}, music ${count('music', 'train')}+${count('music', 'test')} (train+test), on ${nWorkers} threads`,
  );

  const outDir = path.join(wordDir(config), 'features');
  fs.mkdirSync(outDir, { recursive: true });
  const streams = Object.fromEntries(OUTS.map((o) => [o, fs.openSync(path.join(outDir, `${o}.f16`), 'w')])) as Record<Out, number>;
  const counts = Object.fromEntries(OUTS.map((o) => [o, 0])) as Record<Out, number>;
  const idsFile = fs.openSync(path.join(outDir, 'test_pos.ids'), 'w'); // [episode, is yours] per window
  const t0 = Date.now();
  let done = 0;

  await Promise.all(
    Array.from({ length: nWorkers }, (_, w) => {
      const mine = episodes.filter((_, i) => i % nWorkers === w);
      return new Promise<void>((resolve, reject) => {
        const worker = new Worker(new URL(import.meta.url), { workerData: { episodes: mine, music, babble, seed: w + 1 } });
        worker.on('message', (m: { out: Out; data: Uint16Array; n: number; ids?: Uint32Array } | { progress: number }) => {
          if ('progress' in m) {
            done += m.progress;
            progress(done, episodes.length);
            if (done % 500 < m.progress) {
              const rate = done / ((Date.now() - t0) / 1000);
              log(`  ${done}/${episodes.length} episodes (~${Math.round((episodes.length - done) / rate / 60)} min left)`);
            }
            return;
          }
          fs.writeSync(streams[m.out], new Uint8Array(m.data.buffer, m.data.byteOffset, m.data.byteLength));
          if (m.ids) fs.writeSync(idsFile, new Uint8Array(m.ids.buffer, m.ids.byteOffset, m.ids.byteLength));
          counts[m.out] += m.n;
        });
        worker.on('error', reject);
        worker.on('exit', (code) => (code ? reject(new Error(`thread ${w} exited with ${code}`)) : resolve()));
      });
    }),
  );
  for (const o of OUTS) fs.closeSync(streams[o]);
  fs.closeSync(idsFile);
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify({ dim: FEATURE_DIM, dtype: 'float16', counts, createdAt: new Date().toISOString() }, null, 2));
  log(`done in ${Math.round((Date.now() - t0) / 1000)} s:`, counts);
}

// ───────── Each thread ─────────

async function work() {
  const { episodes, music, babble, seed } = workerData as { episodes: Episode[]; music: Record<Set, string[]>; babble: Record<Set, string[]>; seed: number };
  const r = rng(seed * 7919);
  const feats = await OwwFeatures.create(1);

  // Music backgrounds: a few songs per thread, loaded once (~2 MB each).
  const load = (files: string[], n: number) => {
    const out: Float32Array[] = [];
    for (let tries = 0; out.length < n && tries < n * 3; tries++) {
      try {
        out.push(readMusic(r.pick(files)));
      } catch {
        // GTZAN has a few broken files: pick another one.
      }
    }
    return out;
  };
  const bgMusic: Record<Set, Float32Array[]> = { train: load(music.train, 24), test: load(music.test, 8) };

  const buffers = Object.fromEntries(OUTS.map((o) => [o, [] as Float32Array[]])) as Record<Out, Float32Array[]>;
  // For each positive test window: which episode it belongs to and whether it is your voice (for per-phrase recall).
  let tags: number[] = [];
  const flush = (o: Out, force = false) => {
    const list = buffers[o];
    if (!list.length || (!force && list.length < 2000)) return;
    const data = new Uint16Array(list.length * FEATURE_DIM);
    const f16 = new Float16Array(data.buffer);
    list.forEach((x, i) => f16.set(x, i * FEATURE_DIM));
    const ids = o === 'test_pos' ? Uint32Array.from(tags) : undefined;
    if (o === 'test_pos') tags = [];
    parentPort!.postMessage({ out: o, data, n: list.length, ids }, ids ? [data.buffer, ids.buffer] : [data.buffer]);
    buffers[o] = [];
  };
  const emit = (o: Out, x: Float32Array, tag?: [number, number]) => {
    buffers[o].push(x);
    if (tag) tags.push(...tag);
    flush(o);
  };

  let frame = 0; // windows emitted since start-up (each one ends at (frame+1)·HOP)
  let cursor = 0; // samples sent since start-up
  const stream = async (audio: Float32Array, label: (endSample: number) => Out | null, every = 1) => {
    const start = cursor;
    cursor += audio.length;
    await feats.push(audio, (window) => {
      const end = (++frame) * HOP - start; // end of the window, relative to the start of this audio
      if (every > 1 && frame % every) return;
      const o = label(end);
      if (o) emit(o, window(), o === 'test_pos' ? tag : undefined);
    });
  };
  let tag: [number, number] = [0, 0];

  for (const ep of episodes) {
    try {
      if (ep.kind === 'music') {
        // Music alone: never the wake word. For testing, every window (false alarms per hour).
        const audio = readMusic(ep.file);
        level(audio, r.range(0.05, 0.9));
        await stream(audio, () => (ep.set === 'train' ? 'train_neg' : 'test_neg_music'), ep.set === 'train' ? 3 : 1);
      } else {
        const er = rng(ep.seed);
        const voice = augmentVoice(loadClip16k(ep.file), ep.synthetic, er);
        const pre = Math.round(er.range(1.4, 2.0) * SR);
        const post = Math.round(er.range(0.4, 0.7) * SR);
        const [audio, snr] = background(pre + voice.length + post, ep.set, er, bgMusic, babble);
        mixAt(audio, voice, pre, snr);
        level(audio, er.range(0.08, 0.9));
        // Real end of the voice (trimming leaves 0.1 s of margin at the end).
        const phraseEnd = pre + voice.length - 1600;
        if (ep.kind === 'pos') {
          tag = [ep.seed, ep.synthetic ? 0 : 1];
          const pos: Out = ep.set === 'test' ? 'test_pos' : ep.synthetic ? 'train_pos' : 'train_pos_user';
          await stream(audio, (end) => {
            if (end >= phraseEnd - 640 && end <= phraseEnd + 4000) return pos;
            // Before the phrase starts: background only (a hard negative: same background, no wake word).
            if (end <= pre && ep.set === 'train' && er.next() < 0.5) return 'train_neg';
            return null;
          });
        } else {
          await stream(audio, () => (ep.set === 'train' ? 'train_neg' : 'test_neg_speech'));
        }
      }
    } catch (err) {
      console.error(`  ✗ ${path.basename(ep.file)}: ${err instanceof Error ? err.message : err}`);
    }
    parentPort!.postMessage({ progress: 1 });
  }
  for (const o of OUTS) flush(o, true);
}

/** Voice variations: pitch and speed (more for synthetic voices), room echo and microphone. */
function augmentVoice(x: Float32Array, synthetic: boolean, r: Rng): Float32Array {
  let v = synthetic ? pitch(x, r.range(0.9, 1.1)) : pitch(x, r.range(0.96, 1.04));
  if (r.next() < 0.5) v = reverb(v, r.range(0.15, 0.7), r);
  if (r.next() < 0.4) v = lowpass(v, r.range(2500, 7000));
  if (r.next() < 0.3) v = highpass(v, r.range(80, 300));
  return v;
}

/**
 * Background and voice-to-background ratio (dB): music half of the time, from very loud (−3 dB)
 * to soft; otherwise noise, people talking or near silence.
 */
function background(len: number, set: Set, r: Rng, music: Record<Set, Float32Array[]>, babble: Record<Set, string[]>): [Float32Array, number] {
  const p = r.next();
  if (p < 0.5) return [segment(r.pick(music[set]), len, r), r.next() < 0.7 ? r.range(-3, 10) : r.range(10, 20)];
  if (p < 0.7) return [noise(r.pick(['white', 'pink', 'brown'] as const), len, r), r.range(0, 25)];
  if (p < 0.85 && babble[set].length) {
    const bg = new Float32Array(len);
    for (let at = 0; at < len; ) {
      const b = loadClip16k(r.pick(babble[set]));
      for (let i = 0; i < b.length && at + i < len; i++) bg[at + i] += b[i];
      at += b.length + Math.round(r.range(0, 0.3) * SR);
    }
    return [bg, r.range(3, 18)];
  }
  return [noise('pink', len, r), r.range(30, 45)];
}

if (isMainThread) await main();
else await work();

