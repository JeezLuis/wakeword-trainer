# wakeword-trainer

Train your own wake word ("Hey Nova", "OK Computer", "Oye Lumen"…) for [openWakeWord](https://github.com/dscripka/openWakeWord), entirely on your computer. No Colab, no GPU, no accounts, no AI services: a local web app walks you through it, then you leave it running and come back to review the result.

The output is a standard `.onnx` model with the same shape as openWakeWord's own: input `[batch, 16, 96]` (openWakeWord features), output `[batch, 1]` (a score from 0 to 1). It works with the openWakeWord Python library and with anything else that runs openWakeWord models.

It follows the same recipe as openWakeWord's official training notebook, with three additions:

- **Voices in the language of the wake word.** Speech is generated with [Piper](https://github.com/rhasspy/piper) voices in any of its ~30 languages, optionally plus English multi-speaker voices (hundreds of speakers, including non-native ones) with a phonetic spelling you can tune by ear.
- **Your own voice.** Record yourself (and others) in the browser; those recordings get extra weight in training and part of them is held out to measure accuracy on real voices.
- **Built for noisy rooms.** Half of the training examples are mixed with music (GTZAN, ten genres) at loud levels, plus noise, background chatter, room echo and cheap-microphone filters.

## Quick start

Requirements: [Node.js](https://nodejs.org/) 24 or newer (it runs TypeScript directly), ~4 GB of free disk space, and a few hours of CPU time for a full model. Developed and tested on Linux (including WSL); macOS and Windows should work but are untested.

```bash
git clone <this repository>
cd wakeword-trainer
npm install
npm start
```

Open <http://localhost:7700> and follow the steps:

1. **Setup** — downloads what training needs, once (~2.5 GB, resumable): headless Chromium for the voices, openWakeWord's base models, the GTZAN music dataset, pre-computed negative features (ACAV100M) and openWakeWord's validation set.
2. **Wake word** — type the phrase and the main language. A config with suggested phrases and voices is created for you.
3. **Phrases** — how the wake word is written (per language), near-misses that must not trigger it, and everyday sentences. Suggestions are generated with simple rules; press ▶ to hear any line spoken by any voice.
4. **Voices** — which Piper voices to use, how many clips each, and which voice to hold out for testing.
5. **Your voice** — optional but recommended: record ~30 takes of the wake word and ~20 of other phrases with your microphone (or upload WAV files).
6. **Train** — generate speech, compute features, train. Progress and logs stream live. You can close the tab; it keeps running as long as `npm start` does.
7. **Results** — suggested threshold, a report of detections vs. false alarms per hour, a live test with your microphone (optionally over music), random clips of the training data to check pronunciation, and the `.onnx` download.

`npm start -- --port 7701` changes the port. The server listens on `127.0.0.1` only.

## Using the model

```python
# pip install openwakeword
from openwakeword.model import Model

model = Model(wakeword_models=["hey_nova.onnx"], inference_framework="onnx")
score = model.predict(frame)["hey_nova"]   # frame: 1280 samples (80 ms) of 16 kHz int16 audio
if score > 0.5:                              # use the threshold suggested in Results
    print("Wake word!")
```

## How it works

```
configs/<name>.json
   │
   ├─ 1. generate   Piper (in headless Chromium) → data/<name>/tts/{pos,adv,sent}/*.wav
   │                 the wake word, near-misses, ordinary sentences; random speaker, speed
   │                 and intonation for every clip
   │
   ├─ 2. features   continuous "episodes": background + phrase + background, with music,
   │                 noise, chatter, room echo, microphone filters, pitch and volume at random
   │                 → openWakeWord's feature pipeline in streaming mode (as in real time)
   │                 → labelled 16 × 96 windows: positive right after the wake word ends,
   │                   negative for background only or any other phrase
   │
   └─ 3. train      small network (1536 → 64 → 32 → 1), Adam, hard-negative mining,
                     negatives from ACAV100M (~170 h of varied audio) as well as ours
                     → evaluation on held-out data → out/<name>.onnx + out/<name>.report.json
```

Evaluation only uses data the model has not seen: a whole held-out voice, one in five of your recordings, 10 songs of each genre and openWakeWord's 11 h validation set. The report gives, for each threshold, the share of wake words detected and the false alarms per hour (on music and on the validation set).

Everything lives in two folders, both ignored by git: `data/` (downloads, generated speech, features, your recordings under `data/<name>/recordings/`) and `out/` (models and reports).

## Command line

The web app runs these same scripts; you can also use them directly.

```bash
npm run setup                                         # downloads (resumable)
npm run generate -- --config configs/hey_nova.json    # ~15 min with 4 tabs; resumes where it stopped
npm run features -- --config configs/hey_nova.json    # minutes, uses all cores but two
npm run train    -- --config configs/hey_nova.json    # ~20 min; prints the report
```

Options: `--pages N` and `--fresh` (generate), `--workers N` (features), `--steps 10000 --hidden 64,32 --neg-weight 30` (train), `--limit N` (generate, features: a quick trial run).

Testing tools:

```bash
npm run test-clip -- clip.wav --model out/hey_nova.onnx [--music rock --snr 5]   # score over time
npm run compare -- out/a.onnx out/b.onnx --config configs/hey_nova.json          # models side by side
npm run mix-test-audio -- long.wav 8 take1.wav take2.wav                          # phrases over music
```

### Config format

See [`configs/examples/hey-nova.json`](configs/examples/hey-nova.json). Configs you create are saved as `configs/<name>.json` (ignored by git).

| Field | Meaning |
| --- | --- |
| `name` | Id for folders and the model file: lowercase letters, digits, `_`. |
| `phrase`, `description`, `language` | Display name, notes and main language (two letters). |
| `positive` | Per language: how the wake word is written for voices of that language. For voices of another language, write the sounds (`"hey tor keh"`). |
| `adversarial` | Per language: phrases that sound similar but are not the wake word. The single most effective way to reduce false alarms. |
| `sentences` | Per language: ordinary sentences from where the model will be used. |
| `voices` | Piper voices (`id`, `speakers`) and how many clips of each kind (`pos`, `adv`, `sent`). |
| `holdoutVoices` | Voices used only for evaluation. |
| `recordings` | Optional: folder with your recordings (`pos/*.wav`, `neg/*.wav`), relative to the repository. Default `data/<name>/recordings`. |

## Tips

- **Choose a good wake word**: 3–4 syllables or more, distinct sounds, not a common word or name. Two words ("Hey Nova") work better than one.
- **Listen before training**: in Phrases, ▶ a few voices of each language. If the word is mispronounced, change its spelling for that language.
- **Start with "Quick test"** in Voices to check everything end to end, then train the Standard size.
- **Too many false alarms**: add near-misses (especially whatever triggered it), record "other phrases", raise the threshold, or raise the false alarm penalty (Train → Advanced).
- **Misses you**: record more takes (distances, speeds, people, the actual microphone), and add spellings.

## Troubleshooting

- **Chromium does not start on Linux** (`error while loading shared libraries: libnspr4.so` or similar): with admin rights, `sudo npx playwright install-deps chromium`. Without them, on Debian/Ubuntu, Setup fetches the missing libraries itself with `apt-get download` into `data/syslibs/` and uses them from there.
- **A download was interrupted**: run Setup again; it resumes.
- **Piper voices download slowly the first time**: each voice is 20–120 MB, fetched from Hugging Face once and cached (by the headless browser in `data/browser/`, and separately by your own browser for the ▶ previews).

## License

The code is released under the [MIT License](LICENSE): use it, change it and share it freely.

This repository contains code only. The data it downloads has its own terms; check them before distributing the models you train:

- Piper voices: each voice has its own license (see its model card on Hugging Face); several are trained on datasets for non-commercial use.
- [GTZAN](https://huggingface.co/datasets/marsyas/gtzan): research dataset of copyrighted music.
- [openWakeWord features](https://huggingface.co/datasets/davidscripka/openwakeword_features) (ACAV100M, validation set) and base models: see openWakeWord's repository.

## Credits

Built on [openWakeWord](https://github.com/dscripka/openWakeWord) by David Scripka (features, base models, training recipe), [Piper](https://github.com/rhasspy/piper) and [piper-tts-web](https://github.com/Mintplex-Labs/piper-tts-web), [ONNX Runtime](https://onnxruntime.ai/) and [Playwright](https://playwright.dev/).
