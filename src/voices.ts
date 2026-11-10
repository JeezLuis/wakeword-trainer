import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { VoiceInfo } from './catalog.ts';

/**
 * The Piper voices available through piper-tts-web, from the catalog that ships with it
 * (language, quality and number of speakers of each one).
 */
let cache: VoiceInfo[] | null = null;

interface RawVoice {
  key: string;
  name: string;
  language: { family: string; region: string; name_english: string };
  quality: string;
  num_speakers: number;
  files: Record<string, { size_bytes: number }>;
}

export async function voiceCatalog(): Promise<VoiceInfo[]> {
  if (cache) return cache;
  let dir = path.dirname(fileURLToPath(import.meta.resolve('@mintplex-labs/piper-tts-web')));
  while (path.basename(dir) !== 'dist' && dir !== path.dirname(dir)) dir = path.dirname(dir);
  const file = fs.readdirSync(dir).find((f) => /^voices_static.*\.js$/.test(f));
  if (!file) throw new Error(`piper-tts-web: voice catalog not found in ${dir}`);
  const raw = (await import(pathToFileURL(path.join(dir, file)).href)).default as Record<string, RawVoice>;
  cache = Object.values(raw)
    .map((v) => ({
      id: v.key,
      lang: v.language.family,
      langName: v.language.name_english,
      region: v.language.region,
      name: v.name,
      quality: v.quality,
      speakers: v.num_speakers,
      sizeMB: Math.round(Object.entries(v.files).reduce((a, [f, x]) => a + (f.endsWith('.onnx') ? x.size_bytes : 0), 0) / 1e6),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return cache;
}
