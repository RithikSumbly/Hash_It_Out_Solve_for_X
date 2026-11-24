/**
 * Event voices — the transient sounds, all short-lived (allocate, envelope, stop). They take explicit
 * notes from the conductor, which draws them from the bed's current chord, so every event is consonant
 * with the pad and no two repeats are the same. Everything sits between D1 and G4; nothing glides upward.
 *
 *  refusal       struck glass on the melody note, a stack below it per extra reason, a soft colour tone
 *                for interaction rules, and a low "no" under the first hit of a burst
 *  extraction    a falling drain + sub hit scaled by the amount share; dust amounts are a single drip
 *  epochClose    a plagal settle (IV → I) that blooms in place, then a rotation of the signature motif
 *  policyBell    a soft low glass bell when a new champion is installed
 *  childBorn     a faint figure of chord tones
 *  policyDied    a short descending figure
 *  deposit       a swell that opens like a filter, not a rising pitch
 *
 * Every impact is placed on the stereo field by the attacker's side, matching the ink jet.
 */
import { mtof } from "./theory";
import type { DrainPlan, RefusalPlan } from "./conductor";

type ACtx = BaseAudioContext;

export interface Bus {
  input: GainNode;
  verbIn: GainNode;
}

function env(p: AudioParam, t: number, peak: number, atk: number, dec: number) {
  p.setValueAtTime(0.0001, t);
  p.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + atk);
  p.exponentialRampToValueAtTime(0.0001, t + atk + dec);
}

function out(ctx: ACtx, bus: Bus, pan: number, verb: number): StereoPannerNode {
  const p = ctx.createStereoPanner();
  p.pan.value = Math.max(-1, Math.min(1, pan));
  p.connect(bus.input);
  const send = ctx.createGain();
  send.gain.value = verb;
  p.connect(send);
  send.connect(bus.verbIn);
  return p;
}

/** One struck glass tone: a warm resonant body and a soft sub-octave, low-passed so it never bites. */
function glassTone(ctx: ACtx, bus: Bus, freq: number, t: number, dur: number, level: number, pan: number, bright = 1) {
  const pn = out(ctx, bus, pan, 0.34);
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = freq * 1.5;
  bp.Q.value = 3.5;
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = Math.min(1400, 900 * bright);
  bp.connect(lp);
  lp.connect(pn);

  const o = ctx.createOscillator();
  o.type = "triangle";
  o.frequency.value = freq;
  const og = ctx.createGain();
  env(og.gain, t, level, 0.012, dur);
  o.connect(og);
  og.connect(bp);
  o.start(t);
  o.stop(t + dur + 0.1);

  // a quiet inharmonic partial (a glass's 2.76× mode), short, for the "glass" in the strike
  const p2 = ctx.createOscillator();
  p2.type = "sine";
  p2.frequency.value = Math.min(1100, freq * 2.76);
  const pg = ctx.createGain();
  env(pg.gain, t, level * 0.12, 0.004, dur * 0.25);
  p2.connect(pg);
  pg.connect(lp);
  p2.start(t);
  p2.stop(t + dur * 0.3 + 0.1);

  const b = ctx.createOscillator();
  b.type = "sine";
  b.frequency.value = freq * 0.5;
  const bg = ctx.createGain();
  env(bg.gain, t, level * 0.45, 0.02, dur * 0.8);
  b.connect(bg);
  bg.connect(pn);
  b.start(t);
  b.stop(t + dur + 0.1);
}

export function refusal(ctx: ACtx, bus: Bus, p: RefusalPlan) {
  const base = 0.17 * p.level;
  p.notes.forEach((m, i) => {
    glassTone(ctx, bus, mtof(m), p.t + i * 0.022, (i ? 0.8 : 1.15) * p.decay, base / (1 + i * 0.45), p.pan, p.bright);
  });
  if (p.colour !== null) glassTone(ctx, bus, mtof(p.colour), p.t + 0.05, 0.55 * p.decay, base * 0.32, -p.pan * 0.5, p.bright * 0.9);
  if (p.body !== null) {
    // the queen's "no": a short low body under the first hit of a burst
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(mtof(p.body), p.t);
    o.frequency.exponentialRampToValueAtTime(mtof(p.body - 5), p.t + 0.35);
    const g = ctx.createGain();
    env(g.gain, p.t, 0.2 * p.level, 0.006, 0.45);
    o.connect(g);
    g.connect(out(ctx, bus, p.pan * 0.4, 0.1));
    o.start(p.t);
    o.stop(p.t + 0.6);
  }
}

export function extraction(ctx: ACtx, bus: Bus, p: DrainPlan) {
  const t = p.t;
  if (p.drip) {
    // a single drop of quicksilver: a short sine that falls a tone, then a tiny ring
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(mtof(p.base), t);
    o.frequency.exponentialRampToValueAtTime(mtof(p.base - 2), t + 0.12);
    const g = ctx.createGain();
    env(g.gain, t, 0.07 * p.level, 0.004, 0.22);
    o.connect(g);
    g.connect(out(ctx, bus, p.pan, 0.45));
    o.start(t);
    o.stop(t + 0.35);
    return;
  }
  const s = Math.max(0.02, Math.min(1.2, p.share));
  const depth = 5 + 10 * s;
  const dur = 0.5 + 1.0 * s;
  const pn = out(ctx, bus, p.pan, 0.35);
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.setValueAtTime(620, t);
  lp.frequency.exponentialRampToValueAtTime(120, t + dur);
  lp.connect(pn);
  for (const det of [0, 1]) {
    const o = ctx.createOscillator();
    o.type = "triangle";
    o.frequency.setValueAtTime(mtof(p.base + det * 0.12), t);
    o.frequency.exponentialRampToValueAtTime(mtof(p.base - depth) * (det ? 0.994 : 1), t + dur);
    const g = ctx.createGain();
    env(g.gain, t, (0.12 + 0.16 * s) * p.level, 0.01, dur);
    o.connect(g);
    g.connect(lp);
    o.start(t);
    o.stop(t + dur + 0.1);
  }
  const sub = ctx.createOscillator();
  sub.type = "sine";
  sub.frequency.setValueAtTime(mtof(p.base - 12), t);
  sub.frequency.exponentialRampToValueAtTime(mtof(p.base - 19), t + 0.5);
  const sg = ctx.createGain();
  env(sg.gain, t, (0.1 + 0.24 * s) * p.level, 0.006, 0.6);
  sub.connect(sg);
  sg.connect(bus.input);
  sub.start(t);
  sub.stop(t + 0.7);
}

/** A soft pad chord that blooms in place (no pitch glide). */
function bloom(ctx: ACtx, bus: Bus, notes: number[], t: number, level: number, atk: number, dur: number) {
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.setValueAtTime(260, t);
  lp.frequency.exponentialRampToValueAtTime(900, t + atk);
  lp.frequency.exponentialRampToValueAtTime(300, t + atk + dur);
  lp.connect(bus.input);
  const send = ctx.createGain();
  send.gain.value = 0.55;
  lp.connect(send);
  send.connect(bus.verbIn);
  notes.forEach((m, i) => {
    const o = ctx.createOscillator();
    o.type = "triangle";
    o.frequency.value = mtof(m);
    o.detune.value = (i % 2 ? 1 : -1) * 4;
    const g = ctx.createGain();
    env(g.gain, t, level, atk, dur);
    o.connect(g);
    g.connect(lp);
    o.start(t);
    o.stop(t + atk + dur + 0.1);
  });
}

/** The epoch closes: IV blooms, settles to I, and the signature motif answers, low and soft. */
export function epochClose(ctx: ACtx, bus: Bus, four: number[], one: number[], motif: number[], t: number) {
  bloom(ctx, bus, four, t, 0.05, 0.6, 1.6);
  bloom(ctx, bus, one, t + 1.3, 0.055, 0.7, 3.2);
  motif.forEach((m, i) => bell(ctx, bus, mtof(m), t + 2.0 + i * (0.2 + (i % 2) * 0.08), 0.04, (i % 2 ? 1 : -1) * 0.25));
}

/** Just the plagal settle (IV then I), softly, under a recorded bell. */
export function epochSettle(ctx: ACtx, bus: Bus, four: number[], one: number[], t: number, level = 1) {
  bloom(ctx, bus, four, t, 0.05 * level, 0.8, 1.6);
  bloom(ctx, bus, one, t + 1.4, 0.055 * level, 0.9, 3.2);
}

/** A soft low glass bell (gentle 2-op FM, low-passed). */
function bell(ctx: ACtx, bus: Bus, freq: number, t: number, level: number, pan: number) {
  const car = ctx.createOscillator();
  car.type = "sine";
  car.frequency.value = freq;
  const mod = ctx.createOscillator();
  mod.type = "sine";
  mod.frequency.value = freq * 2.0;
  const modG = ctx.createGain();
  modG.gain.setValueAtTime(freq * 0.6, t);
  modG.gain.exponentialRampToValueAtTime(freq * 0.05, t + 1.2);
  mod.connect(modG);
  modG.connect(car.frequency);
  const g = ctx.createGain();
  env(g.gain, t, level, 0.006, 1.8);
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 1200;
  car.connect(g);
  g.connect(lp);
  lp.connect(out(ctx, bus, pan, 0.5));
  car.start(t);
  mod.start(t);
  car.stop(t + 2);
  mod.stop(t + 2);
}

/** A new champion was installed — a soft low glass bell on chord tones. */
export function policyBell(ctx: ACtx, bus: Bus, notes: number[], t: number, level = 1) {
  notes.forEach((m, i) => bell(ctx, bus, mtof(m), t + i * 0.06, (i ? 0.035 : 0.06) * level, i ? -0.2 : 0.1));
}

/** A faint figure — a new candidate policy was born. */
export function childBorn(ctx: ACtx, bus: Bus, notes: number[], pan: number, t: number) {
  notes.forEach((m, i) => {
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.value = mtof(m);
    const g = ctx.createGain();
    env(g.gain, t + i * 0.07, 0.03, 0.006, 0.26);
    o.connect(g);
    g.connect(out(ctx, bus, pan, 0.4));
    o.start(t + i * 0.07);
    o.stop(t + i * 0.07 + 0.4);
  });
}

/** A short descending figure — a policy died out of the pool. */
export function policyDied(ctx: ACtx, bus: Bus, notes: number[], t: number) {
  notes.forEach((m, i) => {
    const o = ctx.createOscillator();
    o.type = "triangle";
    o.frequency.value = mtof(m);
    const g = ctx.createGain();
    env(g.gain, t + i * 0.11, 0.045, 0.006, 0.28);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 800;
    o.connect(g);
    g.connect(lp);
    lp.connect(bus.input);
    o.start(t + i * 0.11);
    o.stop(t + i * 0.11 + 0.42);
  });
}

/** The vault was refilled: a chord that opens like a filter. */
export function deposit(ctx: ACtx, bus: Bus, notes: number[], t: number, level = 1) {
  bloom(ctx, bus, notes, t, 0.045 * level, 0.9, 1.4);
}
