/**
 * Step 1: synthetic voices with Piper.
 *
 *   npm run generate -- --config configs/x.json [--pages 4] [--fresh] [--limit N (trial run)]
 *
 * For every voice in the config it generates clips of the wake word (pos), of similar phrases
 * that are not the wake word (adv) and of ordinary sentences (sent), varying speaker, speed and
 * intonation. They are saved in data/<name>/tts/<kind>/ with a manifest.jsonl. It can be
 * stopped and resumed: existing clips are not generated again (`--fresh` starts over).
 *
 * Uses headless Chromium (Playwright). If system libraries are missing, put their folder in
 * LD_LIBRARY_PATH (see the README).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { DATA, ROOT, arg, browserEnv, generationHash, hash, langOf, loadConfig, log, progress, rng, wordDir, type VoiceSpec, type WordConfig } from './common.ts';

type Kind = 'pos' | 'adv' | 'sent';
interface Job {
  file: string;
  voice: string;
  kind: Kind;
  text: string;
  tuning: { speaker: number; lengthScale: number; noiseScale: number; noiseW: number };
}

function jobs(c: WordConfig): Job[] {
  const out: Job[] = [];
  const dir = path.join(wordDir(c), 'tts');
  for (const v of c.voices) {
    const r = rng(hash(v.id));
    const lang = langOf(v.id);
    const lists: Record<Kind, string[]> = {
      pos: c.positive[lang] ?? [],
      adv: c.adversarial[lang] ?? [],
      sent: c.sentences[lang] ?? [],
    };
    for (const kind of ['pos', 'adv', 'sent'] as const) {
      const n = v[kind];
      if (!lists[kind].length) continue;
      for (let i = 0; i < n; i++) {
        out.push({
          file: path.join(dir, kind, `${v.id}__${String(i).padStart(4, '0')}.wav`),
          voice: v.id,
          kind,
          // Phrases and speakers spread out, in a random but reproducible order.
          text: lists[kind][(i + r.int(lists[kind].length)) % lists[kind].length],
          tuning: {
            speaker: speakerFor(v, i, r),
            lengthScale: r.range(0.78, 1.3),
            noiseScale: r.range(0.35, 0.95),
            noiseW: r.range(0.5, 1.0),
          },
        });
      }
    }
  }
  return out;
}

function speakerFor(v: VoiceSpec, i: number, r: ReturnType<typeof rng>) {
  // With many speakers, a different one each time; with few, take turns.
  return v.speakers > 50 ? r.int(v.speakers) : i % v.speakers;
}

async function main() {
  const { config } = loadConfig();
  const nPages = Number(arg('pages', '4'));
  const ttsDir = path.join(wordDir(config), 'tts');
  if (process.argv.includes('--fresh') && fs.existsSync(ttsDir)) {
    log(`--fresh: deleting ${path.relative(ROOT, ttsDir)}`);
    fs.rmSync(ttsDir, { recursive: true, force: true });
  }
  const all = jobs(config);
  const limit = arg('limit');
  const todo = all.filter((j) => !fs.existsSync(j.file)).slice(0, limit ? Number(limit) : undefined);
  log(`${config.name}: ${all.length} clips, ${todo.length} still to generate`);
  fs.mkdirSync(ttsDir, { recursive: true });
  fs.writeFileSync(path.join(ttsDir, 'source.json'), JSON.stringify({ hash: generationHash(config), updatedAt: new Date().toISOString() }, null, 2));
  if (!todo.length) return;

  const server = await createServer({ configFile: path.join(ROOT, 'synth', 'vite.config.ts') });
  await server.listen();
  const url = `http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}/`;
  // Persistent profile: voices are downloaded once and kept.
  const ctx = await chromium.launchPersistentContext(path.join(DATA, 'browser'), {
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
    env: browserEnv(),
  });

  // Grouped by voice: each tab loads one voice and does all of its clips.
  const byVoice = new Map<string, Job[]>();
  for (const j of todo) byVoice.set(j.voice, [...(byVoice.get(j.voice) ?? []), j]);
  const queue = [...byVoice.values()];
  const manifest = fs.createWriteStream(path.join(ttsDir, 'manifest.jsonl'), { flags: 'a' });
  let done = 0;
  let failed = 0;
  const t0 = Date.now();
  progress(0, todo.length);

  async function worker(w: number) {
    const page = await ctx.newPage();
    page.on('pageerror', (e) => log(`tab ${w}: ${e.message}`));
    await page.goto(url);
    await page.waitForFunction(() => (window as unknown as { synthReady?: boolean }).synthReady, null, { timeout: 60_000 });
    for (let group = queue.shift(); group; group = queue.shift()) {
      log(`tab ${w}: ${group[0].voice} (${group.length} clips; the first time, the voice is downloaded)`);
      for (const j of group) {
        try {
          const b64 = await page.evaluate(
            ([voice, text, tuning]) => (window as unknown as { synth: (v: string, t: string, u: unknown) => Promise<string> }).synth(voice, text, tuning),
            [j.voice, j.text, j.tuning] as const,
          );
          fs.mkdirSync(path.dirname(j.file), { recursive: true });
          fs.writeFileSync(j.file, Buffer.from(b64, 'base64'));
          manifest.write(JSON.stringify({ file: path.relative(wordDir(config), j.file), voice: j.voice, kind: j.kind, text: j.text, ...j.tuning }) + '\n');
        } catch (err) {
          failed++;
          log(`  ✗ ${path.basename(j.file)}: ${err instanceof Error ? err.message.split('\n')[0] : err}`);
        }
        progress(++done, todo.length, j.voice);
        if (done % 100 === 0) {
          const rate = done / ((Date.now() - t0) / 1000);
          log(`  ${done}/${todo.length} (${rate.toFixed(1)}/s, ~${Math.round((todo.length - done) / rate / 60)} min left)`);
        }
      }
    }
    await page.close();
  }

  await Promise.all(Array.from({ length: Math.min(nPages, queue.length) }, (_, w) => worker(w + 1)));
  manifest.end();
  await ctx.close();
  await server.close();
  log(`done: ${done - failed} clips in ${Math.round((Date.now() - t0) / 1000)} s${failed ? `, ${failed} failed` : ''}`);
  if (failed > done / 2) throw new Error('more than half of the clips failed');
}

await main();
