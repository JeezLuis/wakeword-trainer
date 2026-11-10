/**
 * One-time setup: downloads everything training needs (~2.5 GB) into data/.
 *
 *   npm run setup [-- --only chromium,gtzan]
 *
 * Downloads resume if interrupted. Run it again at any time: what is already there is skipped.
 */
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { DATA, SYSLIBS, arg, browserEnv, log, progress } from './common.ts';
import { BASE_DIR, ensureBaseModels } from './oww.ts';

const DOWNLOAD = path.join(DATA, 'download');
const GTZAN_DIR = path.join(DATA, 'gtzan');
const HF = 'https://huggingface.co/datasets';
const ACAV_BYTES = 1_022_361_728; // ~330,000 windows: the first ~1 GB of the 17 GB file

export interface SetupItem {
  id: 'chromium' | 'base' | 'validation' | 'acav' | 'gtzan';
  label: string;
  description: string;
  sizeMB: number;
  required: boolean;
}

export const ITEMS: SetupItem[] = [
  { id: 'chromium', label: 'Headless Chromium', description: 'Runs the Piper voices to generate speech (via Playwright).', sizeMB: 110, required: true },
  { id: 'base', label: 'openWakeWord base models', description: 'Mel spectrogram and speech embedding models shared by every openWakeWord model.', sizeMB: 2, required: true },
  { id: 'gtzan', label: 'GTZAN music', description: '1,000 songs in 10 genres, mixed under the speech so the model works with music playing.', sizeMB: 1230, required: true },
  { id: 'acav', label: 'ACAV100M features (part)', description: 'Pre-computed features of ~170 h of varied audio, used as negatives. Cuts false alarms a lot.', sizeMB: 1020, required: false },
  { id: 'validation', label: 'openWakeWord validation set', description: '11 h of speech, music and noise, to measure false alarms per hour.', sizeMB: 185, required: false },
];

// ───────── Status ─────────

let chromiumCache: { ok: boolean; error?: string; missingLib?: string } | null = null;

/** Launches Chromium once to check it is installed and has the system libraries it needs. */
export async function checkChromium(force = false): Promise<{ ok: boolean; error?: string; missingLib?: string }> {
  if (chromiumCache && !force) return chromiumCache;
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true, env: browserEnv() });
    await browser.close();
    chromiumCache = { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const missingLib = msg.match(/error while loading shared libraries: ([^:\s]+)/)?.[1];
    const notInstalled = /Executable doesn't exist|please run the following command to download new browsers/i.test(msg);
    chromiumCache = {
      ok: false,
      missingLib,
      error: missingLib
        ? `Chromium cannot start: the system library ${missingLib} is missing.`
        : notInstalled
          ? 'Not installed yet.'
          : msg.split('\n').filter((l) => l.trim() && !/^[═║╔╚]|^<launching>/.test(l.trim())).slice(0, 4).join('\n'),
    };
  }
  return chromiumCache;
}

/**
 * Without admin rights: downloads the missing system libraries as Debian/Ubuntu packages and
 * unpacks them into data/syslibs (used through LD_LIBRARY_PATH). One library at a time, since
 * the loader only reports the first one missing.
 */
function packagesFor(lib: string): string[] {
  const known: Record<string, string> = {
    'libnssutil3.so': 'libnss3',
    'libsmime3.so': 'libnss3',
    'libnss3.so': 'libnss3',
    'libnspr4.so': 'libnspr4',
    'libplc4.so': 'libnspr4',
    'libplds4.so': 'libnspr4',
    'libatk-1.0.so.0': 'libatk1.0-0',
    'libatk-bridge-2.0.so.0': 'libatk-bridge2.0-0',
    'libatspi.so.0': 'libatspi2.0-0',
    'libcups.so.2': 'libcups2',
    'libasound.so.2': 'libasound2',
    'libpango-1.0.so.0': 'libpango-1.0-0',
    'libdbus-1.so.3': 'libdbus-1-3',
  };
  let pkg = known[lib];
  if (!pkg) {
    // libXfoo.so.3 → libxfoo3, libfoo2.so.1 → libfoo2-1
    const m = lib.match(/^(lib[^.]+)\.so(?:\.(\d+))?/);
    if (!m) return [];
    const base = m[1].toLowerCase();
    pkg = m[2] ? `${base}${/\d$/.test(base) ? '-' : ''}${m[2]}` : base;
  }
  return [`${pkg}t64`, pkg];
}

async function fixSystemLibraries() {
  const debs = path.join(SYSLIBS, 'debs');
  fs.mkdirSync(debs, { recursive: true });
  const tried = new Set<string>();
  for (let round = 0; round < 25; round++) {
    const status = await checkChromium(true);
    if (status.ok || !status.missingLib) return;
    if (tried.has(status.missingLib)) throw new Error(`Could not provide ${status.missingLib}. Install Chromium's dependencies with: sudo npx playwright install-deps chromium`);
    tried.add(status.missingLib);
    let got = false;
    for (const pkg of packagesFor(status.missingLib)) {
      try {
        log(`  ${status.missingLib} is missing: downloading package ${pkg}`);
        await run('apt-get', ['download', pkg], 'apt-get download', debs);
        got = true;
        break;
      } catch {
        // try the next name
      }
    }
    if (!got) throw new Error(`No package found for ${status.missingLib}. Install Chromium's dependencies with: sudo npx playwright install-deps chromium`);
    for (const deb of fs.readdirSync(debs).filter((f) => f.endsWith('.deb'))) {
      await run('dpkg-deb', ['-x', path.join(debs, deb), SYSLIBS], 'dpkg-deb');
      fs.rmSync(path.join(debs, deb));
    }
  }
}

export async function itemStatus(id: SetupItem['id']): Promise<{ ok: boolean; error?: string; partialMB?: number }> {
  const partial = (f: string) => (fs.existsSync(f + '.part') ? Math.round(fs.statSync(f + '.part').size / 1e6) : undefined);
  switch (id) {
    case 'chromium':
      return checkChromium();
    case 'base':
      return { ok: ['melspectrogram.onnx', 'embedding_model.onnx'].every((f) => fs.existsSync(path.join(BASE_DIR, f))) };
    case 'validation': {
      const f = path.join(DOWNLOAD, 'validation_set_features.npy');
      return { ok: fs.existsSync(f), partialMB: partial(f) };
    }
    case 'acav': {
      const f = path.join(DOWNLOAD, 'acav_part.npy');
      return { ok: fs.existsSync(f), partialMB: partial(f) };
    }
    case 'gtzan': {
      const dir = path.join(GTZAN_DIR, 'genres');
      const ok = fs.existsSync(dir) && fs.readdirSync(dir).filter((g) => fs.statSync(path.join(dir, g)).isDirectory()).length >= 10;
      return { ok, partialMB: partial(path.join(DOWNLOAD, 'genres.tar.gz')) };
    }
  }
}

// ───────── Downloads ─────────

/** Downloads `url` to `dest`, resuming a previous `.part` file. `maxBytes` keeps only the start. */
async function download(url: string, dest: string, label: string, maxBytes?: number) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = dest + '.part';
  let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
  if (maxBytes && have >= maxBytes) {
    fs.truncateSync(part, maxBytes);
    fs.renameSync(part, dest);
    return;
  }
  const headers: Record<string, string> = {};
  if (have || maxBytes) headers.Range = `bytes=${have}-${maxBytes ? maxBytes - 1 : ''}`;
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (res.status === 416 && have) {
    // Already complete.
    fs.renameSync(part, dest);
    return;
  }
  if (!res.ok || !res.body) throw new Error(`${label}: HTTP ${res.status} for ${url}`);
  if (res.status === 200 && have) have = 0; // the server ignored the range: start over
  const rangeTotal = Number(res.headers.get('content-range')?.split('/')[1]);
  const total = maxBytes ?? (Number.isFinite(rangeTotal) && rangeTotal > 0 ? rangeTotal : have + Number(res.headers.get('content-length') ?? 0));
  const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
  let got = have;
  let lastLog = 0;
  log(`${label}: downloading ${(total / 1e6).toFixed(0)} MB${have ? ` (resuming at ${(have / 1e6).toFixed(0)} MB)` : ''}`);
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    const piece = maxBytes && got + chunk.length > maxBytes ? chunk.subarray(0, maxBytes - got) : chunk;
    if (!out.write(piece)) await once(out, 'drain');
    got += piece.length;
    progress(got, total, label);
    if (Date.now() - lastLog > 15_000) {
      lastLog = Date.now();
      log(`  ${label}: ${(got / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB`);
    }
    if (maxBytes && got >= maxBytes) break;
  }
  out.end();
  await once(out, 'finish');
  if (total && got < total) throw new Error(`${label}: download interrupted at ${(got / 1e6).toFixed(0)} MB (run setup again to resume)`);
  fs.renameSync(part, dest);
}

function run(cmd: string, args: string[], label: string, cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd });
    const relay = (b: Buffer) => {
      for (const line of b.toString().split(/[\r\n]+/)) if (line.trim()) log(`  ${line.trim()}`);
    };
    child.stdout.on('data', relay);
    child.stderr.on('data', relay);
    child.on('error', reject);
    child.on('exit', (code) => (code ? reject(new Error(`${label} failed (exit code ${code})`)) : resolve()));
  });
}

export async function install(id: SetupItem['id']) {
  const item = ITEMS.find((i) => i.id === id)!;
  progress(0, 1, item.label);
  switch (id) {
    case 'chromium': {
      const require = createRequire(import.meta.url);
      const cli = path.join(path.dirname(require.resolve('playwright/package.json')), 'cli.js');
      await run(process.execPath, [cli, 'install', 'chromium-headless-shell'], 'playwright install');
      let status = await checkChromium(true);
      if (!status.ok && status.missingLib && process.platform === 'linux' && fs.existsSync('/usr/bin/apt-get')) {
        log('Chromium needs system libraries that are not installed; fetching them into data/syslibs (no admin rights needed)…');
        await fixSystemLibraries();
        status = await checkChromium(true);
      }
      if (!status.ok) throw new Error(`Chromium is installed but does not start:\n${status.error}\n(see "Troubleshooting" in the README)`);
      break;
    }
    case 'base':
      await ensureBaseModels();
      break;
    case 'validation':
      await download(`${HF}/davidscripka/openwakeword_features/resolve/main/validation_set_features.npy`, path.join(DOWNLOAD, 'validation_set_features.npy'), item.label);
      break;
    case 'acav':
      await download(`${HF}/davidscripka/openwakeword_features/resolve/main/openwakeword_features_ACAV100M_2000_hrs_16bit.npy`, path.join(DOWNLOAD, 'acav_part.npy'), item.label, ACAV_BYTES);
      break;
    case 'gtzan': {
      const tar = path.join(DOWNLOAD, 'genres.tar.gz');
      if (!fs.existsSync(tar)) await download(`${HF}/marsyas/gtzan/resolve/main/data/genres.tar.gz`, tar, item.label);
      log(`${item.label}: extracting…`);
      progress(0, 0, `${item.label}: extracting`);
      fs.mkdirSync(GTZAN_DIR, { recursive: true });
      await run('tar', ['-xzf', tar, '-C', GTZAN_DIR], 'tar');
      fs.rmSync(tar);
      break;
    }
  }
  progress(1, 1, item.label);
  log(`✓ ${item.label}`);
}

async function main() {
  const only = arg('only')?.split(',');
  for (const item of ITEMS) {
    if (only && !only.includes(item.id)) continue;
    const status = await itemStatus(item.id);
    if (status.ok) {
      log(`✓ ${item.label} (already there)`);
      continue;
    }
    await install(item.id);
  }
  log('setup complete');
}

if (import.meta.filename === path.resolve(process.argv[1] ?? '')) await main();
