# The Red Queen's narration

The queen narrates the demo film herself: 14 short chapters, each shipped as an MP3 with word timings.

| path | what |
|---|---|
| [`web/public/voice/<id>.mp3`](../../web/public/voice) | `c01`–`c10`, with chapter 4 in five variants (`c04a` the attack, `c04w` waiting for a block, `c04f` the fallback, `c04r` refused, `c04p` paid). Mono MP3, 32 kHz (the site's AudioContext rate), 64 kbps CBR, LAME gapless header, no ID3 tag. |
| [`web/public/voice/manifest.json`](../../web/public/voice/manifest.json) | `voice`, `engine`, `licence`, `format`, and per clip `text`, `file`, `dur`, `words` `[{w, s, e}]`, `phrases` `[{t, s, e}]` |
| [`lines.json`](./lines.json) | the script, and the direction for every chapter and piece |
| [`reference.flac`](./reference.flac) | the 15 s voice sample Chatterbox clones (bf_emma, see below) |
| [`render.py`](./render.py) | renders everything above from `lines.json` |
| [`requirements.txt`](./requirements.txt) | the exact Python environment |

Times are seconds from the start of the MP3. Each `words` entry is one space-separated word of the
text with its punctuation attached, so `words.map(w => w.w).join(" ") === text`. `phrases` are the
sentences (split after `. ! ? :`).

## Engine and voice

- **Engine:** [Chatterbox](https://github.com/resemble-ai/chatterbox) by Resemble AI, `chatterbox-tts`
  0.1.7, English model `ResembleAI/chatterbox` pinned at commit
  `5bb1f6ee58e50c3b8d408bc82a6d3740c2db6e18` (`t3_cfg.safetensors` 0.5B Llama-style text-to-speech-token
  model, `s3gen.safetensors` flow-matching decoder and HiFT vocoder, `ve.safetensors` voice encoder,
  `tokenizer.json`). **Licence: MIT** (code and weights). Runs on the CPU (torch 2.6.0).
- **Voice:** zero-shot cloning of `reference.flac`: six sentences of bf_emma, a British voice from Kokoro-82M
  (Apache-2.0), 15.2 s, clean and dry, chosen for the widest pitch movement.
- **Watermark:** every piece carries Resemble AI's Perth watermark (inaudible; Chatterbox adds it to all
  its output).

## Direction

`lines.json` gives each chapter a `note` (the intended delivery) and its pieces: usually one sentence
each. A piece can set:

| key | what |
|---|---|
| `exaggeration` | Chatterbox's emotional intensity (0.25–2; default 0.5). Higher is livelier and quicker. |
| `cfg_weight` | Chatterbox's guidance (default 0.5) |
| `temperature` | sampling temperature (default 0.8) |
| `end` | the ending the take must have: `fall`, `low` (a firm fall), `cont` (a list item: level or rising) or `rise` (the question). Default from the punctuation. |
| `stress` | words whose pitch peak is measured |
| `pace` | target syllables per second while speaking (default 5.6) |
| `pause` | silence after the piece, in seconds |
| `say` | a different string for the engine (unused; the engine reads the display text) |
| `takes` | the most attempts allowed (default 3) |

Per chapter (as rendered):

| chapter | delivery | exaggeration | pace (syl/s) | notable pieces |
|---|---|---|---|---|
| c01 | a warm, regal welcome, a slight smile on Hello; unhurried | 0.55–0.65 | 5.6 | "Hello. I'm the Red…" (ex 0.65); "I guard a vault…" (stress vault); "People try to take…" (ex 0.55) |
| c02 | wry, a little conspiratorial; the third sentence clipped, the last quietly confident with a falling end | 0.45–0.6 | 5.6 | "More and more machines…" (ex 0.55); "Attackers keep changing." (pace 6.0); "So I change too." (ex 0.45, pace 4.9, low, firm fall) |
| c03 | brisk and crisp; the eight measurements are a spoken list: the non-final items keep a light continuation rise, only the last falls; a slight lift on genome | 0.5 | 5.9 | "how big the payment…" (pace 6.1); "who's asking, whether it…" (pace 6.0); "Each of those gets…" (stress genome) |
| c04a | present-tense urgency, a touch quicker; Now watch low and firm | 0.45–0.65 | 5.8 | "Now watch." (ex 0.45, left as spoken, low, firm fall) |
| c04w | calm reassurance | 0.4 | 4.5 |  |
| c04f | matter-of-fact | 0.45 | 5.6 |  |
| c04r | analytical, building through measure, weigh and patterns; tension rising on Add it all up; a clear pause, then Refused low, firm and final; the last sentence relaxed and satisfied | 0.45–0.75 | 5.6 | "First, I measure it." (ex 0.7, stress measure); "Then I weigh each…" (ex 0.55, stress weigh, patterns); "Add it all up,…" (ex 0.75, 0.8 s after); "Refused." (ex 0.55, left as spoken, low, firm fall); "Nothing left the vault,…" (ex 0.45) |
| c04p | the same build; so this one goes through wry and grudging; I'll remember it, though with a slight edge; the last sentence resolute | 0.5–0.7 | 5.6 | "First, I measure it." (ex 0.7, stress measure); "Then I weigh each…" (ex 0.55, stress weigh, patterns); "Add it all up,…" (ex 0.6); "I'll remember it, though." (ex 0.65); "My next generation is…" (ex 0.55) |
| c05 | hushed, almost confiding | 0.35 | 5.2 |  |
| c06 | judicial and measured; the question rises at its end; The best four survive firm; The rest are eliminated plain, not gleeful | 0.4–0.6 | 5.6 | "How much would each…" (ex 0.55); "minus a heavy penalty…" (ex 0.6, must rise); "The best four survive." (ex 0.55, stress survive); "The rest are eliminated,…" (ex 0.4) |
| c07 | wonder and pride; takes the crown swells a little; the last sentence intimate | 0.4–0.7 | 5.6 | "Each gene comes from…" (ex 0.7, stress crown); "Even my shape changes…" (ex 0.4) |
| c08 | grim determination; As the old line goes introduces the Carroll line, said as a quote, slower and more deliberate; That's the race we're in plain and resolute | 0.5–0.55 | 5.6 | "it takes all the…" (ex 0.5, pace 4.8); "That's the race we're…" (ex 0.5) |
| c09 | plain and confident, a beat after the first sentence | 0.45 | 5.8 | "None of this runs…" (0.65 s after) |
| c10 | friendly and inviting; a light challenge on see if you can get anything past me, not theatrical | 0.55–0.6 | 5.6 | "Pick an attack, and…" (ex 0.6) |

## How a chapter is made

1. **One take per piece.** Chatterbox speaks the piece (seeded, so it is reproducible).
   wav2vec2-base-960h reads it back (greedy CTC) and force-aligns its words, and pYIN tracks its
   pitch. Whisper small.en checks the finished clips separately, so the render stays within this
   machine's memory.
2. **A second take only when the first fails a check:**
   - the words read back differ by more than 12 % of characters, or a word cannot be aligned;
   - the pitch range (5th to 95th percentile) is under 6.9 semitones (4 semitones for pieces under five
     words);
   - the ending is wrong: a statement that rises, a list item that drops more than 1.5 semitones, or a
     question that doesn't rise;
   - a stressed word has no pitch lift (under 1.5 st above the piece's median);
   - the take is more than 15 % quicker than its piece's `pace`;
   - the take is cut off.

   There are at most 3 takes (4 or 6 where `takes` says so). When none passes, the best-scoring take is kept.
   Identical pieces share seeds and takes, so the first two sentences of `c04r` and `c04p` are the
   same recording. A take that never stops is cut off by a token budget of twice a slow reading.
3. **Natural speed.** Every take keeps the speed it was spoken at (`MAX_SLOW = 1.0` in `render.py`). Pace comes
   from choosing takes: a take more than 15 % quicker than its piece's `pace` fails and is rendered again
   (`MAX_QUICK`). The shipped render: all 14 clips at 2.4 to 3.4 words a second, every word heard by the aligner.
4. **Assembly.** Each piece is trimmed to its sound (30 ms before, 60 ms after, short fades), set to
   the same speech level, and joined with its `pause`:
   - 0.2 s inside the list;
   - 0.35–0.55 s between sentences;
   - 0.65 s for the beat in `c09`;
   - 0.8 s before "Refused.".

   The joins all fall in silence, and the pieces are clean, so no room tone is needed.
5. **Processing:** pre-level to -20 LUFS; ffmpeg `highpass=f=70`, high shelf -3 dB at 7 kHz,
   `acompressor` 2:1 above -24 dB; resample to 32 kHz; trim to 40 ms before and 120 ms after the sound;
   -18 LUFS measured on the MP3 by ffmpeg's EBU R128 meter; a look-ahead true-peak limiter keeps it at or
   under -1 dBTP; libmp3lame CBR 64 kbps.
6. **Word timings:** forced alignment of each piece's exact words (wav2vec2-base-960h, CTC Viterbi over
   characters, 20 ms frames). A word ends where the next begins, or where its sound dies away before a
   pause. Times are shifted by each piece's place in the chapter and by the trim.

## Re-rendering

```bash
# once: a Python 3.12 environment outside the repo
uv venv --python 3.12 /tmp/redqueen-voice/venv
uv pip install --python /tmp/redqueen-voice/venv/bin/python -r tools/voice/requirements.txt

# every chapter (the first run downloads ~3.6 GB of pinned weights into HF_HOME, outside the repo)
HF_HOME=/tmp/redqueen-voice/hf /tmp/redqueen-voice/venv/bin/python tools/voice/render.py

# one chapter: its MP3 is rewritten and its manifest entry replaced, the rest are kept
HF_HOME=/tmp/redqueen-voice/hf /tmp/redqueen-voice/venv/bin/python tools/voice/render.py --only c06

# list the pieces and their direction
/tmp/redqueen-voice/venv/bin/python tools/voice/render.py --pieces
```

Takes are cached in `--work` (default `$TMPDIR/redqueen-voice-takes`), so changing one piece's
direction only re-renders that piece. `--keep <dir>` writes each chapter's assembled WAV and a log
of every take (what Whisper heard, pitch range, ending, rate, and why a take was redone).

A full render of all 14 chapters takes about 50 minutes on an Apple M4, on the CPU at `nice -n 20`, with
6 threads: about 6x real time per take, one take for most pieces. A re-assembly from cached takes takes
about 10 minutes.

## Licences and credit

| part | licence | shipped? |
|---|---|---|
| Chatterbox code and weights (Resemble AI) | MIT | no; only the audio it made |
| Perth watermarker (`resemble-perth`) | MIT | no |
| S3 tokenizer (`s3tokenizer`) | Apache-2.0 | no |
| Reference voice: Kokoro-82M `bf_emma` (hexgrad) | Apache-2.0 | no |
| wav2vec2-base-960h (word alignment) | Apache-2.0 | no |
| Whisper small.en (checks) | Apache-2.0 (model card) | no |
| torch, transformers, librosa, scipy | BSD / Apache-2.0 / ISC | no |

Nothing non-commercial is used. Using the audio on a public site is fine.

Suggested credit: "Narration: synthetic voice made with Chatterbox by Resemble AI (MIT), cloned from
the Kokoro-82M voice bf_emma (Apache-2.0)." The clips carry Resemble AI's Perth watermark.
