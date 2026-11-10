import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { NAME_RE, type WordConfig } from './catalog.ts';

export type { VoiceSpec, WordConfig } from './catalog.ts';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const DATA = path.join(ROOT, 'data');
export const OUT = path.join(ROOT, 'out');
export const CONFIGS = path.join(ROOT, 'configs');

// ───────── Headless browser ─────────

/** System libraries downloaded by `npm run setup` when Chromium cannot start (Linux, no admin rights). */
export const SYSLIBS = path.join(DATA, 'syslibs');

/** Environment for launching Chromium: adds data/syslibs to LD_LIBRARY_PATH if it is there. */
export function browserEnv(): Record<string, string> | undefined {
  const dirs = ['usr/lib/x86_64-linux-gnu', 'usr/lib/aarch64-linux-gnu', 'lib/x86_64-linux-gnu', 'lib/aarch64-linux-gnu', 'usr/lib']
    .map((d) => path.join(SYSLIBS, d))
    .filter((d) => fs.existsSync(d));
  if (!dirs.length) return undefined;
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  return { ...env, LD_LIBRARY_PATH: [...dirs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') };
}

// ───────── Wake word config ─────────

/** `--config configs/x.json` (required). */
export function loadConfig(argv = process.argv): { config: WordConfig; file: string } {
  const i = argv.indexOf('--config');
  if (i < 0 || !argv[i + 1]) {
    const available = fs.existsSync(CONFIGS) ? fs.readdirSync(CONFIGS).filter((f) => f.endsWith('.json')) : [];
    throw new Error(`Missing --config <file>.${available.length ? ` Available: ${available.map((f) => `configs/${f}`).join(', ')}` : ' Create one with `npm start` or copy configs/examples/hey-nova.json.'}`);
  }
  const file = path.resolve(argv[i + 1]);
  const config = JSON.parse(fs.readFileSync(file, 'utf8')) as WordConfig;
  const errors = validateConfig(config);
  if (errors.length) throw new Error(`${file}:\n  - ${errors.join('\n  - ')}`);
  return { config, file };
}

export function validateConfig(c: WordConfig): string[] {
  const errors: string[] = [];
  if (!c || typeof c !== 'object') return ['config is not an object'];
  if (!NAME_RE.test(c.name ?? '')) errors.push('`name` must be lowercase letters, digits and underscores (e.g. "hey_nova")');
  for (const key of ['positive', 'adversarial', 'sentences'] as const) {
    if (!c[key] || typeof c[key] !== 'object') errors.push(`\`${key}\` must be an object of { language: [phrases] }`);
  }
  if (!Array.isArray(c.voices)) errors.push('`voices` must be a list');
  else for (const v of c.voices) if (!v.id || !(v.speakers >= 1)) errors.push(`voice ${JSON.stringify(v.id)}: needs an id and speakers ≥ 1`);
  if (!Array.isArray(c.holdoutVoices)) errors.push('`holdoutVoices` must be a list (can be empty)');
  if (c.positive && !Object.values(c.positive).some((l) => l?.length)) errors.push('no positive phrases (how the wake word is written)');
  return errors;
}

export const wordDir = (c: WordConfig | string) => path.join(DATA, typeof c === 'string' ? c : c.name);
export const langOf = (voice: string) => voice.slice(0, 2);

/** Where your own recordings live: `pos/*.wav` (the wake word) and `neg/*.wav` (anything else). */
export function recordingsPath(c: WordConfig): string {
  return c.recordings ? path.resolve(ROOT, c.recordings) : path.join(wordDir(c), 'recordings');
}
export function recordingsDir(c: WordConfig): string | null {
  const dir = recordingsPath(c);
  return fs.existsSync(dir) ? dir : null;
}

/** How many clips `generate` will produce for this config. */
export function expectedClips(c: WordConfig): Record<'pos' | 'adv' | 'sent', number> {
  const out = { pos: 0, adv: 0, sent: 0 };
  for (const v of c.voices) {
    const lang = langOf(v.id);
    if (c.positive[lang]?.length) out.pos += v.pos;
    if (c.adversarial[lang]?.length) out.adv += v.adv;
    if (c.sentences[lang]?.length) out.sent += v.sent;
  }
  return out;
}

/** Fingerprint of everything that changes the generated audio (to tell when it is out of date). */
export function generationHash(c: WordConfig): string {
  const relevant = { positive: c.positive, adversarial: c.adversarial, sentences: c.sentences, voices: c.voices };
  return crypto.createHash('sha1').update(JSON.stringify(relevant)).digest('hex').slice(0, 12);
}

// ───────── Seeded randomness (so every run comes out the same) ─────────

export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  const next = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
  return {
    next,
    range: (a: number, b: number) => a + (b - a) * next(),
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)],
    normal: () => Math.sqrt(-2 * Math.log(next() || 1e-12)) * Math.cos(2 * Math.PI * next()),
  };
}
export type Rng = ReturnType<typeof rng>;

export function hash(s: string) {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

// ───────── WAV ─────────

/** 16-bit PCM WAV (mono or stereo, mixed down to mono) → samples in −1…1 and the sample rate. */
export function parseWav(b: Buffer, name = 'audio'): { samples: Float32Array; rate: number } {
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${name}: not a WAV file`);
  let o = 12;
  let rate = 16000;
  let channels = 1;
  let bits = 16;
  let format = 1;
  while (o + 8 <= b.length) {
    const id = b.toString('ascii', o, o + 4);
    const size = b.readUInt32LE(o + 4);
    if (id === 'fmt ') {
      format = b.readUInt16LE(o + 8);
      channels = b.readUInt16LE(o + 10);
      rate = b.readUInt32LE(o + 12);
      bits = b.readUInt16LE(o + 22);
    } else if (id === 'data') {
      if (format === 3 && bits === 32) {
        const n = Math.floor(Math.min(size, b.length - o - 8) / 4 / channels);
        const out = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          let v = 0;
          for (let c = 0; c < channels; c++) v += b.readFloatLE(o + 8 + (i * channels + c) * 4);
          out[i] = v / channels;
        }
        return { samples: out, rate };
      }
      if (bits !== 16) throw new Error(`${name}: only 16-bit PCM or 32-bit float WAV is supported`);
      const n = Math.floor(Math.min(size, b.length - o - 8) / 2 / channels);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let v = 0;
        for (let c = 0; c < channels; c++) v += b.readInt16LE(o + 8 + (i * channels + c) * 2);
        out[i] = v / channels / 32768;
      }
      return { samples: out, rate };
    }
    o += 8 + size + (size % 2);
  }
  throw new Error(`${name}: WAV without data`);
}

export const readWav = (file: string) => parseWav(fs.readFileSync(file), file);

export function encodeWav(samples: Float32Array, rate = 16000): Buffer {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + samples.length * 2, 4);
  b.write('WAVEfmt ', 8, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  return b;
}

export function writeWav(file: string, samples: Float32Array, rate = 16000) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodeWav(samples, rate));
}

/** Linear resampling (good enough for 16 kHz speech; also used to shift pitch). */
export function resample(x: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return x;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(x.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const p = i * ratio;
    const i0 = Math.floor(p);
    const f = p - i0;
    out[i] = x[i0] * (1 - f) + (x[Math.min(x.length - 1, i0 + 1)] ?? 0) * f;
  }
  return out;
}

/** WAV at 16 kHz, with the silence at both ends trimmed. */
export function loadClip16k(file: string): Float32Array {
  const { samples, rate } = readWav(file);
  return trimSilence(resample(samples, rate, 16000));
}

export function trimSilence(x: Float32Array, threshold = 0.01): Float32Array {
  const win = 160;
  const loud = (i: number) => {
    let e = 0;
    for (let j = i; j < Math.min(x.length, i + win); j++) e += x[j] * x[j];
    return Math.sqrt(e / win) > threshold;
  };
  let a = 0;
  while (a < x.length && !loud(a)) a += win;
  let b = x.length - win;
  while (b > a && !loud(b)) b -= win;
  // Keep a little margin on each side.
  return x.slice(Math.max(0, a - 800), Math.min(x.length, b + win + 1600));
}

export const rms = (x: Float32Array) => {
  let e = 0;
  for (const v of x) e += v * v;
  return Math.sqrt(e / Math.max(1, x.length));
};

// ───────── Output ─────────

export function log(...args: unknown[]) {
  console.log(`[${new Date().toLocaleTimeString('en-GB')}]`, ...args);
}

/** Simple `--name value` command-line options. */
export function arg(name: string, def: string): string;
export function arg(name: string): string | undefined;
export function arg(name: string, def?: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}

/**
 * Machine-readable progress for the web app (it runs the steps with WAKEWORD_UI=1 and reads
 * these lines). On the command line it prints nothing: the regular logs are enough.
 */
let lastProgress = 0;
export function progress(done: number, total: number, label?: string) {
  if (!process.env.WAKEWORD_UI) return;
  const now = Date.now();
  if (done < total && now - lastProgress < 400) return;
  lastProgress = now;
  process.stdout.write(`::progress::${JSON.stringify({ done, total, label })}\n`);
}
