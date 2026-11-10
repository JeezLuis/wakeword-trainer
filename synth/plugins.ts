import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { Plugin } from 'vite';

/**
 * Two Vite plugins needed to run Piper (piper-tts-web) in the browser, used by both the
 * headless generator page (synth/) and the web app (ui/):
 *
 * - ONNX Runtime's .wasm files are served from /ort/, from the installed version.
 * - A patch so Piper reads speaker, speed and intonation from `globalThis.__piper` (the library
 *   hard-codes speaker 0 and the model's defaults).
 */

export function onnxWasm(): Plugin {
  const require = createRequire(import.meta.url);
  let dist = path.dirname(require.resolve('onnxruntime-web'));
  while (path.basename(dist) !== 'dist' && dist !== path.dirname(dist)) dist = path.dirname(dist);
  const files = fs.readdirSync(dist).filter((f) => /^ort-wasm.*\.(wasm|mjs)$/.test(f));
  return {
    name: 'onnx-wasm',
    configureServer(server) {
      server.middlewares.use('/ort/', (req, res, next) => {
        const file = (req.url ?? '').split('?')[0].replace(/^\//, '');
        if (!files.includes(file)) return next();
        res.setHeader('content-type', file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
        fs.createReadStream(path.join(dist, file)).pipe(res);
      });
    },
  };
}

export function piperTuning(): Plugin {
  const swaps: [RegExp, string][] = [
    // Speaker ids wrap around the number of speakers, so a wrong id can never crash the model.
    [/const speakerId = 0;/, 'const speakerId = (globalThis.__piper?.speaker ?? 0) % Math.max(1, __privateGet(this, _modelConfig).num_speakers ?? 1);'],
    [/(const noiseScale = )(__privateGet\(this, _modelConfig\)\.inference\.noise_scale);/, '$1globalThis.__piper?.noiseScale ?? $2;'],
    [/(const lengthScale = )(__privateGet\(this, _modelConfig\)\.inference\.length_scale);/, '$1globalThis.__piper?.lengthScale ?? $2;'],
    [/(const noiseW = )(__privateGet\(this, _modelConfig\)\.inference\.noise_w);/, '$1globalThis.__piper?.noiseW ?? $2;'],
  ];
  return {
    name: 'piper-tuning',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('piper-tts-web') || !code.includes('const speakerId = 0;')) return null;
      let out = code;
      for (const [re, rep] of swaps) {
        if (!re.test(out)) throw new Error(`piper-tts-web: could not find ${re} (has the library changed?)`);
        out = out.replace(re, rep);
      }
      return { code: out, map: null };
    },
  };
}

/** Settings both pages need so Vite leaves Piper and ONNX Runtime alone. */
export const piperOptimizeDeps = { exclude: ['@mintplex-labs/piper-tts-web', 'onnxruntime-web'] };
