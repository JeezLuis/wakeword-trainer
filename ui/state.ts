import type { VoiceInfo, WordConfig } from '../src/catalog.ts';
import { api } from './api.ts';
import { toast } from './dom.ts';

export interface SetupItem {
  id: string;
  label: string;
  description: string;
  sizeMB: number;
  required: boolean;
  ok: boolean;
  error?: string;
  partialMB?: number;
}
export interface Step {
  name: 'setup' | 'generate' | 'features' | 'train';
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
  startedAt?: string;
  endedAt?: string;
  progress?: { done: number; total: number; label?: string };
  etaSeconds?: number;
}
export interface Job {
  id: string;
  word: string | null;
  status: Step['status'];
  steps: Step[];
  startedAt: string;
  endedAt?: string;
  error?: string;
}
export interface ReportRow {
  threshold: number;
  recallYourVoice: number | null;
  recallHeldOutVoice: number | null;
  falseAlarmsPerHourMusic: number | null;
  falseAlarmsPerHourValidation: number | null;
  falseAlarmsHeldOutSpeech: number;
}
export interface Report {
  name: string;
  hidden: number[];
  steps: number;
  negWeight: number;
  data: { trainPos: number; trainUser: number; trainNeg: number; acav: number };
  evaluation?: { yourPhrases: number; heldOutPhrases: number; musicHours: number; validationHours: number | null; heldOutSpeechHours: number };
  report: ReportRow[];
  createdAt: string;
}
export interface WordStatus {
  name: string;
  configUpdatedAt: string;
  tts: { pos: number; adv: number; sent: number; expected: { pos: number; adv: number; sent: number }; outdated: boolean; updatedAt: string | null };
  recordings: { pos: number; neg: number; dir: string };
  features: { counts: Record<string, number>; createdAt: string } | null;
  model: { file: string; sizeKB: number; createdAt: string } | null;
  report: Report | null;
}
export interface AppState {
  setup: SetupItem[];
  words: { name: string; phrase: string; hasModel: boolean }[];
  examples: { file: string; config: WordConfig }[];
  job: Job | null;
  genres: string[];
  cpus: number;
}

export const state = {
  app: null as AppState | null,
  voices: [] as VoiceInfo[],
  word: null as { config: WordConfig; status: WordStatus } | null,
  saving: false,
  dirty: false,
};

export async function loadApp() {
  state.app = await api<AppState>('/api/state');
  if (!state.voices.length) state.voices = await api<VoiceInfo[]>('/api/voices');
}

export async function loadWord(name: string) {
  state.word = await api<{ config: WordConfig; status: WordStatus }>(`/api/words/${name}`);
}

export async function refreshStatus() {
  if (!state.word) return;
  state.word.status = await api<WordStatus>(`/api/words/${state.word.config.name}/status`);
}

// Changes to the config are saved automatically, shortly after the last edit.
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();
export const onSaved = (fn: () => void) => listeners.add(fn);

export function changed() {
  state.dirty = true;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void save(), 700);
  document.dispatchEvent(new Event('config-changed'));
}

export async function save() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!state.word || !state.dirty) return;
  state.dirty = false;
  state.saving = true;
  try {
    const res = await api<{ status: WordStatus }>(`/api/words/${state.word.config.name}`, { method: 'PUT', body: state.word.config });
    state.word.status = res.status;
    listeners.forEach((fn) => fn());
  } catch (err) {
    toast(`Not saved: ${(err as Error).message}`, 'error');
  } finally {
    state.saving = false;
    document.dispatchEvent(new Event('config-saved'));
  }
}

export const langName = (lang: string) => state.voices.find((v) => v.lang === lang)?.langName ?? lang;

/** Languages of a config: its main language, those of its voices and those with phrases. */
export function configLangs(c: WordConfig): string[] {
  const set = new Set<string>();
  if (c.language) set.add(c.language);
  for (const v of c.voices) set.add(v.id.slice(0, 2));
  for (const k of Object.keys(c.positive)) if (c.positive[k]?.length) set.add(k);
  return [...set];
}
