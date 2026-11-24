/**
 * The ambient bed: a slow, generative chord pad in the live key.
 *
 * The bed never glides, because a Shepard–Risset glissando ("rises forever without getting higher") heard
 * for minutes sounds like endless climbing, which is tense. Four voices hold chord tones in fixed registers (D2..G4)
 * and move to the nearest tone of the next chord, holding common tones, the way a choir voice-leads.
 * Chords change every 15–29 s on a seeded Markov walk through the mode, with 5–8 s swells, so the bed is
 * always moving and never repeats, but its pitch is bounded and mean-reverting: nothing trends upward.
 *
 * The vault balance opens the pad (brighter and fuller when full, darker with the top voice gone when
 * drained); refusal pressure darkens it a little. The tension of an attack lives in the event voices,
 * not in a detuned bed. Each voice's level wanders on its own slow random walk instead of an LFO, so
 * there is no periodic pulse to notice.
 *
 * The current chord is exposed (`chordNow`) so every other sound — refusals, the queen's glass, the
 * distant giants — is drawn from the same harmony and is consonant with the bed by construction.
 *
 * Pure Web Audio, one seeded PRNG, scheduled through pump(now) so it renders identically offline.
 */
import { chordPcs, isDiminished, ladder, mtof, mulberry32, type Key } from "./theory";

type ACtx = BaseAudioContext;

export interface BedMix {
  motion: number; // 0..1 scroll energy
  cinema: boolean;
  calm: boolean; // reduced motion
}

export interface Chord {
  /** scale degree of the root (0 = tonic) */
  deg: number;
  /** pitch classes, root first */
  pcs: number[];
  /** MIDI note the bass voice is holding */
  bass: number;
  /** bumps on every change, so listeners can tell a new chord from the same one */
  id: number;
}

/** voice registers (MIDI): bass, tenor, alto, top. The pad lives here and stays here. */
const RANGES: [number, number][] = [
  [38, 50],
  [47, 59],
  [52, 63],
  [57, 67],
];
const VOICE_LEVEL = [0.3, 0.24, 0.2, 0.13];

/** next-chord candidates by scale degree (repeats = weight): modal, unhurried, no V→I pull. */
const NEXT: Record<number, number[]> = {
  0: [5, 5, 3, 3, 6, 2, 4],
  1: [4, 6, 6, 0],
  2: [5, 5, 0, 3],
  3: [0, 0, 0, 6, 5, 1],
  4: [0, 0, 5, 3],
  5: [3, 3, 0, 0, 6, 2],
  6: [0, 0, 0, 3, 5],
};

const ATTACK_MAX = 8;

interface Note {
  midi: number;
  gain: GainNode;
  oscs: OscillatorNode[];
}

export class Bed {
  private ctx: ACtx;
  private rnd: () => number;
  private padGain: GainNode;
  private padLp: BiquadFilterNode;
  private voiceGain: GainNode[] = [];
  private notes: (Note | null)[] = [null, null, null, null];
  private pitch = [43, 53, 57, 62];

  private key: Key;
  private chord: Chord;
  private homeNext = true; // the next change returns to the tonic (first chord, new key)
  private nextChange = 0;
  private lastChange = -100;
  private nextBreath = 0;

  private frac = 1;
  private pressure = 0;
  private level = 1;
  private mix: BedMix = { motion: 0, cinema: false, calm: false };

  constructor(ctx: ACtx, masterInput: GainNode, verbIn: GainNode, key: Key, seed = 0x7ed9) {
    this.ctx = ctx;
    this.key = key;
    this.rnd = mulberry32(seed);

    this.padLp = ctx.createBiquadFilter();
    this.padLp.type = "lowpass";
    this.padLp.frequency.value = 700;
    this.padLp.Q.value = 0.4;
    this.padGain = ctx.createGain();
    this.padGain.gain.value = 0.0001;
    this.padLp.connect(this.padGain);
    this.padGain.connect(masterInput);
    const send = ctx.createGain();
    send.gain.value = 0.55;
    this.padGain.connect(send);
    send.connect(verbIn);

    for (let v = 0; v < 4; v++) {
      const g = ctx.createGain();
      g.gain.value = 0.85;
      g.connect(this.padLp);
      this.voiceGain.push(g);
    }
    this.chord = { deg: 0, pcs: chordPcs(key, 0), bass: 43, id: 0 };
  }

  /** kept for API compatibility: the first chord is laid on the first pump */
  start() {
    this.nextChange = this.ctx.currentTime;
  }

  setVault(frac: number) {
    this.frac = Math.max(0, Math.min(1.25, frac));
  }
  setPressure(p: number) {
    this.pressure = Math.max(0, Math.min(1, p));
  }
  /** overall level multiplier: 1 alone, lower as quiet harmonic glue under the recorded world */
  setLevel(m: number) {
    this.level = Math.max(0, m);
  }
  setMix(m: BedMix) {
    this.mix = m;
  }

  chordNow(): Chord {
    return this.chord;
  }

  /** A new policy's key: voice-lead to its tonic chord soon (never mid-swell, so nothing jumps). */
  setKey(key: Key, atTime?: number) {
    const same = key.tonic === this.key.tonic && key.mode === this.key.mode;
    this.key = key;
    if (same) return;
    this.homeNext = true;
    const at = atTime ?? this.ctx.currentTime;
    this.nextChange = Math.max(at + 0.3, this.lastChange + ATTACK_MAX + 0.5);
  }

  pump(now: number, lookahead = 0.4) {
    const f = Math.min(1, this.frac);
    const bright = this.mix.calm ? 0.75 : 1;
    const cutoff = Math.max(220, (300 + 620 * f * f) * bright * (1 + this.mix.motion * 0.2) - this.pressure * 140);
    this.padLp.frequency.setTargetAtTime(cutoff, now, 0.9);
    this.padGain.gain.setTargetAtTime((0.05 + 0.035 * f) * (this.mix.cinema ? 1.15 : 1) * this.level, now, 1.5);

    // each voice drifts on its own slow random walk: the pad breathes without a pulse
    while (this.nextBreath <= now + lookahead) {
      const t = Math.max(this.nextBreath, now);
      for (let v = 0; v < 4; v++) {
        const target = (0.65 + 0.35 * this.rnd()) * (v === 3 ? f * f : 1);
        this.voiceGain[v].gain.setTargetAtTime(target, t, 1.6);
      }
      this.nextBreath = t + 1.8 + this.rnd() * 2.2;
    }

    while (this.nextChange <= now + lookahead) {
      const t = Math.max(this.nextChange, now);
      this.change(t);
      this.nextChange = t + (this.mix.calm ? 24 : 15) + this.rnd() * 14;
    }
  }

  private pickNext(deg: number): number {
    const opts = (NEXT[deg] ?? NEXT[0]).filter((d) => d !== deg && !isDiminished(this.key, d));
    if (!opts.length) return isDiminished(this.key, 0) ? 5 : 0;
    return opts[Math.floor(this.rnd() * opts.length)];
  }

  private change(t: number) {
    let deg: number;
    if (this.homeNext) {
      deg = isDiminished(this.key, 0) ? 5 : 0;
      this.homeNext = false;
    } else deg = this.pickNext(this.chord.deg);
    const seventh = this.rnd() < 0.3;
    const pcs = chordPcs(this.key, deg, seventh);
    const atk = 5 + this.rnd() * (ATTACK_MAX - 5);
    const rel = 6 + this.rnd() * 3;
    const used = new Set<number>();

    for (let v = 0; v < 4; v++) {
      const [lo, hi] = RANGES[v];
      let cands = ladder(v === 0 ? [pcs[0]] : pcs, lo, hi);
      if (!cands.length) cands = ladder(pcs, lo, hi);
      const mid = (lo + hi) / 2;
      let best = cands[0];
      let bestCost = Infinity;
      for (const c of cands) {
        const cost = Math.abs(c - this.pitch[v]) + 0.15 * Math.abs(c - mid) + (used.has(c) ? 4 : 0) + this.rnd() * 0.9;
        if (cost < bestCost) {
          bestCost = cost;
          best = c;
        }
      }
      used.add(best);
      this.pitch[v] = best;
      const held = this.notes[v];
      if (held && held.midi === best) continue; // a common tone is held, not re-struck
      if (held) this.release(held, t, rel);
      this.notes[v] = this.strike(v, best, t, atk);
    }
    this.lastChange = t;
    this.chord = { deg, pcs, bass: this.pitch[0], id: this.chord.id + 1 };
  }

  private strike(v: number, midi: number, t: number, atk: number): Note {
    const ctx = this.ctx;
    const f = mtof(midi);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(VOICE_LEVEL[v], t + atk);
    gain.connect(this.voiceGain[v]);
    const oscs: OscillatorNode[] = [];
    const add = (type: OscillatorType, freq: number, level: number, cents: number) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      o.detune.value = cents;
      const g = ctx.createGain();
      g.gain.value = level;
      o.connect(g);
      g.connect(gain);
      o.start(t);
      oscs.push(o);
    };
    const side = v % 2 ? 1 : -1;
    add("sine", f, 1, (this.rnd() * 2 - 1) * 2);
    add("triangle", f, 0.4, side * (3 + this.rnd() * 4)); // a slow chorus beat, a few cents wide
    if (v === 0) add("sine", f / 2, 0.75, 0); // the sub, an octave under the bass
    return { midi, gain, oscs };
  }

  private release(n: Note, t: number, rel: number) {
    n.gain.gain.setTargetAtTime(0, t, rel / 4);
    for (const o of n.oscs) o.stop(t + rel + 1.5);
  }
}
