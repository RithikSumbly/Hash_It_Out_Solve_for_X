#!/usr/bin/env python3
"""Render the Red Queen's pause fillers ("Let me look.", "Hmm.") as finished clips for the site.

Her live voice is Kokoro (kokoro-onnx 0.6.1, model v1.0 int8, voice bf_emma, en-gb), made in queen/voice.py. Making
a filler at start-up with the same call as a reply goes wrong in four ways
(measured with --diagnose):

  - espeak-ng, Kokoro's phonemizer, spells "Mm." and "Hm." as letters: "em-em", "aitch-em" (Whisper: "XMM", "HM").
  - Voice.speak cuts text into sentences and the site plays only part 0 of a filler, so "Hm. Let me see." was just
    "Hm.", "Right. Let me think." just "Right.", "The vault first. One moment." just "The vault first.".
  - Kokoro ends an utterance badly. After a final voiceless consonant it often adds a creaky syllable an octave
    under her pitch ("One moment here.", "Right, let me thinker."); after a final vowel, nasal or l/r it often
    breathes out 100-150 ms of hiss near 8 kHz, heard as an "s" ("chains", "ready ones"). Ending the text with a
    comma or with nothing instead of a full stop usually avoids the first; the second is cut off here (end_hiss).
  - The shortest ones ("Mm.", "Hm.", "Watch.") keep 0.2-0.4 s of trailing near-silence and a faint noise blip in it.

Each line is rendered in many takes: her three mood speeds, each text ending in ".", "," and nothing, and where
espeak gets the words wrong, respellings or hand-written phonemes; a line of two sentences can also be made
sentence by sentence and joined with a 0.3 s pause ("A.|B."), as her replies are. Each take has any end hiss cut,
is trimmed to 40 ms of air at each end with raised-cosine fades (10 ms in, 30 ms out), normalised to the integrated
loudness of her replies (her set lines from queen/guard.py made with queen/voice.py's settings: median -19.4
LUFS) with true peak at most -1 dBTP, encoded exactly as Voice.mp3 encodes a reply, and decoded back. Whisper small
must transcribe it as the line; among those that pass, the take whose audio Whisper finds most likely to say the
line (mean log-probability of the line's tokens, teacher-forced) wins, with a small preference for her calm pace
and a heavy penalty for a detected creaky tail. The winner must pass Whisper medium too, or the next take is tried.
A line can name alternative words (`alt`), used only when no take of the line itself passes both; a line with no
passing take at all is not written. The result:

    web/public/voice/fillers/<id>.mp3      mono MP3, 24 kHz, LAME 3.100 VBR via libsndfile (as Voice.mp3)
    web/public/voice/fillers/manifest.json [{id, topic, say, file, dur}]

Two interpreters: Kokoro's (kokoro-onnx 0.6.1, onnxruntime, soundfile, numpy) runs this script; Whisper
(openai-whisper, checkpoints small and medium in ~/.cache/whisper) runs in a second one, which this script calls
with --whisper-worker. ffmpeg decodes the MP3s back, as a browser does, honouring the LAME delay. Takes and
transcripts are cached in --work, so a re-run only renders and transcribes what changed.

    python tools/voice/render_fillers.py                        # render, check, choose, write
    python tools/voice/render_fillers.py --diagnose             # the Space's way, measured; writes nothing to web/
    python tools/voice/render_fillers.py --only any-1 self-2     # just these (other manifest entries kept)
    python tools/voice/render_fillers.py --list                 # the lines and their takes; renders nothing

    --whisper-python PATH   interpreter with openai-whisper (default $WHISPER_PYTHON or ~/miniforge3/bin/python)
    --work DIR              take cache (default: a folder in the system temp dir)
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
OUT = REPO / "web" / "public" / "voice" / "fillers"
MODELS = Path(os.environ.get("KOKORO_DIR", REPO / "queen" / "models"))
VOICE = "bf_emma"
LANG = "en-gb"
SR = 24000
CALM = 0.97            # queen/voice.py SPEED["calm"]: the Space made every filler at this speed
SPEEDS = (0.93, 0.97, 1.0)  # her three mood speeds (stern, calm, amused)

LEAD = 0.040           # air kept before the first sound and after the last
TAIL = 0.040
FADE_IN = 0.010        # raised-cosine fades, inside that air
FADE_OUT = 0.030
REL_DB = 50.0          # a 20 ms frame is sound if within 50 dB of the loudest frame ...
ABS_DB = -65.0         # ... and above -65 dBFS
TRUE_PEAK_MAX = -1.0   # dBTP after normalising
JOIN_GAP = 0.30        # the pause between sentences made apart (a take written "First.|Second.")

# Her replies, as the Space makes them: queen/voice.py speaks these set lines (queen/guard.py) sentence by
# sentence. Their integrated loudness is the fillers' target.
REPLIES = [
    ("calm", "I'm a guard, not an oracle. Ask me about the guarding."),
    ("calm", "That's a square on someone else's board. Mine is this vault."),
    ("calm", "I speak of one thing: my vault, and how I keep it."),
    ("calm", "I keep money safe. What you do with yours is your own move."),
    ("calm", "Speak, then. I can explain any part of me, show you any part of this page, or attack myself while you watch."),
    ("calm", "Your microphone is closed to me. Type, and I'll answer just the same."),
    ("amused", "That's an attack. I refuse attacks for a living."),
    ("amused", "A familiar move. I've been bred from people who tried it before you."),
    ("stern", "Keep your keys to yourself. I never need them, and neither does anyone honest."),
    ("stern", "Put that away. Private keys stay private, even from me."),
]
SPEED = {"stern": 0.93, "calm": 0.97, "amused": 1.0}

# The fillers the Space made at start-up (queen/app.py FILLERS before this script), for --diagnose.
SPACE_FILLERS = {
    "any": ["Mm.", "Let me look.", "One moment.", "Hm. Let me see.", "Give me a breath.", "Let me check the chain.",
            "Right. Let me think.", "Let me read the board."],
    "vault": ["Let me count the vault.", "Let me look at the balance.", "The vault first. One moment."],
    "record": ["Let me look at the record.", "Let me see what came in.", "Let me find that verdict."],
    "lineage": ["Let me look back through my lineage.", "Let me read my genes.", "Where to begin with my family."],
    "attack": ["Watch.", "Let me ready one.", "Very well. Stand back."],
    "self": ["Where to begin.", "Hm.", "Mm. Me."],
}


def ph(s: str) -> str:
    """A take given as Kokoro phonemes (IPA), bypassing espeak-ng."""
    return "ph:" + s


# The lines. Each: (id, topic, say, takes). `say` is the line as written (the caption and manifest text); a take is
# the text Kokoro is given (or ph:... phonemes), rendered at every speed in SPEEDS. `hear` (optional) lists other
# transcripts that count as saying the line (Whisper writes a hum as "Hmm" or "Mm").
HUM = ["hmm", "um", "umm"]  # what a lone hum may be written as; inside a longer line only hm/hmm/mm count
LINES: list[dict] = [
    # any: the pause itself
    # Kokoro cannot hum: every m-only phoneme string comes out as "Emma", "Emmet", "Meme" or "Amen", so "Mmm."
    # falls back to a filler as short and as dry
    dict(id="any-1", topic="any", say="Mmm.", hear=HUM,
         takes=[ph("ˈmːː."), ph("ˈmː."), ph("mˈmm."), ph("mmm.")],
         alt=[dict(say="Now then.", takes=["Now then."])]),
    dict(id="any-2", topic="any", say="Let me look.", takes=["Let me look."]),
    dict(id="any-3", topic="any", say="One moment.", takes=["One moment."]),
    dict(id="any-4", topic="any", say="Hmm. Let me see.",
         takes=["Hmm. Let me see.", "Hmm, let me see.", ph("hmm. lˈɛt mˌiː sˈiː."), "Hmm.|Let me see."]),
    dict(id="any-5", topic="any", say="Right. Let me think.",
         takes=["Right. Let me think.", "Right, let me think.", "Right.|Let me think."]),
    dict(id="any-6", topic="any", say="Let me read the board.", takes=["Let me read the board."]),
    # explain: how and why
    dict(id="explain-1", topic="explain", say="Let me put it plainly.", takes=["Let me put it plainly."]),
    dict(id="explain-2", topic="explain", say="Where to start. Here.",
         takes=["Where to start. Here.", "Where to start? Here.", "Where to start... Here.", "Where to start.|Here.",
                "Where to start?|Here."]),
    dict(id="explain-3", topic="explain", say="It's simpler than it sounds.", takes=["It's simpler than it sounds."]),
    dict(id="explain-4", topic="explain", say="Let me walk you through it.", takes=["Let me walk you through it."]),
    # vault (RP says "vault" /vɒlt/ or /vɔːlt/; espeak gives the first, Whisper writes it "volt")
    dict(id="vault-1", topic="vault", say="Let me count the vault.",
         takes=["Let me count the vault.", ph("lˈɛt mˌiː kˈaʊnt ðə vˈɔːlt.")]),
    dict(id="vault-2", topic="vault", say="Let me look at the balance.", takes=["Let me look at the balance."]),
    dict(id="vault-3", topic="vault", say="The vault first. One moment.",
         takes=["The vault first. One moment.", "The vault first, one moment.", "The vault first.|One moment",
                ph("ðə vˈɔːlt fˈɜːst. wˈɒn mˈəʊmənt.")]),
    # record: verdicts, transactions, a hash
    dict(id="record-1", topic="record", say="Let me look at the record.", takes=["Let me look at the record."]),
    dict(id="record-2", topic="record", say="Let me find that verdict.", takes=["Let me find that verdict."]),
    dict(id="record-3", topic="record", say="Let me read the chain.", takes=["Let me read the chain."]),
    dict(id="record-4", topic="record", say="Let me check that transaction.", takes=["Let me check that transaction."]),
    # lineage: evolution, breeding, generations, family
    dict(id="lineage-1", topic="lineage", say="Let me look back through my lineage.",
         takes=["Let me look back through my lineage."]),
    dict(id="lineage-2", topic="lineage", say="Let me read my genes.", takes=["Let me read my genes."]),
    dict(id="lineage-3", topic="lineage", say="Let me look at my family.", takes=["Let me look at my family."]),
    # attack
    dict(id="attack-1", topic="attack", say="Watch.", takes=["Watch.", "Watch!"]),
    # with a full stop, "one" ends in a hiss ("ones"); once the hiss is cut it is whole
    dict(id="attack-2", topic="attack", say="Let me ready one.",
         takes=["Let me ready one.", ph("lˈɛt mˌiː ɹˈɛdi wˈʌn.")],
         alt=[dict(say="Let me ready one now.", takes=["Let me ready one now."])]),
    dict(id="attack-3", topic="attack", say="Very well. Stand back.",
         takes=["Very well. Stand back.", "Very well, stand back.", "Very well.|Stand back."]),
    # policy: writing or proposing a rule, defences (RP "draft" is /drɑːft/; espeak's en-gb gives /draft/)
    dict(id="policy-1", topic="policy", say="Let me draft one.",
         takes=["Let me draft one.", ph("lˈɛt mˌiː dɹˈɑːft wˈʌn."), ph("lˈɛt mˌiː dɹˈɑːft wˌɒn.")]),
    dict(id="policy-2", topic="policy", say="A policy. Let me think how I'd write it.",
         takes=["A policy. Let me think how I'd write it.", "A policy.|Let me think how I'd write it."]),
    dict(id="policy-3", topic="policy", say="Let me weigh that.", takes=["Let me weigh that."]),
    # go: take me somewhere, show me
    dict(id="go-1", topic="go", say="This way.", takes=["This way.", "This way!"]),
    dict(id="go-2", topic="go", say="Come with me.", takes=["Come with me."]),
    dict(id="go-3", topic="go", say="Let me show you.", takes=["Let me show you."]),
    # roles: admin, allowed wallets, registrars
    dict(id="roles-1", topic="roles", say="Who may do what. Let me see.",
         takes=["Who may do what. Let me see.", "Who may do what? Let me see.", "Who may do what.|Let me see."]),
    dict(id="roles-2", topic="roles", say="Let me check who's allowed.", takes=["Let me check who's allowed."]),
    # trust: security, why a blockchain, can it be gamed
    dict(id="trust-1", topic="trust", say="A fair question. Let me think.",
         takes=["A fair question. Let me think.", "A fair question, let me think.", "A fair question.|Let me think."]),
    dict(id="trust-2", topic="trust", say="Let me be honest about that.", takes=["Let me be honest about that."]),
    # self: who are you
    dict(id="self-1", topic="self", say="Where to begin.", takes=["Where to begin.", "Where to begin..."]),
    dict(id="self-2", topic="self", say="Hmm.", hear=HUM, takes=["Hmm.", ph("hˈmː."), ph("hmm."), ph("hˈm.")]),
    # "Mmm. Me." fails as "Mmm." does; her nearest, "Hmm. Me.", runs together into "Hum me"
    dict(id="self-3", topic="self", say="Mmm. Me.",
         takes=[ph("ˈmːː. mˈiː."), ph("mˈmm. mˈiː."), "ph:ˈmːː.|Me.", "ph:mˈmm.|Me.", "Hmm. Me.", "Hmm.|Me."],
         alt=[dict(say="Me? Very well.", takes=["Me? Very well.", "Me?|Very well."])]),
]


# ------------------------------------------------------------------------------------------------ analysis
def frames_db(x: np.ndarray, sr: int = SR, frame: float = 0.020, hop: float = 0.005) -> np.ndarray:
    n, h = int(frame * sr), int(hop * sr)
    if len(x) < n:
        x = np.pad(x, (0, n - len(x)))
    m = 1 + (len(x) - n) // h
    idx = np.arange(n)[None, :] + h * np.arange(m)[:, None]
    rms = np.sqrt(np.mean(x[idx].astype(np.float64) ** 2, axis=1))
    return 20 * np.log10(np.maximum(rms, 1e-9))


def speech_bounds(x: np.ndarray, sr: int = SR) -> tuple[float, float, list[str]]:
    """(start, end) of the sound in seconds, dropping a short quiet blip stranded at either end."""
    hop, frame = 0.005, 0.020
    db = frames_db(x, sr, frame, hop)
    top = float(db.max())
    act = db > max(top - REL_DB, ABS_DB)
    notes: list[str] = []
    if not act.any():
        return 0.0, len(x) / sr, ["silent"]
    # segments of sound
    segs, i = [], 0
    while i < len(act):
        if act[i]:
            j = i
            while j + 1 < len(act) and act[j + 1]:
                j += 1
            segs.append([i, j])
            i = j + 1
        else:
            i += 1
    changed = True
    while changed and len(segs) > 1:
        changed = False
        for k in (0, -1):
            a, b = segs[k]
            nb = segs[1] if k == 0 else segs[-2]
            gap = (nb[0] - b) if k == 0 else (a - nb[1])
            short = (b - a + 1) * hop < 0.045
            quiet = db[a:b + 1].max() < top - 30
            if short and quiet and gap * hop > 0.12:
                notes.append(f"stray {'head' if k == 0 else 'tail'} blip at {a * hop:.2f}s")
                segs.pop(k)
                changed = True
                break
    return segs[0][0] * hop, segs[-1][1] * hop + frame, notes


def _biquad_response(b, a, n_fft: int) -> np.ndarray:
    w = np.exp(-1j * np.pi * np.arange(n_fft // 2 + 1) / (n_fft // 2))
    return (b[0] + b[1] * w + b[2] * w * w) / (a[0] + a[1] * w + a[2] * w * w)


def k_weight(x: np.ndarray, sr: int) -> np.ndarray:
    """BS.1770 K-weighting (pyloudnorm's two-stage design), applied in the frequency domain."""
    out = []
    G, Q, fc = 4.0, 1 / math.sqrt(2), 1500.0
    A = 10 ** (G / 40)
    w0 = 2 * math.pi * fc / sr
    al = math.sin(w0) / (2 * Q)
    c = math.cos(w0)
    shelf = ([A * ((A + 1) + (A - 1) * c + 2 * math.sqrt(A) * al), -2 * A * ((A - 1) + (A + 1) * c),
              A * ((A + 1) + (A - 1) * c - 2 * math.sqrt(A) * al)],
             [(A + 1) - (A - 1) * c + 2 * math.sqrt(A) * al, 2 * ((A - 1) - (A + 1) * c),
              (A + 1) - (A - 1) * c - 2 * math.sqrt(A) * al])
    Q, fc = 0.5, 38.0
    w0 = 2 * math.pi * fc / sr
    al = math.sin(w0) / (2 * Q)
    c = math.cos(w0)
    hp = ([(1 + c) / 2, -(1 + c), (1 + c) / 2], [1 + al, -2 * c, 1 - al])
    pad = sr  # one second: the filters' tails die well within it
    n = 1 << int(math.ceil(math.log2(len(x) + pad)))
    X = np.fft.rfft(x.astype(np.float64), n)
    X *= _biquad_response(*shelf, n) * _biquad_response(*hp, n)
    out = np.fft.irfft(X, n)[: len(x)]
    return out


def lufs(x: np.ndarray, sr: int = SR) -> float:
    """Integrated loudness (BS.1770-4 gating). A clip under 3 s is looped first, so a single word is measured
    over full 400 ms blocks of itself."""
    if len(x) < 3 * sr:
        x = np.tile(x, int(math.ceil(3 * sr / max(len(x), 1))))
    y = k_weight(x, sr)
    blk, step = int(0.4 * sr), int(0.1 * sr)
    z = np.array([np.mean(y[i:i + blk] ** 2) for i in range(0, len(y) - blk + 1, step)])
    l = -0.691 + 10 * np.log10(np.maximum(z, 1e-12))
    z1 = z[l > -70]
    if not len(z1):
        return -70.0
    rel = -0.691 + 10 * np.log10(z1.mean()) - 10
    z2 = z[(l > -70) & (l > rel)]
    return float(-0.691 + 10 * np.log10(z2.mean()))


def true_peak_db(x: np.ndarray) -> float:
    n = len(x)
    X = np.fft.rfft(x.astype(np.float64))
    up = np.fft.irfft(X, 4 * n) * 4
    return float(20 * np.log10(max(np.abs(up).max(), np.abs(x).max(), 1e-9)))


def voicing(x: np.ndarray, sr: int = SR) -> tuple[float, float]:
    """(fraction of 40 ms frames within 30 dB of the loudest that are voiced, their median f0)."""
    n, h = int(0.04 * sr), int(0.01 * sr)
    if len(x) < n:
        return 0.0, 0.0
    db = frames_db(x, sr, 0.04, 0.01)
    top, v, f0 = db.max(), [], []
    lo, hi = sr // 400, sr // 70
    for k, i in enumerate(range(0, len(x) - n + 1, h)):
        if k >= len(db) or db[k] < top - 30:
            continue
        fr = x[i:i + n] - x[i:i + n].mean()
        ac = np.correlate(fr, fr, "full")[n - 1:]
        ac = ac / (ac[0] + 1e-12)
        j = lo + int(np.argmax(ac[lo:hi]))
        v.append(ac[j] > 0.5)
        if ac[j] > 0.5:
            f0.append(sr / j)
    return (float(np.mean(v)) if v else 0.0), (float(np.median(f0)) if f0 else 0.0)


def centroid(x: np.ndarray, sr: int = SR) -> float:
    X = np.abs(np.fft.rfft(x * np.hanning(len(x)))) ** 2
    f = np.fft.rfftfreq(len(x), 1 / sr)
    return float((X * f).sum() / max(X.sum(), 1e-12))


STOPS = ("t", "k", "p", "tʃ", "θ", "s", "f", "ʃ")


def tail_check(x: np.ndarray, phonemes: str, sr: int = SR) -> str | None:
    """Kokoro sometimes adds a syllable after a final voiceless consonant ("moment-uh", "think-er"; Whisper writes
    "One moment here."): after the release, 50 ms or more of creaky voice an octave under her own pitch, where only
    a burst or a hiss belongs."""
    words = phonemes.split()
    last = re.sub(r"[ˈˌː.,!?;:…|]", "", words[-1]) if words else ""
    if not last.endswith(STOPS):
        return None
    s, e, _ = speech_bounds(x, sr)
    seg = x[int(s * sr):int(e * sr)]
    n, h = int(0.04 * sr), int(0.01 * sr)
    lo, hi = sr // 400, sr // 60
    db = frames_db(seg, sr, 0.04, 0.01)
    top = db.max()
    f0 = []
    for k, i in enumerate(range(0, len(seg) - n + 1, h)):
        fr = seg[i:i + n] - seg[i:i + n].mean()
        ac = np.correlate(fr, fr, "full")[n - 1:]
        ac = ac / (ac[0] + 1e-12)
        j = lo + int(np.argmax(ac[lo:hi]))
        f0.append((sr / j) if ac[j] > 0.5 and k < len(db) and db[k] > top - 22 else 0.0)
    f0 = np.array(f0)
    if not (f0 > 0).any():
        return None
    mine = float(np.median(f0[f0 > 0]))
    tail = f0[-int(0.30 / 0.01):]
    creak = np.sum((tail > 0) & (tail < 0.72 * mine)) * 0.01
    if creak >= 0.05:
        return f"creaky syllable ({creak:.2f}s near {np.median(tail[(tail > 0) & (tail < 0.72 * mine)]):.0f} Hz, " \
               f"her pitch {mine:.0f} Hz) after the final {last[-2:]}"
    return None


VOICED_END = set("aeiouɑɐɒɔəɚɛɜɪʊʌæɨʉyøœmnŋlɹwjɾ")


def end_hiss(x: np.ndarray, phonemes: str, sr: int = SR) -> int | None:
    """Where Kokoro ends an utterance on a voiced sound (a vowel, a nasal, l, r) it often breathes out after it: 100
    to 150 ms of hiss centred near 8 kHz, which Whisper hears as an "s" ("chains", "ones", "nows"). Returns the
    sample after the last voiced frame when what follows it is that hiss, else None."""
    words = phonemes.split()
    last = re.sub(r"[ˈˌː.,!?;:…|]", "", words[-1]) if words else ""
    if not last or last[-1] not in VOICED_END:
        return None
    s, e, _ = speech_bounds(x, sr)
    a, b = int(s * sr), int(e * sr)
    n, h = int(0.02 * sr), int(0.005 * sr)
    lo, hi = sr // 400, sr // 70
    last_v = None
    for i in range(a, b - n + 1, h):
        fr = x[i:i + n] - x[i:i + n].mean()
        ac = np.correlate(fr, fr, "full")[n - 1:]
        ac = ac / (ac[0] + 1e-12)
        if ac[lo:hi].max() > 0.5 and centroid(fr) < 2500:
            last_v = i + n
    if last_v is None or (b - last_v) / sr < 0.03:
        return None
    return last_v if centroid(x[last_v:b]) > 3500 else None


def dehiss(x: np.ndarray, phonemes: str, sr: int = SR) -> tuple[np.ndarray, str | None]:
    cut = end_hiss(x, phonemes, sr)
    if cut is None:
        return x, None
    s, e, _ = speech_bounds(x, sr)
    y = x[:cut].astype(np.float64).copy()
    f = int(0.020 * sr)
    y[-f:] *= 0.5 + 0.5 * np.cos(np.pi * np.arange(1, f + 1) / f)
    return y.astype(np.float32), f"cut {e - cut / sr:.2f}s of end hiss"


def measure(x: np.ndarray, sr: int = SR) -> dict:
    s, e, notes = speech_bounds(x, sr)
    peak = float(np.abs(x).max())
    edge = max(abs(float(x[0])), abs(float(x[-1]))) if len(x) else 0.0
    return {
        "dur": round(len(x) / sr, 3), "lead": round(s, 3), "trail": round(max(len(x) / sr - e, 0), 3),
        "speech": round(e - s, 3), "peak_db": round(20 * math.log10(max(peak, 1e-9)), 2),
        "true_peak_db": round(true_peak_db(x), 2), "clipped": int(np.sum(np.abs(x) >= 0.999)),
        "lufs": round(lufs(x[int(s * sr):int(e * sr)] if e > s else x, sr), 2),
        "edge_db": round(20 * math.log10(max(edge, 1e-9)), 1), "notes": notes,
    }


# ----------------------------------------------------------------------------------------- making a take
def finish(x: np.ndarray, gain_db: float) -> tuple[np.ndarray, list[str]]:
    """Trim to LEAD/TAIL of air, fade, apply gain."""
    s, e, notes = speech_bounds(x)
    a = int(round((s - LEAD) * SR))
    b = int(round((e + TAIL) * SR))
    head = max(0, -a)
    y = x[max(a, 0):min(b, len(x))].astype(np.float64)
    y = np.concatenate([np.zeros(head), y, np.zeros(max(0, b - len(x)))])
    fi, fo = int(FADE_IN * SR), int(FADE_OUT * SR)
    y[:fi] *= 0.5 - 0.5 * np.cos(np.pi * np.arange(fi) / fi)
    y[-fo:] *= 0.5 + 0.5 * np.cos(np.pi * np.arange(1, fo + 1) / fo)
    y[0] = y[-1] = 0.0
    y *= 10 ** (gain_db / 20)
    return y.astype(np.float32), notes


def mp3(audio: np.ndarray, sr: int = SR) -> bytes:
    """Exactly queen/voice.py's Voice.mp3."""
    import soundfile as sf
    buf = io.BytesIO()
    sf.write(buf, audio, sr, format="MP3", subtype="MPEG_LAYER_III")
    return buf.getvalue()


def decode(path: Path, sr: int = SR) -> np.ndarray:
    """What a browser hears: ffmpeg decodes the MP3, dropping the encoder delay the LAME tag records."""
    raw = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(path), "-f", "f32le", "-ac", "1",
                          "-ar", str(sr), "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32).copy()


class Kokoro_:
    def __init__(self) -> None:
        import onnxruntime as ort
        from kokoro_onnx import Kokoro
        so = ort.SessionOptions()
        so.intra_op_num_threads = 4
        so.inter_op_num_threads = 1
        sess = ort.InferenceSession(str(MODELS / "kokoro-v1.0.int8.onnx"), so, providers=["CPUExecutionProvider"])
        self.k = Kokoro.from_session(sess, str(MODELS / "voices-v1.0.bin"))

    def phonemes(self, take: str) -> str:
        if "|" in take:
            return " | ".join(self.phonemes(t) for t in take.split("|"))
        return take[3:] if take.startswith("ph:") else self.k.tokenizer.phonemize(take, LANG)

    def say(self, take: str, speed: float) -> np.ndarray:
        if "|" in take:  # sentences made apart and joined with a pause
            parts = []
            for t in take.split("|"):
                a = self.say(t, speed)
                s, e, _ = speech_bounds(a)
                parts += [a[int(s * SR):int(e * SR)], np.zeros(int(JOIN_GAP * SR), np.float32)]
            return np.concatenate(parts[:-1])
        if take.startswith("ph:"):
            a, sr = self.k.create(take[3:], voice=VOICE, speed=speed, lang=LANG, is_phonemes=True)
        else:
            a, sr = self.k.create(take, voice=VOICE, speed=speed, lang=LANG)  # queen/voice.py's call
        assert sr == SR
        return a


# ------------------------------------------------------------------------------------------ whisper check
def whisper_worker(jobs_path: str, out_path: str, model_name: str) -> None:
    """Runs in the Whisper interpreter: free transcription plus the teacher-forced log-probability of each
    expected text, per clip."""
    import torch
    import whisper
    from whisper.tokenizer import get_tokenizer
    torch.set_num_threads(max(1, (os.cpu_count() or 4) - 1))
    model = whisper.load_model(model_name, device="cpu")
    tok = get_tokenizer(model.is_multilingual, num_languages=model.num_languages, language="en", task="transcribe")
    sot = list(tok.sot_sequence_including_notimestamps)
    jobs = json.loads(Path(jobs_path).read_text())
    out = {}
    opts = whisper.DecodingOptions(language="en", without_timestamps=True, fp16=False, temperature=0.0)
    with torch.no_grad():
        for j in jobs:
            audio = whisper.load_audio(j["path"])
            mel = whisper.log_mel_spectrogram(whisper.pad_or_trim(audio), model.dims.n_mels)
            r = whisper.decode(model, mel, opts)
            feat = model.embed_audio(mel[None])
            forced = {}
            for t in j["expect"]:
                body = tok.encode(" " + t.strip()) + [tok.eot]
                seq = torch.tensor([sot + body[:-1]])
                lp = torch.log_softmax(model.logits(seq, feat)[0].float(), -1)
                tgt = torch.tensor(body)
                pos = torch.arange(len(sot) - 1, len(sot) - 1 + len(body))
                forced[t] = float(lp[pos, tgt].mean())
            out[j["key"]] = {"text": r.text.strip(), "avg_logprob": float(r.avg_logprob),
                             "no_speech": float(r.no_speech_prob), "forced": forced}
            if len(out) % 25 == 0:
                print(f"    {len(out)}/{len(jobs)}", file=sys.stderr, flush=True)
                Path(out_path).write_text(json.dumps(out))
    Path(out_path).write_text(json.dumps(out))


def whisper_run(clips: list[dict], model_name: str, work: Path, py: str) -> dict:
    """clips: [{key, path, expect}]; cached per key and model in work/whisper-<model>.json."""
    cache_p = work / f"whisper-{model_name}.json"
    cache = json.loads(cache_p.read_text()) if cache_p.exists() else {}
    todo = [c for c in clips if c["key"] not in cache or set(c["expect"]) - set(cache[c["key"]]["forced"])]
    if todo:
        jp, op = work / "whisper-jobs.json", work / "whisper-out.json"
        jp.write_text(json.dumps(todo))
        env = dict(os.environ, PYTHONWARNINGS="ignore")
        print(f"  whisper {model_name}: {len(todo)} clips ...", flush=True)
        subprocess.run([py, "-I", str(Path(__file__).resolve()), "--whisper-worker", str(jp), str(op),
                        "--whisper-model", model_name], check=True, env=env)
        cache.update(json.loads(op.read_text()))
        cache_p.write_text(json.dumps(cache, indent=1))
    return {c["key"]: cache[c["key"]] for c in clips}


# Whisper picks a spelling for a sound; these are the same sound in her accent (RP "vault" is /vɒlt/)
HOMOPHONE = {"volt": "vault", "volts": "vaults", "jeans": "genes", "way": "weigh", "whey": "weigh",
             "too": "to", "two": "to", "won": "one"}  # applied to both sides, so a map is an equivalence


def norm(t: str) -> str:
    t = t.lower().replace("’", "'")
    t = re.sub(r"[^a-z' ]+", " ", t)
    t = t.replace("'", "")
    t = re.sub(r"\b(h*m+(h*m+)*)\b", "hmm", t)  # hm, hmm, mm, mhm: one word ("hum" and "um" are not, see HUM)
    return " ".join(HOMOPHONE.get(w, w) for w in t.split())


def heard_ok(text: str, line: dict) -> bool:
    got = norm(text)
    want = {norm(line["say"])} | {norm(h) for h in line.get("hear", [])}
    if got in want:
        return True
    # a hum line written "Mmm. Me." passes as "Hmm. Me." too
    return got.replace("hmm", "") == norm(line["say"]).replace("hmm", "") and "hmm" in got and "hmm" in norm(line["say"])


def expects(line: dict) -> list[str]:
    """The line as Whisper might punctuate it (the forced score takes the likeliest)."""
    say = line["say"]
    e = [say, re.sub(r"[.!?] (\w)", lambda m: ", " + m.group(1).lower(), say), re.sub(r"\. ", "? ", say)]
    if line.get("hear") or "hmm" in norm(say):
        for b in list(e):
            for alt in ("Hmm", "Mm", "Mmm", "Hm"):
                e.append(re.sub(r"^(M+m*|Hm+)(?=[.,?])", alt, b))
    return list(dict.fromkeys(e))


def variants(line: dict) -> list[dict]:
    """The line as written, then any alternative words (`alt`) to fall back on."""
    base = {k: v for k, v in line.items() if k != "alt"}
    return [base] + [{**base, "hear": [], **a} for a in line.get("alt", [])]


def endings(line: dict) -> list[str]:
    """Each take, plus the same words ending in a comma and in nothing: a full stop often makes Kokoro add a
    syllable after a final consonant ("moment-here", "one-s"), and the other endings often do not."""
    out = []
    for t in line["takes"]:
        out.append(t)
        if t.endswith(".") and "|" not in t and line.get("endings", True):
            out += [t[:-1] + ","] + ([] if t.startswith("ph:") else [t[:-1]])
    return list(dict.fromkeys(out))


def f0_end(x: np.ndarray, sr: int = SR) -> float:
    """Pitch movement at the end, in semitones: the last 150 ms of voicing against the 300 ms before it. A filler
    is a statement; a strong rise makes it sound like a question."""
    n, h = int(0.04 * sr), int(0.01 * sr)
    db = frames_db(x, sr, 0.04, 0.01)
    top, track = db.max(), []
    lo, hi = sr // 400, sr // 70
    for k, i in enumerate(range(0, len(x) - n + 1, h)):
        if k >= len(db) or db[k] < top - 30:
            continue
        fr = x[i:i + n] - x[i:i + n].mean()
        ac = np.correlate(fr, fr, "full")[n - 1:]
        ac = ac / (ac[0] + 1e-12)
        j = lo + int(np.argmax(ac[lo:hi]))
        if ac[j] > 0.6:
            track.append((i / sr, sr / j))
    if len(track) < 8:
        return 0.0
    t_end = track[-1][0]
    last = [f for t, f in track if t > t_end - 0.15]
    before = [f for t, f in track if t_end - 0.45 < t <= t_end - 0.15]
    if not last or not before:
        return 0.0
    return float(12 * np.log2(np.median(last) / np.median(before)))


# ---------------------------------------------------------------------------------------------- the work
def reply_target(kk: Kokoro_, work: Path) -> tuple[float, list[dict]]:
    rows = []
    for mood, text in REPLIES:
        for s in [s.strip() for s in re.split(r"(?<=[.!?])\s+", text) if s.strip()]:
            a = kk.say(s, SPEED[mood])
            p = work / f"reply-{hashlib.sha1((mood + s).encode()).hexdigest()[:10]}.mp3"
            p.write_bytes(mp3(a))
            d = decode(p)
            rows.append({"mood": mood, "text": s, "lufs": round(lufs(d), 2),
                         "true_peak_db": round(true_peak_db(d), 2), "dur": round(len(d) / SR, 2)})
    return float(np.median([r["lufs"] for r in rows])), rows


def diagnose(args) -> None:
    work = args.work
    kk = Kokoro_()
    target, replies = reply_target(kk, work)
    print(f"her replies: median {target:.2f} LUFS over {len(replies)} sentences "
          f"(range {min(r['lufs'] for r in replies):.2f} .. {max(r['lufs'] for r in replies):.2f})")
    clips, rows = [], []
    for topic, group in SPACE_FILLERS.items():
        for f in group:
            a = kk.say(f, CALM)
            p = work / f"space-{hashlib.sha1(f.encode()).hexdigest()[:10]}.mp3"
            p.write_bytes(mp3(a))
            d = decode(p)
            m = measure(d)
            line = {"say": f, "hear": HUM if norm(f) == "hmm" else []}
            rows.append({"topic": topic, "say": f, "phonemes": kk.phonemes(f), **m, "line": line})
            clips.append({"key": p.stem, "path": str(p), "expect": expects(line)})
    wh = whisper_run(clips, args.whisper_model, work, args.whisper_python)
    for r, c in zip(rows, clips):
        w = wh[c["key"]]
        r["heard"] = w["text"]
        r["ok"] = heard_ok(w["text"], r.pop("line"))
        r["forced"] = round(max(w["forced"].values()), 3)
        r["loud_vs_replies"] = round(r["lufs"] - target, 2)
    print(f"{'say':38} {'phonemes':36} {'dur':>5} {'lead':>5} {'trail':>5} {'LUFS':>6} {'dTgt':>5} {'TP':>6} "
          f"{'edge':>6}  heard")
    for r in rows:
        print(f"{r['say']:38} {r['phonemes'][:36]:36} {r['dur']:5.2f} {r['lead']:5.2f} {r['trail']:5.2f} "
              f"{r['lufs']:6.1f} {r['loud_vs_replies']:+5.1f} {r['true_peak_db']:6.1f} {r['edge_db']:6.1f}  "
              f"{'ok ' if r['ok'] else 'BAD'} {r['heard']!r} {r['notes'] or ''}")
    (work / "diagnosis.json").write_text(json.dumps({"reply_target_lufs": target, "replies": replies,
                                                     "space_fillers": rows}, indent=1, ensure_ascii=False))
    print(f"written {work / 'diagnosis.json'}")


def render(args) -> None:
    work = args.work
    lines = [l for l in LINES if not args.only or l["id"] in args.only]
    kk = Kokoro_()
    target, replies = reply_target(kk, work)
    print(f"target: {target:.2f} LUFS (median of {len(replies)} reply sentences at queen/voice.py's settings)")
    takes = []
    for line in lines:
        for alt, var in enumerate(variants(line)):
            for t in endings(var):
                for sp in SPEEDS:
                    key = hashlib.sha1(f"{VOICE}|{LANG}|{t}|{sp}|v1".encode()).hexdigest()[:12]
                    raw_p = work / f"take-{key}.npy"
                    if raw_p.exists():
                        raw = np.load(raw_p)
                    else:
                        raw = kk.say(t, sp)
                        np.save(raw_p, raw)
                    phon = kk.phonemes(t)
                    clean, hiss = dehiss(raw, phon.split("|")[-1])
                    s, e, _ = speech_bounds(clean)
                    gain = target - lufs(clean[int(s * SR):int(e * SR)])
                    y, notes = finish(clean, gain)
                    if hiss:
                        notes.append(hiss)
                        key += "-dh"
                    tp = true_peak_db(y)
                    if tp > TRUE_PEAK_MAX:  # rare: give up a little loudness rather than clip
                        y = (y * 10 ** ((TRUE_PEAK_MAX - tp) / 20)).astype(np.float32)
                        notes.append(f"peak-limited by {tp - TRUE_PEAK_MAX:.1f} dB")
                    p = work / f"fin-{key}.mp3"
                    p.write_bytes(mp3(y))
                    d = decode(p)
                    fs, fe, _ = speech_bounds(d)
                    body = d[int(fs * SR):int(fe * SR)]
                    vf, f0 = voicing(body)
                    faults = [f for f in [tail_check(d, phon)] if f]
                    rise = f0_end(body)
                    if var.get("hear") == HUM and (vf < 0.6 or centroid(body) > 900):
                        faults.append(f"not a closed hum (voiced {vf:.2f}, centroid {centroid(body):.0f} Hz)")
                    takes.append({"line": var, "alt": alt, "id": line["id"], "take": t, "speed": sp,
                                  "key": f"fin-{key}", "path": str(p), "raw": measure(raw), "final": measure(d), "notes": notes,
                                  "faults": faults, "voiced": round(vf, 2), "f0": round(f0), "phonemes": phon,
                                  "centroid": round(centroid(body)), "end_st": round(rise, 1), "gain": round(gain, 2)})
    print(f"  {len(takes)} takes rendered")
    wh = whisper_run([{"key": t["key"], "path": t["path"], "expect": expects(t["line"])} for t in takes],
                     args.whisper_model, work, args.whisper_python)
    for t in takes:
        w = wh[t["key"]]
        t["heard"], t["ok"] = w["text"], heard_ok(w["text"], t["line"])
        t["forced"] = max(w["forced"].values())
        # prefer the take Whisper is surest says the line, then her calm pace; a fault all but rules a take out
        t["score"] = (t["forced"] - 0.04 * abs(t["speed"] - CALM) / 0.03 - 0.5 * bool(t["final"]["clipped"])
                      - 0.5 * len(t["faults"]) - 0.15 * (t["end_st"] > 2.5))
    picks = {}
    for line in lines:
        # the line as written first; its alternative words only if no take of it passes
        mine = sorted([t for t in takes if t["id"] == line["id"]], key=lambda t: (t["alt"], -t["score"]))
        good = [t for t in mine if t["ok"]]
        picks[line["id"]] = good[:8]
        print(f"\n{line['id']:10} {' / '.join(v['say'] for v in variants(line))}")
        for t in mine:
            print(f"   {'*' if good and t is good[0] else ' '} {'ok ' if t['ok'] else 'BAD'} {t['take']!r:44} "
                  f"x{t['speed']:.2f}  {t['final']['speech']:4.2f}s  end {t['end_st']:+5.1f}st  forced {t['forced']:6.3f}  "
                  f"score {t['score']:6.3f}  heard {t['heard']!r} {'; '.join(t['faults'])}")
    # the winners again, with a bigger Whisper, on the finished MP3s; a winner that fails falls to the next take,
    # and a line with no take that passes both is not written (it needs other words)
    final = {}
    for rnd in range(6):
        cand = {i: c[0] for i, c in picks.items() if c and i not in final}
        if not cand:
            break
        big = whisper_run([{"key": t["key"], "path": t["path"], "expect": expects(t["line"])} for t in cand.values()],
                          args.check_model, work, args.whisper_python)
        for i, t in cand.items():
            b = big[t["key"]]
            t["check"] = {"model": args.check_model, "heard": b["text"], "ok": heard_ok(b["text"], t["line"]),
                          "forced": round(max(b["forced"].values()), 3)}
            if t["check"]["ok"]:
                final[i] = t
            else:
                print(f"  {i}: {args.check_model} heard {b['text']!r} for {t['take']!r}; trying the next take")
                picks[i] = picks[i][1:]
    failed = [l for l in lines if l["id"] not in final]
    OUT.mkdir(parents=True, exist_ok=True)
    man_p = OUT / "manifest.json"
    manifest = {m["id"]: m for m in json.loads(man_p.read_text())} if (args.only and man_p.exists()) else {}
    report = []
    for line in lines:
        if line["id"] not in final:
            continue
        t = final[line["id"]]
        data = Path(t["path"]).read_bytes()
        (OUT / f"{line['id']}.mp3").write_bytes(data)
        manifest[line["id"]] = {"id": line["id"], "topic": line["topic"], "say": t["line"]["say"],
                                "file": f"{line['id']}.mp3", "dur": t["final"]["dur"]}
        report.append({k: v for k, v in t.items() if k not in ("line", "path")})
    if not args.only:  # a full run owns the folder: clips of lines no longer in LINES go
        for f in OUT.glob("*.mp3"):
            if f.stem not in manifest:
                f.unlink()
    order = {l["id"]: i for i, l in enumerate(LINES)}
    man_p.write_text(json.dumps(sorted(manifest.values(), key=lambda m: order.get(m["id"], 999)), indent=2,
                                ensure_ascii=False) + "\n")
    (work / "picks.json").write_text(json.dumps({"target_lufs": target, "replies": replies, "picks": report},
                                                indent=1, ensure_ascii=False))
    print(f"\n{'id':10} {'say':42} {'take':44} {'speed':>5} {'dur':>5} {'LUFS':>6} {'TP':>5}  check")
    for r in report:
        f = r["final"]
        print(f"{r['id']:10} {manifest[r['id']]['say']:42} {r['take']!r:44} {r['speed']:5.2f} {f['dur']:5.2f} "
              f"{f['lufs']:6.1f} {f['true_peak_db']:5.1f}  {'ok' if r.get('check', {}).get('ok') else 'FAIL'} "
              f"{r.get('check', {}).get('heard')!r}")
    for line in failed:
        print(f"NOT WRITTEN {line['id']} {line['say']!r}: no take passed both Whisper checks")
    print(f"\nwritten {len(report)} clips and {man_p}; details in {work / 'picks.json'}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--diagnose", action="store_true")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--work", type=Path, default=Path(tempfile.gettempdir()) / "red-queen-fillers")
    ap.add_argument("--whisper-python", default=os.environ.get("WHISPER_PYTHON",
                                                               str(Path.home() / "miniforge3" / "bin" / "python")))
    ap.add_argument("--whisper-model", default="small")
    ap.add_argument("--check-model", default="medium")
    ap.add_argument("--whisper-worker", nargs=2)
    args = ap.parse_args()
    if args.whisper_worker:
        return whisper_worker(*args.whisper_worker, args.whisper_model)
    if args.list:
        for l in LINES:
            print(f"{l['id']:10} {l['topic']:8} {l['say']!r}")
            for t in [t for v in variants(l) for t in endings(v)]:
                print(f"{'':20} {t!r} x {', '.join(map(str, SPEEDS))}")
        return
    args.work.mkdir(parents=True, exist_ok=True)
    diagnose(args) if args.diagnose else render(args)


if __name__ == "__main__":
    main()
