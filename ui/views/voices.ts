import { fmtMin, h, section } from '../dom.ts';
import { nextButton } from '../main.ts';
import { playButton } from '../preview.ts';
import { changed, configLangs, langName, state } from '../state.ts';
import { CLIPS_PER_SECOND, PRESETS, defaultVoices, pickHoldout, voiceCounts, type Preset, type VoiceSpec } from '../../src/catalog.ts';

let preset: Preset = 'standard';
let showAll: Record<string, boolean> = {};

export async function voicesView() {
  const root = h('div');
  const draw = () => root.replaceChildren(content(draw));
  draw();
  return root;
}

function counts(id: string, speakers: number) {
  const c = state.word!.config;
  return voiceCounts(speakers, (c.sentences[id.slice(0, 2)] ?? []).length > 0, PRESETS[preset].factor);
}

function content(redraw: () => void) {
  const c = state.word!.config;
  const langs = configLangs(c);
  const selected = new Map(c.voices.map((v) => [v.id, v]));
  const totals = { pos: 0, adv: 0, sent: 0 };
  for (const v of c.voices) {
    const l = v.id.slice(0, 2);
    if (c.positive[l]?.length) totals.pos += v.pos;
    if (c.adversarial[l]?.length) totals.adv += v.adv;
    if (c.sentences[l]?.length) totals.sent += v.sent;
  }
  const total = totals.pos + totals.adv + totals.sent;

  const warnings: string[] = [];
  if (!c.holdoutVoices.length) warnings.push('Pick a held-out voice: without it, the report cannot tell how well the model works on a voice it has never heard.');
  for (const l of langs) {
    const n = c.voices.filter((v) => v.id.startsWith(`${l}_`)).length;
    if (n && !c.positive[l]?.length) warnings.push(`${langName(l)} voices are selected but there is no ${langName(l)} spelling of the wake word: they will only say the other phrases.`);
  }
  const held = c.holdoutVoices[0];
  if (held && c.voices.filter((v) => v.id.slice(0, 2) === held.slice(0, 2)).length < 2) warnings.push('The held-out voice is the only one in its language: add another one, or every clip in that language is left out of training.');

  const setPreset = (p: Preset) => {
    preset = p;
    for (const v of c.voices) Object.assign(v, counts(v.id, v.speakers));
    changed();
    redraw();
  };

  const toggle = (id: string, speakers: number, on: boolean) => {
    if (on) c.voices.push({ id, speakers, ...counts(id, speakers) });
    else {
      c.voices = c.voices.filter((v) => v.id !== id);
      c.holdoutVoices = c.holdoutVoices.filter((v) => v !== id);
    }
    if (!c.holdoutVoices.length) c.holdoutVoices = pickHoldout(c.voices, c.language ?? langs[0]);
    changed();
    redraw();
  };

  const numberCell = (v: VoiceSpec, key: 'pos' | 'adv' | 'sent') =>
    h(
      'td',
      null,
      h('input', {
        type: 'number',
        min: 0,
        max: 5000,
        value: v[key],
        class: 'num',
        onchange: (e: Event) => {
          v[key] = Math.max(0, Math.round(Number((e.target as HTMLInputElement).value) || 0));
          changed();
          redraw();
        },
      }),
    );

  const langTable = (lang: string) => {
    const all = state.voices.filter((v) => v.lang === lang);
    const shown = showAll[lang] ? all : all.filter((v) => selected.has(v.id) || defaultVoices(state.voices, lang).some((d) => d.id === v.id));
    const phrase = c.positive[lang]?.[0] ?? c.phrase ?? 'Hello';
    return h(
      'section',
      { class: 'card' },
      h(
        'div',
        { class: 'card-head' },
        h('h2', null, langName(lang), ' ', h('span', { class: 'muted' }, `${c.voices.filter((v) => v.id.startsWith(`${lang}_`)).length} selected`)),
        h(
          'button',
          {
            class: 'ghost small',
            onclick: () => {
              showAll[lang] = !showAll[lang];
              redraw();
            },
          },
          showAll[lang] ? 'Show fewer' : `Show all ${all.length}`,
        ),
      ),
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'voices' },
          h('thead', null, h('tr', null, h('th', null, ''), h('th', null, 'Voice'), h('th', null, 'Speakers'), h('th', { title: 'Clips of the wake word' }, 'Wake word'), h('th', { title: 'Clips of near-misses' }, 'Near-miss'), h('th', { title: 'Clips of everyday sentences' }, 'Sentences'), h('th', { title: 'Kept out of training to test on an unseen voice' }, 'Held out'), h('th', null, ''))),
          h(
            'tbody',
            null,
            shown.map((info) => {
              const v = selected.get(info.id);
              return h(
                'tr',
                { class: v ? '' : 'off' },
                h('td', null, h('input', { type: 'checkbox', checked: !!v, onchange: (e: Event) => toggle(info.id, info.speakers, (e.target as HTMLInputElement).checked) })),
                h('td', null, h('span', { class: 'voice-id' }, `${info.region} · ${info.name}`), h('span', { class: 'muted' }, ` ${info.quality} · ${info.sizeMB} MB`)),
                h('td', null, info.speakers > 1 ? h('strong', null, info.speakers) : '1'),
                v ? [numberCell(v, 'pos'), numberCell(v, 'adv'), numberCell(v, 'sent')] : [h('td'), h('td'), h('td')],
                h(
                  'td',
                  null,
                  v
                    ? h('input', {
                        type: 'radio',
                        name: 'holdout',
                        checked: c.holdoutVoices.includes(info.id),
                        onchange: () => {
                          c.holdoutVoices = [info.id];
                          changed();
                          redraw();
                        },
                      })
                    : null,
                ),
                h('td', null, playButton(() => info.id, () => phrase, `Listen: "${phrase}"`)),
              );
            }),
          ),
        ),
      ),
    );
  };

  const otherLangs = [...new Map(state.voices.map((v) => [v.lang, v.langName])).entries()].filter(([l]) => !langs.includes(l)).sort((a, b) => a[1].localeCompare(b[1]));

  return h(
    'div',
    null,
    h('h1', null, 'Voices'),
    h(
      'p',
      { class: 'lead' },
      'Which Piper voices say the phrases, and how many clips each one makes. Variety matters more than quantity: multi-speaker voices (hundreds of different people) are the most useful. One voice is held out to test the model on a voice it has never heard.',
    ),
    section(
      'Dataset size',
      null,
      h(
        'div',
        { class: 'presets' },
        (Object.keys(PRESETS) as Preset[]).map((p) =>
          h(
            'label',
            { class: `preset ${p === preset ? 'active' : ''}` },
            h('input', { type: 'radio', name: 'preset', checked: p === preset, onchange: () => setPreset(p) }),
            h('strong', null, PRESETS[p].label),
            h('span', { class: 'help' }, PRESETS[p].hint),
          ),
        ),
      ),
      h(
        'p',
        { class: 'summary' },
        h('strong', null, total.toLocaleString('en')),
        ` clips: ${totals.pos.toLocaleString('en')} of the wake word, ${totals.adv.toLocaleString('en')} near-misses, ${totals.sent.toLocaleString('en')} sentences · about ${fmtMin(total / CLIPS_PER_SECOND)} to generate.`,
      ),
    ),
    warnings.length ? h('div', { class: 'card warn' }, h('ul', null, warnings.map((w) => h('li', null, w)))) : null,
    langs.map(langTable),
    h(
      'div',
      { class: 'row' },
      h(
        'select',
        {
          onchange: (e: Event) => {
            const l = (e.target as HTMLSelectElement).value;
            if (!l) return;
            for (const v of defaultVoices(state.voices, l, 2)) if (!selected.has(v.id)) c.voices.push({ id: v.id, speakers: v.speakers, ...counts(v.id, v.speakers) });
            c.positive[l] ??= c.phrase ? [c.phrase.toLowerCase()] : [];
            changed();
            redraw();
          },
        },
        h('option', { value: '' }, '+ Add voices of another language…'),
        otherLangs.map(([code, name]) => h('option', { value: code }, `${name} (${code})`)),
      ),
    ),
    nextButton('voices'),
  );
}
