/**
 * Shared by the pipeline and the web app (no Node imports here): the config format, phrase
 * suggestions for a new wake word, default sentences per language and how many clips each
 * voice gets.
 */

export interface VoiceSpec {
  /** Piper voice id, e.g. "en_US-libritts_r-medium". Its first two letters are the language. */
  id: string;
  speakers: number;
  /** Clips to generate of the wake word, of near-misses and of ordinary sentences. */
  pos: number;
  adv: number;
  sent: number;
}

export interface WordConfig {
  /** Identifier, used for folders and the model file: lowercase, digits and `_`. */
  name: string;
  /** How the wake word is written, for display ("Hey Nova"). */
  phrase?: string;
  description?: string;
  /** Main language of the people who will say it (two letters). */
  language?: string;
  /** Per language: how the wake word is written for voices of that language. */
  positive: Record<string, string[]>;
  /** Per language: phrases that sound similar but are NOT the wake word. */
  adversarial: Record<string, string[]>;
  /** Per language: ordinary sentences from where the model will be used. */
  sentences: Record<string, string[]>;
  voices: VoiceSpec[];
  /** Voices kept out of training, used only to measure accuracy on an unseen voice. */
  holdoutVoices: string[];
  /** Folder with your own recordings (pos/*.wav, neg/*.wav). Default: data/<name>/recordings. */
  recordings?: string;
}

export interface VoiceInfo {
  id: string;
  lang: string;
  langName: string;
  region: string;
  name: string;
  quality: string;
  speakers: number;
  sizeMB: number;
}

export const NAME_RE = /^[a-z0-9][a-z0-9_]{0,63}$/;

export function slugify(phrase: string): string {
  return (
    phrase
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 64) || 'wake_word'
  );
}

const words = (phrase: string) =>
  phrase
    .replace(/[.,!?¡¿;:"«»]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A few ways of writing the wake word (punctuation changes how the voices say it). */
export function suggestPositives(phrase: string, nativeLang: boolean): string[] {
  const w = words(phrase);
  if (!w.length) return [];
  const lower = w.join(' ').toLowerCase();
  if (!nativeLang) return [lower];
  const title = cap(w.join(' '));
  const out = [`${title}.`, title, `${title}!`, lower];
  if (w.length > 1) out.splice(1, 0, `${cap(w[0])}, ${w.slice(1).join(' ')}.`);
  return [...new Set(out)];
}

const GREETINGS: Record<string, string[]> = {
  en: ['hey', 'hi', 'okay', 'hello'],
  es: ['oye', 'hola', 'ey', 'vale'],
  fr: ['hé', 'salut', 'dis'],
  de: ['hey', 'hallo', 'okay'],
  it: ['ehi', 'ciao', 'senti'],
  pt: ['ei', 'olá', 'oi'],
  nl: ['hé', 'hallo', 'oké'],
};

const NAMES: Record<string, string[]> = {
  en: ['Jack', 'Emma', 'Nora', 'Tom', 'Lucy', 'Sam'],
  es: ['Jorge', 'María', 'Pablo', 'Lucía', 'Toni', 'Rosa'],
  fr: ['Pierre', 'Marie', 'Louis', 'Claire', 'Jean'],
  de: ['Jonas', 'Anna', 'Lukas', 'Mia', 'Paul'],
  it: ['Marco', 'Giulia', 'Luca', 'Sara', 'Paolo'],
  pt: ['João', 'Maria', 'Pedro', 'Ana', 'Rita'],
  nl: ['Daan', 'Emma', 'Sem', 'Julia', 'Lucas'],
};

/** The word inside an ordinary sentence: it must not trigger unless it is the whole phrase. */
const IN_SENTENCE: Record<string, ((w: string) => string)[]> = {
  en: [(w) => `I was talking about ${w} yesterday.`, (w) => `Is ${w} the right one?`, (w) => `${cap(w)} is not here.`],
  es: [(w) => `Ayer hablamos de ${w}.`, (w) => `¿Es ${w} el que buscas?`, (w) => `${cap(w)} no está aquí.`],
  fr: [(w) => `On parlait de ${w} hier.`, (w) => `C'est ${w}, non ?`],
  de: [(w) => `Wir haben gestern über ${w} gesprochen.`, (w) => `Ist das ${w}?`],
  it: [(w) => `Ieri parlavamo di ${w}.`, (w) => `È ${w}, vero?`],
  pt: [(w) => `Ontem falámos de ${w}.`, (w) => `É ${w}, não é?`],
  nl: [(w) => `We hadden het gisteren over ${w}.`, (w) => `Is dat ${w}?`],
};

const OTHER_ASSISTANTS = ['Hey Siri.', 'OK Google.', 'Hey Google.', 'Alexa.'];

/** Similar-sounding variants of a word: another first consonant, another final vowel, cut short. */
function nearMisses(word: string): string[] {
  const w = word.toLowerCase();
  const out = new Set<string>();
  const consonants = 'bdgklmnprst';
  const vowels = 'aeiou';
  const first = w[0];
  if (consonants.includes(first)) {
    const swaps = consonants.replace(first, '');
    for (let i = 0; i < 3; i++) out.add(swaps[(w.length * 7 + i * 3) % swaps.length] + w.slice(1));
  } else if (vowels.includes(first)) {
    out.add('t' + w);
    out.add('m' + w);
  }
  const lastVowel = [...w].map((c, i) => (vowels.includes(c) ? i : -1)).filter((i) => i >= 0).at(-1);
  if (lastVowel !== undefined) {
    const v = w[lastVowel];
    const other = vowels[(vowels.indexOf(v) + 2) % vowels.length];
    out.add(w.slice(0, lastVowel) + other + w.slice(lastVowel + 1));
  }
  if (w.length > 4) out.add(w.slice(0, Math.ceil(w.length * 0.6)));
  out.delete(w);
  return [...out];
}

/**
 * Starting list of near-misses (phrases that must NOT trigger). They are the most effective way
 * to cut false alarms. Rule-based: review them and add your own (similar names, common words).
 */
export function suggestAdversarial(phrase: string, lang: string): string[] {
  const w = words(phrase);
  if (!w.length) return [];
  const key = w.reduce((a, b) => (b.length > a.length ? b : a));
  const lead = w.length > 1 ? w.slice(0, w.indexOf(key)).join(' ') : '';
  const greet = GREETINGS[lang] ?? GREETINGS.en;
  const names = NAMES[lang] ?? NAMES.en;
  const out = new Set<string>();

  // Each part on its own.
  if (w.length > 1) for (const part of w) out.add(`${cap(part)}.`);
  // The lead-in with something else.
  if (lead) for (const n of names.slice(0, 4)) out.add(`${cap(lead)}, ${n}.`);
  else for (const g of greet.slice(0, 2)) out.add(`${cap(g)}, ${names[0]}.`);
  // Similar-sounding words, with and without the lead-in.
  for (const m of nearMisses(key)) {
    out.add(lead ? `${cap(lead)}, ${m}.` : `${cap(m)}.`);
  }
  // The key word inside ordinary sentences.
  for (const s of IN_SENTENCE[lang] ?? IN_SENTENCE.en) out.add(s(key.toLowerCase()));
  // Other assistants' wake words.
  for (const a of OTHER_ASSISTANTS) out.add(a);

  const self = new Set(suggestPositives(phrase, true).map((p) => p.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').trim()));
  return [...out].filter((p) => !self.has(p.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').trim()));
}

/** Everyday sentences: generic negatives. Replace them with sentences from where you'll use it. */
export const DEFAULT_SENTENCES: Record<string, string[]> = {
  en: [
    'What time is it?',
    'Can you turn the lights off?',
    'I need to buy milk tomorrow.',
    'Put on some music, please.',
    'Turn the volume up a little.',
    'Stop the music for a second.',
    'What is the weather like today?',
    "Let's go for a walk after lunch.",
    'Where did I leave my keys?',
    'Set a timer for ten minutes.',
    'Hello, how are you doing?',
    'Thanks, that is all for now.',
    'Could you repeat that, please?',
    'Go back to the previous step.',
    'What is the next step?',
    'I will be right back.',
    'The meeting starts at three.',
    'Can you call my mother?',
    "I don't know what happened.",
    'Did you feed the cat?',
    'The kitchen is a mess.',
    'Open the window, it is hot in here.',
    'Remind me to water the plants.',
    'How long does it take to get there?',
    "That's a really good idea.",
    'Wait a moment, I am washing my hands.',
    'We should clean the garage this weekend.',
    'Read me the last message.',
    'Turn off the TV.',
    'Good morning, did you sleep well?',
    'I think it is going to rain.',
    'Pass me the screwdriver.',
    'Write that down in the notes.',
    'How much does it cost?',
    'See you later.',
    'Okay, sounds good.',
    'Where is the remote?',
    'Make it a bit warmer in here.',
    'Pause it for a moment.',
    'Can you help me with this?',
  ],
  es: [
    '¿Qué hora es?',
    '¿Puedes apagar las luces?',
    'Mañana tengo que comprar leche.',
    'Pon algo de música, por favor.',
    'Sube un poco el volumen.',
    'Para la música un momento.',
    '¿Qué tiempo hace hoy?',
    'Vamos a dar un paseo después de comer.',
    '¿Dónde he dejado las llaves?',
    'Pon un temporizador de diez minutos.',
    'Hola, ¿qué tal estás?',
    'Gracias, eso es todo.',
    '¿Puedes repetirlo, por favor?',
    'Vuelve al paso anterior.',
    '¿Cuál es el siguiente paso?',
    'Ahora vuelvo.',
    'La reunión empieza a las tres.',
    '¿Puedes llamar a mi madre?',
    'No sé qué ha pasado.',
    '¿Le has dado de comer al gato?',
    'La cocina está hecha un desastre.',
    'Abre la ventana, que hace calor.',
    'Recuérdame regar las plantas.',
    '¿Cuánto se tarda en llegar?',
    'Esa es una idea muy buena.',
    'Espera un momento, que me lavo las manos.',
    'Este fin de semana hay que limpiar el garaje.',
    'Léeme el último mensaje.',
    'Apaga la tele.',
    'Buenos días, ¿has dormido bien?',
    'Creo que va a llover.',
    'Pásame el destornillador.',
    'Apúntalo en las notas.',
    '¿Cuánto cuesta?',
    'Hasta luego.',
    'Vale, me parece bien.',
    '¿Dónde está el mando?',
    'Sube un poco la calefacción.',
    'Páralo un momento.',
    '¿Me ayudas con esto?',
  ],
  fr: [
    'Quelle heure est-il ?',
    'Tu peux éteindre la lumière ?',
    'Je dois acheter du lait demain.',
    'Mets un peu de musique, s’il te plaît.',
    'Monte un peu le son.',
    'Arrête la musique une seconde.',
    'Quel temps fait-il aujourd’hui ?',
    'On va se promener après le déjeuner.',
    'Où est-ce que j’ai mis mes clés ?',
    'Mets un minuteur de dix minutes.',
    'Bonjour, comment ça va ?',
    'Merci, c’est tout.',
    'Tu peux répéter, s’il te plaît ?',
    'Quelle est la prochaine étape ?',
    'Je reviens tout de suite.',
    'La réunion commence à trois heures.',
    'Je ne sais pas ce qui s’est passé.',
    'Ouvre la fenêtre, il fait chaud.',
    'C’est une très bonne idée.',
    'Attends un moment.',
    'Éteins la télé.',
    'Je crois qu’il va pleuvoir.',
    'Passe-moi le tournevis.',
    'Combien ça coûte ?',
    'À plus tard.',
  ],
  de: [
    'Wie spät ist es?',
    'Kannst du das Licht ausmachen?',
    'Ich muss morgen Milch kaufen.',
    'Mach bitte etwas Musik an.',
    'Mach es ein bisschen lauter.',
    'Halt die Musik kurz an.',
    'Wie ist das Wetter heute?',
    'Lass uns nach dem Essen spazieren gehen.',
    'Wo habe ich meine Schlüssel gelassen?',
    'Stell einen Timer auf zehn Minuten.',
    'Hallo, wie geht es dir?',
    'Danke, das ist alles.',
    'Kannst du das bitte wiederholen?',
    'Was ist der nächste Schritt?',
    'Ich bin gleich zurück.',
    'Das Meeting beginnt um drei.',
    'Ich weiß nicht, was passiert ist.',
    'Mach das Fenster auf, es ist warm hier.',
    'Das ist eine sehr gute Idee.',
    'Warte einen Moment.',
    'Schalte den Fernseher aus.',
    'Ich glaube, es wird regnen.',
    'Gib mir mal den Schraubenzieher.',
    'Wie viel kostet das?',
    'Bis später.',
  ],
  it: [
    'Che ore sono?',
    'Puoi spegnere la luce?',
    'Domani devo comprare il latte.',
    'Metti un po’ di musica, per favore.',
    'Alza un po’ il volume.',
    'Ferma la musica un attimo.',
    'Che tempo fa oggi?',
    'Andiamo a fare una passeggiata dopo pranzo.',
    'Dove ho lasciato le chiavi?',
    'Imposta un timer di dieci minuti.',
    'Ciao, come stai?',
    'Grazie, è tutto.',
    'Puoi ripetere, per favore?',
    'Qual è il prossimo passo?',
    'Torno subito.',
    'La riunione inizia alle tre.',
    'Non so cosa sia successo.',
    'Apri la finestra, fa caldo.',
    'È un’ottima idea.',
    'Aspetta un momento.',
    'Spegni la televisione.',
    'Credo che pioverà.',
    'Passami il cacciavite.',
    'Quanto costa?',
    'A più tardi.',
  ],
  pt: [
    'Que horas são?',
    'Podes apagar a luz?',
    'Amanhã tenho de comprar leite.',
    'Põe um pouco de música, por favor.',
    'Aumenta um pouco o volume.',
    'Para a música um momento.',
    'Como está o tempo hoje?',
    'Vamos dar uma volta depois do almoço.',
    'Onde deixei as chaves?',
    'Põe um temporizador de dez minutos.',
    'Olá, como estás?',
    'Obrigado, é tudo.',
    'Podes repetir, por favor?',
    'Qual é o próximo passo?',
    'Volto já.',
    'A reunião começa às três.',
    'Não sei o que aconteceu.',
    'Abre a janela, está calor.',
    'É uma ótima ideia.',
    'Espera um momento.',
    'Desliga a televisão.',
    'Acho que vai chover.',
    'Passa-me a chave de fendas.',
    'Quanto custa?',
    'Até logo.',
  ],
  nl: [
    'Hoe laat is het?',
    'Kun je het licht uitdoen?',
    'Ik moet morgen melk kopen.',
    'Zet wat muziek aan, alsjeblieft.',
    'Zet het volume wat hoger.',
    'Zet de muziek even stil.',
    'Wat voor weer is het vandaag?',
    'Laten we na de lunch gaan wandelen.',
    'Waar heb ik mijn sleutels gelaten?',
    'Zet een timer van tien minuten.',
    'Hallo, hoe gaat het?',
    'Dank je, dat was het.',
    'Kun je dat herhalen?',
    'Wat is de volgende stap?',
    'Ik ben zo terug.',
    'De vergadering begint om drie uur.',
    'Ik weet niet wat er gebeurd is.',
    'Doe het raam open, het is warm.',
    'Dat is een heel goed idee.',
    'Wacht even.',
    'Zet de televisie uit.',
    'Ik denk dat het gaat regenen.',
    'Geef me de schroevendraaier even.',
    'Hoeveel kost het?',
    'Tot straks.',
  ],
};

// ───────── How much audio to generate ─────────

export const PRESETS = {
  quick: { label: 'Quick test', factor: 0.25, hint: 'A rough model in well under an hour. Good to check that everything works.' },
  standard: { label: 'Standard', factor: 1, hint: 'Recommended. Around 5,000 clips with the default voices.' },
  large: { label: 'Large', factor: 2, hint: 'More variety, slower. Worth it once the phrases are right.' },
} as const;
export type Preset = keyof typeof PRESETS;

/** Clips for one voice: more with more speakers (variety is what helps), within limits. */
export function voiceCounts(speakers: number, primary: boolean, factor: number): { pos: number; adv: number; sent: number } {
  const pos = Math.min(900, Math.max(120, Math.round(6 * speakers)));
  const adv = Math.min(300, Math.max(100, Math.round(pos * 0.4)));
  const r = (n: number) => Math.max(10, Math.round(n * factor));
  return { pos: r(pos), adv: r(adv), sent: primary ? r(40) : 0 };
}

const QUALITY_RANK: Record<string, number> = { high: 3, medium: 2, low: 1, x_low: 0 };

/**
 * Default voices for a language: every multi-speaker voice plus a few single-speaker ones,
 * one model per speaker (the best quality available).
 */
export function defaultVoices(catalog: VoiceInfo[], lang: string, maxSingle = 6): VoiceInfo[] {
  const best = new Map<string, VoiceInfo>();
  // "_r" voices are trained on restored (cleaner) recordings: prefer them over a higher quality setting.
  const rank = (v: VoiceInfo) => QUALITY_RANK[v.quality] + (v.name.endsWith('_r') ? 1.5 : 0);
  for (const v of catalog.filter((x) => x.lang === lang)) {
    const key = `${v.region}-${v.name.replace(/_r$/, '')}`;
    const cur = best.get(key);
    if (!cur || rank(v) > rank(cur) || (rank(v) === rank(cur) && v.speakers > cur.speakers)) best.set(key, v);
  }
  const all = [...best.values()].filter((v) => v.quality !== 'x_low' || [...best.values()].length < 3);
  const multi = all.filter((v) => v.speakers > 1).sort((a, b) => b.speakers - a.speakers);
  const single = all.filter((v) => v.speakers === 1).sort((a, b) => QUALITY_RANK[b.quality] - QUALITY_RANK[a.quality] || a.id.localeCompare(b.id));
  // Spread single-speaker voices across regions (en_US, en_GB…).
  const picked: VoiceInfo[] = [];
  const regions = [...new Set(single.map((v) => v.region))];
  for (let i = 0; picked.length < maxSingle && i < single.length; i++) {
    for (const r of regions) {
      const next = single.filter((v) => v.region === r && !picked.includes(v))[0];
      if (next && picked.length < maxSingle) picked.push(next);
    }
  }
  return [...multi, ...picked];
}

/** Held-out voice: a single-speaker voice of the main language (not the only one). */
export function pickHoldout(voices: VoiceSpec[], lang: string): string[] {
  const same = voices.filter((v) => v.id.startsWith(`${lang}_`));
  if (same.length < 2) return [];
  const single = same.filter((v) => v.speakers === 1);
  return [(single.at(-1) ?? same.at(-1))!.id];
}

/** Rough time estimates, for planning (they depend a lot on the machine). */
export const CLIPS_PER_SECOND = 5;
