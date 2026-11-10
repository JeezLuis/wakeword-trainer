import { h, lines, section } from '../dom.ts';
import { nextButton } from '../main.ts';
import { playButton } from '../preview.ts';
import { changed, configLangs, langName, state } from '../state.ts';
import { DEFAULT_SENTENCES, suggestAdversarial, suggestPositives } from '../../src/catalog.ts';

let currentLang = '';

export async function phrasesView() {
  const c = state.word!.config;
  const langs = configLangs(c);
  if (!langs.includes(currentLang)) currentLang = c.language && langs.includes(c.language) ? c.language : langs[0];
  const body = h('div');
  const tabs = h('div', { class: 'tabs' });

  const draw = () => {
    tabs.replaceChildren(
      ...langs.map((l) =>
        h(
          'button',
          {
            class: l === currentLang ? 'tab active' : 'tab',
            onclick: () => {
              currentLang = l;
              draw();
            },
          },
          langName(l),
          l === c.language ? h('span', { class: 'badge' }, 'main') : null,
        ),
      ),
    );
    body.replaceChildren(langPanel(currentLang));
  };
  draw();

  return h(
    'div',
    null,
    h('h1', null, 'Phrases'),
    h(
      'p',
      { class: 'lead' },
      'What the synthetic voices will say. Three lists per language: the wake word itself, near-misses that must not trigger it, and everyday sentences. Use ▶ to hear how a voice pronounces each line.',
    ),
    langs.length > 1 ? tabs : null,
    body,
    nextButton('phrases'),
  );
}

function langPanel(lang: string) {
  const c = state.word!.config;
  const native = lang === c.language;
  const catalog = state.voices.filter((v) => v.lang === lang);
  const chosen = c.voices.filter((v) => v.id.startsWith(`${lang}_`)).map((v) => v.id);
  let voice = chosen[0] ?? catalog[0]?.id ?? '';
  const voiceSelect = h(
    'select',
    { onchange: (e: Event) => (voice = (e.target as HTMLSelectElement).value) },
    [...chosen, ...catalog.map((v) => v.id).filter((id) => !chosen.includes(id))].map((id) => {
      const v = state.voices.find((x) => x.id === id);
      return h('option', { value: id }, `${id}${v && v.speakers > 1 ? ` (${v.speakers} speakers)` : ''}${chosen.includes(id) ? '' : ' — not selected'}`);
    }),
  );
  const getVoice = () => voice;

  // ─── Positive spellings: a list of inputs, each with ▶
  c.positive[lang] ??= [];
  const posList = h('div', { class: 'list' });
  const drawPos = () => {
    posList.replaceChildren(
      ...c.positive[lang].map((p, i) => {
        const input = h('input', {
          type: 'text',
          value: p,
          oninput: (e: Event) => {
            c.positive[lang][i] = (e.target as HTMLInputElement).value;
            changed();
          },
          onblur: () => {
            c.positive[lang] = c.positive[lang].map((x) => x.trim()).filter(Boolean);
            changed();
          },
        });
        return h(
          'div',
          { class: 'list-row' },
          input,
          playButton(getVoice, () => input.value),
          h(
            'button',
            {
              class: 'icon ghost',
              title: 'Remove',
              onclick: () => {
                c.positive[lang].splice(i, 1);
                changed();
                drawPos();
              },
            },
            '✕',
          ),
        );
      }),
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            class: 'ghost',
            onclick: () => {
              c.positive[lang].push('');
              drawPos();
              (posList.querySelector('.list-row:last-of-type input') as HTMLInputElement | null)?.focus();
            },
          },
          '+ Add a spelling',
        ),
        !c.positive[lang].length && c.phrase
          ? h(
              'button',
              {
                class: 'ghost',
                onclick: () => {
                  c.positive[lang] = suggestPositives(c.phrase!, native);
                  changed();
                  drawPos();
                },
              },
              'Fill in from the wake word',
            )
          : null,
      ),
    );
  };
  drawPos();

  // ─── Text areas (one phrase per line)
  const area = (key: 'adversarial' | 'sentences', rows: number) => {
    c[key][lang] ??= [];
    const count = h('span', { class: 'muted' });
    const ta = h('textarea', {
      rows,
      spellcheck: false,
      value: c[key][lang].join('\n'),
      oninput: () => {
        c[key][lang] = lines(ta.value);
        count.textContent = `${c[key][lang].length} phrases`;
        changed();
      },
    });
    count.textContent = `${c[key][lang].length} phrases`;
    const set = (list: string[]) => {
      c[key][lang] = [...new Set(list)];
      ta.value = c[key][lang].join('\n');
      count.textContent = `${c[key][lang].length} phrases`;
      changed();
    };
    return { ta, count, set };
  };
  const adv = area('adversarial', 12);
  const sent = area('sentences', 10);
  const tryInput = h('input', { type: 'text', placeholder: 'Type anything to hear it…' });

  return h(
    'div',
    null,
    h('div', { class: 'card voice-picker' }, h('label', null, `Voice for ▶ (${langName(lang)})`, voiceSelect), h('div', { class: 'list-row' }, tryInput, playButton(getVoice, () => tryInput.value))),
    section(
      'The wake word',
      native
        ? 'Different ways of writing it: punctuation and capitals change the intonation. Every line is used.'
        : `For ${langName(lang)} voices, write how it sounds with ${langName(lang)} spelling (e.g. "hey tor keh"), and listen until it sounds right.`,
      posList,
    ),
    section(
      'Near-misses — must NOT trigger',
      'Phrases that sound similar: parts of the wake word, similar names, the key word inside a sentence. The most effective way to reduce false alarms. Check the suggestions: none of them should be the wake word.',
      adv.ta,
      h(
        'div',
        { class: 'row' },
        adv.count,
        c.phrase
          ? h('button', { class: 'ghost', onclick: () => adv.set([...c.adversarial[lang], ...suggestAdversarial(c.phrase!, lang)]) }, 'Add suggestions')
          : null,
      ),
    ),
    section(
      'Everyday sentences — must NOT trigger',
      native
        ? 'Ordinary speech, ideally what people say where the device will be. Replace or add to the defaults.'
        : 'Optional for helper voices: leave empty to use these voices only for the wake word and near-misses.',
      sent.ta,
      h('div', { class: 'row' }, sent.count, DEFAULT_SENTENCES[lang] ? h('button', { class: 'ghost', onclick: () => sent.set([...c.sentences[lang], ...DEFAULT_SENTENCES[lang]]) }, 'Add default sentences') : null),
    ),
  );
}
