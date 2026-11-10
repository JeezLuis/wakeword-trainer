/** Microphone capture (raw PCM, no processing), WAV encoding and playback. */

const WORKLET = `
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('tap', Tap);
`;

export class Recorder {
  #ctx: AudioContext | null = null;
  #stream: MediaStream | null = null;
  #node: AudioWorkletNode | null = null;
  #chunks: Float32Array[] = [];
  #recording = false;
  onLevel: ((rms: number) => void) | null = null;

  async open() {
    if (this.#ctx) return;
    this.#stream = await navigator.mediaDevices.getUserMedia({
      // Raw audio, like most wake word detectors get from the microphone.
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.#ctx = new AudioContext();
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    await this.#ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const src = this.#ctx.createMediaStreamSource(this.#stream);
    this.#node = new AudioWorkletNode(this.#ctx, 'tap');
    this.#node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      const x = e.data;
      if (this.#recording) this.#chunks.push(x);
      if (this.onLevel) {
        let s = 0;
        for (const v of x) s += v * v;
        this.onLevel(Math.sqrt(s / x.length));
      }
    };
    src.connect(this.#node);
  }

  get rate() {
    return this.#ctx?.sampleRate ?? 48000;
  }

  async start() {
    await this.open();
    if (this.#ctx!.state === 'suspended') await this.#ctx!.resume();
    this.#chunks = [];
    this.#recording = true;
  }

  stop(): Float32Array {
    this.#recording = false;
    const n = this.#chunks.reduce((a, c) => a + c.length, 0);
    const out = new Float32Array(n);
    let o = 0;
    for (const c of this.#chunks) {
      out.set(c, o);
      o += c.length;
    }
    this.#chunks = [];
    return out;
  }

  close() {
    this.#recording = false;
    this.#stream?.getTracks().forEach((t) => t.stop());
    void this.#ctx?.close();
    this.#ctx = null;
    this.#stream = null;
    this.#node = null;
  }
}

export const recorder = new Recorder();

export function encodeWav(samples: Float32Array, rate: number): Blob {
  const b = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const str = (o: number, s: string) => [...s].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  b.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVEfmt ');
  b.setUint32(16, 16, true);
  b.setUint16(20, 1, true);
  b.setUint16(22, 1, true);
  b.setUint32(24, rate, true);
  b.setUint32(28, rate * 2, true);
  b.setUint16(32, 2, true);
  b.setUint16(34, 16, true);
  str(36, 'data');
  b.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) b.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), true);
  return new Blob([b.buffer], { type: 'audio/wav' });
}

export const peak = (x: Float32Array) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

let player: HTMLAudioElement | null = null;
export function play(src: string | Blob): Promise<void> {
  player?.pause();
  const url = typeof src === 'string' ? src : URL.createObjectURL(src);
  player = new Audio(url);
  return new Promise((resolve) => {
    player!.onended = () => resolve();
    player!.onerror = () => resolve();
    void player!.play().catch(() => resolve());
  });
}
export const stopPlayback = () => player?.pause();
