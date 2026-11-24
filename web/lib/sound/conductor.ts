/**
 * The conductor decides what each chain event plays, so a stream of identical events never sounds
 * identical. The live arena is repetitive by nature: the same few bots send the same attacks every
 * minute, and a burst lands five or twelve refusals in one block. Played literally, that would be one
 * tense note struck again and again.
 *
 * Game-audio practice for repeated events, applied here:
 *  - pitch from a melody, not a lookup: each refusal takes the next step of a wandering line over the
 *    bed's current chord tones. The walk is mean-reverting (it leans back toward the middle of its
 *    range), so it never climbs; it never strikes the same note twice in a row; and because the chord
 *    changes every 15–29 s, the same attack sounds different a minute later;
 *  - the reason bits set the texture, not the pitch: more reasons stack more chord tones below the
 *    melody note, and an interaction rule adds a soft colour tone (the clever attacks sound clever);
 *  - bursts become a strum: events closer than ~0.1 s are spread out, each later one quieter, and past
 *    six in three seconds they are swallowed (voice limiting);
 *  - round-robin micro-variation on every hit: level, decay, brightness and pan jitter;
 *  - tiny drains (dust amounts) are a drip, not a full drain.
 *
 * Pure and seeded, so the offline harness hears exactly what the browser plays. `trace` keeps the last
 * decisions for the harness to check that consecutive notes differ.
 */
import { ladder, mulberry32, scaleStepAbove, type Key } from "./theory";
import type { Chord } from "./bed";

export interface RefusalPlan {
  t: number;
  notes: number[]; // MIDI, melody note first, then the stack below it
  colour: number | null; // MIDI colour tone for interaction rules
  body: number | null; // MIDI of the low "no" under the first hit of a burst
  level: number;
  decay: number;
  bright: number;
  pan: number;
}

export interface DrainPlan {
  t: number;
  share: number;
  base: number; // MIDI
  level: number;
  pan: number;
  drip: boolean;
}

const MELODY_LO = 50; // D3
const MELODY_HI = 67; // G4

export class Conductor {
  private rnd = mulberry32(0xc0d1);
  private key: Key;
  private idx = -1;
  private lastPitch = -1;
  private lastLadder: number[] = [];
  private recent: number[] = [];
  private lastRefusal = -10;
  private lastDrain = -10;
  private epochs = 0;
  readonly trace: { t: number; kind: string; notes: number[]; level: number }[] = [];

  constructor(key: Key) {
    this.key = key;
  }

  setKey(key: Key) {
    this.key = key;
  }

  private log(t: number, kind: string, notes: number[], level: number) {
    this.trace.push({ t, kind, notes, level: +level.toFixed(3) });
    if (this.trace.length > 256) this.trace.shift();
  }

  /** the melody's chord tones for this chord, re-seating the walker when the chord changes */
  private ladderFor(chord: Chord): number[] {
    const sig = chord.pcs.join(",");
    if (sig !== this.ladderSig) {
      const L = ladder(chord.pcs, MELODY_LO, MELODY_HI);
      const from = this.lastPitch < 0 ? (MELODY_LO + MELODY_HI) / 2 : this.lastPitch;
      let bi = 0;
      for (let i = 1; i < L.length; i++) if (Math.abs(L[i] - from) < Math.abs(L[bi] - from)) bi = i;
      this.idx = bi;
      this.lastLadder = L;
      this.ladderSig = sig;
    }
    return this.lastLadder;
  }
  private ladderSig = "";

  /** the next note of the wandering line */
  step(chord: Chord): number {
    const L = this.ladderFor(chord);
    const mid = (L.length - 1) / 2;
    const pull = (this.idx - mid) / Math.max(1, mid); // -1 low .. +1 high
    let s = this.rnd() < 0.5 - 0.38 * pull ? 1 : -1;
    if (this.rnd() < 0.28) s *= 2;
    let i = Math.max(0, Math.min(L.length - 1, this.idx + s));
    if (L[i] === this.lastPitch) i = Math.max(0, Math.min(L.length - 1, this.idx - s));
    this.idx = i;
    this.lastPitch = L[i];
    return L[i];
  }

  refusal(at: number, bits: number[], chord: Chord, pan: number): RefusalPlan | null {
    let t = at;
    if (t < this.lastRefusal + 0.1) t = this.lastRefusal + 0.1 + this.rnd() * 0.06;
    this.recent = this.recent.filter((x) => x > t - 3);
    const n = this.recent.length;
    if (n >= 6) return null;
    this.recent.push(t);
    const burstHead = t - this.lastRefusal > 0.6;
    this.lastRefusal = t;

    const top = this.step(chord);
    const L = this.lastLadder;
    const notes = [top];
    const stack = Math.min(3, bits.length) - 1;
    const ti = L.indexOf(top);
    for (let k = 1; k <= stack; k++) {
      const below = L[ti - 2 * k] ?? L[ti - k];
      if (below !== undefined && !notes.includes(below)) notes.push(below);
    }
    const clever = bits.some((b) => b >= 8);
    const level = (0.85 + 0.15 * this.rnd()) / (1 + 0.32 * n);
    const plan: RefusalPlan = {
      t,
      notes,
      colour: clever ? scaleStepAbove(this.key, top) : null,
      body: burstHead ? chord.bass - 12 : null,
      level,
      decay: 0.85 + 0.4 * this.rnd(),
      bright: 0.8 + 0.4 * this.rnd(),
      pan: Math.max(-1, Math.min(1, pan + (this.rnd() * 2 - 1) * 0.12)),
    };
    this.log(t, "refusal", notes, level);
    return plan;
  }

  extraction(at: number, share: number, chord: Chord, pan: number): DrainPlan | null {
    let t = at;
    if (t < this.lastDrain + 0.12) {
      if (share < 0.02) return null; // dust drips inside a burst merge into the first
      t = this.lastDrain + 0.12 + this.rnd() * 0.05;
    }
    this.lastDrain = t;
    const drip = share < 0.02;
    const base = drip ? this.step(chord) - 12 : chord.bass;
    const level = (0.8 + 0.2 * this.rnd()) * (drip ? 0.55 : 1);
    this.log(t, drip ? "drip" : "drain", [base], level);
    return { t, share, base, level, pan: Math.max(-1, Math.min(1, pan + (this.rnd() * 2 - 1) * 0.1)), drip };
  }

  /** notes for an epoch's close: a plagal settle (IV then I) voiced near the bed, and a motif rotation */
  epoch(): number {
    return this.epochs++;
  }

  /** a few chord tones in a register, in a random order (for small figures) */
  figure(chord: Chord, lo: number, hi: number, count: number, descending?: boolean): number[] {
    const L = ladder(chord.pcs, lo, hi);
    const start = Math.floor(this.rnd() * Math.max(1, L.length - count));
    const out = L.slice(start, start + count);
    const down = descending ?? this.rnd() < 0.5;
    return down ? out.reverse() : out;
  }

  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.rnd() * xs.length)];
  }

  jitter(amount: number): number {
    return 1 + (this.rnd() * 2 - 1) * amount;
  }
}
