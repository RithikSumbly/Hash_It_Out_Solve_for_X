#!/usr/bin/env python3
"""Render the Red Queen's narration for the demo film.

The queen's voice is Chatterbox (Resemble AI, MIT) cloning `reference.flac`, 15 s of the bf_emma voice
the site used before (Kokoro-82M, see kokoro/). Each chapter in lines.json is spoken piece by piece
(sentences, list items) with its own direction: Chatterbox's `exaggeration` (emotional intensity),
`cfg_weight` (pace: lower is slower and more deliberate) and temperature. Every piece is rendered in a
seeded take, more only when it fails a check; each take is read back and force-aligned to its
words (wav2vec2-base-960h) and pitch-tracked (pYIN), and the take that says the words and has the
intonation the direction asks for (a fall, a continuation rise, a question rise, a stressed word)
is kept. The pieces are joined with the pauses the direction gives, post-processed with ffmpeg, and
written as

    web/public/voice/<id>.mp3      mono MP3, 32 kHz, 64 kbps CBR, -18 LUFS, true peak <= -1 dBTP
    web/public/voice/manifest.json voice, engine, licence, format, and per line: text, file, dur,
                                   words [{w, s, e}], phrases [{t, s, e}]

Takes are cached in --work (default: a folder in the system temp dir), so re-running after a change
to one piece only renders that piece. See README.md for setup, settings and licences.

    python tools/voice/render.py                      # every line
    python tools/voice/render.py --only c03 c06       # just these (manifest entries are merged)
    python tools/voice/render.py --pieces             # list the pieces and their direction, render nothing
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("TQDM_DISABLE", "1")
import numpy as np

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
DEFAULT_OUT = REPO / "web" / "public" / "voice"

MODEL = ("ResembleAI/chatterbox", "5bb1f6ee58e50c3b8d408bc82a6d3740c2db6e18",
         ["ve.safetensors", "t3_cfg.safetensors", "s3gen.safetensors", "tokenizer.json", "conds.pt"])
ALIGNER = ("facebook/wav2vec2-base-960h", "22aad52d435eb6dbaf354bdad9b0da84ce7d6156",
           ["config.json", "preprocessor_config.json", "vocab.json", "tokenizer_config.json",
            "special_tokens_map.json", "feature_extractor_config.json", "model.safetensors"])
SR = 24000             # Chatterbox output rate
OUT_SR = 32000         # the site's AudioContext rate
HOP = 0.005
REL_DB = 40.0          # speech = 20 ms frames within 40 dB of the loudest
TRIM_REL_DB = 50.0

DEFAULTS = {"exaggeration": 0.5, "cfg_weight": 0.5, "temperature": 0.8, "takes": 3, "seed": 1000,
            "pause": 0.45, "pace": 4.7}
MAX_SLOW = 1.0         # no pacing step: slowing takes (up to 30 %, stressed words most) makes the pace lurch
                       # within sentences, so every take keeps its natural speed and pace comes from choosing takes
MAX_QUICK = 1.15       # a take more than 15 % quicker than the line's pace fails and is rendered again
POST = {
    "prenorm_lufs": -20.0,
    "filters": ",".join([
        "highpass=f=70:poles=2",
        "highshelf=f=7000:g=-3:t=q:w=0.707",
        "acompressor=threshold=-24dB:ratio=2:attack=10:release=150:knee=2.8:detection=rms",
    ]),
    "lufs": -18.0, "true_peak_max": -1.0, "lead": 0.040, "tail": 0.120, "fade_in": 0.015,
    "fade_out": 0.060, "bitrate": "64k",
}


def fetch(repo, rev, files) -> Path:
    """Pinned files from the Hugging Face hub (cached in HF_HOME; works offline once cached)."""
    from huggingface_hub import hf_hub_download
    return Path([hf_hub_download(repo, f, revision=rev) for f in files][0]).parent


# ---------------------------------------------------------------------------------------- analysis

def frames_db(x: np.ndarray, sr: int, hop: float = HOP, win: float = 0.02) -> np.ndarray:
    h, w = int(round(hop * sr)), int(round(win * sr))
    pad = np.pad(x.astype(np.float64), (w // 2, w // 2))
    n = max(1, len(x) // h)
    fr = np.lib.stride_tricks.sliding_window_view(pad, w)[::h][:n]
    return 20 * np.log10(np.sqrt((fr ** 2).mean(axis=1)) + 1e-9)


def bounds(x: np.ndarray, sr: int, rel: float) -> tuple[float, float]:
    e = frames_db(x, sr)
    act = np.flatnonzero(e > e.max() - rel)
    return act[0] * HOP, (act[-1] + 1) * HOP


def to16k(x: np.ndarray) -> np.ndarray:
    from scipy.signal import resample_poly
    return resample_poly(x, 2, 3).astype(np.float32)


def semitones(hz):
    return 12 * np.log2(np.asarray(hz) / 100.0)


def syllables(word: str) -> int:
    w = re.sub(r"[^a-z]", "", word.lower())
    if not w:
        return 0
    n = len(re.findall(r"[aeiouy]+", w))
    if w.endswith("e") and not w.endswith(("le", "ee", "ye")) and n > 1:
        n -= 1
    if w.endswith("ed") and not w.endswith(("ted", "ded")) and n > 1:
        n -= 1
    return max(1, n)


SMALL = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen " \
        "sixteen seventeen eighteen nineteen".split()
TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()


def number_words(n: int) -> str:
    if n < 20:
        return SMALL[n]
    if n < 100:
        return TENS[n // 10] + ("" if n % 10 == 0 else " " + SMALL[n % 10])
    return str(n)


def norm_words(s: str) -> list:
    s = s.replace("%", " percent").replace("-", " ")
    s = re.sub(r"\d+", lambda m: " " + number_words(int(m.group())) + " ", s)
    return re.sub(r"[^a-z' ]", " ", s.lower()).split()


def edit_distance(a: list, b: list) -> int:
    d = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        prev, d[0] = d[0], i
        for j in range(1, len(b) + 1):
            prev, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] != b[j - 1]))
    return d[-1]


# ------------------------------------------------------------------------------------------ models

class Voice:
    """Chatterbox, conditioned once on the reference voice."""

    def __init__(self, reference: Path, device: str):
        import torch
        from chatterbox.tts import ChatterboxTTS
        self.torch = torch
        self.tts = ChatterboxTTS.from_local(fetch(*MODEL), device)
        self.tts.prepare_conditionals(str(reference), exaggeration=0.5)

    def take(self, text: str, exaggeration: float, cfg_weight: float, temperature: float, seed: int):
        """ChatterboxTTS.generate, seeded, without the watermark (that goes on the take we keep)."""
        torch = self.torch
        import torch.nn.functional as F
        from chatterbox.tts import punc_norm
        from chatterbox.models.t3.modules.cond_enc import T3Cond
        from chatterbox.models.s3tokenizer import drop_invalid_tokens
        tts = self.tts
        c = tts.conds.t3
        tts.conds.t3 = T3Cond(speaker_emb=c.speaker_emb, cond_prompt_speech_tokens=c.cond_prompt_speech_tokens,
                              emotion_adv=exaggeration * torch.ones(1, 1, 1)).to(device=tts.device)
        torch.manual_seed(seed)
        tokens = tts.tokenizer.text_to_tokens(punc_norm(text)).to(tts.device)
        if cfg_weight > 0.0:
            tokens = torch.cat([tokens, tokens], dim=0)
        tokens = F.pad(tokens, (1, 0), value=tts.t3.hp.start_text_token)
        tokens = F.pad(tokens, (0, 1), value=tts.t3.hp.stop_text_token)
        # speech tokens run at 25 a second; allow twice a slow reading, so a take that never stops
        # (Chatterbox sometimes rambles on) is cut short instead of running to 40 s
        nsyl = sum(syllables(w) for w in text.split())
        budget = min(1000, int(25 * (2.0 * nsyl / 3.5 + 1.5)))
        with torch.inference_mode():
            speech = tts.t3.inference(t3_cond=tts.conds.t3, text_tokens=tokens, max_new_tokens=budget,
                                      temperature=temperature, cfg_weight=cfg_weight,
                                      repetition_penalty=1.2, min_p=0.05, top_p=1.0)[0]
            speech = drop_invalid_tokens(speech)
            speech = speech[speech < 6561].to(tts.device)
            mel = tts.s3gen.flow_inference(speech, ref_dict=tts.conds.gen, finalize=True)
        mel = mel[0].float().cpu().numpy()
        return self.vocode(mel, seed), mel

    def vocode(self, mel: np.ndarray, seed: int) -> np.ndarray:
        """S3Gen's vocoder (HiFT, which predicts the pitch from the mel) on an 80 x T mel at 50 frames/s."""
        torch = self.torch
        s3 = self.tts.s3gen
        torch.manual_seed(seed)
        with torch.inference_mode():
            wav, _ = s3.hift_inference(torch.from_numpy(mel)[None].to(self.tts.device, dtype=s3.dtype), None)
            wav[:, :len(s3.trim_fade)] *= s3.trim_fade
        return wav.squeeze(0).detach().cpu().numpy().astype(np.float32)

    def watermark(self, wav: np.ndarray) -> np.ndarray:
        return np.asarray(self.tts.watermarker.apply_watermark(wav, sample_rate=SR), dtype=np.float32)


class Aligner:
    """CTC forced alignment of known words, wav2vec2-base-960h, character Viterbi at 20 ms."""

    def __init__(self):
        import torch
        from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor
        d = fetch(*ALIGNER)
        self.torch = torch
        self.proc = Wav2Vec2Processor.from_pretrained(d)
        self.model = Wav2Vec2ForCTC.from_pretrained(d).eval()
        v = self.proc.tokenizer.get_vocab()
        self.vocab, self.blank, self.sep = v, v["<pad>"], v["|"]

    @staticmethod
    def spell(word: str) -> list:
        return [p for p in re.sub(r"[^A-Za-z'\- ]", "", word).upper().replace("-", " ").split() if p.strip("'")]

    def emissions(self, y16: np.ndarray) -> np.ndarray:
        with self.torch.inference_mode():
            x = self.proc(y16, sampling_rate=16000, return_tensors="pt").input_values
            return self.torch.log_softmax(self.model(x).logits[0], dim=-1).numpy()

    def transcribe(self, em: np.ndarray) -> str:
        """Greedy CTC reading of the take (what the aligner itself hears)."""
        inv = {i: c for c, i in self.vocab.items()}
        ids = em.argmax(axis=1)
        out, prev = [], None
        for i in ids:
            if i != prev and i != self.blank:
                out.append(inv[i])
            prev = i
        return "".join(out).replace("|", " ").replace("<s>", "").replace("</s>", "").strip().lower()

    def align(self, y16: np.ndarray, words: list, em: np.ndarray | None = None):
        """-> [(start, end)] seconds per word (end = its last character's frame), mean log-prob."""
        if em is None:
            em = self.emissions(y16)
        toks, owner = [], []
        for wi, w in enumerate(words):
            for part in self.spell(w):
                if toks:
                    toks.append(self.sep)
                    owner.append(-1)
                for ch in part:
                    toks.append(self.vocab[ch])
                    owner.append(wi)
        T, S = em.shape[0], 2 * len(toks) + 1
        ext = np.full(S, self.blank)
        ext[1::2] = toks
        neg = -1e9
        dp = np.full(S, neg)
        dp[0], dp[1] = em[0, ext[0]], em[0, ext[1]]
        bp = np.zeros((T, S), dtype=np.int8)
        skip = np.zeros(S, dtype=bool)
        skip[3::2] = ext[3::2] != ext[1:-2:2]
        for t in range(1, T):
            adv = np.concatenate([[neg], dp[:-1]])
            skp = np.where(skip, np.concatenate([[neg, neg], dp[:-2]]), neg)
            best = np.maximum(np.maximum(dp, adv), skp)
            bp[t] = np.where(best == dp, 0, np.where(best == adv, 1, 2))
            dp = best + em[t, ext]
        s = S - 1 if dp[S - 1] >= dp[S - 2] else S - 2
        score = dp[s] / T
        span = [[None, None] for _ in words]
        for t in range(T - 1, -1, -1):
            if s % 2 == 1 and owner[s // 2] >= 0:
                o = span[owner[s // 2]]
                o[1] = t + 1 if o[1] is None else o[1]
                o[0] = t
            s -= bp[t, s]
        return [(None if a is None else a * 0.02, None if b is None else b * 0.02) for a, b in span], float(score)


class Judge:
    """Checks a take with the aligner's own CTC model (Whisper runs separately, on the finished clips,
    to keep the render within this machine's memory)."""

    def __init__(self):
        self.aligner = Aligner()

    def measure(self, y: np.ndarray, piece: dict) -> dict:
        """Everything the choice needs about one take."""
        import librosa
        y16 = to16k(y)
        em = self.aligner.emissions(y16)
        heard = self.aligner.transcribe(em)
        ref = " ".join(norm_words(piece["text"]))
        hyp = " ".join(norm_words(heard))
        cer = edit_distance(list(ref), list(hyp)) / max(1, len(ref))
        errors = int(cer > 0.12)                     # characters, so an odd spelling of a name is not an error
        words = piece["text"].split()
        spans, ascore = self.aligner.align(y16, words, em)
        e = frames_db(y, SR)
        thr = e.max() - REL_DB
        act = np.flatnonzero(e > thr)
        on, off = act[0] * HOP, (act[-1] + 1) * HOP
        q = e[act[0]:act[-1]] <= thr          # silent runs inside the speech
        longest, run = 0, 0
        for v in q:
            run = run + 1 if v else 0
            longest = max(longest, run)
        f0, _, _ = librosa.pyin(y16, fmin=65, fmax=450, sr=16000, frame_length=1024, hop_length=160)
        t = np.arange(len(f0)) * 0.01
        lev = 20 * np.log10(librosa.feature.rms(y=y16, frame_length=1024, hop_length=160)[0][:len(f0)] + 1e-9)
        voiced = ~np.isnan(f0) & (lev > lev.max() - 35)      # pYIN also "hears" pitch in digital silence
        st = np.where(voiced, semitones(np.where(voiced, f0, 100.0)), np.nan)
        v = st[voiced]
        rng = float(np.percentile(v, 95) - np.percentile(v, 5)) if len(v) > 10 else 0.0
        med = float(np.median(v)) if len(v) else 0.0
        # pitch movement over the last 0.35 s of voicing: last third minus first third (st)
        tv, sv = t[voiced], st[voiced]
        sel = tv >= (tv[-1] - 0.35) if len(tv) else []
        fin = float("nan")
        if len(tv) and sel.sum() >= 6:
            w = sv[sel]
            k = max(2, len(w) // 3)
            fin = float(np.median(w[-k:]) - np.median(w[:k]))
        stress = {}
        for word in piece.get("stress", []):
            idx = [i for i, w in enumerate(words) if re.sub(r"[^\w']", "", w).lower() == word.lower()]
            if idx and spans[idx[0]][0] is not None:
                a, b = spans[idx[0]]
                m = voiced & (t >= a) & (t <= b + 0.1)
                stress[word] = float(np.max(st[m]) - med) if m.any() else float("nan")
        gaps = 0.0
        for (a0, b0), (a1, b1) in zip(spans, spans[1:]):
            if b0 is not None and a1 is not None and a1 - b0 > 0.1:
                gaps += a1 - b0
        nsyl = sum(syllables(w) for w in words)
        rate = nsyl / max(0.2, off - on - gaps)
        return dict(heard=heard, errors=errors, cer=round(cer, 3), nwords=len(words), align=ascore,
                    unaligned=sum(a is None for a, _ in spans), spans=spans, on=on, off=off,
                    tail=len(y) / SR - off, longest_silence=longest * HOP, f0_range=rng, f0_median=med,
                    final=fin, stress=stress, rate=rate, dur=len(y) / SR)


def score(m: dict, piece: dict) -> float:
    """Higher is better. Words first, then the intonation the direction asks for, then pace."""
    s = -10.0 * m["errors"] - 5.0 * m["unaligned"]
    fin, end = m["final"], piece.get("end")
    if not np.isnan(fin):
        if end == "fall":
            s += 2.0 if fin < -1.5 else (1.0 if fin < -0.5 else -1.0)
        elif end == "rise":
            s += 3.0 if fin > 1.5 else (1.0 if fin > 0.5 else -3.0)
        elif end == "cont":
            s += 2.0 if fin > -0.5 else (0.0 if fin > -1.5 else -1.5)
        elif end == "low":           # a low, firm, final fall
            s += 2.5 if fin < -2.0 else (1.0 if fin < -1.0 else -1.0)
    for w, peak in m["stress"].items():
        if not np.isnan(peak):
            s += 1.0 if peak >= 2.5 else (0.4 if peak >= 1.5 else 0.0)
    target = piece["pace"]                        # syllables per second while speaking
    if m["rate"] > 1.3 * target:                  # more than the pacing step will slow down
        s -= 2.0 * (m["rate"] - 1.3 * target)
    elif m["rate"] < 0.8 * target:                # dragging
        s -= 2.0 * (0.8 * target - m["rate"])
    s += 0.12 * min(m["f0_range"], 12.0)
    allowed = 0.35 if "," in piece["text"] else 0.2
    if m["longest_silence"] > allowed + 0.15:
        s -= 3.0
    if m["tail"] < 0.03:
        s -= 3.0                     # cut off
    return s


# ------------------------------------------------------------------------------------------ pacing

def warp_mel(mel: np.ndarray, factor: float, stress: list = ()) -> np.ndarray:
    """Slow a take down by `factor` the way a speaker does, not by stretching everything evenly:
    vowels and other loud, voiced frames take most of the extra time, consonants and pauses little;
    the last 30 % of the phrase is lengthened up to 1.6x more (phrase-final lengthening); stressed
    words 1.5x more. No frame is stretched by more than 1.6. The mel (50 frames/s) is resampled along
    time and re-voiced by the vocoder, which predicts the pitch itself, so pitch is kept."""
    T = mel.shape[1]
    if factor <= 1.0 or T < 4:
        return mel
    e = mel.mean(axis=0)
    lo, hi = np.percentile(e, 10), np.percentile(e, 95)
    v = np.clip((e - lo) / max(1e-6, hi - lo), 0.0, 1.0)
    w = np.where(v < 0.15, 0.2, 0.3 + 0.7 * v)
    pos = np.arange(T) / (T - 1)
    w = w * (1.0 + 0.6 * np.clip((pos - 0.7) / 0.3, 0.0, 1.0))
    for a, b in stress:
        w[int(a / 0.02):int(b / 0.02) + 1] *= 1.5
    k = (factor - 1.0) * T / w.sum()
    d = np.minimum(1.0 + k * w, 1.6)
    edges = np.concatenate([[0.0], np.cumsum(d)])
    x = np.interp(np.arange(int(round(edges[-1]))) + 0.5, edges, np.arange(T + 1)) - 0.5
    x = np.clip(x, 0, T - 1)
    i0 = np.floor(x).astype(int)
    i1 = np.minimum(i0 + 1, T - 1)
    f = (x - i0)[None, :]
    return (mel[:, i0] * (1 - f) + mel[:, i1] * f).astype(np.float32)


# ------------------------------------------------------------------------------------------ pieces

def plan(text: str, direction: dict, settings: dict) -> list:
    """The pieces of a line with their direction, checked to rebuild the text."""
    base = {k: direction.get(k, settings[k]) for k in ("exaggeration", "cfg_weight", "temperature", "takes", "pace")}
    pieces = direction.get("pieces")
    if not pieces:
        pieces = [{"text": s.strip()} for s in re.findall(r"[^.!?]+[.!?]+", text)]
    out = []
    for p in pieces:
        q = {**base, "pause": settings["pause"], **p}
        q.setdefault("end", "rise" if q["text"].endswith("?") else ("cont" if q["text"].endswith(",") else "fall"))
        out.append(q)
    if " ".join(p["text"] for p in out) != text:
        raise SystemExit(f"pieces do not rebuild the text:\n  {' '.join(p['text'] for p in out)}\n  {text}")
    return out


def cache_key(piece: dict, seed: int, ref_hash: str) -> str:
    k = dict(say=piece.get("say", piece["text"]), ex=piece["exaggeration"], cfg=piece["cfg_weight"],
             temp=piece["temperature"], seed=seed, ref=ref_hash, model=MODEL[1])
    return hashlib.sha1(json.dumps(k, sort_keys=True).encode()).hexdigest()[:16]


KOKORO_RANGE = 6.9     # minimum per-sentence pitch range (st, p5-p95) a take must reach


def failures(m: dict, piece: dict) -> list:
    """Measurable reasons to take a piece again: wrong words, flatter than the old voice, or the
    wrong kind of ending."""
    out = []
    if m["errors"] or m["unaligned"]:
        out.append(f"heard {m['heard']!r}")
    need = KOKORO_RANGE if len(piece["text"].split()) >= 5 else 4.0
    if m["f0_range"] < need:
        out.append(f"pitch range {m['f0_range']:.1f} st < {need}")
    fin, end = m["final"], piece.get("end")
    if not np.isnan(fin):
        if end == "rise" and fin < 0.5:
            out.append(f"question ends {fin:+.1f} st")
        elif end == "cont" and fin < -1.5:
            out.append(f"list item falls {fin:+.1f} st")
        elif end in ("fall", "low") and fin > 0.5:
            out.append(f"statement rises {fin:+.1f} st")
    for w, peak in m["stress"].items():
        if not np.isnan(peak) and peak < 1.5:
            out.append(f"no lift on {w} ({peak:+.1f} st)")
    if m["rate"] > MAX_QUICK * piece["pace"]:
        out.append(f"too quick ({m['rate']:.1f} syl/s)")
    if m["tail"] < 0.03:
        out.append("cut off")
    return out


def best_take(voice, judge, piece: dict, work: Path, ref_hash: str, base_seed: int, log: list):
    """One take; another (next seed) only while the take fails a check, up to piece["takes"] in all.
    The same words with the same direction get the same seeds, so c04r and c04p share takes."""
    import soundfile as sf
    say = piece.get("say", piece["text"])
    seed0 = base_seed + int(hashlib.sha1(say.encode()).hexdigest(), 16) % 1_000_000
    results = []
    for k in range(piece["takes"]):
        seed = seed0 + k
        key = cache_key(piece, seed, ref_hash)
        wav, meta, melf = work / f"{key}.wav", work / f"{key}.json", work / f"{key}.mel.npy"
        if wav.exists() and melf.exists():
            y = sf.read(wav, dtype="float32")[0]
            if meta.exists():
                m = json.loads(meta.read_text())
            else:                                   # scoring changed: re-measure, don't re-render
                m = judge.measure(y, piece)
                meta.write_text(json.dumps(m))
        else:
            y, mel = voice.take(say, piece["exaggeration"], piece["cfg_weight"], piece["temperature"], seed)
            m = judge.measure(y, piece)
            sf.write(wav, y, SR, subtype="FLOAT")
            np.save(melf, mel)
            meta.write_text(json.dumps(m))
        m["mel"], m["seed"] = str(melf), seed
        fails = failures(m, piece)
        results.append((score(m, piece) - 5.0 * len(fails), k, seed, y, m, fails))
        if not fails:
            break
    best = max(results, key=lambda r: (r[0], -r[1]))
    sc, k, seed, y, m, fails = best
    log.append(dict(text=piece["text"], chosen=k, seed=seed, score=round(sc, 2), failed=fails,
                    takes=[dict(seed=r[2], score=round(r[0], 2), errors=r[4]["errors"], final=round(r[4]["final"], 2),
                                rate=round(r[4]["rate"], 2), f0_range=round(r[4]["f0_range"], 1), fails=r[5],
                                stress={a: round(b, 1) for a, b in r[4]["stress"].items()}, heard=r[4]["heard"])
                           for r in results]))
    return y, m


def render_line(voice, judge, lid: str, text: str, direction: dict, settings: dict, work: Path,
                ref_hash: str, log: list):
    """-> 24 kHz audio of the whole line and word timings [(word, s, e)]"""
    pieces = plan(text, direction, settings)
    chosen = []
    for p in pieces:
        y, m = best_take(voice, judge, p, work, ref_hash, settings["seed"], log)
        factor = min(MAX_SLOW, m["rate"] / p["pace"])
        if factor > 1.02:
            stress = [m["spans"][i] for i, w in enumerate(p["text"].split())
                      if re.sub(r"[^\w']", "", w).lower() in [x.lower() for x in p.get("stress", [])]
                      and m["spans"][i][0] is not None]
            y = voice.vocode(warp_mel(np.load(m["mel"]), factor, stress), m["seed"])
        log[-1]["slowed"] = round(max(1.0, factor), 3)
        chosen.append((p, y, m))
    # level: every piece's speech at the same mean power, plus the piece's own gain (dB)
    parts, words, t = [], [], 0.0
    for i, (p, y, m) in enumerate(chosen):
        y = voice.watermark(y)
        e = frames_db(y, SR)
        act = e > e.max() - 30
        power = float(np.mean(10 ** (e[act] / 10)))
        y = y * (10 ** (-20 / 20) / np.sqrt(power)) * 10 ** (p.get("gain", 0.0) / 20)
        on, off = bounds(y, SR, REL_DB + 5)
        a, b = max(0.0, on - 0.03), min(len(y) / SR, off + 0.06)
        seg = y[int(a * SR):int(b * SR)].copy()
        f = int(0.01 * SR)
        seg[:f] *= np.linspace(0, 1, f, dtype=np.float32)
        seg[-3 * f:] *= np.linspace(1, 0, 3 * f, dtype=np.float32)
        # word times inside this piece: aligned starts; ends run to the next start, or to the
        # end of the sound before a pause
        spans, _ = judge.aligner.align(to16k(seg), p["text"].split())
        for j, (s0, e0) in enumerate(spans):          # a word the aligner could not place: share the gap
            if s0 is None:
                prev = spans[j - 1][1] if j else 0.03
                nxt = next((x[0] for x in spans[j + 1:] if x[0] is not None), prev + 0.2)
                spans[j] = (prev, max(prev + 0.05, nxt))
        ee = frames_db(seg, SR)
        thr = ee.max() - REL_DB
        ws = p["text"].split()
        for j, (w, (s0, e0)) in enumerate(zip(ws, spans)):
            s0 = 0.03 if j == 0 else s0
            if j + 1 < len(ws) and spans[j + 1][0] is not None and spans[j + 1][0] - e0 < 0.15:
                e1 = spans[j + 1][0]
            else:
                k = int(e0 / HOP)
                while k < len(ee) and ee[k] > thr:
                    k += 1
                e1 = min(k * HOP, len(seg) / SR)
            words.append((w, t + s0, t + e1))
        parts.append(seg)
        t += len(seg) / SR
        if i + 1 < len(chosen):
            gap = max(0.0, p["pause"] - 0.03 - 0.06)
            parts.append(np.zeros(int(round(gap * SR)), np.float32))
            t += int(round(gap * SR)) / SR
    return np.concatenate(parts), words


# ---------------------------------------------------------------------------------- post-processing

def run_ffmpeg(args: list, data: bytes | None = None) -> bytes:
    p = subprocess.run(["ffmpeg", "-hide_banner", "-nostdin", "-v", "error", *args], input=data, capture_output=True)
    if p.returncode:
        raise RuntimeError(p.stderr.decode(errors="replace"))
    return p.stdout


def ffmpeg_filter(x: np.ndarray, sr: int, chain: str) -> np.ndarray:
    raw = run_ffmpeg(["-f", "f32le", "-ar", str(sr), "-ac", "1", "-i", "pipe:0", "-af", chain,
                      "-f", "f32le", "-ar", str(sr), "-ac", "1", "pipe:1"], x.astype("<f4").tobytes())
    y = np.frombuffer(raw, dtype="<f4").copy()
    if len(y) != len(x):
        raise RuntimeError(f"ffmpeg changed the length {len(x)} -> {len(y)}")
    return y


def loudness(path: Path) -> tuple[float, float]:
    p = subprocess.run(["ffmpeg", "-hide_banner", "-nostdin", "-nostats", "-i", str(path),
                        "-af", "loudnorm=print_format=json", "-f", "null", "-"], capture_output=True, text=True)
    m = json.loads(p.stderr[p.stderr.rfind("{"):p.stderr.rfind("}") + 1])
    return float(m["input_i"]), float(m["input_tp"])


def limit(y: np.ndarray, ceiling_db: float) -> tuple[np.ndarray, float]:
    from scipy.ndimage import minimum_filter1d, uniform_filter1d
    from scipy.signal import resample_poly
    up = np.abs(resample_poly(y, 4, 1))[: 4 * len(y)].reshape(-1, 4).max(axis=1)
    need = np.minimum(1.0, 10 ** (ceiling_db / 20) / np.maximum(up, 1e-12))
    if need.min() >= 1.0:
        return y, 0.0
    g = minimum_filter1d(need, 2 * int(0.003 * OUT_SR) + 1)
    g = uniform_filter1d(g, 2 * int(0.0025 * OUT_SR) + 1)
    return (y * g).astype(np.float32), float(20 * np.log10(g.min()))


def encode_mp3(y: np.ndarray, path: Path):
    run_ffmpeg(["-y", "-f", "f32le", "-ar", str(OUT_SR), "-ac", "1", "-i", "pipe:0", "-c:a", "libmp3lame",
                "-b:a", POST["bitrate"], "-ar", str(OUT_SR), "-ac", "1", "-map_metadata", "-1",
                "-id3v2_version", "0", "-write_xing", "1", str(path)], y.astype("<f4").tobytes())


def post_process(x: np.ndarray, words: list, out_mp3: Path):
    import pyloudnorm
    from scipy.signal import resample_poly
    x = x * 10 ** ((POST["prenorm_lufs"] - pyloudnorm.Meter(SR).integrated_loudness(x)) / 20)
    x = ffmpeg_filter(x.astype(np.float32), SR, POST["filters"])
    y = resample_poly(x, 4, 3).astype(np.float32)
    on, off = bounds(y, OUT_SR, TRIM_REL_DB)
    t0 = max(0.0, on - POST["lead"])
    t1 = min(len(y) / OUT_SR, off + POST["tail"])
    y = y[int(round(t0 * OUT_SR)):int(round(t1 * OUT_SR))].copy()
    fi, fo = int(POST["fade_in"] * OUT_SR), int(POST["fade_out"] * OUT_SR)
    y[:fi] *= (0.5 - 0.5 * np.cos(np.linspace(0, np.pi, fi))).astype(np.float32)
    y[-fo:] *= (0.5 + 0.5 * np.cos(np.linspace(0, np.pi, fo))).astype(np.float32)
    dur = len(y) / OUT_SR
    shifted = [dict(w=w, s=round(min(max(s - t0, 0.0), dur), 3), e=round(min(max(e - t0, 0.0), dur), 3))
               for w, s, e in words]
    for a, b in zip(shifted, shifted[1:]):
        if a["e"] > b["s"]:
            a["e"] = b["s"]
    y = (y * 10 ** ((POST["lufs"] - pyloudnorm.Meter(OUT_SR).integrated_loudness(y)) / 20)).astype(np.float32)
    ceiling, best, history = POST["true_peak_max"] - 0.5, None, []
    for _ in range(6):
        z, red = limit(y, ceiling)
        encode_mp3(z, out_mp3)
        lufs, peak = loudness(out_mp3)
        history.append((lufs, peak))
        err = abs(lufs - POST["lufs"])
        if peak <= POST["true_peak_max"] and (best is None or err < best[0]):
            best = (err, z, red)
        if peak <= POST["true_peak_max"] and err <= 0.03:
            break
        y = (y * 10 ** ((POST["lufs"] - lufs) / 20 * 0.7)).astype(np.float32)
        if peak > POST["true_peak_max"]:
            ceiling -= peak - POST["true_peak_max"] + 0.1
    if best is None or best[0] > 0.1:
        raise RuntimeError(f"{out_mp3.name}: loudness did not converge: {history}")
    encode_mp3(best[1], out_mp3)
    lufs, peak = loudness(out_mp3)
    dec = np.frombuffer(run_ffmpeg(["-i", str(out_mp3), "-f", "f32le", "-ac", "1", "-ar", str(OUT_SR), "pipe:1"]),
                        dtype="<f4")
    return dur, shifted, dict(lufs=lufs, true_peak=peak, limiter_db=best[2], decoded_dur=len(dec) / OUT_SR)


def phrases(words: list) -> list:
    out, cur = [], []
    for w in words:
        cur.append(w)
        if w["w"][-1] in ".!?:":
            out.append(dict(t=" ".join(x["w"] for x in cur), s=cur[0]["s"], e=cur[-1]["e"]))
            cur = []
    if cur:
        out.append(dict(t=" ".join(x["w"] for x in cur), s=cur[0]["s"], e=cur[-1]["e"]))
    return out


def dump_manifest(m: dict) -> str:
    s = json.dumps(m, indent=2, ensure_ascii=False)
    s = re.sub(r'\{\s*"w": (".*?"),\s*"s": ([\d.]+),\s*"e": ([\d.]+)\s*\}', r'{ "w": \1, "s": \2, "e": \3 }', s)
    s = re.sub(r'\{\s*"t": (".*?"),\s*"s": ([\d.]+),\s*"e": ([\d.]+)\s*\}', r'{ "t": \1, "s": \2, "e": \3 }', s)
    return s + "\n"


# ------------------------------------------------------------------------------------------ driver

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--lines", type=Path, default=HERE / "lines.json")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--work", type=Path, default=Path(tempfile.gettempdir()) / "redqueen-voice-takes")
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--threads", type=int, default=6)
    ap.add_argument("--keep", type=Path, help="also write each line's assembled WAV and the take log here")
    ap.add_argument("--pieces", action="store_true", help="list the pieces with their direction and stop")
    a = ap.parse_args()

    src = json.loads(a.lines.read_text())
    settings = {**DEFAULTS, **src.get("settings", {})}
    lines, direction = src["lines"], src.get("direction", {})
    ids = a.only or list(lines)
    if [i for i in ids if i not in lines]:
        sys.exit(f"unknown ids: {[i for i in ids if i not in lines]}")
    if a.pieces:
        for lid in ids:
            print(lid, direction.get(lid, {}).get("note", ""))
            for p in plan(lines[lid], direction.get(lid, {}), settings):
                print(f"   ex {p['exaggeration']:.2f} cfg {p['cfg_weight']:.2f} t {p['temperature']:.2f} "
                      f"x{p['takes']} end {p['end']:4s} pause {p['pause']:.2f}  {p['text']}")
        return
    if not shutil.which("ffmpeg"):
        sys.exit("ffmpeg is required")
    import torch
    torch.set_num_threads(a.threads)
    reference = HERE / src.get("reference", "reference.flac")
    ref_hash = hashlib.sha1(reference.read_bytes()).hexdigest()[:12]
    a.work.mkdir(parents=True, exist_ok=True)
    a.out.mkdir(parents=True, exist_ok=True)
    if a.keep:
        a.keep.mkdir(parents=True, exist_ok=True)
    voice = Voice(reference, a.device)
    judge = Judge()

    man_path = a.out / "manifest.json"
    old = json.loads(man_path.read_text())["lines"] if (a.only and man_path.exists()) else {}
    entries = {}
    for lid in ids:
        log = []
        audio, words = render_line(voice, judge, lid, lines[lid], direction.get(lid, {}), settings, a.work,
                                   ref_hash, log)
        if a.keep:
            import soundfile as sf
            sf.write(a.keep / f"{lid}.wav", audio, SR, subtype="FLOAT")
            (a.keep / f"{lid}.takes.json").write_text(json.dumps(log, indent=1))
        dur, words, qa = post_process(audio, words, a.out / f"{lid}.mp3")
        entries[lid] = dict(text=lines[lid], file=f"{lid}.mp3", dur=round(dur, 3), words=words, phrases=phrases(words))
        n = len(lines[lid].split())
        bad = [f"{x['text'][:30]}… heard {x['takes'][x['chosen']]['heard']!r}" for x in log
               if x["takes"][x["chosen"]]["errors"]]
        print(f"{lid:5s} {dur:6.2f}s {n:3d} words {n / dur:4.2f} w/s  {qa['lufs']:.2f} LUFS TP {qa['true_peak']:.2f} "
              f"lim {qa['limiter_db']:.1f}  " + (" | ".join(bad) if bad else "all words heard"), flush=True)
    merged = {i: entries.get(i, old.get(i)) for i in lines if entries.get(i, old.get(i))}
    manifest = {
        "voice": "The Red Queen: Chatterbox zero-shot clone of bf_emma (Kokoro-82M British English female), "
                 "per-chapter direction in tools/voice/lines.json",
        "engine": f"Chatterbox TTS ({MODEL[0]}@{MODEL[1][:7]}) via chatterbox-tts 0.1.7; takes chosen with "
                  f"Whisper small.en and wav2vec2-base-960h alignment",
        "licence": "Chatterbox weights and code: MIT (Resemble AI). Reference voice: Kokoro-82M bf_emma, Apache-2.0 "
                   "(hexgrad). Synthetic speech, with Resemble AI's Perth watermark.",
        "format": {"codec": "mp3", "sampleRate": OUT_SR, "channels": 1, "bitrate": 64000,
                   "loudness": POST["lufs"], "truePeakMax": POST["true_peak_max"]},
        "lines": merged,
    }
    man_path.write_text(dump_manifest(manifest))


if __name__ == "__main__":
    main()
