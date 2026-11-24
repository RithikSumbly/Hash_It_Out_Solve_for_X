---
title: The Red Queen
emoji: 👑
colorFrom: red
colorTo: gray
sdk: gradio
sdk_version: 5.33.0
python_version: '3.12'
app_file: app.py
pinned: false
short_description: Speak to the Red Queen, a policy bred on chain
---

# The Red Queen, in person

The server behind *Speak to her* on [the arena](https://red-queen-seven.vercel.app). It runs on a Hugging Face ZeroGPU
Space: a FastAPI app mounted in Gradio, on the Space's CPU. The visitor's browser records a question (or the visitor
types it); the server screens it, asks Gemini for her answer and her actions, screens the answer, and speaks it in her
voice with Kokoro-82M (Apache-2.0, voice bf_emma). She also acts on chain from her own test wallet: real attacks on her
own vault, policy proposals graded by the Crucible, closing due rounds and sparring.

## Routes

| Route | What |
|---|---|
| `POST /api/ask {q, sid}` | Her reply: words, actions, mood, voice id |
| `POST /api/hear?sid=` (WAV) | A spoken question: streams what she heard, then her reply (NDJSON) |
| `GET /api/voice/{id}/{n}` | Sentence n of a reply as MP3; the first plays while the rest are made |
| `GET /api/attack/{job}` | An attack or proposal she is sending: running, or the contract's verdict in her words |
| `GET /api/line/{key}`, `GET /api/fillers` | Her set lines and short fillers, made at start-up |
| `POST /attack` | The film's live attack (the shape `web/lib/demo.ts` reads) |
| `POST /topup {address}` | Test ETH for a visitor's empty wallet, rate-limited |
| `GET /health` | Models, keys configured, her wallet, the last round she closed |
| `GET /alive` | A keep-alive ping that does not count as someone watching |
| `/` | A small page to try her by typing |

Browser requests are accepted only from the site's origins (`SITE_ORIGINS`); the route map is not published.

## Files

- `app.py`: the routes, the Gemini call (structured JSON, safety settings, two keys, model fallbacks with rests on
  rate limits and overloads, a hard deadline), limits per device and per network, per-visitor memory, background jobs
  for her attacks and proposals, the round keeper and the top-up.
- `prompt.md`: who she is: character, how she speaks to beginners and experts, what she admits, the numbers rule
  (only live data from this turn), what she will not do (code, advice, keys), and the actions she can take.
- `knowledge.md`, `facts.md`: her reference material about the system, loaded into every turn.
- `guard.py`: everything around the model: rate limits, text normalising (look-alike letters, invisible characters,
  leetspeak, spaced-out letters), screens for injection, code, advice, secrets and off-topic asks (a hit costs no
  model call), her set lines, the turn builder (live data reduced to plain values, the visitor's words fenced as
  untrusted), the output screen (schema, canary, code, links, AI talk, markdown, length, the action allowlist, the
  film only on request), prepared answers for newcomers, and her words for the contract's verdicts.
- `chain.py`: live numbers from Base Sepolia, her attack tool (paid money is put back at once; held payments are
  released by her keeper once due and put back; she is not a guardian), her proposals to the Crucible (clamped to the
  monotone rule first), and the round keeper (closes a due round that saw activity, closes quiet rounds on a
  schedule, and spars after a quiet close).
- `voice.py`: Kokoro on two CPU threads, one sentence at a time.
- `clone.py`: one line in the visitor's own voice (Qwen3-TTS 1.7B Base on a borrowed ZeroGPU slot), made once she
  has heard about ten seconds of them; the recordings stay in memory and are dropped once it is made.
- `abi/`, `deployment.json`: the contracts she talks to.
- `test_guard.py`: questions that must pass, attack phrasings that must not, actions, limits and verdict wording.

## Configuration

Secrets go in the Space settings, never in code. See [`.env.example`](.env.example) for the full list.

| Variable | Required | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | yes | Her answers (Google AI Studio key) |
| `DEMO_PRIVATE_KEY` | for on-chain moves | Her test wallet: attacks, proposals, closes, top-ups |
| `GEMINI_API_KEY_2` | no | A second key, used when the first is rate-limited |
| `GEMINI_LITE_MODELS`, `GEMINI_DEEP_MODELS` | no | Comma-separated model ids for quick and deeper turns |
| `PRESENTER_KEY` | no | Devices opened once with `?presenter=<key>` are never rate-limited |
| `RPC_URL`, `LOGS_RPC_URL` | no | Base Sepolia RPC and a wide-range logs gateway |
| `DAILY_BUDGET`, `NET_PER_MIN`, `NET_PER_DAY` | no | Model budget and per-network limits |
| `FILM_PER_HOUR`, `FILM_PER_NET_HOUR` | no | The film's live attacks |
| `KEEP_WATCHED_S`, `KEEP_QUIET_S`, `KEEP_SPAR`, `SPAR_STAKE_EVERY_S` | no | The keeper's schedule |
| `TOPUP_ETH`, `TOPUP_PER_DAY`, `TOPUP_PER_NET_HOUR`, `TOPUP_RESERVE_ETH` | no | The visitor top-up |
| `SITE_ORIGINS` | no | Origins allowed to call her from a browser |
| `QUEEN_DEPLOYMENT` | no | Another deployment file, e.g. a local chain's |

## Run and test

```bash
python3 -m pip install -r requirements.txt
GEMINI_API_KEY=... python3 app.py
```

```bash
python3 -m pytest -q test_guard.py
```
