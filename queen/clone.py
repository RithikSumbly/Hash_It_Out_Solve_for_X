"""
Her one line in the visitor's own voice: Qwen3-TTS Base (Apache-2.0), cloned zero-shot from the visitor's recorded
questions and what she heard them say. It runs on the Space's borrowed GPU (ZeroGPU): the model is placed on CUDA at
start-up (ZeroGPU defers that until a @spaces.GPU call), and only the generation itself holds a GPU.

How it keeps the visitor's own delivery:
- in-context mode with an exact transcript of the reference, so the model continues the visitor's own speech;
- the whole line is given up front (non_streaming_mode), so the pace doesn't drift towards the model's average;
- the checkpoint's own sampling settings, so the liveliness comes from the reference, not from added randomness;
- several takes in one batch, keeping the one closest to the visitor by the model's own speaker encoder, after
  throwing out any take whose length is far from what the visitor's pace predicts (runaways, a change of speaker).

Imported by app.py only on a ZeroGPU Space; app.py goes on without it if it cannot load.
"""

from __future__ import annotations

import io
import os

import librosa
import numpy as np
import soundfile as sf
import torch
from qwen_tts import Qwen3TTSModel

MODEL_ID = os.environ.get("CLONE_MODEL", "Qwen/Qwen3-TTS-12Hz-1.7B-Base")
TAKES = max(1, int(os.environ.get("CLONE_TAKES", "3")))
MAX_TOKENS = 400  # about 32 s at 12.5 codes a second: the line is far shorter, so this only stops a runaway
SR = 24_000  # the model's speaker encoder and codec both work at 24 kHz

model = Qwen3TTSModel.from_pretrained(MODEL_ID, device_map="cuda", dtype=torch.bfloat16, attn_implementation="sdpa")


def _embed(pcm24: np.ndarray) -> torch.Tensor:
    return model.model.extract_speaker_embedding(audio=pcm24.astype(np.float32), sr=SR).float().flatten()


def _generate(prompt, text: str, takes: int):
    return model.generate_voice_clone(
        text=[text] * takes,
        language="English",
        voice_clone_prompt=prompt,
        non_streaming_mode=True,
        do_sample=True,
        temperature=0.9,
        top_k=50,
        top_p=1.0,
        repetition_penalty=1.05,
        subtalker_dosample=True,
        subtalker_temperature=0.9,
        subtalker_top_k=50,
        subtalker_top_p=1.0,
        max_new_tokens=MAX_TOKENS,
    )


def make(ref_wav: bytes, ref_text: str, text: str) -> tuple[np.ndarray, int]:
    """`text` in the voice of `ref_wav` (a WAV of the visitor), whose words are `ref_text`."""
    pcm, sr = sf.read(io.BytesIO(ref_wav), dtype="float32", always_2d=False)
    if pcm.ndim > 1:
        pcm = pcm.mean(axis=1)
    ref = pcm if sr == SR else librosa.resample(pcm, orig_sr=sr, target_sr=SR)
    prompt = model.create_voice_clone_prompt(
        ref_audio=(ref, SR), ref_text=ref_text or None, x_vector_only_mode=not ref_text)
    try:
        wavs, out_sr = _generate(prompt, text, TAKES)
    except torch.OutOfMemoryError:  # one take is still worth having
        torch.cuda.empty_cache()
        wavs, out_sr = _generate(prompt, text, 1)
    takes = [np.asarray(w, dtype=np.float32) for w in wavs]
    if len(takes) == 1:
        return takes[0], int(out_sr)

    # the visitor's pace (characters a second of their reference) predicts how long the line should take
    ref_secs = len(ref) / SR
    pace = len(ref_text) / ref_secs if ref_text and ref_secs > 1 else 14.0
    expect = len(text) / min(22.0, max(8.0, pace))
    fits = [i for i, w in enumerate(takes) if 0.6 * expect <= len(w) / out_sr <= 1.7 * expect] or list(range(len(takes)))
    target = _embed(ref)
    scores = {}
    for i in fits:
        w = takes[i] if out_sr == SR else librosa.resample(takes[i], orig_sr=out_sr, target_sr=SR)
        scores[i] = torch.nn.functional.cosine_similarity(_embed(w), target, dim=0).item()
    best = max(scores, key=scores.get)
    print("clone takes:", ", ".join(
        f"{len(w) / out_sr:.1f}s" + (f" sim {scores[i]:.3f}" if i in scores else " (length off)") + (" *" if i == best else "")
        for i, w in enumerate(takes)), f"(expected {expect:.1f}s)", flush=True)
    return takes[best], int(out_sr)
