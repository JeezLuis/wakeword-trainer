import { api } from '../api.ts';
import { h, section, toast } from '../dom.ts';
import { go, nextButton, renderNav } from '../main.ts';
import { changed, loadApp, state } from '../state.ts';
import {
  DEFAULT_SENTENCES,
  NAME_RE,
  PRESETS,
  defaultVoices,
  pickHoldout,
  slugify,
  suggestAdversarial,
  suggestPositives,
  voiceCounts,
  type WordConfig,
} from '../../src/catalog.ts';

const POPULAR = ['en', 'es', 'fr', 'de', 'it', 'pt', 'nl'];

function languageOptions(selected: string) {
  const langs = [...new Map(state.voices.map((v) => [v.lang, v.langName])).entries()].sort((a, b) => {
    const pa = POPULAR.indexOf(a[0]);
    const pb = POPULAR.indexOf(b[0]);
    return (pa < 0 ? 99 : pa) - (pb < 0 ? 99 : pb) || a[1].localeCompare(b[1]);
  });
  return langs.map(([code, name]) => h('option', { value: code, selected: code === selected }, `${name} (${code})`));
}

/** A new config with sensible defaults for every step. */
export function buildConfig(phrase: string, name: string, lang: string, englishHelpers: boolean, description: string): WordConfig {
  const c: WordConfig = { name, phrase, description, language: lang, positive: {}, adversarial: {}, sentences: {}, voices: [], holdoutVoices: [] };
  const langs = [lang, ...(englishHelpers && lang !== 'en' ? ['en'] : [])];
  for (const l of langs) {
    const native = l === lang;
    c.positive[l] = suggestPositives(phrase, native);
    c.adversarial[l] = suggestAdversarial(phrase, l);
    c.sentences[l] = native ? (DEFAULT_SENTENCES[l] ?? []) : [];
    for (const v of defaultVoices(state.voices, l, native ? 6 : 0)) {
      c.voices.push({ id: v.id, speakers: v.speakers, ...voiceCounts(v.speakers, c.sentences[l].length > 0, PRESETS.standard.factor) });
    }
  }
  c.holdoutVoices = pickHoldout(c.voices, lang);
  return c;
}

export async function newWordView() {
  if (!state.app) await loadApp();
  let nameTouched = false;
  const phrase = h('input', { type: 'text', placeholder: 'e.g. Hey Nova', autofocus: true, maxlength: 60 });
  const name = h('input', { type: 'text', placeholder: 'hey_nova', pattern: NAME_RE.source, oninput: () => (nameTouched = true) });
  const lang = h('select', null, languageOptions('en'));
  const helpers = h('input', { type: 'checkbox', checked: true });
  const helpersRow = h('label', { class: 'check-row' }, helpers, h('span', null, h('strong', null, 'Also use English voices'), ' — hundreds of extra speakers (including non-native ones). Recommended: you will write how the word sounds for them.'));
  const desc = h('input', { type: 'text', placeholder: 'Optional: where and how it will be used' });
  const update = () => {
    if (!nameTouched) name.value = slugify(phrase.value);
    helpersRow.hidden = lang.value === 'en';
  };
  phrase.addEventListener('input', update);
  lang.addEventListener('change', update);
  update();

  const create = async (e: Event) => {
    e.preventDefault();
    const p = phrase.value.trim();
    const n = name.value.trim();
    if (!p) return toast('Write the wake word first.', 'error');
    if (!NAME_RE.test(n)) return toast('The id can only have lowercase letters, digits and underscores.', 'error');
    if (state.app!.words.some((w) => w.name === n)) return toast(`"${n}" already exists. Pick another id.`, 'error');
    const config = buildConfig(p, n, lang.value, helpers.checked && lang.value !== 'en', desc.value.trim());
    try {
      await api(`/api/words/${n}`, { method: 'PUT', body: config });
      await loadApp();
      go(`#/w/${n}/phrases`);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  return h(
    'div',
    null,
    h('h1', null, 'New wake word'),
    h('p', { class: 'lead' }, 'Pick a phrase that is easy to say and unlikely to come up in conversation: two or three words, four or more syllables, with distinct sounds (like "Hey Nova" or "OK Computer").'),
    h(
      'form',
      { class: 'card form', onsubmit: create },
      h('label', null, 'Wake word', phrase),
      h('label', null, 'Main language (of the people who will say it)', lang),
      helpersRow,
      h('details', null, h('summary', null, 'More options'), h('label', null, 'Id (folder and model file name)', name), h('label', null, 'Description', desc)),
      h('div', { class: 'row' }, h('button', { class: 'primary', type: 'submit' }, 'Create')),
      h('p', { class: 'help' }, 'This creates a config with suggested phrases and voices. You can review and change everything in the next steps.'),
    ),
    state.app!.examples.length
      ? section(
          'Or start from an example',
          null,
          h(
            'div',
            { class: 'row' },
            state.app!.examples.map((ex) =>
              h(
                'button',
                {
                  class: 'ghost',
                  onclick: async () => {
                    if (state.app!.words.some((w) => w.name === ex.config.name)) return go(`#/w/${ex.config.name}/phrases`);
                    await api(`/api/words/${ex.config.name}`, { method: 'PUT', body: ex.config });
                    await loadApp();
                    go(`#/w/${ex.config.name}/phrases`);
                  },
                },
                ex.config.phrase ?? ex.config.name,
              ),
            ),
          ),
        )
      : null,
  );
}

export async function wordView() {
  const c = state.word!.config;
  const s = state.word!.status;
  const field = (label: string, key: 'phrase' | 'description', placeholder = '') =>
    h(
      'label',
      null,
      label,
      h('input', {
        type: 'text',
        value: c[key] ?? '',
        placeholder,
        oninput: (e: Event) => {
          c[key] = (e.target as HTMLInputElement).value;
          changed();
          if (key === 'phrase') {
            const w = state.app?.words.find((x) => x.name === c.name);
            if (w) w.phrase = c.phrase || c.name;
            renderNav();
          }
        },
      }),
    );
  return h(
    'div',
    null,
    h('h1', null, c.phrase ?? c.name),
    h(
      'section',
      { class: 'card form' },
      field('Wake word (display name)', 'phrase'),
      field('Description', 'description', 'Optional'),
      h(
        'label',
        null,
        'Main language',
        h(
          'select',
          {
            onchange: (e: Event) => {
              c.language = (e.target as HTMLSelectElement).value;
              changed();
            },
          },
          languageOptions(c.language ?? c.voices[0]?.id.slice(0, 2) ?? 'en'),
        ),
      ),
      h('p', { class: 'help' }, 'Id: ', h('code', null, c.name), ' · config: ', h('code', null, `configs/${c.name}.json`), ' · recordings: ', h('code', null, s.recordings.dir), s.model ? [' · model: ', h('code', null, s.model.file)] : null),
    ),
    nextButton('word'),
  );
}
