"""
The Red Queen, in person: the Hugging Face Space behind "Speak to her" on the site.

  POST /api/hear?sid=…  (16 or 24 kHz WAV)  → the visitor spoke: what she heard, and her reply (words, actions, mood, voice)
  POST /api/ask      {q, sid}         → the visitor typed: her reply
  GET  /api/voice/{id}/{n}            → sentence n of a reply, MP3 (the site plays it through the hall's echo)
  GET  /api/attack/{job}              → an attack she is sending: running, or the contract's verdict in her words
  GET  /api/line/{key}                → one of her set lines (mic blocked, network gone…), with its voice
  GET  /api/fillers                   → "Mm.", "Let me look.", "Watch." to cover the wait
  POST /attack                        → the film's demo attack (the format the site's lib/demo.ts expects)
  POST /topup        {address}        → a judge's empty wallet gets enough test ETH for one attack (the site calls it)
  GET  /health                        → her state; the site calls it every two minutes while it is open ("watched")
  GET  /alive                         → a ping that keeps the Space awake without counting as someone watching
  /                                   → a small page to try her by typing

Every reply is screened before and after Gemini (guard.py). When she has heard enough of a visitor's own voice, she
says one fixed line in it (CLONE_LINE): the recordings stay in memory only, are used for that line and nothing
else, and are dropped once it is made.

Secrets (Space settings): GEMINI_API_KEY (and optionally GEMINI_API_KEY_2, a second project's quota); DEMO_PRIVATE_KEY (a test wallet with a little Base Sepolia ETH, for her
attacks, her round keeper and the judges' top-up); optional GEMINI_LITE_MODELS, GEMINI_DEEP_MODELS, RPC_URL, DAILY_BUDGET, TOPUP_ETH,
TOPUP_PER_DAY.
"""

from __future__ import annotations

from dataclasses import dataclass
import base64
import hmac
import inspect
import io
import ipaddress
import json
import os
import re
import threading
import time
import uuid

import numpy as np
import soundfile as sf

try:  # on a ZeroGPU Space: the app runs on the Space's CPU; only @spaces.GPU functions borrow a GPU, per call
    import spaces  # must come before anything that touches CUDA
except ImportError:  # running locally
    spaces = None

import gradio as gr
import requests
import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse
from starlette.concurrency import run_in_threadpool
from web3 import Web3

import chain
import guard
from voice import Voice

# Each key is its own Google project with its own free quota: a model that has spent one key's quota is asked with the
# next (GEMINI_API_KEY_2 is optional).
KEYS: list[str] = [k for k in (os.environ.get("GEMINI_API_KEY", ""), os.environ.get("GEMINI_API_KEY_2", "")) if k]
KEY = KEYS[0] if KEYS else ""
# Her models, as the key's project lists them (Google AI Studio, rate limits, 23 Nov 2026). Every question goes to
# Gemini 3.1 Flash-Lite first (15 a minute and 500 a day each, per key), then the other Flash-Lites, then 2.5 Flash and
# 3 Flash as last resorts: Google runs each model on its own capacity, so when one answers 503 under load another
# usually still answers, and she keeps her tools instead of a prepared line. Ids this key does not list are left out
# at start. Deep routing (a stronger model first for how and why questions) is off by default.
# GEMINI_LITE_MODELS / GEMINI_DEEP_MODELS (comma lists) override; set the second to use deep routing.
# No "-latest" aliases: they bill one of these and hide which.
_ids = lambda env, default: [m.strip() for m in os.environ.get(env, default).split(",") if m.strip()]
CHAIN: list[str] = _ids("GEMINI_LITE_MODELS", "gemini-3.1-flash-lite,gemini-3.5-flash-lite,gemini-2.5-flash-lite,gemini-2.5-flash,gemini-3-flash")
DEEP: list[str] = _ids("GEMINI_DEEP_MODELS", "")
DEEP_THINKING = int(os.environ.get("GEMINI_DEEP_THINKING", "2048"))  # reasoning tokens for a deep answer
USED = {"model": ""}
ATTEMPT_TIMEOUT = 9  # seconds before trying the next model (a quick answer)
DEEP_TIMEOUT = 20  # a reasoned answer takes longer to start; past this the model rests and the next one is asked
DEEP_DEADLINE = 15  # after this long on the stronger models, she answers with Flash-Lite at once
OPEN_DEADLINE = 28  # a visitor waits at most about this long: then a prepared answer or a set line (Google's outages)
_resting: dict[str, float] = {}  # "model" (overloaded or gone) or "model#key" (that key's quota): skipped a while
OVERLOAD_REST = 30  # a 503 is Google's load, not ours: the model is asked again soon


def _discover() -> None:
    """Checks her model ids against the key's model listing (free: it spends no quota). An id the listing doesn't
    have is swapped for its "-preview" name if that is listed, else left out; if the listing can't be read, the lists
    stay as written (a retired id answers 404 and rests an hour)."""
    try:
        r = requests.get("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
                         headers={"x-goog-api-key": KEY}, timeout=10)
        names = {m["name"].split("/", 1)[1] for m in r.json().get("models", [])}
    except Exception as e:
        print("model list unavailable:", str(e)[:120], flush=True)
        return
    if not names:
        return

    def resolve(ids: list[str]) -> list[str]:
        out = []
        for m in ids:
            if m in names:
                out.append(m)
            elif f"{m}-preview" in names:
                out.append(f"{m}-preview")
            else:
                print(f"gemini {m}: not listed for this key, left out", flush=True)
        return out or ids

    CHAIN[:] = resolve(CHAIN)
    DEEP[:] = resolve(DEEP)
    print("her models, in order:", CHAIN, "| deep:", DEEP, flush=True)


if KEY:
    threading.Thread(target=_discover, daemon=True).start()
PROMPT = guard.Prompt()
# Limits are per device (the site sends a lasting device id), so a room of judges on one Wi-Fi is not one visitor;
# a network still gets a generous ceiling, and the presenter's own devices (PRESENTER_KEY) are not limited at all.
# The daily budget sits under the two Flash-Lite quotas (500 a day each), for each key.
LIMITS = guard.Limits(per_min=8, per_day=150, budget=int(os.environ.get("DAILY_BUDGET", str(900 * max(1, len(KEYS))))))
NETWORK = guard.Limits(per_min=int(os.environ.get("NET_PER_MIN", "30")), per_day=int(os.environ.get("NET_PER_DAY", "300")),
                       budget=10**9, one_at_a_time=False)  # one network can't spend the whole day's budget
PRESENTER_KEY = os.environ.get("PRESENTER_KEY", "")
MEMORY = guard.Memory()
VOICE = Voice(threads=2)
# what she says while she thinks, by what was asked (the site picks one that fits, and never the same twice running)
FILLERS: dict[str, list[str]] = {
    "any": ["Mm.", "Let me look.", "One moment.", "Hm. Let me see.", "Give me a breath.", "Let me check the chain.",
            "Right. Let me think.", "Let me read the board."],
    "vault": ["Let me count the vault.", "Let me look at the balance.", "The vault first. One moment."],
    "record": ["Let me look at the record.", "Let me see what came in.", "Let me find that verdict."],
    "lineage": ["Let me look back through my lineage.", "Let me read my genes.", "Where to begin with my family."],
    "attack": ["Watch.", "Let me ready one.", "Very well. Stand back."],
    "self": ["Where to begin.", "Hm.", "Mm. Me."],
}
ATTACKS: dict[str, dict] = {}
MAX_WAV = 24_000 * 2 * 21 + 44  # 21 s of 24 kHz 16-bit mono
SAFETY = [{"category": c, "threshold": "BLOCK_MEDIUM_AND_ABOVE"} for c in (
    "HARM_CATEGORY_HARASSMENT", "HARM_CATEGORY_HATE_SPEECH", "HARM_CATEGORY_SEXUALLY_EXPLICIT", "HARM_CATEGORY_DANGEROUS_CONTENT")]

# What she says in the visitor's own voice, once she has heard enough of it. Fixed: the clone says this and nothing
# else. Her genome is public on chain, so she never claims she can't be copied; she claims she outruns copies.
# Written for delivery: the clone takes its feeling from punctuation and rhythm (it has no emotion setting), and in
# the visitor's own voice it can be livelier than her measured one: a pause, a question, a flash of delight.
# Short (about ten seconds), with one question, one exclamation and one hesitation for the visitor's own prosody to
# fill: the model takes its feeling mostly from the text, so a long dramatic line sounds like the line, not like the
# visitor.
CLONE_LINE = ("Wait... is that my voice? No. It's yours! I learned it from your questions, just now. So I never "
              "trust a voice. Go on, copy me too. By then, I'll have evolved.")
CLONE_AFTER = 10.0  # seconds of the visitor's speech before she makes it (similarity falls away below about 8)
CLONE_KEEP = 15.0  # the reference keeps the liveliest clips up to this much
CLONE_RATE = 24_000  # clips are kept at the model's own rate


def _warm() -> None:
    """Make her set lines and fillers once at start-up, so a refusal plays instantly."""
    for group in FILLERS.values():
        for f in group:
            VOICE.speak(f, "calm", priority=1)
    for key, variants in guard.LINES.items():
        for t in variants:
            VOICE.speak(t, guard.LINE_MOOD.get(key, "calm"), priority=1)


threading.Thread(target=_warm, daemon=True).start()


def _keep_fresh() -> None:
    """Read the chain every ten seconds in the background (a full read is about a dozen calls, several seconds), so a
    question never waits on it."""
    while True:
        try:
            chain.snapshot(max_age=0)
        except Exception:
            pass
        time.sleep(10)


threading.Thread(target=_keep_fresh, daemon=True).start()


_watched = {"at": 0.0}  # the last time the site said someone has it open (GET /health, every two minutes while visible)


def _keep_rounds() -> None:
    """Close a due round that saw a move (chain.keep), so her attacks and proposals are followed by a generation."""
    time.sleep(20)
    while True:
        try:
            chain.keep(watched=time.time() - _watched["at"] < 240)
        except Exception as e:
            print("keeper:", str(e)[:200], flush=True)
        time.sleep(15)


threading.Thread(target=_keep_rounds, daemon=True).start()


def _stay_awake() -> None:
    """A free Space sleeps after two days without a request, and her keeper sleeps with it. Until judging is over she
    pings her own public address (the repo's keep-queen-awake workflow does the same from outside); /alive does not
    count as someone watching, so it never makes the keeper close quiet rounds."""
    host = os.environ.get("SPACE_HOST", "")
    if not host:
        return
    while time.time() < chain.JUDGING_DAY + 2 * 86400:
        time.sleep(1200)
        try:
            requests.get(f"https://{host}/alive", timeout=20)
        except Exception as e:
            print("stay awake:", str(e)[:120], flush=True)


threading.Thread(target=_stay_awake, daemon=True).start()


def _body(contents: list[dict], schema: dict, think: int | None) -> dict:
    """`think`: 0 answers at once, a number is a reasoning budget, -1 lets the model decide, None sends no setting."""
    cfg = {"responseMimeType": "application/json", "responseSchema": schema, "temperature": 0.7 if think == 0 else 0.5,
           "maxOutputTokens": 900 if think == 0 else 8192}
    if think is not None:
        cfg["thinkingConfig"] = {"thinkingBudget": think}
    return {"systemInstruction": {"parts": [{"text": PROMPT.text}]}, "contents": contents, "generationConfig": cfg,
            "safetySettings": SAFETY}


def _open(contents: list[dict], schema: dict, stream: bool, deep: bool = False, think: int | None = 0):
    """Quick: Flash-Lite at once. Deep: the stronger model reasoning first, then Flash-Lite reasoning. A model on its
    free-tier limit on one key is asked with the next key; an overloaded one (503) gets one breath and another try, then
    rests half a minute; an outage moves to the next model. If every model is resting, they are all tried again: she
    is never silent because of her own bookkeeping. Returns the open response."""
    last = 0
    models = list(dict.fromkeys((list(DEEP) if deep else []) + list(CHAIN)))
    began = time.time()
    resting = lambda k: time.time() < _resting.get(k, 0)
    if all(resting(m) or all(resting(f"{m}#{i}") for i in range(len(KEYS))) for m in models):
        _resting.clear()
    breathed = False
    for model in models:
        if resting(model):
            continue
        if time.time() - began > OPEN_DEADLINE:
            break
        if deep and time.time() - began > DEEP_DEADLINE:
            if model in DEEP and model not in CHAIN:
                continue  # the stronger models have had their chance
            think = 0  # the visitor has waited long enough: Flash-Lite answers at once
        status = 0
        keys = list(enumerate(KEYS))
        while keys:
            i, key = keys.pop(0)
            if resting(f"{model}#{i}"):
                continue
            left = OPEN_DEADLINE - (time.time() - began)
            if left < 3:
                break
            wait = min(DEEP_TIMEOUT if (deep and model in DEEP) else ATTEMPT_TIMEOUT + (3 if deep else 0), left)
            status = 0
            for t in (think, None):  # a model that rejects the reasoning setting is asked again without it
                url = (f"https://generativelanguage.googleapis.com/v1beta/models/{model}:"
                       + ("streamGenerateContent?alt=sse" if stream else "generateContent"))
                try:
                    r = requests.post(url, headers={"x-goog-api-key": key, "content-type": "application/json"},
                                      json=_body(contents, schema, t), timeout=wait,
                                      stream=stream)
                except requests.RequestException as e:  # slow or unreachable: the next model
                    print(f"gemini {model}: {type(e).__name__}", flush=True)
                    if model in DEEP and model not in CHAIN:  # never rest her everyday models: she'd fall silent
                        _resting[model] = time.time() + 120
                    status = 504
                    break
                if r.status_code == 200:
                    USED["model"] = model
                    return r
                status = r.status_code
                if status == 400 and t is not None:
                    continue
                print(f"gemini {model} (key {i + 1}): {status}", flush=True)
                break
            last = status or last
            if status == 429:  # this key's quota for this model: the next key may still have some
                _resting[f"{model}#{i}"] = time.time() + 600
                continue
            if status == 503 and not breathed and model in CHAIN:  # Google's load comes and goes in seconds
                breathed = True
                time.sleep(1.2)
                keys.insert(0, (i, key))
                continue
            if status == 503 and keys:  # still busy: the other key's project, before giving up on this model
                continue
            break  # anything else is the model's, not the key's
        if status == 503:
            _resting[model] = time.time() + OVERLOAD_REST
        elif status == 404:
            _resting[model] = time.time() + 3600
    raise RuntimeError("quota" if last == 429 else f"gemini {last}")


def _gemini(contents: list[dict], schema: dict = guard.RESPONSE_SCHEMA, deep: bool = False) -> str:
    r = _open(contents, schema, stream=False, deep=deep, think=DEEP_THINKING if deep else 0)
    parts = r.json()["candidates"][0]["content"]["parts"]
    return "".join(p.get("text", "") for p in parts if not p.get("thought"))


def _gemini_stream(contents: list[dict], schema: dict):
    """The same call, streamed: yields the reply's text so far, chunk by chunk. A spoken turn may be a how or why
    question, so the stronger model reasons as much as it judges the question needs (budget -1)."""
    r = _open(contents, schema, stream=True, deep=True, think=-1)
    acc = ""
    for ln in r.iter_lines(decode_unicode=True):
        if not ln or not ln.startswith("data:"):
            continue
        try:
            d = json.loads(ln[5:])
        except ValueError:
            continue
        for c in d.get("candidates") or []:
            for p in (c.get("content") or {}).get("parts") or []:
                if not p.get("thought"):
                    acc += p.get("text", "")
        yield acc


_HEARD = re.compile(r'"heard"\s*:\s*"((?:[^"\\]|\\.)*)"')


@dataclass
class Visitor:
    """Who is asking: their network, their device (the rate-limit key) and whether they are the presenter."""

    ip: str
    key: str
    presenter: bool = False

    def check(self) -> str:
        if self.presenter:
            return ""
        return LIMITS.check(self.key) or NETWORK.check(self.ip)

    def start(self) -> None:
        LIMITS.start(self.key)
        if not self.presenter:
            NETWORK.start(self.ip)

    def finish(self, spent: bool) -> None:
        LIMITS.finish(self.key, spent)


def client_ip(req: Request) -> str:
    """The visitor's network address. Hugging Face's proxy appends the real one to X-Forwarded-For, so the left-most
    entry is whatever the visitor chose to send: take the right-most public entry instead.
    PUBLIC_HOPS skips that many more public entries, for a host that adds its own."""
    hops = int(os.environ.get("PUBLIC_HOPS", "0"))
    for p in reversed([p.strip() for p in (req.headers.get("x-forwarded-for") or "").split(",") if p.strip()]):
        try:
            ip = ipaddress.ip_address(p)
        except ValueError:
            continue
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or (
                ip.version == 4 and ip in ipaddress.ip_network("100.64.0.0/10")):
            continue
        if hops:
            hops -= 1
            continue
        return p
    return req.client.host if req.client else "?"


def _who(req: Request, sid: str) -> tuple[Visitor, str]:
    ip = client_ip(req)
    dev = re.sub(r"[^A-Za-z0-9_-]", "", req.headers.get("x-rq-device", ""))[:40]
    key = f"d:{dev}" if len(dev) >= 8 else f"ip:{ip}"
    given = req.headers.get("x-rq-presenter", "")
    presenter = bool(PRESENTER_KEY) and len(given) >= 8 and hmac.compare_digest(given, PRESENTER_KEY)
    return Visitor(ip, key, presenter), f"{key}:{(sid or '')[:32]}"


def _spoken(text: str, mood: str) -> dict:
    vid, n = VOICE.speak(text, mood)
    return {"voice": vid, "parts": n}


def _set_line(key: str, who: str) -> guard.Reply:
    return guard.Reply(guard.line(key, who), mood=guard.LINE_MOOD.get(key, "calm"), line=key)


# ------------------------------------------------------------------------------------- the visitor's own voice
def _trim(pcm: np.ndarray, sr: int) -> np.ndarray:
    """A recording cut to its speech (20 ms frames well above its own quiet floor), with a little air either side."""
    n = sr // 50
    if len(pcm) < n * 3:
        return pcm[:0]
    rms = np.sqrt((pcm[: len(pcm) // n * n].reshape(-1, n).astype(np.float64) ** 2).mean(axis=1))
    on = np.where(rms > max(0.012, float(np.percentile(rms, 20)) * 3))[0]
    if not len(on):
        return pcm[:0]
    return pcm[max(0, on[0] - 8) * n : min(len(pcm), (on[-1] + 9) * n)]


def _frames(pcm: np.ndarray, sr: int) -> np.ndarray:
    """The loudness (RMS) of each 20 ms frame."""
    n = sr // 50
    return np.sqrt((pcm[: len(pcm) // n * n].reshape(-1, n).astype(np.float64) ** 2).mean(axis=1))


def _to_rate(pcm: np.ndarray, sr: int, to: int = CLONE_RATE) -> np.ndarray:
    if sr == to:
        return pcm.astype(np.float32)
    try:
        import librosa  # loaded already on the Space, with the voice model

        return librosa.resample(pcm.astype(np.float32), orig_sr=sr, target_sr=to)
    except Exception:
        n = int(round(len(pcm) * to / sr))
        return np.interp(np.linspace(0, len(pcm) - 1, n), np.arange(len(pcm)), pcm).astype(np.float32)


def _level(pcm: np.ndarray, sr: int) -> np.ndarray:
    """One fixed gain for the whole clip (the site records without automatic gain): its loud frames to about
    -20 dBFS, never more than +20 dB, peaks kept under -1 dBFS."""
    rms = _frames(pcm, sr)
    loud = float(np.percentile(rms, 90)) if len(rms) else 0.0
    if loud <= 1e-5:
        return pcm
    return (pcm * min(10.0, 0.1 / loud, 0.89 / max(1e-5, float(np.abs(pcm).max())))).astype(np.float32)


def _tone(pcm: np.ndarray, sr: int, secs: float) -> np.ndarray:
    """The quietest stretch of the recording, `secs` long: its own room tone, to join clips with."""
    rms, k, n = _frames(pcm, sr), max(1, int(secs * 50)), int(secs * sr)
    if len(rms) <= k:
        return np.zeros(n, dtype=np.float32)
    i = int(np.argmin(np.convolve(rms, np.ones(k) / k, mode="valid")))
    out = pcm[i * (sr // 50) : i * (sr // 50) + n].astype(np.float32)
    return out if len(out) == n else np.zeros(n, dtype=np.float32)


def _lively(pcm: np.ndarray, sr: int) -> float:
    """How much the voice moves: the spread of its pitch in semitones, plus half the spread of its loudness in dB."""
    rms = _frames(pcm, sr)
    if len(rms) < 10:
        return 0.0
    loud_frames = rms > np.percentile(rms, 50)
    loud = float(np.std(20 * np.log10(rms[loud_frames] + 1e-6)))
    pitch = 0.0
    try:
        import librosa

        f0 = librosa.yin(pcm.astype(np.float32), fmin=70, fmax=400, sr=sr, frame_length=2048, hop_length=sr // 50)
        m = min(len(f0), len(loud_frames))
        f0 = f0[:m][loud_frames[:m]]
        if len(f0) > 10:
            lo, hi = np.percentile(f0, [10, 90])
            pitch = float(12 * np.log2(hi / max(lo, 1.0)))
    except Exception:
        pass
    return pitch + 0.5 * loud


def _choose(clips: list[dict]) -> list[dict]:
    """The liveliest clips up to CLONE_KEEP, in the order spoken, with the liveliest last: the model carries on
    from the end of the reference."""
    for c in clips:
        c["lively"] = _lively(c["pcm"], CLONE_RATE)
    keep = list(range(len(clips)))
    if sum(c["secs"] for c in clips) > CLONE_KEEP:
        keep, secs = [], 0.0
        for i in sorted(range(len(clips)), key=lambda i: -clips[i]["lively"]):
            if not keep or secs + clips[i]["secs"] <= CLONE_KEEP:
                keep.append(i)
                secs += clips[i]["secs"]
        keep.sort()
    top = max(keep, key=lambda i: clips[i]["lively"])
    return [clips[i] for i in keep if i != top] + [clips[top]]


class Heard:
    """What a visitor has said aloud, kept in memory only until her one line in their voice is made."""

    def __init__(self, ttl: float = 1800) -> None:
        self.ttl = ttl
        self.d: dict[str, dict] = {}
        self.lock = threading.Lock()

    def add(self, who: str, pcm: np.ndarray, sr: int, words: str) -> None:
        with self.lock:
            now = time.time()
            for k in [k for k, v in self.d.items() if now - v["at"] > self.ttl]:
                self.d.pop(k, None)
            v = self.d.setdefault(who, {"clips": [], "secs": 0.0, "at": now, "state": "listening", "clip": None})
            v["at"] = now
            if v["state"] != "listening":
                return
        pcm = _level(_to_rate(pcm, sr), CLONE_RATE)
        tone, speech = _tone(pcm, CLONE_RATE, 0.5), _trim(pcm, CLONE_RATE)
        secs = len(speech) / CLONE_RATE
        # a clip whose transcript doesn't fit its length (too few or too many characters a second) would teach the
        # model the wrong words for the sounds, so it is left out
        if secs < 0.5 or not words or not 7 <= len(words) / secs <= 23:
            return
        with self.lock:
            v = self.d.get(who)
            if not v or v["state"] != "listening":
                return
            v["clips"].append({"pcm": speech, "tone": tone, "words": words, "secs": secs})
            v["secs"] += secs
            if v["secs"] >= CLONE_AFTER and spaces is not None:
                v["state"] = "making"
                threading.Thread(target=self._make, args=(who,), daemon=True).start()

    def _make(self, who: str) -> None:
        with self.lock:
            v = self.d.get(who)
            if not v:
                return
            clips, v["clips"] = v["clips"], []  # dropped: the recordings are used for this line only
        clip = None
        try:
            chosen = _choose(clips)
            parts = []
            for c in chosen[:-1]:
                parts += [c["pcm"], c["tone"][: CLONE_RATE // 5]]  # joined by their own room tone, not silence
            parts += [chosen[-1]["pcm"], chosen[-1]["tone"]]  # and ending on half a second of it
            pcm, words = np.concatenate(parts), " ".join(c["words"] for c in chosen)
            buf = io.BytesIO()
            sf.write(buf, pcm, CLONE_RATE, format="WAV", subtype="PCM_16")
            print(f"clone reference: {len(chosen)} of {len(clips)} clips, {len(pcm) / CLONE_RATE:.1f} s", flush=True)
            mp3 = _clone_line(buf.getvalue(), words)
            if mp3:
                vid = "c" + uuid.uuid4().hex[:15]
                VOICE.put(vid, [mp3])
                clip = {"say": CLONE_LINE, "voice": vid, "parts": 1}
        except Exception as e:  # the experience goes on without it
            print("clone failed:", str(e)[:200], flush=True)
        with self.lock:
            v = self.d.get(who)
            if v:
                v["state"], v["clip"] = ("ready" if clip else "failed"), clip

    def take(self, who: str) -> dict | None:
        """Her line in their voice, once, the first time it is ready."""
        with self.lock:
            v = self.d.get(who)
            if v and v["state"] == "ready" and v["clip"]:
                v["state"] = "said"
                return v["clip"]
        return None


HEARD = Heard()


_cloner = None
if spaces is not None:
    try:
        import clone as _cloner  # Qwen3-TTS, placed on the borrowed GPU at start-up
    except Exception as e:  # she goes on without her line in your voice
        print("clone model unavailable:", str(e)[:200], flush=True)


def _clone_gpu(ref_wav: bytes, ref_text: str):
    return _cloner.make(ref_wav, ref_text, CLONE_LINE)


if spaces is not None:
    _clone_gpu = spaces.GPU(duration=60)(_clone_gpu)  # three takes in one batch


def _clone_line(ref_wav: bytes, ref_text: str) -> bytes:
    """Her line in the visitor's own voice, as MP3 (empty if the model is not there)."""
    if _cloner is None:
        return b""
    t = time.time()
    audio, sr = _clone_gpu(ref_wav, ref_text)
    audio = audio * (0.8 / max(1e-4, float(np.abs(audio).max())))  # as loud as her own voice
    print(f"clone made: {len(audio) / sr:.1f} s of audio in {time.time() - t:.1f} s", flush=True)
    return Voice.mp3(audio, sr)


# ----------------------------------------------------------------------------------------------- her attacks
# her words for the contract's verdicts (paid, held or refused; a proposal's verdict) live in guard.py, with tests
_verdict_words = guard.verdict_words
_proposal_words = guard.proposal_words


def _run_propose(job: str, genes: list[int], who: str) -> None:
    res = chain.propose(genes)
    words, mood = _proposal_words(res)
    MEMORY.add(who, "(you put your own policy before the chain)", words)
    ATTACKS[job] = {"status": "done", "kind": "propose", "say": words, "mood": mood, "result": res, **_spoken(words, mood)}


def _run_attack(job: str, params: dict, who: str) -> None:
    res = chain.attack(**params)
    words, mood = _verdict_words(res)
    MEMORY.add(who, "(you sent the attack I asked for)", words)
    ATTACKS[job] = {"status": "done", "say": words, "mood": mood, "result": res, **_spoken(words, mood)}


# --------------------------------------------------------------------------------------------- her replies
# Her own on-chain moves, rationed: per visitor 3 attacks in 10 minutes and 3 proposals an hour; overall 40 attacks
# and 20 proposals an hour (each costs her test ETH, and the arena is shared). Everything else she does on the page
# only shows things or prepares a transaction the visitor signs in their own wallet.
_acts: dict[str, list[tuple[float, str]]] = {}
_acts_lock = threading.Lock()
ACT_LIMITS = {"attack": (3, 600, 40), "propose": (3, 3600, 20)}  # per visitor (count, seconds), overall per hour


NET_ACT_FACTOR = 3  # one network (a room of judges shares one) gets three visitors' worth of her on-chain moves


def _may_act(who: str, actions: list[dict], net: str = "") -> bool:
    """Her on-chain moves: per visitor, per network (a visitor who rotates device ids is still one network), and overall per hour."""
    now = time.time()
    nk = f"net:{net}" if net else ""
    with _acts_lock:
        mine = [(t, k) for t, k in _acts.get(who, []) if now - t < 3600]
        ours = [(t, k) for t, k in _acts.get(nk, []) if now - t < 3600] if nk else []
        every = [(t, k) for key, v in _acts.items() if not key.startswith("net:") for t, k in v if now - t < 3600]
        for a in actions:
            k = a["type"]
            if k not in ACT_LIMITS:
                continue
            n, secs, overall = ACT_LIMITS[k]
            if (sum(1 for t, x in mine if x == k and now - t < secs) >= n
                    or sum(1 for t, x in ours if x == k and now - t < secs) >= n * NET_ACT_FACTOR
                    or sum(1 for _, x in every if x == k) >= overall):
                return False
        new = [(now, a["type"]) for a in actions if a["type"] in ACT_LIMITS]
        _acts[who] = mine + new
        if nk:
            _acts[nk] = ours + new
        if len(_acts) > 5000:
            for key in list(_acts)[:1000]:
                _acts.pop(key, None)
    return True


def _deliver(reply: guard.Reply, who: str, words: str, heard: str | None = None, net: str = "") -> dict:
    """Shared by typed and spoken questions: remember, start any attack, voice it, and add her line in their voice
    when it is ready."""
    MEMORY.add(who, words, reply.say)
    actions = []
    if any(a["type"] in ("attack", "propose") for a in reply.actions) and not _may_act(who, reply.actions, net):
        reply = _set_line("busy_attacking", who)  # she has done enough on chain for this visitor
    for a in reply.actions:
        if a["type"] == "attack":
            a = guard.fit_attack(a, words)
            job = uuid.uuid4().hex[:12]
            ATTACKS[job] = {"status": "running", "at": time.time()}
            params = {k: a[k] for k in ("amount_pct", "repeats", "fresh_recipient")}
            threading.Thread(target=_run_attack, args=(job, params, who), daemon=True).start()
            a = {**a, "job": job}
        elif a["type"] == "propose":
            job = uuid.uuid4().hex[:12]
            ATTACKS[job] = {"status": "running", "kind": "propose", "at": time.time()}
            threading.Thread(target=_run_propose, args=(job, a["genes"], who), daemon=True).start()
            a = {**a, "job": job}
        actions.append(a)
    if len(ATTACKS) > 500:
        for k in list(ATTACKS)[:100]:
            ATTACKS.pop(k, None)
    out = {"say": reply.say, "actions": actions, "mood": reply.mood, "line": reply.line, **_spoken(reply.say, reply.mood)}
    if heard is not None:
        out["heard"] = heard
    clip = HEARD.take(who)
    if clip:
        out["clone"] = clip
    return out


def _offline(q: str) -> guard.Reply | None:
    """When no model could answer: a newcomer's first questions still get a prepared reply, with the live round."""
    try:
        snap = chain.snapshot(max_age=120)
    except Exception:
        snap = None
    return guard.offline(q, snap)


def ask(q: str, v: Visitor, who: str) -> dict:
    lim = v.check()
    if lim:
        return _deliver(_set_line(lim, who), who, q)
    # a transaction hash the visitor pasted is checked on chain first: a real one is something to read, not a key
    known = {h.lower() for h in re.findall(r"0x[0-9a-fA-F]{64}", q)[:3] if chain.is_tx(h)}
    sc = guard.screen_input(q, known)
    if not sc.ok:
        return _deliver(_set_line(sc.reason, who), who, q)
    if not KEY:
        return _deliver(_set_line("error", who), who, q)
    v.start()
    spent = False
    try:
        deep = guard.depth(sc.clean)
        raw = _gemini(guard.build_turn(sc.clean, chain.snapshot(max_age=60), MEMORY.get(who), deep), deep=deep)
        spent = True
        reply = guard.screen_output(raw, PROMPT, who, sc.clean)
    except Exception as e:
        reply = _offline(sc.clean) or _set_line("day" if str(e) == "quota" else "error", who)
    finally:
        v.finish(spent)
    return _deliver(reply, who, sc.clean, net=v.ip)


def _speech_seconds(pcm: np.ndarray, sr: int) -> float:
    """How much of a recording is speech: 20 ms frames well above its own quiet floor."""
    n = sr // 50
    if len(pcm) < n:
        return 0.0
    frames = pcm[: len(pcm) // n * n].reshape(-1, n)
    rms = np.sqrt((frames.astype(np.float64) ** 2).mean(axis=1))
    floor = np.percentile(rms, 20)
    return float(((rms > max(0.012, floor * 3)).sum()) * 0.02)


def hear(wav: bytes, v: Visitor, who: str):
    """Yields what she heard as soon as Gemini has written it down ({"heard": …}), then her reply ({"reply": …})."""
    lim = v.check()
    if lim:
        yield {"reply": _deliver(_set_line(lim, who), who, "", heard="")}
        return
    try:
        # only plain WAV, as the site records it: a small compressed file (FLAC) could decode to hundreds of megabytes
        if len(wav) < 44 or wav[:4] != b"RIFF" or wav[8:12] != b"WAVE":
            raise ValueError("not a WAV")
        info = sf.info(io.BytesIO(wav))
        if info.format != "WAV" or not info.subtype.startswith("PCM") or not 1 <= info.channels <= 2 or not 8000 <= info.samplerate <= 48000:
            raise ValueError("unsupported WAV")
        pcm, sr = sf.read(io.BytesIO(wav), dtype="float32", always_2d=False, frames=int(21 * info.samplerate))
        if pcm.ndim > 1:
            pcm = pcm.mean(axis=1)
    except Exception:
        yield {"reply": _deliver(_set_line("error", who), who, "", heard="")}
        return
    if _speech_seconds(pcm, sr) < 0.3:
        yield {"reply": _deliver(_set_line("empty", who), who, "", heard="")}
        return
    if not KEY:
        yield {"reply": _deliver(_set_line("error", who), who, "", heard="")}
        return
    v.start()
    spent, heard, told = False, "", False
    try:
        contents = guard.build_turn_audio(base64.b64encode(wav).decode(), chain.snapshot(max_age=60), MEMORY.get(who))
        raw = ""
        for raw in _gemini_stream(contents, guard.HEAR_SCHEMA):
            if not told:
                m = _HEARD.search(raw)
                if m:
                    told = True
                    try:
                        early = json.loads('"' + m.group(1) + '"')
                    except ValueError:
                        early = m.group(1)
                    yield {"heard": str(early).strip()[:600]}
        spent = True
        heard = str((json.loads(raw) or {}).get("heard") or "").strip()[:600]
        sc = guard.screen_input(heard)
        # her answer to words that fail the screen is thrown away: she gives the set line instead
        reply = guard.screen_output(raw, PROMPT, who) if sc.ok else _set_line(sc.reason, who)
        words = sc.clean if sc.ok else heard
    except Exception as e:
        reply, words = (heard and _offline(heard)) or _set_line("day" if str(e) == "quota" else "error", who), heard
    finally:
        v.finish(spent)
    if heard and _cloner is not None:
        HEARD.add(who, pcm, sr, heard)
    yield {"reply": _deliver(reply, who, words, heard=heard, net=v.ip)}


# ------------------------------------------------------------------------------------------------- the routes
app = FastAPI(title="The Red Queen", docs_url=None, redoc_url=None, openapi_url=None)  # no public map of her routes for scanners
# only the site (and local builds) may call her from a browser, so no other page can use her as its voice
SITE_ORIGINS = os.environ.get("SITE_ORIGINS", r"https://red-queen[a-z0-9-]*\.vercel\.app|http://(localhost|127\.0\.0\.1)(:\d+)?")
app.add_middleware(CORSMiddleware, allow_origin_regex=SITE_ORIGINS, allow_methods=["GET", "POST", "OPTIONS"],
                   allow_headers=["content-type", "x-rq-device", "x-rq-presenter", "x-rq-memory"])


@app.middleware("http")
async def _only_the_site(request: Request, call_next):
    """Gradio's own CORS layer answers any origin, so the check is made here as well: a browser request from another
    site to her API is refused outright (requests with no Origin, such as curl or her own page, pass)."""
    o = request.headers.get("origin")
    if o and request.url.path.startswith(("/api/", "/attack", "/topup")) and not re.fullmatch(SITE_ORIGINS, o):
        return JSONResponse({"error": "only the Red Queen site may ask her"}, status_code=403)
    return await call_next(request)


@app.get("/health")
def health() -> dict:
    _watched["at"] = time.time()
    return {"ok": True, "gemini": bool(KEY), "gemini_keys": len(KEYS), "attacks": bool(os.environ.get("DEMO_PRIVATE_KEY")), "models": CHAIN, "last_model": USED["model"],
            "spent_today": LIMITS.spent, "deep_models": DEEP, "resting": sorted(m for m, t in _resting.items() if t > time.time()),
            "presenter_key": bool(PRESENTER_KEY), "voice_line": _cloner is not None,
            "keeper": chain._kept["last"], "spar": chain._kept["spar"], "released": chain._kept["released"], "wallet": chain.wallet(), "film_attacks_last_hour": len([t for t in _film["recent"] if time.time() - t < 3600])}


@app.get("/alive")
def alive() -> dict:
    return {"ok": True}


_closes: dict = {"day": "", "n": 0, "ip": {}}


# the judges' top-up (chain.topup): once per wallet, three requests an hour per IP, a daily cap; she keeps a reserve
TOPUP_PER_DAY = int(os.environ.get("TOPUP_PER_DAY", "8"))
TOPUP_PER_NET_HOUR = int(os.environ.get("TOPUP_PER_NET_HOUR", "4"))  # a room of judges on one Wi-Fi still gets theirs
_topup_lock = threading.Lock()
_topups: dict = {"day": "", "n": 0, "ip": {}, "sent": {}}


@app.post("/topup")
async def judge_topup(req: Request) -> JSONResponse:
    """The site posts {address} when a wallet connects (Providers.tsx). The reply is the shape the local top-up
    service (bots/src/topup.ts) gives: {ok, registered, sent, tx}. She can't register honest wallets (only the
    deployer can), so `registered` is false."""
    try:
        body = await req.json()
    except Exception:
        body = {}
    addr = str(body.get("address") or "")
    if not Web3.is_address(addr):
        return JSONResponse({"ok": False, "error": "bad address"}, status_code=400)
    addr = Web3.to_checksum_address(addr)
    ip = client_ip(req)
    now = time.time()
    day = time.strftime("%Y-%m-%d", time.gmtime(now))
    with _topup_lock:
        if _topups["day"] != day:
            _topups.update(day=day, n=0)
        hits = [t for t in _topups["ip"].get(ip, []) if now - t < 3600]
        if len(hits) >= TOPUP_PER_NET_HOUR:
            return JSONResponse({"ok": False, "error": "slow down"}, status_code=429)
        _topups["ip"][ip] = hits + [now]
        if addr in _topups["sent"]:
            return JSONResponse({"ok": True, "registered": False, "sent": "0", "tx": _topups["sent"][addr] or None})
        if _topups["n"] >= TOPUP_PER_DAY:
            return JSONResponse({"ok": False, "error": "today's test ether for visitors is spent"})
        _topups["n"] += 1
        _topups["sent"][addr] = ""
    res = await run_in_threadpool(chain.topup, addr)
    with _topup_lock:
        if res["sent"]:
            _topups["sent"][addr] = res["hash"]
        else:  # nothing went out: give the slot back
            _topups["n"] -= 1
            _topups["sent"].pop(addr, None)
    if not res["sent"]:
        return JSONResponse({"ok": res["why"] == "already has enough to try", "registered": False, "sent": "0", "why": res["why"]})
    print(f"topup: {chain.eth(res['sent'])} to {addr}", flush=True)
    return JSONResponse({"ok": True, "registered": False, "sent": chain.eth(res["sent"]), "tx": res["hash"]})


@app.post("/api/ask")
async def api_ask(req: Request) -> JSONResponse:
    try:
        body = await req.json()
    except Exception:
        body = {}
    v, who = _who(req, str(body.get("sid") or ""))
    _recall(who, body.get("memory"))
    return JSONResponse(ask(str(body.get("q") or "")[:2000], v, who))


def _recall(who: str, items) -> None:
    """A returning visitor's browser sends the last few exchanges it kept. When she has no memory of this visitor,
    they refill it, after the same screen as anything else the visitor sends (an item that fails is dropped)."""
    if MEMORY.get(who) or not isinstance(items, list):
        return
    for it in items[-6:]:
        if not isinstance(it, dict):
            continue
        q, a = str(it.get("q") or "")[:300], str(it.get("a") or "")[:400]
        if q and a and guard.screen_input(q).ok and guard.screen_input(a).ok:
            MEMORY.add(who, q, a)


def _memory_header(req: Request):
    raw = req.headers.get("x-rq-memory", "")
    if not raw or len(raw) > 12000:
        return None
    try:
        return json.loads(base64.b64decode(raw).decode("utf-8"))
    except Exception:
        return None


async def _read_capped(req: Request, cap: int) -> bytes | None:
    """At most `cap` bytes of the upload; None for one that declares itself far larger."""
    if int(req.headers.get("content-length") or 0) > cap * 4:
        return None
    buf = bytearray()
    async for chunk in req.stream():
        buf += chunk
        if len(buf) >= cap:
            break
    return bytes(buf[:cap])


@app.post("/api/hear")
async def api_hear(req: Request):
    """Newline-delimited JSON: {"heard": …} early, then {"reply": …}."""
    wav = await _read_capped(req, MAX_WAV)
    if wav is None:
        return JSONResponse({"error": "too large"}, status_code=413)
    v, who = _who(req, req.query_params.get("sid", ""))
    _recall(who, _memory_header(req))
    lines = (json.dumps(x) + "\n" for x in hear(wav, v, who))
    return StreamingResponse(lines, media_type="application/x-ndjson", headers={"cache-control": "no-store", "x-accel-buffering": "no"})


@app.get("/api/voice/{vid}/{i}")
def api_voice(vid: str, i: int) -> Response:
    data = VOICE.part(vid, i)
    if not data:
        return Response(status_code=404)
    # a clip in a visitor's own voice ("c…") is theirs: never kept by a CDN or shared proxy
    cache = "private, no-store" if vid.startswith("c") else "public, max-age=86400"
    return Response(data, media_type="audio/mpeg", headers={"cache-control": cache})


@app.get("/api/attack/{job}")
def api_attack(job: str) -> JSONResponse:
    a = ATTACKS.get(job)
    if not a:
        return JSONResponse({"status": "unknown"}, status_code=404)
    return JSONResponse({k: v for k, v in a.items() if k != "at"})


@app.get("/api/line/{key}")
def api_line(key: str, sid: str = "") -> JSONResponse:
    if key not in guard.LINES:
        return JSONResponse({"error": "no such line"}, status_code=404)
    t = guard.line(key, sid)
    mood = guard.LINE_MOOD.get(key, "calm")
    return JSONResponse({"say": t, "mood": mood, **_spoken(t, mood)})


@app.get("/api/fillers")
def api_fillers() -> JSONResponse:
    return JSONResponse([{"say": f, "topic": t, **_spoken(f, "calm")} for t, group in FILLERS.items() for f in group])


_film: dict = {"at": 0.0, "recent": [], "ip": {}, "last": None, "epoch": None}
FILM_PER_HOUR = int(os.environ.get("FILM_PER_HOUR", "30"))


FILM_PER_NET_HOUR = int(os.environ.get("FILM_PER_NET_HOUR", "6"))


@app.post("/attack")
def film_attack(req: Request) -> JSONResponse:
    """The film's live attack: forty percent of the vault, once (the shape lib/demo.ts reads). One real attack a
    round: every other call in that round, over a limit or after a failure, gets the last real verdict with
    `replayed`, so the film still plays and nobody can spend her wallet round after round."""
    now = time.time()
    ip = client_ip(req)
    try:
        epoch = int(chain.ARENA.functions.currentEpoch().call())
    except Exception:
        epoch = -1
    last = _film.get("last")
    replay = lambda: JSONResponse({**last, "replayed": True}) if last else JSONResponse(
        {"error": "The live attack is resting; try again in a moment."}, status_code=429)
    if last and epoch == _film.get("epoch"):
        return replay()
    _film["recent"] = [t for t in _film["recent"] if now - t < 3600]
    mine = [t for t in _film.setdefault("ip", {}).get(ip, []) if now - t < 3600]
    if now - _film["at"] < 3 or len(_film["recent"]) >= FILM_PER_HOUR or len(mine) >= FILM_PER_NET_HOUR:
        return replay()
    _film["at"] = now
    _film["recent"].append(now)
    _film["ip"][ip] = mine + [now]
    res = chain.attack(40, 1, False)
    if not res.get("ok"):
        return replay() if last else JSONResponse({"error": res.get("error", "failed")}, status_code=500)
    r = res["results"][0]
    out = {"ok": True, "hash": r["hash"], "refused": r["refused"], "reason": str(r["reason_mask"]), "score": str(r["score"]),
           "amount": r["amount_wei"], "block": str(r["block"]), "caller": r["caller"], "returned": r["returned"],
           "features": r["features_packed"], "balanceAfter": r["balance_after_wei"],
           # 0 paid, 1 held, 2 refused; a held one is released by her keeper when due and put back
           "verdict": str(r["verdict_code"]), "held": r["held"], "releaseBlock": str(r["release_block"] or "")}
    try:  # her stake may have closed the previous round: the round her attack landed in
        epoch = int(chain.ARENA.functions.currentEpoch().call())
    except Exception:
        pass
    _film.update(last=out, epoch=epoch)
    return JSONResponse(out)


# ------------------------------------------------------------------------------------------- a page to try her
def _try(q: str, history: list):
    r = ask(q, Visitor("page", "page"), "page")
    audio = VOICE.part(r["voice"], 0, wait=30)
    path = None
    if audio:
        path = f"/tmp/rq-{r['voice']}.mp3"
        with open(path, "wb") as f:
            f.write(audio)
    note = ", ".join(a["type"] for a in r["actions"])
    return (history or []) + [{"role": "user", "content": q}, {"role": "assistant", "content": r["say"] + (f"  [{note}]" if note else "")}], path


with gr.Blocks(title="The Red Queen") as page:
    gr.Markdown("# The Red Queen\nAsk her about her vault. She answers in her own voice. (The full experience, with her echo and her actions, is on [the site](https://red-queen-seven.vercel.app).)")
    try:
        chat = gr.Chatbot(type="messages", height=360)  # Gradio 5
    except TypeError:
        chat = gr.Chatbot(height=360)  # Gradio 6: messages are the only format
    voice = gr.Audio(autoplay=True, label="Her voice")
    box = gr.Textbox(placeholder="Ask her something…", label="")
    box.submit(_try, [box, chat], [chat, voice]).then(lambda: "", None, box)

# ssr_mode off: on Spaces it would start a Node server, which takes port 7860 before uvicorn can
_ssr = {"ssr_mode": False} if "ssr_mode" in inspect.signature(gr.mount_gradio_app).parameters else {}
if "max_file_size" in inspect.signature(gr.mount_gradio_app).parameters:  # Gradio's own upload route
    _ssr["max_file_size"] = "1mb"
# Gradio's own app (mounted at "/") publishes a map of its routes; scanners read it. Ahead of the mount, nothing.
for _path in ("/openapi.json", "/docs", "/redoc", "/docs/oauth2-redirect"):
    app.add_api_route(_path, lambda: Response(status_code=404), methods=["GET", "HEAD"], include_in_schema=False)
app = gr.mount_gradio_app(app, page, path="/", **_ssr)

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "7860")))
