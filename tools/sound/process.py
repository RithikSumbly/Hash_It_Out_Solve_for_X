#!/usr/bin/env python3
"""
Red Queen sound: turn the downloaded recordings into web-ready assets.

    python3 -I tools/sound/process.py <raw-dir> <out-dir>

  raw-dir  the folder of downloaded source MP3s (names as listed in SOURCES below)
  out-dir  web/public/sound

What it does, per asset (see ASSETS):
  - decodes the source to 48 kHz float (ffmpeg), mixes to mono for one-shots;
  - high-passes rumble and hum (and notches mains hum where a recording has it);
  - rolls off harsh highs (a low-pass and a high-shelf so energy above ~5 kHz stays low; glass keeps
    a little air);
  - slices multi-hit recordings into one-shots by onset / silence detection, trims, and fades every
    slice in and out (no clicks);
  - for ambience, picks the calmest, most even stretch of the recording;
  - for tonal material (glass, bowl, gong, chime, whale calls) detects the fundamental (the lowest strong
    spectral peak) and records baseHz, so the engine can pitch it onto the bed's harmony;
  - for the singing glass, bakes a seamless loop: a period-aligned stretch is made circular with a
    crossfade and tiled twice, so the loop region [P/2, 3P/2] is seamless even if a decoder shifts the
    file by the MP3 encoder delay;
  - loudness-normalises per role (ambience to an integrated LUFS target, one-shots to a short-term
    K-weighted level), caps every peak at -1 dBFS, and records the residual correction as `gain` / `g`;
  - lays multi-slice assets out as one sprite per asset with silent gaps (fewer requests), encodes
    MP3 (mono one-shots, stereo ambience) and writes manifest.json.

Requires ffmpeg, python3, numpy, scipy. Deterministic: same inputs, same outputs.
"""
import json
import os
import subprocess
import sys
import tempfile

import numpy as np
from scipy import signal

SR = 48000  # processing rate

# ------------------------------------------------------------------ sources and credits

SOURCES = {
    "night-field-1-422582": ("Countryside at the night crickets", "Martin.Sadoux", "CC0 1.0", "https://freesound.org/people/Martin.Sadoux/sounds/422582/"),
    "night-field-2-208008": ("WindSwellMildNovemberCricket2013.wav", "kvgarlic", "CC0 1.0", "https://freesound.org/people/kvgarlic/sounds/208008/"),
    "wind-soft-1-393567": ("Gale In The Dunes", "Kinoton", "CC0 1.0", "https://freesound.org/people/Kinoton/sounds/393567/"),
    "brook-1-197705": ("Water, small stream", "peridactyloptrix", "CC0 1.0", "https://freesound.org/people/peridactyloptrix/sounds/197705/"),
    "brook-2-236981": ("Stream Running Into Pond", "mhtaylor67", "CC0 1.0", "https://freesound.org/people/mhtaylor67/sounds/236981/"),
    "water-drops-1-815419": ("AAD WATER DRIPPING INTO WATER", "AwenAudio", "CC0 1.0", "https://freesound.org/people/AwenAudio/sounds/815419/"),
    "glass-singing-1-419147": ("Ringing sound from crystal glass. Tune: G", "PappaBert", "CC0 1.0", "https://freesound.org/people/PappaBert/sounds/419147/"),
    "glass-singing-2-35792": ("Crystal Hum 1 (wav).wav", "necrodigits", "CC0 1.0", "https://freesound.org/people/necrodigits/sounds/35792/"),
    "glass-strike-1-193823": ("Wine glass tinkles", "jhumbucker", "CC0 1.0", "https://freesound.org/people/jhumbucker/sounds/193823/"),
    "glass-strike-2-518598": ("Wine Glass Toast Clink", "BennettFilmTeacher", "CC0 1.0", "https://freesound.org/people/BennettFilmTeacher/sounds/518598/"),
    "crystal-bowl-1-202017": ("singing bell hit 2.wav", "ryancacophony", "CC0 1.0", "https://freesound.org/people/ryancacophony/sounds/202017/"),
    "bell-distant-1-486629": ('Gong Brilliant Paiste 32"', "JensZygar", "CC0 1.0", "https://freesound.org/people/JensZygar/sounds/486629/"),
    "ink-splash-1-445109": ("Mud Splat", "Breviceps", "CC0 1.0", "https://freesound.org/people/Breviceps/sounds/445109/"),
    "ink-splash-2-577966": ("Paint splash", "colorsCrimsonTears", "CC0 1.0", "https://freesound.org/people/colorsCrimsonTears/sounds/577966/"),
    "liquid-pour-1-553954": ("bottle-glugs.wav", "isbeorn", "CC0 1.0", "https://freesound.org/people/isbeorn/sounds/553954/"),
    "chess-piece-1-366065": ("chess pieces.wav", "simone_ds", "CC0 1.0", "https://freesound.org/people/simone_ds/sounds/366065/"),
    "low-impact-1-410721": ("Symphonic_Concert_Bass_Drum_Vel02.wav", "pjcohen", "CC BY 4.0", "https://freesound.org/people/pjcohen/sounds/410721/"),
    "whoosh-soft-1-495390": ("Foley_Clothes_Jacket_Whoosh_Sequence_Stereo.wav", "Nox_Sound", "CC0 1.0", "https://freesound.org/people/Nox_Sound/sounds/495390/"),
    "clock-tick-2-347139": ("Antique fireplace clock bell one strike", "Kinoton", "CC0 1.0", "https://freesound.org/people/Kinoton/sounds/347139/"),
    "whale-song-1-noaa": ("Humpback whale song", "NOAA (U.S. National Oceanic and Atmospheric Administration)", "Public domain (U.S. Government work)", "https://www.fisheries.noaa.gov/national/science-data/sounds-ocean-mammals"),
    "whale-song-2-797762": ("humpback_whales_and_orcas_ambient_underwater_recording", "raiden04", "CC BY 4.0", "https://freesound.org/people/raiden04/sounds/797762/"),
    "glass-rub-1-198403": ("ANI - Wine glass - Rubbing 1a", "ani_music", "CC0 1.0", "https://freesound.org/people/ani_music/sounds/198403/"),
    "glass-rub-2-556410": ("WindChime1.wav", "perrydolia", "CC0 1.0", "https://freesound.org/people/perrydolia/sounds/556410/"),
    "board-slide-1-801350": ("Chess piece sliding 2", "Alnotreally", "CC0 1.0", "https://freesound.org/people/Alnotreally/sounds/801350/"),
    "board-slide-2-124539": ("knock-wood-soft.aiff", "stereostereo", "CC0 1.0", "https://freesound.org/people/stereostereo/sounds/124539/"),
    "paper-soft-1-444431": ("Sliding Envelope.wav", "MTJohnson", "CC0 1.0", "https://freesound.org/people/MTJohnson/sounds/444431/"),
    "pencil-scratch-1-444676": ("Drawing with Pencil (Slow & Continuous)", "AO-SoundPawz", "CC0 1.0", "https://freesound.org/people/AO-SoundPawz/sounds/444676/"),
    "room-tone-1-788451": ("room-tone empty church in village Bokhoven 357 PM 241220_096", "klankbeeld", "CC BY 4.0", "https://freesound.org/people/klankbeeld/sounds/788451/"),
    "swoosh-deep-1-558827": ("Deep Whoosh #5", "Kinoton", "CC0 1.0", "https://freesound.org/people/Kinoton/sounds/558827/"),
}

# ------------------------------------------------------------------ the asset plan
#
# kind:
#   ambience  the calmest `dur` seconds, stereo or mono, for random-offset grain playback
#   whale     tonal call segments found automatically, one sprite
#   slices    onset-sliced one-shots, one sprite
#   chunks    a continuous texture cut into short strokes at energy minima, one sprite
#   whole     a single one-shot, trimmed (several sources -> one sprite)
#   loop      a period-aligned, seamless, tiled loop (the singing glass)
#
# filters: hp (Hz), lp (Hz), shelf (Hz, dB) high-shelf, notch [Hz...]

ASSETS = [
    # --- the night world (stereo where the width matters) ---
    dict(name="amb-wind", src="wind-soft-1-393567", role="ambience", kind="ambience", ch=2, sr=32000, kbps=80,
         dur=30, hp=70, lp=4200, shelf=(2500, -3), lufs=-24),
    dict(name="amb-brook-a", src="brook-1-197705", role="ambience", kind="ambience", ch=1, sr=32000, kbps=56,
         dur=20, hp=120, lp=4800, shelf=(2500, -5), lufs=-24),
    dict(name="amb-brook-b", src="brook-2-236981", role="ambience", kind="ambience", ch=1, sr=32000, kbps=56,
         dur=20, hp=150, lp=4800, shelf=(2500, -5), lufs=-24),
    dict(name="amb-room", src="room-tone-1-788451", role="ambience", kind="ambience", ch=2, sr=32000, kbps=64,
         dur=24, hp=45, notch=[57.1, 114.3, 130.4, 171.3, 202.1, 228.6, 284.2], lp=3000, shelf=(1500, -3), lufs=-28),
    # no far voices, footsteps, door or clock: the hall should feel empty
    # --- the giants singing far off ---
    dict(name="whale", src=["whale-song-2-797762", "whale-song-1-noaa"], role="whale", kind="whale", ch=1, sr=22050,
         kbps=48, hp=70, lp=1600, tonal=True, maxseg=[6, 2], seglen=(3.5, 8.0), avoid=[(405, 420)]),
    # --- glass ---
    dict(name="glass-ding", src="glass-strike-1-193823", role="glass", kind="slices", ch=1, sr=44100, kbps=96,
         hp=180, lp=9000, shelf=(5000, -6), tonal=True, on_db=16, rise_db=12, min_gap=0.25, maxlen=2.4, minlen=0.25,
         fade_out=0.35, keep=22, maxHz=1500),
    dict(name="glass-clink", src="glass-strike-2-518598", role="glass", kind="slices", ch=1, sr=44100, kbps=96,
         hp=250, lp=9000, shelf=(5000, -6), tonal=True, on_db=18, rise_db=14, min_gap=0.4, maxlen=1.8, minlen=0.3,
         fade_out=0.3, keep=12),
    dict(name="rub", src="glass-rub-1-198403", role="rub", kind="whole", ch=1, sr=44100, kbps=96,
         hp=250, lp=7000, shelf=(4000, -6), tonal=True, fade_in=0.06, maxlen=3.0, fade_out=0.6),
    dict(name="windchime", src="glass-rub-2-556410", role="windchime", kind="whole", ch=1, sr=44100, kbps=96,
         hp=250, lp=7000, shelf=(4000, -6), tonal=True, maxlen=4.5, fade_out=2.0),
    dict(name="sing-a", src="glass-singing-1-419147", role="sing", kind="loop", ch=1, sr=44100, kbps=112,
         hp=250, lp=5000, tonal=True, loop_from=(2.0, 9.5), loop_len=3.2),
    dict(name="sing-b", src="glass-singing-2-35792", role="sing", kind="loop", ch=1, sr=44100, kbps=112,
         hp=260, notch=[60, 120, 180], lp=5000, tonal=True, loop_from=(3.0, 16.0), loop_len=3.2),
    dict(name="bowl", src="crystal-bowl-1-202017", role="bowl", kind="whole", ch=1, sr=44100, kbps=96,
         hp=120, lp=6000, shelf=(2500, -5), tonal=True, maxlen=12.0, fade_out=5.0),
    dict(name="gong", src="bell-distant-1-486629", role="gong", kind="whole", ch=1, sr=44100, kbps=96,
         hp=50, lp=3500, shelf=(1500, -4), tonal=True, maxlen=11.0, fade_out=5.0),
    dict(name="chime", src="clock-tick-2-347139", role="chime", kind="whole", ch=1, sr=44100, kbps=96,
         hp=150, lp=5000, shelf=(2500, -5), tonal=True, maxlen=7.0, fade_out=3.0),
    # --- ink, water ---
    dict(name="ink", src=["ink-splash-1-445109", "ink-splash-2-577966"], role="ink", kind="whole", ch=1, sr=44100,
         kbps=96, hp=60, lp=4000, shelf=(2000, -4), maxlen=0.6, fade_out=0.12),
    dict(name="thud", src="low-impact-1-410721", role="thud", kind="whole", ch=1, sr=44100, kbps=96,
         hp=32, lp=2500, maxlen=2.2, fade_out=0.9),
    dict(name="glug", src="liquid-pour-1-553954", role="glug", kind="slices", ch=1, sr=44100, kbps=96,
         hp=90, lp=4500, shelf=(2500, -4), on_db=18, rise_db=10, min_gap=0.12, maxlen=0.55, minlen=0.08,
         fade_out=0.08, keep=14),
    dict(name="drip", src="water-drops-1-815419", role="drip", kind="slices", ch=1, sr=44100, kbps=96,
         hp=150, lp=5000, shelf=(3000, -4), on_db=18, rise_db=12, min_gap=0.15, maxlen=0.45, minlen=0.08,
         fade_out=0.12, keep=14),
    # --- wood, paper ---
    dict(name="chess", src="chess-piece-1-366065", role="chess", kind="slices", ch=1, sr=44100, kbps=96,
         hp=90, lp=5500, shelf=(3000, -4), on_db=18, rise_db=14, min_gap=0.3, maxlen=0.38, minlen=0.06,
         fade_out=0.1, keep=16),
    dict(name="knock", src="board-slide-2-124539", role="knock", kind="slices", ch=1, sr=44100, kbps=96,
         hp=90, lp=5000, shelf=(2500, -4), on_db=14, rise_db=10, min_gap=0.15, maxlen=0.4, minlen=0.05,
         fade_out=0.08, keep=8),
    dict(name="slide", src="board-slide-1-801350", role="slide", kind="whole", ch=1, sr=44100, kbps=96,
         hp=80, lp=4500, shelf=(2500, -4), maxlen=1.6, fade_in=0.04, fade_out=0.35),
    dict(name="paper", src="paper-soft-1-444431", role="paper", kind="chunks", ch=1, sr=44100, kbps=96,
         hp=250, lp=3800, shelf=(2200, -4), chunk=(0.14, 0.3), fade=0.035, keep=5),
    dict(name="pencil", src="pencil-scratch-1-444676", role="pencil", kind="chunks", ch=1, sr=44100, kbps=96,
         hp=300, lp=3600, shelf=(2000, -5), chunk=(0.28, 0.6), fade=0.05, keep=10),
    # --- air ---
    dict(name="whoosh", src="whoosh-soft-1-495390", role="whoosh", kind="slices", ch=1, sr=44100, kbps=96,
         hp=80, lp=3800, shelf=(2000, -4), on_db=14, rise_db=8, min_gap=0.5, maxlen=1.1, minlen=0.3,
         fade_out=0.25, fade_in=0.03, keep=6),
    dict(name="swoosh-deep", src="swoosh-deep-1-558827", role="swoosh", kind="whole", ch=1, sr=44100, kbps=96,
         hp=35, lp=3000, maxlen=3.0, fade_in=0.05, fade_out=0.8),
]

# short-term level target for one-shots (dB, K-weighted, max over 100 ms windows) and the peak ceiling
ONESHOT_LK = -16.0
PEAK_CEIL = 10 ** (-1.0 / 20)
GAP = 0.12  # silence between slices in a sprite (s)
LEAD = 0.06  # silence before the first slice (s)


# ------------------------------------------------------------------ io


def load(path):
    """decode to float64 (n, 2) at SR"""
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-ac", "2", "-ar", str(SR), "-f", "f32le", "-"],
                       capture_output=True, check=True)
    x = np.frombuffer(r.stdout, dtype=np.float32).astype(np.float64)
    return x.reshape(-1, 2)


def encode(x, out_path, ch, sr, kbps):
    """x: (n,) or (n,2) float at SR -> MP3 at sr/kbps"""
    if x.ndim == 1:
        x = x[:, None]
    with tempfile.NamedTemporaryFile(suffix=".f32", delete=False) as f:
        f.write(np.ascontiguousarray(x, dtype=np.float32).tobytes())
        tmp = f.name
    try:
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(SR), "-ac", str(x.shape[1]), "-i", tmp,
                        "-af", "aresample=filter_size=64:phase_shift=10:cutoff=0.95", "-ac", str(ch), "-ar", str(sr),
                        "-c:a", "libmp3lame", "-b:a", f"{kbps}k", "-map_metadata", "-1", out_path], check=True)
    finally:
        os.unlink(tmp)


def decode_check(path):
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-f", "f32le", "-ac", "1", "-"], capture_output=True, check=True)
    y = np.frombuffer(r.stdout, dtype=np.float32)
    return float(np.abs(y).max()) if len(y) else 0.0


# ------------------------------------------------------------------ dsp


def sos_apply(sos, x):
    return signal.sosfiltfilt(sos, x, axis=0)


def high_shelf(f0, gain_db, q=0.707):
    A = 10 ** (gain_db / 40)
    w0 = 2 * np.pi * f0 / SR
    alpha = np.sin(w0) / (2 * q)
    cw = np.cos(w0)
    b0 = A * ((A + 1) + (A - 1) * cw + 2 * np.sqrt(A) * alpha)
    b1 = -2 * A * ((A - 1) + (A + 1) * cw)
    b2 = A * ((A + 1) + (A - 1) * cw - 2 * np.sqrt(A) * alpha)
    a0 = (A + 1) - (A - 1) * cw + 2 * np.sqrt(A) * alpha
    a1 = 2 * ((A - 1) - (A + 1) * cw)
    a2 = (A + 1) - (A - 1) * cw - 2 * np.sqrt(A) * alpha
    return np.array([[b0 / a0, b1 / a0, b2 / a0, 1.0, a1 / a0, a2 / a0]])


def clean(x, spec):
    """rumble/hum high-pass, notches, harsh-high roll-off"""
    y = x
    if spec.get("hp"):
        y = sos_apply(signal.butter(4, spec["hp"], "hp", fs=SR, output="sos"), y)
    for f in spec.get("notch", []):
        b, a = signal.iirnotch(f, 18, fs=SR)
        y = signal.filtfilt(b, a, y, axis=0)
    if spec.get("lp"):
        y = sos_apply(signal.butter(4, spec["lp"], "lp", fs=SR, output="sos"), y)
    if spec.get("shelf"):
        f0, g = spec["shelf"]
        y = signal.sosfilt(high_shelf(f0, g), y, axis=0)
    return y


# K-weighting (ITU-R BS.1770) at 48 kHz
K1 = (np.array([1.53512485958697, -2.69169618940638, 1.19839281085285]), np.array([1.0, -1.69065929318241, 0.73248077421585]))
K2 = (np.array([1.0, -2.0, 1.0]), np.array([1.0, -1.99004745483398, 0.99007225036621]))


def kweight(x):
    y = signal.lfilter(*K1, x, axis=0)
    return signal.lfilter(*K2, y, axis=0)


def lufs_integrated(x):
    """gated integrated loudness of (n,) or (n,c)"""
    if x.ndim == 1:
        x = x[:, None]
    y = kweight(x)
    blk, hop = int(0.4 * SR), int(0.1 * SR)
    pw = []
    for s in range(0, len(y) - blk + 1, hop):
        pw.append(np.sum(np.mean(y[s:s + blk] ** 2, axis=0)))
    pw = np.array(pw) + 1e-20
    L = -0.691 + 10 * np.log10(pw)
    g = pw[L > -70]
    if not len(g):
        return -70.0
    rel = -0.691 + 10 * np.log10(g.mean()) - 10
    g2 = g[(-0.691 + 10 * np.log10(g)) > rel]
    return float(-0.691 + 10 * np.log10(g2.mean()))


def short_level(x):
    """max K-weighted level over 100 ms windows (one-shot loudness)"""
    if x.ndim == 1:
        x = x[:, None]
    y = kweight(x)
    w = int(0.1 * SR)
    p = np.sum(y ** 2, axis=1)
    if len(p) < w:
        return -0.691 + 10 * np.log10(p.mean() + 1e-20)
    c = np.convolve(p, np.ones(w) / w, mode="valid")
    return float(-0.691 + 10 * np.log10(c.max() + 1e-20))


def fades(x, fin, fout):
    n = len(x)
    a = min(n // 2, max(1, int(fin * SR)))
    b = min(n // 2, max(1, int(fout * SR)))
    env = np.ones(n)
    env[:a] = np.sin(np.linspace(0, np.pi / 2, a)) ** 2
    env[n - b:] = np.cos(np.linspace(0, np.pi / 2, b)) ** 2
    return x * (env[:, None] if x.ndim == 2 else env)


def envelope_db(mono, hop_s=0.005, win_s=0.01):
    hop, win = int(hop_s * SR), int(win_s * SR)
    n = max(1, (len(mono) - win) // hop)
    e = np.array([np.sqrt(np.mean(mono[i * hop:i * hop + win] ** 2)) for i in range(n)])
    return 20 * np.log10(e + 1e-9), hop


def detect_onsets(mono, spec):
    db, hop = envelope_db(mono)
    floor = np.percentile(db, 20)
    peak = db.max()
    thr = max(floor + spec.get("on_db", 15), peak - 42)
    rise = spec.get("rise_db", 10)
    gap = int(spec.get("min_gap", 0.2) * SR / hop)
    ons = []
    last = -10 ** 9
    for i in range(4, len(db)):
        if db[i] < thr:
            continue
        if db[i] - db[max(0, i - 6):i].min() >= rise and i - last >= gap:
            # walk to the local max within 30 ms for the slice peak, keep onset at i
            ons.append(i)
            last = i
    return ons, db, hop, floor


def tonal_peak(x, fmin=60, fmax=4000):
    """lowest strong spectral peak (within 10 dB of the strongest) in Hz, with the top peaks for the log"""
    mono = x if x.ndim == 1 else x.mean(axis=1)
    if len(mono) < 2048:
        return None, []
    N = 1 << 18
    w = mono * np.hanning(len(mono))
    X = np.abs(np.fft.rfft(w, N))
    f = np.fft.rfftfreq(N, 1 / SR)
    db = 20 * np.log10(X / (X.max() + 1e-20) + 1e-12)
    pk, _ = signal.find_peaks(db, prominence=6, height=-30)
    pk = pk[(f[pk] >= fmin) & (f[pk] <= fmax)]
    if not len(pk):
        return None, []
    top = db[pk].max()
    strong = [i for i in pk if db[i] >= top - 10]
    base = f[min(strong, key=lambda i: f[i])]
    # refine with parabolic interpolation
    i = int(np.argmin(np.abs(f - base)))
    if 0 < i < len(X) - 1:
        a, b, c = db[i - 1], db[i], db[i + 1]
        d = 0.5 * (a - c) / (a - 2 * b + c + 1e-12)
        base = f[i] + d * (f[1] - f[0])
    tops = sorted(pk, key=lambda i: -db[i])[:5]
    return float(base), [(round(float(f[i]), 1), round(float(db[i]), 1)) for i in sorted(tops)]


def hf_share(x, fc=4000):
    mono = x if x.ndim == 1 else x.mean(axis=1)
    X = np.abs(np.fft.rfft(mono)) ** 2
    f = np.fft.rfftfreq(len(mono), 1 / SR)
    return float(X[f > fc].sum() / (X.sum() + 1e-20))


# ------------------------------------------------------------------ asset builders


def norm_oneshot(y):
    """loudness-match a one-shot to ONESHOT_LK, cap the peak; returns (y, residual linear gain g)"""
    L = short_level(y)
    y = y * 10 ** ((ONESHOT_LK - L) / 20)
    pk = np.abs(y).max()
    g = 1.0
    if pk > PEAK_CEIL:
        g = pk / PEAK_CEIL
        y = y / g
    return y, round(float(g), 3)


def slice_hits(x, spec):
    mono = x.mean(axis=1)
    ons, db, hop, floor = detect_onsets(mono, spec)
    out = []
    for k, i in enumerate(ons):
        s = max(0, i * hop - int(0.004 * SR))
        nxt = ons[k + 1] * hop - int(0.006 * SR) if k + 1 < len(ons) else len(mono)
        e = min(nxt, s + int(spec["maxlen"] * SR), len(mono))
        # end where the envelope has settled near the floor
        seg_db = db[i:e // hop]
        if len(seg_db):
            pk = seg_db.max()
            quiet = np.where(seg_db < max(floor + 4, pk - 40))[0]
            quiet = quiet[quiet > int(0.03 * SR / hop)]
            if len(quiet):
                e = min(e, i * hop + quiet[0] * hop + int(0.02 * SR))
        if (e - s) / SR < spec.get("minlen", 0.05):
            continue
        out.append((s, e, float(db[i:max(i + 1, e // hop)].max())))
    # keep the strongest `keep` (by peak level), then restore time order
    keep = spec.get("keep", len(out))
    out = sorted(sorted(out, key=lambda t: -t[2])[:keep], key=lambda t: t[0])
    return [(s, e) for s, e, _ in out]


def chunk_texture(x, spec):
    """cut a continuous texture into strokes of chunk=(min,max) seconds at local energy minima"""
    mono = x.mean(axis=1)
    db, hop = envelope_db(mono, 0.01, 0.03)
    floor = np.percentile(db, 15)
    # act_db: how far above the floor counts as sound (a walking sequence is all "sound": -100)
    active = db > floor + spec.get("act_db", 12)
    lo, hi = spec["chunk"]
    out = []
    i = 0
    n = len(db)
    while i < n:
        if not active[i]:
            i += 1
            continue
        j = i
        while j < n and active[j]:
            j += 1
        # region [i, j): cut into chunks
        a = i
        while (j - a) * hop / SR >= lo:
            want_lo = a + int(lo * SR / hop)
            want_hi = min(j, a + int(hi * SR / hop))
            if want_hi <= want_lo:
                b = j
            else:
                b = want_lo + int(np.argmin(db[want_lo:want_hi]))
            out.append((a * hop, b * hop, float(db[a:b].mean())))
            a = b
        i = j
    keep = spec.get("keep", len(out))
    # prefer even, mid-level strokes (not the loudest scrape, not the faintest)
    med = np.median([m for _, _, m in out]) if out else 0
    out = sorted(sorted(out, key=lambda t: abs(t[2] - med))[:keep], key=lambda t: t[0])
    return [(s, e) for s, e, _ in out]


def trim_whole(x, spec):
    mono = x.mean(axis=1)
    db, hop = envelope_db(mono)
    floor = np.percentile(db, 10)
    pk = db.max()
    above = np.where(db > max(floor + 10, pk - 45))[0]
    s = max(0, above[0] * hop - int(0.004 * SR)) if len(above) else 0
    e = min(len(mono), s + int(spec.get("maxlen", 5) * SR))
    tail = np.where(db[:e // hop] > max(floor + 3, pk - 60))[0]
    if len(tail):
        e = min(e, tail[-1] * hop + int(0.05 * SR))
    return s, e


def calm_window(x, dur):
    """the most even `dur`-second window (low level variance, no transients)"""
    mono = x.mean(axis=1)
    blk = int(0.5 * SR)
    n = len(mono) // blk
    lv = np.array([20 * np.log10(np.sqrt(np.mean(mono[i * blk:(i + 1) * blk] ** 2)) + 1e-9) for i in range(n)])
    pk = np.array([20 * np.log10(np.abs(mono[i * blk:(i + 1) * blk]).max() + 1e-9) for i in range(n)])
    w = int(dur / 0.5)
    if n <= w:
        return 0, len(mono)
    best, bi = 1e9, 0
    for i in range(1, n - w):
        seg = lv[i:i + w]
        crest = (pk[i:i + w] - seg).max()
        score = seg.std() + 0.5 * max(0, crest - 14) + 0.2 * (seg.max() - seg.min())
        if score < best:
            best, bi = score, i
    return bi * blk, (bi + w) * blk


def find_whale_calls(x, spec, maxn):
    """tonal, energetic stretches in 90-1500 Hz"""
    mono = x.mean(axis=1)
    f, t, S = signal.stft(mono, fs=SR, nperseg=4096, noverlap=3072)
    A = np.abs(S)
    band = (f >= 90) & (f <= 1500)
    B = A[band]
    e = 20 * np.log10(np.sqrt((B ** 2).mean(axis=0)) + 1e-9)
    ton = 20 * np.log10(B.max(axis=0) / (np.median(B, axis=0) + 1e-12))
    # smooth over ~0.5 s
    k = max(1, int(0.5 / (t[1] - t[0])))
    es = np.convolve(e, np.ones(k) / k, mode="same")
    ts = np.convolve(ton, np.ones(k) / k, mode="same")
    floor = np.percentile(es, 30)
    good = (es > floor + 9) & (ts > np.percentile(ts, 60))
    for a, b in spec.get("avoid", []):
        good[(t >= a) & (t <= b)] = False
    segs = []
    i = 0
    while i < len(good):
        if not good[i]:
            i += 1
            continue
        j = i
        while j < len(good) and (good[j] or (j + k < len(good) and good[j:j + k].any())):
            j += 1
        a, b = t[i] - 0.6, t[min(j, len(t) - 1)] + 1.2
        lo, hi = spec["seglen"]
        if b - a >= lo:
            b = min(b, a + hi)
            score = float(es[i:j].max() + 0.5 * ts[i:j].mean())
            segs.append((max(0, a), min(len(mono) / SR, b), score))
        i = j
    segs = sorted(segs, key=lambda s: -s[2])[:maxn]
    return sorted([(int(a * SR), int(b * SR)) for a, b, _ in segs])


def make_loop(x, spec, base):
    """a seamless circular stretch of ~loop_len s, period-aligned to the fundamental, tiled twice"""
    mono = x.mean(axis=1)
    a0, a1 = spec["loop_from"]
    period = SR / base
    nper = max(1, round(spec["loop_len"] * SR / period))
    P = int(round(nper * period))
    X = int(0.25 * SR)  # baked crossfade
    # pick the start inside [a0, a1] whose stretch has the steadiest amplitude
    best, bs = 1e9, int(a0 * SR) + X
    step = int(0.05 * SR)
    for s in range(int(a0 * SR) + X, int(a1 * SR) - P - X, step):
        seg = mono[s:s + P]
        hop = int(0.05 * SR)
        r = np.array([np.sqrt(np.mean(seg[i:i + hop] ** 2)) for i in range(0, len(seg) - hop, hop)])
        score = r.std() / (r.mean() + 1e-9)
        if score < best:
            best, bs = score, s
    # refine the period alignment by cross-correlation around P (keeps the seam in phase)
    ref = mono[bs:bs + X]
    lags = range(P - int(period), P + int(period) + 1)
    cc = [float(np.dot(ref, mono[bs + L:bs + L + X])) for L in lags]
    P = list(lags)[int(np.argmax(cc))]
    R = mono[bs:bs + P].copy()
    w = np.sin(np.linspace(0, np.pi / 2, X)) ** 2
    # the end of R must flow into R[0]: blend the material that follows R's end into its beginning
    R[:X] = mono[bs:bs + X] * w + mono[bs + P:bs + P + X] * (1 - w)
    # check the wrap: R[-1] -> R[0]
    return np.concatenate([R, R]), P


# ------------------------------------------------------------------ main


def main(raw, out):
    os.makedirs(out, exist_ok=True)
    cache = {}

    def src(name):
        if name not in cache:
            cache[name] = load(os.path.join(raw, name + ".mp3"))
        return cache[name]

    manifest = {"version": 3, "note": "Red Queen sound assets. Times in seconds within each file. gain/g: linear "
                "correction to the role's reference loudness. baseHz: fundamental (lowest strong partial). "
                "loop: a seamless region. Generated by tools/sound/process.py.",
                "assets": []}
    used = set()
    total = 0
    report = []

    for spec in ASSETS:
        srcs = spec["src"] if isinstance(spec["src"], list) else [spec["src"]]
        used.update(srcs)
        ch = spec["ch"]
        kind = spec["kind"]
        entry = {"name": spec["name"], "file": spec["name"] + ".mp3", "role": spec["role"], "channels": ch,
                 "credit": [SOURCES[s][1] + " — " + SOURCES[s][0] + " (" + SOURCES[s][2] + ")" for s in srcs]}
        body = None

        if kind == "ambience":
            x = src(srcs[0])
            s, e = calm_window(x, spec["dur"])
            y = clean(x[s:e], spec)
            y = y if ch == 2 else y.mean(axis=1, keepdims=True)
            L = lufs_integrated(y)
            y = y * 10 ** ((spec["lufs"] - L) / 20)
            g = 1.0
            pk = np.abs(y).max()
            if pk > PEAK_CEIL:
                g = pk / PEAK_CEIL
                y /= g
            y = fades(y, 0.05, 0.05)
            body = y
            entry.update(gain=round(float(g), 3), lufs=spec["lufs"], loop=[0.3, round(len(y) / SR - 0.3, 3)],
                         src_range=[round(s / SR, 2), round(e / SR, 2)])
            report.append(f"{spec['name']}: {s / SR:.1f}-{e / SR:.1f}s  L={L:.1f} -> {spec['lufs']}  hf>4k {hf_share(y):.3f}")

        elif kind == "loop":
            x = clean(src(srcs[0]), spec)
            a0, a1 = spec["loop_from"]
            base, tops = tonal_peak(x[int(a0 * SR):int(a1 * SR)], 150, 3000)
            tile, P = make_loop(x, spec, base)
            y = tile
            L = short_level(y)
            y = y * 10 ** ((ONESHOT_LK - 4 - L) / 20)
            pk = np.abs(y).max()
            g = 1.0
            if pk > PEAK_CEIL:
                g = pk / PEAK_CEIL
                y /= g
            # tiny fades at the file edges only (the loop region is inside)
            y = fades(y, 0.02, 0.02)
            body = y
            entry.update(gain=round(float(g), 3), baseHz=round(base, 2),
                         loop=[round(P / 2 / SR, 5), round(3 * P / 2 / SR, 5)], period=round(P / SR, 5))
            jump = abs(tile[P - 1] - tile[P]) / (np.abs(tile).max() + 1e-9)
            report.append(f"{spec['name']}: base {base:.1f} Hz  P={P / SR:.3f}s  seam step {jump:.4f}  tops {tops}")

        elif kind in ("slices", "chunks", "whole", "whale"):
            pieces = []  # (array (n,), info)
            for si, sname in enumerate(srcs):
                x = clean(src(sname), spec)
                if kind == "slices":
                    spans = slice_hits(x, spec)
                elif kind == "chunks":
                    spans = chunk_texture(x, spec)
                elif kind == "whale":
                    spans = find_whale_calls(x, spec, spec["maxseg"][si])
                else:
                    spans = [trim_whole(x, spec)]
                for (s, e) in spans:
                    seg = x[s:e].mean(axis=1)
                    if kind == "chunks":
                        seg = fades(seg, spec["fade"], spec["fade"])
                    elif kind == "whale":
                        seg = fades(seg, 0.6, 1.0)
                    else:
                        seg = fades(seg, spec.get("fade_in", 0.002), min(spec.get("fade_out", 0.1), (e - s) / SR * 0.45))
                    info = {"src": sname, "at": round(s / SR, 3)}
                    if spec.get("tonal"):
                        a = int((0.2 if kind == "whole" else 0.04) * SR) if kind != "whale" else 0
                        span = {"whale": 6.0, "whole": 4.0}.get(kind, 0.6)
                        b = min(len(seg), a + int(span * SR))
                        base, tops = tonal_peak(seg[a:b], 60, 3000)
                        info["baseHz"] = round(base, 1) if base else None
                        info["tops"] = tops
                    if spec.get("maxHz") and info.get("baseHz") and info["baseHz"] > spec["maxHz"]:
                        continue
                    pieces.append((seg, info))
            # normalise
            normed = []
            for seg, info in pieces:
                if kind == "whale":
                    L = short_level(seg)
                    y = seg * 10 ** ((ONESHOT_LK - 2 - L) / 20)
                    pk = np.abs(y).max()
                    g = 1.0
                    if pk > PEAK_CEIL:
                        g = pk / PEAK_CEIL
                        y = y / g
                    g = round(float(g), 3)
                else:
                    y, g = norm_oneshot(seg)
                normed.append((y, info, g))
            # lay out a sprite
            parts = [np.zeros(int(LEAD * SR))]
            t = LEAD
            slices = []
            for y, info, g in normed:
                n = len(y)
                sl = {"s": round(t, 4), "e": round(t + n / SR, 4), "g": g}
                if info.get("baseHz"):
                    sl["hz"] = info["baseHz"]
                slices.append(sl)
                parts.append(y)
                parts.append(np.zeros(int(GAP * SR)))
                t += n / SR + GAP
            body = np.concatenate(parts)[:, None]
            entry["slices"] = slices
            if spec.get("tonal"):
                hz = [s["hz"] for s in slices if s.get("hz")]
                entry["baseHz"] = round(float(np.median(hz)), 1) if hz else None
            entry["gain"] = 1.0
            report.append(f"{spec['name']}: {len(slices)} slices  " + "  ".join(
                f"[{i['src'][-6:]}@{i['at']:.2f} {len(y) / SR:.2f}s g{g}" + (f" {i['baseHz']}Hz" if i.get('baseHz') else "") + "]"
                for y, i, g in normed))
            if spec.get("tonal"):
                for y, i, g in normed:
                    report.append(f"    tops {i['src'][-6:]}@{i['at']:.2f}: {i.get('tops')}")
        else:
            raise ValueError(kind)

        path = os.path.join(out, entry["file"])
        encode(body, path, ch, spec["sr"], spec["kbps"])
        size = os.path.getsize(path)
        total += size
        entry["dur"] = round(len(body) / SR, 4)
        entry["sr"] = spec["sr"]
        entry["bytes"] = size
        pk = decode_check(path)
        report.append(f"    -> {entry['file']} {size / 1024:.0f} KB, {entry['dur']:.2f}s, decoded peak {20 * np.log10(pk + 1e-9):.2f} dBFS, hf>4k {hf_share(body):.3f}")
        manifest["assets"].append(entry)

    with open(os.path.join(out, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1)

    # credits
    lines = ["Red Queen — credits", "=" * 19, "",
             "Every recording below was processed (trimmed, sliced, filtered, normalised, pitched at playback)",
             "for this site by tools/sound/process.py. Attribution is required for the CC BY 4.0 works.",
             "Licences: CC0 1.0 https://creativecommons.org/publicdomain/zero/1.0/",
             "          CC BY 4.0 https://creativecommons.org/licenses/by/4.0/", ""]
    by = [s for s in sorted(used) if "BY" in SOURCES[s][2]]
    rest = [s for s in sorted(used) if s not in by]
    by.sort(key=lambda s: SOURCES[s][1].lower())
    rest.sort(key=lambda s: SOURCES[s][1].lower())
    lines.append("Attribution required (CC BY 4.0):")
    for s in by:
        t, a, l, u = SOURCES[s]
        lines.append(f"  \u201c{t}\u201d by {a}, {l}, {u} (modified)")
    lines.append("")
    lines.append("Other sources:")
    for s in rest:
        t, a, l, u = SOURCES[s]
        lines.append(f"  \u201c{t}\u201d by {a}, {l}, {u}")
    lines.append("")
    # the rest of the site's borrowed material (not made by this script, credited here so there is one list)
    lines += ["Voice and type:",
              "  Narration in the demo: a synthetic voice made with Kokoro-82M by hexgrad (Apache-2.0), voice bf_emma,",
              "    https://huggingface.co/hexgrad/Kokoro-82M (tools/voice)",
              "  Display face: Red Queen Glass, a modification of Bodoni Moda by The Bodoni Moda Project Authors (SIL Open Font License 1.1),",
              "    web/public/fonts/OFL.txt (tools/font)",
              ""]
    with open(os.path.join(out, "CREDITS.txt"), "w") as f:
        f.write("\n".join(lines))

    print("\n".join(report))
    print(f"\nTOTAL {total / 1024:.0f} KB in {len(manifest['assets'])} files (+ manifest, credits)")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    main(sys.argv[1], sys.argv[2])
