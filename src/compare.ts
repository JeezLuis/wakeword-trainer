/**
 * Compares models on the same clips (your recordings and others), clean and with music:
 *
 *   npm run compare -- out/a.onnx out/b.onnx --config configs/x.json [--extra folder-with-wavs]
 *
 * For each model, how many clips score above 0.5 / 0.7 / 0.8. In --extra, files whose name
 * contains "neg" count as "should not trigger".
 */
import fs from 'node:fs';
import path from 'node:path';
import * as ort from 'onnxruntime-node';
import { arg, loadClip16k, loadConfig, recordingsDir } from './common.ts';
import { featureWindows, prepareClip, runModel, testSong } from './score.ts';

const models = process.argv.slice(2).filter((a) => a.endsWith('.onnx'));
if (!models.length) throw new Error('Usage: npm run compare -- out/a.onnx [out/b.onnx …] --config configs/x.json [--extra folder]');
const { config } = loadConfig();
const rec = recordingsDir(config);
const wavs = (d: string) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.wav')).sort().map((f) => path.join(d, f)) : []);
const groups: Record<string, string[]> = {
  'yours: wake word': rec ? wavs(path.join(rec, 'pos')) : [],
  'yours: other': rec ? wavs(path.join(rec, 'neg')) : [],
};
const extra = arg('extra');
if (extra) for (const f of wavs(extra)) (groups[path.basename(f).includes('neg') ? 'extra: should not' : 'extra: should'] ??= []).push(f);

const rock = testSong('rock');
const conditions: [string, number | null][] = [['clean', null], ...(rock ? ([['rock 10 dB', 10], ['rock 5 dB', 5]] as [string, number][]) : [])];
const sessions = await Promise.all(models.map((m) => ort.InferenceSession.create(m)));

for (const [group, files] of Object.entries(groups)) {
  if (!files.length) continue;
  for (const [cond, snr] of conditions) {
    const tallies = models.map(() => [0, 0, 0]);
    for (const [i, f] of files.entries()) {
      const audio = prepareClip(loadClip16k(f), { music: snr === null ? null : rock, snr: snr ?? 0, seed: i + 1 });
      const windows = await featureWindows(audio, 4);
      for (const [m, s] of sessions.entries()) {
        const max = Math.max(0, ...(await runModel(s, windows)));
        [0.5, 0.7, 0.8].forEach((t, k) => (tallies[m][k] += max >= t ? 1 : 0));
      }
    }
    console.log(`${group.padEnd(20)} ${cond.padEnd(11)} ` + models.map((m, i) => `${path.basename(m)}: ${tallies[i].map((n) => `${n}/${files.length}`).join(' ')}`).join('   '));
  }
}
console.log('(each cell: how many score above 0.5 / 0.7 / 0.8)');
