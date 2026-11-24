"""
Her live voice: Kokoro (82M, Apache-2.0), voice bf_emma, the voice her narration was cloned from. On the
Space's two CPUs it speaks faster than real time, so a reply is cut into sentences and each is made in turn: the
first can play while the rest are still being made. One worker thread does all the synthesis, so two visitors
never fight over the CPUs. Audio is MP3 (a few kilobytes a second).
"""

from __future__ import annotations

import hashlib
import itertools
import io
import os
import queue
import re
import threading
import time
import urllib.request
from pathlib import Path

import numpy as np
import onnxruntime as ort
import soundfile as sf
from kokoro_onnx import Kokoro

MODELS = Path(os.environ.get("KOKORO_DIR", Path(__file__).parent / "models"))
FILES = {
    "kokoro-v1.0.int8.onnx": "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.int8.onnx",
    "voices-v1.0.bin": "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin",
}
VOICE = "bf_emma"
_VOICED_END = set("aeiouɑɐɒɔəɚɛɜɪʊʌæɨʉyøœmnŋlɹwjɾ")


def _centroid(x: np.ndarray, sr: int) -> float:
    X = np.abs(np.fft.rfft(x * np.hanning(len(x)))) ** 2
    f = np.fft.rfftfreq(len(x), 1 / sr)
    return float((X * f).sum() / max(X.sum(), 1e-12))
# her pace by mood: stern is a touch slower, amused a touch quicker
SPEED = {"stern": 0.93, "calm": 0.97, "amused": 1.0}


def _fetch() -> None:
    MODELS.mkdir(parents=True, exist_ok=True)
    for name, url in FILES.items():
        p = MODELS / name
        if not p.exists() or p.stat().st_size < 1_000_000:
            urllib.request.urlretrieve(url, p)


class Voice:
    def __init__(self, threads: int = 2) -> None:
        _fetch()
        so = ort.SessionOptions()
        so.intra_op_num_threads = threads
        so.inter_op_num_threads = 1
        sess = ort.InferenceSession(str(MODELS / "kokoro-v1.0.int8.onnx"), so, providers=["CPUExecutionProvider"])
        self.k = Kokoro.from_session(sess, str(MODELS / "voices-v1.0.bin"))
        self.parts: dict[str, list] = {}  # voice id -> [bytes | None] per sentence
        self.done: dict[str, threading.Event] = {}
        # live replies (priority 0) jump ahead of the start-up warm-up of her set lines (priority 1)
        self.jobs: "queue.PriorityQueue[tuple[int, int, str, int, str, float]]" = queue.PriorityQueue()
        self.seq = itertools.count()
        self.lock = threading.Lock()
        threading.Thread(target=self._work, daemon=True).start()

    @staticmethod
    def sentences(text: str) -> list[str]:
        out = [s.strip() for s in re.split(r"(?<=[.!?])\s+", text.strip()) if s.strip()]
        return out or [text.strip()]

    @staticmethod
    def mp3(audio: np.ndarray, sr: int) -> bytes:
        """MP3: every browser decodes it (Safari does not decode Ogg Vorbis)."""
        buf = io.BytesIO()
        sf.write(buf, audio, sr, format="MP3", subtype="MPEG_LAYER_III")
        return buf.getvalue()

    def dehiss(self, audio: np.ndarray, sr: int, text: str) -> np.ndarray:
        """Kokoro often breathes out 100-190 ms of hiss near 8 kHz after an utterance that ends on a voiced sound (a
        vowel, a nasal, l, r), heard as a stray "s" ("I'm a guard, not an oracle-s"). Measured while rendering her
        fillers (tools/voice/render_fillers.py): cut it after the last voiced frame, with a 20 ms
        fade. Anything unexpected leaves the audio as it was."""
        try:
            ph = self.k.tokenizer.phonemize(text, "en-gb").split()
            last = re.sub(r"[ˈˌː.,!?;:…|]", "", ph[-1]) if ph else ""
            if not last or last[-1] not in _VOICED_END:
                return audio
            x = np.asarray(audio, dtype=np.float32)
            n, h = int(0.02 * sr), int(0.005 * sr)
            m = 1 + (len(x) - n) // h
            if m < 20:
                return audio
            idx = np.arange(n)[None, :] + h * np.arange(m)[:, None]
            db = 20 * np.log10(np.maximum(np.sqrt((x[idx].astype(np.float64) ** 2).mean(axis=1)), 1e-9))
            on = np.where(db > max(float(db.max()) - 50, -65))[0]
            if not len(on):
                return audio
            end = int(on[-1]) * h + n
            lo, hi, last_v = sr // 400, sr // 70, None
            for i in range(max(0, end - int(0.8 * sr)), end - n + 1, h):
                fr = x[i : i + n] - x[i : i + n].mean()
                ac = np.correlate(fr, fr, "full")[n - 1 :]
                ac = ac / (ac[0] + 1e-12)
                if ac[lo:hi].max() > 0.5 and _centroid(fr, sr) < 2500:
                    last_v = i + n
            if last_v is None or (end - last_v) / sr < 0.03 or _centroid(x[last_v:end], sr) <= 3500:
                return audio
            y = x[:last_v].astype(np.float64)
            f = int(0.02 * sr)
            y[-f:] *= 0.5 + 0.5 * np.cos(np.pi * np.arange(1, f + 1) / f)
            return np.concatenate([y, np.zeros(int(0.04 * sr))]).astype(np.float32)
        except Exception:
            return audio

    def _work(self) -> None:
        while True:
            _, _, vid, i, text, speed = self.jobs.get()
            with self.lock:  # already made (a live request promoted it, or it was asked for twice)
                if vid not in self.parts or self.parts[vid][i] is not None:
                    continue
            try:
                audio, sr = self.k.create(text, voice=VOICE, speed=speed, lang="en-gb")
                data = self.mp3(self.dehiss(audio, sr, text), sr)
            except Exception:
                data = b""
            with self.lock:
                if vid in self.parts:
                    self.parts[vid][i] = data
                    if all(p is not None for p in self.parts[vid]):
                        self.done[vid].set()

    def speak(self, text: str, mood: str = "calm", priority: int = 0) -> tuple[str, int]:
        """Queue her words; returns (voice id, number of parts). The same words in the same mood share an id."""
        speed = SPEED.get(mood, 0.97)
        vid = hashlib.sha1(f"{mood}|{text}".encode()).hexdigest()[:16]
        parts = self.sentences(text)
        with self.lock:
            if vid in self.parts:
                # still waiting in the warm-up and wanted now: queue the missing sentences again, at the front
                if priority == 0:
                    for i, s in enumerate(parts):
                        if i < len(self.parts[vid]) and self.parts[vid][i] is None:
                            self.jobs.put((0, next(self.seq), vid, i, s, speed))
                return vid, len(self.parts[vid])
            self.parts[vid] = [None] * len(parts)
            self.done[vid] = threading.Event()
            if len(self.parts) > 3000:  # forget the oldest replies
                for k in list(self.parts)[:500]:
                    self.parts.pop(k, None)
                    self.done.pop(k, None)
        for i, s in enumerate(parts):
            self.jobs.put((priority, next(self.seq), vid, i, s, speed))
        return vid, len(parts)

    def put(self, vid: str, parts: list[bytes]) -> None:
        """Audio made elsewhere (her line in the visitor's voice), served like any reply."""
        with self.lock:
            self.parts[vid] = list(parts)
            self.done[vid] = threading.Event()
            self.done[vid].set()

    def part(self, vid: str, i: int, wait: float = 20.0) -> bytes | None:
        """One sentence of audio, waiting for it to be made if need be."""
        t0 = time.time()
        while time.time() - t0 < wait:
            with self.lock:
                p = self.parts.get(vid)
                if p is None or i >= len(p):
                    return None
                if p[i] is not None:
                    return p[i]
            time.sleep(0.05)
        return None
