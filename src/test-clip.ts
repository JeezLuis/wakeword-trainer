/**
 * Tests a model on one clip, as a real-time detector would.
 *
 *   npm run test-clip -- <audio.wav> --model out/<name>.onnx [--music rock --snr 5]
 *
 * Streams the clip (with 1 s of silence before and after, and optionally music underneath)
 * through the openWakeWord pipeline and draws the score every 80 ms.
 */
import * as ort from 'onnxruntime-node';
import { arg, loadClip16k } from './common.ts';
import { featureWindows, genres, prepareClip, runModel, testSong } from './score.ts';

const file = process.argv[2];
const model = arg('model');
if (!file || file.startsWith('--') || !model) throw new Error('Usage: npm run test-clip -- <audio.wav> --model out/<name>.onnx [--music rock --snr 5]');
const genre = arg('music');
const music = genre ? testSong(genre) : null;
if (genre && !music) throw new Error(`No test song for genre "${genre}". Available: ${genres().join(', ') || 'none (run npm run setup)'}`);
const snr = Number(arg('snr', '5'));

const audio = prepareClip(loadClip16k(file), { music, snr });
const scores = await runModel(await ort.InferenceSession.create(model), await featureWindows(audio));
scores.forEach((s, i) => console.log(`${((i + 1) * 0.08).toFixed(2).padStart(6)} s  ${s.toFixed(3)}  ${'█'.repeat(Math.round(s * 40))}`));
console.log(`max ${Math.max(0, ...scores).toFixed(3)}${music ? ` (with ${genre} music at ${snr} dB)` : ''}`);
