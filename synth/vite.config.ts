import { defineConfig } from 'vite';
import { onnxWasm, piperOptimizeDeps, piperTuning } from './plugins.ts';

/** Headless synthesis page driven by src/generate.ts with Playwright. */
export default defineConfig({
  root: import.meta.dirname,
  plugins: [onnxWasm(), piperTuning()],
  optimizeDeps: piperOptimizeDeps,
  server: { port: 0, host: '127.0.0.1', hmr: false },
  logLevel: 'warn',
});
