/**
 * The web app: a local server that guides you through creating a wake word model.
 *
 *   npm start [-- --port 7700] [--host 127.0.0.1]
 *
 * Serves the interface (ui/, through Vite) and a small JSON API. Long steps (setup, generate,
 * features, train) run as child processes, one at a time; their logs and progress are streamed
 * to the browser. Closing the tab does not stop them; stopping this server does.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createVite } from 'vite';
import * as ort from 'onnxruntime-node';
import { onnxWasm, piperOptimizeDeps, piperTuning } from '../synth/plugins.ts';
import { NAME_RE, type WordConfig } from './catalog.ts';
import { CONFIGS, DATA, OUT, ROOT, arg, encodeWav, expectedClips, generationHash, parseWav, recordingsPath, resample, validateConfig, wordDir } from './common.ts';
import { ITEMS, checkChromium, itemStatus } from './setup.ts';
import { featureWindows, genres, prepareClip, runModel, testSong } from './score.ts';
import { voiceCatalog } from './voices.ts';

const PORT = Number(arg('port', process.env.PORT ?? '7700'));
const HOST = arg('host', '127.0.0.1');
const EXAMPLES = path.join(CONFIGS, 'examples');

// ───────── Helpers ─────────

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendFile(res: http.ServerResponse, file: string, type: string, downloadName?: string) {
  if (!fs.existsSync(file)) throw new HttpError(404, 'not found');
  const headers: Record<string, string | number> = { 'content-type': type, 'content-length': fs.statSync(file).size, 'cache-control': 'no-store' };
  if (downloadName) headers['content-disposition'] = `attachment; filename="${downloadName}"`;
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

async function body(req: http.IncomingMessage, limit = 30 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'request too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
const json = async <T>(req: http.IncomingMessage): Promise<T> => {
  try {
    return JSON.parse((await body(req)).toString('utf8')) as T;
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
};

/** configs/<name>.json, or any config file whose `name` is <name>. */
function configFile(name: string): string {
  const direct = path.join(CONFIGS, `${name}.json`);
  if (fs.existsSync(direct)) return direct;
  const other = listJson(CONFIGS).find((f) => readJson<WordConfig>(path.join(CONFIGS, f))?.name === name);
  return other ? path.join(CONFIGS, other) : direct;
}
function readConfig(name: string): WordConfig {
  if (!NAME_RE.test(name)) throw new HttpError(400, 'invalid name');
  const file = configFile(name);
  if (!fs.existsSync(file)) throw new HttpError(404, `no config for "${name}"`);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as WordConfig;
}
const listJson = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : []);
const countWav = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.wav')).length : 0);
const readJson = <T>(file: string): T | null => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
};

// ───────── Status of a wake word ─────────

function wordStatus(name: string) {
  const config = readConfig(name);
  const dir = wordDir(name);
  const tts = path.join(dir, 'tts');
  const source = readJson<{ hash: string; updatedAt: string }>(path.join(tts, 'source.json'));
  const rec = recordingsPath(config);
  const model = path.join(OUT, `${name}.onnx`);
  const features = readJson<{ counts: Record<string, number>; createdAt: string }>(path.join(dir, 'features', 'meta.json'));
  return {
    name,
    configUpdatedAt: fs.statSync(configFile(name)).mtime.toISOString(),
    tts: {
      pos: countWav(path.join(tts, 'pos')),
      adv: countWav(path.join(tts, 'adv')),
      sent: countWav(path.join(tts, 'sent')),
      expected: expectedClips(config),
      outdated: source ? source.hash !== generationHash(config) : false,
      updatedAt: source?.updatedAt ?? null,
    },
    recordings: { pos: countWav(path.join(rec, 'pos')), neg: countWav(path.join(rec, 'neg')), dir: path.relative(ROOT, rec) },
    features,
    model: fs.existsSync(model) ? { file: path.relative(ROOT, model), sizeKB: Math.round(fs.statSync(model).size / 1024), createdAt: fs.statSync(model).mtime.toISOString() } : null,
    report: readJson(path.join(OUT, `${name}.report.json`)),
  };
}

// ───────── Jobs (one at a time) ─────────

type StepName = 'setup' | 'generate' | 'features' | 'train';
type Status = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
interface Step {
  name: StepName;
  status: Status;
  args: string[];
  startedAt?: string;
  endedAt?: string;
  progress?: { done: number; total: number; label?: string };
  etaSeconds?: number;
}
interface Job {
  id: string;
  word: string | null;
  status: Status;
  steps: Step[];
  startedAt: string;
  endedAt?: string;
  error?: string;
}

const LAST_JOB = path.join(DATA, 'last-job.json');
let job: Job | null = readJson<Job>(LAST_JOB);
if (job?.status === 'running') {
  job.status = 'cancelled';
  job.error = 'The server stopped while this was running. Start it again to resume (audio generation picks up where it left off).';
  for (const s of job.steps) if (s.status === 'running' || s.status === 'pending') s.status = 'cancelled';
}
let child: ChildProcess | null = null;
let cancelRequested = false;
const logLines: string[] = [];
const clients = new Set<http.ServerResponse>();

function broadcast(event: string, data: unknown) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
}
let jobTimer: NodeJS.Timeout | null = null;
function publishJob() {
  // Progress arrives many times per second: send it at most every 300 ms.
  if (jobTimer) return;
  jobTimer = setTimeout(() => {
    jobTimer = null;
    broadcast('job', job);
    if (job) fs.writeFileSync(LAST_JOB, JSON.stringify(job, null, 2));
  }, 300);
}
function addLog(line: string, logFile?: string) {
  logLines.push(line);
  if (logLines.length > 2000) logLines.splice(0, logLines.length - 2000);
  broadcast('log', line);
  if (logFile) fs.appendFileSync(logFile, line + '\n');
}

const SCRIPTS: Record<StepName, string> = {
  setup: 'src/setup.ts',
  generate: 'src/generate.ts',
  features: 'src/features.ts',
  train: 'src/train.ts',
};

function runStep(step: Step, logFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [SCRIPTS[step.name], ...step.args], {
      cwd: ROOT,
      env: { ...process.env, WAKEWORD_UI: '1', FORCE_COLOR: '0' },
      // Own process group, so cancelling also stops Chromium and worker threads.
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = proc;
    // Recent progress samples: the rate over the last ~2 minutes gives a steadier estimate
    // (the first minutes include downloads and start-up).
    let samples: [number, number][] = [];
    const onLine = (line: string) => {
      if (line.startsWith('::progress::')) {
        try {
          const p = JSON.parse(line.slice(12)) as NonNullable<Step['progress']>;
          if (step.progress && (p.total !== step.progress.total || p.label !== step.progress.label && step.name === 'setup')) samples = [];
          step.progress = p;
          const now = Date.now();
          samples.push([now, p.done]);
          while (samples.length > 2 && now - samples[1][0] > 120_000) samples.shift();
          const [t0, d0] = samples[0];
          const rate = (p.done - d0) / Math.max(1e-3, (now - t0) / 1000);
          step.etaSeconds = p.total > 0 && rate > 0 && now - t0 > 10_000 ? Math.round((p.total - p.done) / rate) : undefined;
          publishJob();
        } catch {
          // ignore malformed progress
        }
        return;
      }
      addLog(line, logFile);
    };
    readline.createInterface({ input: proc.stdout! }).on('line', onLine);
    readline.createInterface({ input: proc.stderr! }).on('line', onLine);
    proc.on('error', reject);
    proc.on('exit', (code, signal) => {
      child = null;
      if (code === 0) resolve();
      else reject(new Error(cancelRequested ? 'cancelled' : `${step.name} failed (${signal ?? `exit code ${code}`}); see the log`));
    });
  });
}

function killChild() {
  if (!child?.pid) return;
  const pid = child.pid;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F']);
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    // already gone
  }
  setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }, 5000).unref();
}

interface JobRequest {
  word?: string;
  steps: StepName[];
  options?: { fresh?: boolean; pages?: number; workers?: number; steps?: number; hidden?: string; negWeight?: number; only?: string[] };
}

function startJob(reqJob: JobRequest): Job {
  if (job?.status === 'running') throw new HttpError(409, 'Something is already running. Wait for it or cancel it first.');
  const o = reqJob.options ?? {};
  const word = reqJob.word ?? null;
  if (reqJob.steps.some((s) => s !== 'setup') && !word) throw new HttpError(400, 'missing word');
  if (word) readConfig(word);
  const cfg = word ? ['--config', path.relative(ROOT, configFile(word))] : [];
  const int = (v: unknown, min: number, max: number) => (Number.isFinite(Number(v)) ? String(Math.min(max, Math.max(min, Math.round(Number(v))))) : null);
  const argsFor = (name: StepName): string[] => {
    const a = [...(name === 'setup' ? [] : cfg)];
    const add = (flag: string, v: string | null) => v !== null && a.push(flag, v);
    if (name === 'setup' && o.only?.length) add('--only', o.only.filter((x) => ITEMS.some((i) => i.id === x)).join(','));
    if (name === 'generate') {
      add('--pages', o.pages !== undefined ? int(o.pages, 1, 16) : null);
      if (o.fresh) a.push('--fresh');
    }
    if (name === 'features') add('--workers', o.workers !== undefined ? int(o.workers, 1, 128) : null);
    if (name === 'train') {
      add('--steps', o.steps !== undefined ? int(o.steps, 100, 200000) : null);
      if (o.hidden && /^\d+(,\d+)*$/.test(o.hidden)) a.push('--hidden', o.hidden);
      add('--neg-weight', o.negWeight !== undefined ? int(o.negWeight, 1, 1000) : null);
    }
    return a;
  };
  const order: StepName[] = ['setup', 'generate', 'features', 'train'];
  const steps = order.filter((s) => reqJob.steps.includes(s)).map((name): Step => ({ name, status: 'pending', args: argsFor(name) }));
  if (!steps.length) throw new HttpError(400, 'no steps');
  job = { id: Date.now().toString(36), word, status: 'running', steps, startedAt: new Date().toISOString() };
  cancelRequested = false;
  logLines.length = 0;
  broadcast('reset', null);
  void runJob(job);
  return job;
}

async function runJob(j: Job) {
  const logDir = j.word ? path.join(wordDir(j.word), 'logs') : path.join(DATA, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  for (const step of j.steps) {
    if (cancelRequested) {
      step.status = 'cancelled';
      continue;
    }
    step.status = 'running';
    step.startedAt = new Date().toISOString();
    publishJob();
    const logFile = path.join(logDir, `${step.name}.log`);
    fs.appendFileSync(logFile, `\n──── ${step.startedAt} ────\n`);
    addLog(`──── ${step.name} ────`);
    try {
      await runStep(step, logFile);
      step.status = 'done';
    } catch (err) {
      step.status = cancelRequested ? 'cancelled' : 'failed';
      j.error = cancelRequested ? 'Cancelled.' : err instanceof Error ? err.message : String(err);
      addLog(`✗ ${j.error}`, logFile);
      cancelRequested = true; // skip the remaining steps
    }
    step.endedAt = new Date().toISOString();
    step.etaSeconds = undefined;
    publishJob();
  }
  j.status = j.steps.some((s) => s.status === 'failed') ? 'failed' : j.steps.some((s) => s.status === 'cancelled') ? 'cancelled' : 'done';
  j.endedAt = new Date().toISOString();
  if (j.steps.some((s) => s.name === 'setup')) await checkChromium(true);
  publishJob();
}

// ───────── Routes ─────────

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, params: string[], url: URL) => Promise<void> | void;
const routes: [string, RegExp, Handler][] = [];
const route = (method: string, pattern: string, handler: Handler) =>
  routes.push([method, new RegExp('^' + pattern.replace(/:(\w+)/g, '([^/]+)') + '$'), handler]);

route('GET', '/api/state', async (_req, res) => {
  const setup = await Promise.all(ITEMS.map(async (i) => ({ ...i, ...(await itemStatus(i.id)) })));
  const words = listJson(CONFIGS)
    .map((f) => readJson<WordConfig>(path.join(CONFIGS, f)))
    .filter((c): c is WordConfig => !!c && NAME_RE.test(c.name ?? ''))
    .map((c) => ({ name: c.name, phrase: c.phrase || c.name, hasModel: fs.existsSync(path.join(OUT, `${c.name}.onnx`)) }));
  const examples = listJson(EXAMPLES).map((f) => ({ file: f, config: readJson<WordConfig>(path.join(EXAMPLES, f)) }));
  send(res, 200, { setup, words, examples, job, genres: genres(), cpus: (await import('node:os')).cpus().length });
});

route('POST', '/api/setup/recheck', async (_req, res) => {
  await checkChromium(true);
  send(res, 200, { ok: true });
});

route('GET', '/api/voices', async (_req, res) => send(res, 200, await voiceCatalog()));

route('GET', '/api/words/:name', (_req, res, [name]) => send(res, 200, { config: readConfig(name), status: wordStatus(name) }));

route('PUT', '/api/words/:name', async (req, res, [name]) => {
  if (!NAME_RE.test(name)) throw new HttpError(400, 'Use lowercase letters, digits and underscores for the name.');
  const config = await json<WordConfig>(req);
  config.name = name;
  const errors = validateConfig(config);
  if (errors.length) throw new HttpError(400, errors.join('; '));
  fs.mkdirSync(CONFIGS, { recursive: true });
  fs.writeFileSync(configFile(name), JSON.stringify(config, null, 2) + '\n');
  send(res, 200, { ok: true, status: wordStatus(name) });
});

route('GET', '/api/words/:name/status', (_req, res, [name]) => send(res, 200, wordStatus(name)));

// Your recordings
const recDir = (name: string, kind: string) => {
  if (kind !== 'pos' && kind !== 'neg') throw new HttpError(400, 'kind must be pos or neg');
  return path.join(recordingsPath(readConfig(name)), kind);
};
const safeFile = (f: string) => {
  if (!/^[\w.-]+\.wav$/.test(f)) throw new HttpError(400, 'invalid file name');
  return f;
};

route('GET', '/api/words/:name/recordings', (_req, res, [name]) => {
  const list = (kind: string) => {
    const dir = recDir(name, kind);
    return fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => f.endsWith('.wav')).sort().map((f) => ({ file: f, seconds: +(Math.max(0, fs.statSync(path.join(dir, f)).size - 44) / 32000).toFixed(1) }))
      : [];
  };
  send(res, 200, { pos: list('pos'), neg: list('neg') });
});

route('POST', '/api/words/:name/recordings/:kind', async (req, res, [name, kind], url) => {
  const dir = recDir(name, kind);
  const { samples, rate } = parseWav(await body(req), 'upload');
  const audio = resample(samples, rate, 16000);
  if (audio.length < 16000 * 0.3) throw new HttpError(400, 'too short');
  const base = (url.searchParams.get('name') ?? '').replace(/\.wav$/i, '').replace(/[^\w-]+/g, '_').slice(0, 40);
  const file = `${base || kind}_${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}_${Math.random().toString(36).slice(2, 6)}.wav`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), encodeWav(audio));
  send(res, 200, { file });
});

route('GET', '/api/words/:name/recordings/:kind/:file', (_req, res, [name, kind, file]) => sendFile(res, path.join(recDir(name, kind), safeFile(file)), 'audio/wav'));

route('DELETE', '/api/words/:name/recordings/:kind/:file', (_req, res, [name, kind, file]) => {
  fs.rmSync(path.join(recDir(name, kind), safeFile(file)), { force: true });
  send(res, 200, { ok: true });
});

// Generated clips (to listen to a few and check the pronunciation)
route('GET', '/api/words/:name/samples', (_req, res, [name], url) => {
  readConfig(name);
  const kind = url.searchParams.get('kind') ?? 'pos';
  if (!['pos', 'adv', 'sent'].includes(kind)) throw new HttpError(400, 'invalid kind');
  const n = Math.min(40, Number(url.searchParams.get('n') ?? 8));
  const manifest = path.join(wordDir(name), 'tts', 'manifest.jsonl');
  const entries = fs.existsSync(manifest)
    ? fs
        .readFileSync(manifest, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { file: string; voice: string; kind: string; text: string; speaker: number })
        .filter((e) => e.kind === kind && fs.existsSync(path.join(wordDir(name), e.file)))
    : [];
  const picked: typeof entries = [];
  const pool = [...entries];
  while (picked.length < n && pool.length) picked.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  send(res, 200, { total: entries.length, samples: picked.map((e) => ({ file: path.basename(e.file), voice: e.voice, speaker: e.speaker, text: e.text })) });
});

route('GET', '/api/words/:name/tts/:kind/:file', (_req, res, [name, kind, file]) => {
  readConfig(name);
  if (!['pos', 'adv', 'sent'].includes(kind)) throw new HttpError(400, 'invalid kind');
  sendFile(res, path.join(wordDir(name), 'tts', kind, safeFile(file)), 'audio/wav');
});

// Model, report, logs
route('GET', '/api/words/:name/model', (_req, res, [name]) => {
  readConfig(name);
  sendFile(res, path.join(OUT, `${name}.onnx`), 'application/octet-stream', `${name}.onnx`);
});
route('GET', '/api/words/:name/report', (_req, res, [name]) => {
  readConfig(name);
  sendFile(res, path.join(OUT, `${name}.report.json`), 'application/json', `${name}.report.json`);
});
route('GET', '/api/words/:name/logs/:step', (_req, res, [name, step]) => {
  readConfig(name);
  if (!['generate', 'features', 'train'].includes(step)) throw new HttpError(400, 'invalid step');
  sendFile(res, path.join(wordDir(name), 'logs', `${step}.log`), 'text/plain; charset=utf-8');
});

// Try the model on a clip recorded in the browser
route('POST', '/api/words/:name/test', async (req, res, [name], url) => {
  readConfig(name);
  const model = path.join(OUT, `${name}.onnx`);
  if (!fs.existsSync(model)) throw new HttpError(404, 'no model yet: train it first');
  const { samples, rate } = parseWav(await body(req), 'upload');
  const genre = url.searchParams.get('music');
  const music = genre ? testSong(genre) : null;
  if (genre && !music) throw new HttpError(400, `no test song for "${genre}"`);
  const pad = 0.5;
  const audio = prepareClip(resample(samples, rate, 16000), { pad, music, snr: Number(url.searchParams.get('snr') ?? 5), seed: Date.now() % 1000 });
  const session = await ort.InferenceSession.create(model);
  const scores = await runModel(session, await featureWindows(audio));
  send(res, 200, { hop: 0.08, pad, scores: Array.from(scores, (v) => +v.toFixed(4)), audio: music ? encodeWav(audio).toString('base64') : null });
});

// Jobs
route('POST', '/api/jobs', async (req, res) => send(res, 200, startJob(await json<JobRequest>(req))));
route('POST', '/api/jobs/cancel', (_req, res) => {
  if (job?.status === 'running') {
    cancelRequested = true;
    addLog('Cancelling…');
    killChild();
  }
  send(res, 200, { ok: true });
});

route('GET', '/api/events', (req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  res.write(`event: job\ndata: ${JSON.stringify(job)}\n\n`);
  res.write(`event: logs\ndata: ${JSON.stringify(logLines.slice(-400))}\n\n`);
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
});

async function api(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  // Only this page may change things (not some other website open in the same browser).
  if (req.method !== 'GET' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) throw new HttpError(403, 'cross-origin request refused');
  for (const [method, re, handler] of routes) {
    const m = method === req.method && url.pathname.match(re);
    if (m) return handler(req, res, m.slice(1).map(decodeURIComponent), url);
  }
  throw new HttpError(404, 'unknown endpoint');
}

// ───────── Start ─────────

const server = http.createServer();
const vite = await createVite({
  configFile: false,
  root: path.join(ROOT, 'ui'),
  plugins: [onnxWasm(), piperTuning()],
  optimizeDeps: piperOptimizeDeps,
  server: { middlewareMode: true, hmr: { server } },
  appType: 'spa',
  logLevel: 'warn',
});
server.on('request', (req, res) => {
  if (!req.url?.startsWith('/api/')) return vite.middlewares(req, res);
  Promise.resolve(api(req, res)).catch((err: unknown) => {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) send(res, status, { error: err instanceof Error ? err.message : String(err) });
    else res.end();
  });
});
server.on('error', (err: NodeJS.ErrnoException) => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${PORT} is in use. Try: npm start -- --port 7701` : err);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  console.log(`\n  Wake word trainer running at  http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/\n`);
  console.log('  Leave this terminal open while training. Ctrl+C stops the server and any running step.\n');
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (child) {
      cancelRequested = true;
      killChild();
    }
    if (job?.status === 'running') {
      job.status = 'cancelled';
      job.error = 'The server was stopped.';
      fs.writeFileSync(LAST_JOB, JSON.stringify(job, null, 2));
    }
    process.exit(0);
  });
}
