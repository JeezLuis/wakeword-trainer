import { TtsSession } from '@mintplex-labs/piper-tts-web';

/**
 * Piper text-to-speech in the browser. One session per voice: the model is downloaded once and
 * kept in the browser's storage (OPFS).
 */

export interface Tuning {
  speaker: number;
  lengthScale: number;
  noiseScale: number;
  noiseW: number;
}

let session: TtsSession | null = null;
let current = '';

export async function synthesize(voice: string, text: string, tuning?: Partial<Tuning>, onProgress?: (loaded: number, total: number) => void): Promise<Blob> {
  if (!session || current !== voice) {
    // The library keeps a single instance; reset it to switch voices.
    (TtsSession as unknown as { _instance: unknown })._instance = null;
    session = await TtsSession.create({
      voiceId: voice as never,
      wasmPaths: { ...TtsSession.WASM_LOCATIONS, onnxWasm: `${location.origin}/ort/` },
      progress: onProgress ? (p: { loaded: number; total: number }) => onProgress(p.loaded, p.total) : undefined,
    } as never);
    current = voice;
  }
  (globalThis as { __piper?: Partial<Tuning> }).__piper = tuning ?? {};
  return session.predict(text);
}
