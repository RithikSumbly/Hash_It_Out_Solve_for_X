/**
 * The recorded world: a hollow hall at night, and you are alone in it. A quiet bed you stop noticing,
 * and now and then one small thing that only an empty room makes audible, left to ring in the long hall:
 *
 *   room    the empty church's room tone, the air of the hall, mostly heard through the hall itself
 *   hollow  the night wind an octave down and darkened: the deep, slow breathing of a large empty space
 *   wind    the breeze through the high windows (stereo); opens a little with scroll and attacks
 *   brooks  two brooks outside, one each side, quiet
 *   details every 6-16 s, one thing somewhere in the hall: water dripping (sometimes twice), the walls
 *           settling (a deep, soft knock of old wood), a gust, a glass far off starting to sing on a tone
 *           of the chord, a glass touched. Weighted, never the same kind twice in a row; each at its own
 *           distance and side, quiet, and wet with the hall
 *   whales  very far off, deep calls every 60-120 s: the giants singing, pitched onto the bed's chord
 *
 * Nothing here suggests anyone else is in the room: the feeling is of being alone. No loop is ever audible: every bed layer is played as overlapping grains
 * (8-16 s) from random offsets, joined by long equal-power crossfades, each grain a hair off in pitch and
 * position. Seeded, scheduled from pump(now), so it renders exactly the same offline.
 */
import { mulberry32 } from "./theory";
import type { Chord } from "./bed";
import { nearestPc, ftom, play, rateFor, type Asset, type Bus, type Picker, type SampleBank } from "./samples";

type ACtx = BaseAudioContext;

interface LayerSpec {
  asset: string;
  level: number;
  pan: number;
  panJitter: number;
  grain: [number, number];
  xfade: number;
  detune: number; // max rate jitter, cents
  send: number;
  /** send to the far hall (distant things) */
  far?: number;
  /** a low-pass on the layer (distance), Hz */
  lp?: number;
  /** base playback rate (0.5: an octave down) */
  rate?: number;
}

const LAYERS: Record<string, LayerSpec> = {
  room: { asset: "amb-room", level: 0.32, pan: 0, panJitter: 0.1, grain: [9, 14], xfade: 4, detune: 6, send: 0.8, lp: 2600 },
  hollow: { asset: "amb-wind", level: 0.3, pan: 0, panJitter: 0.35, grain: [10, 16], xfade: 5, detune: 20, send: 0.5, far: 0.4, lp: 340, rate: 0.5 },
  wind: { asset: "amb-wind", level: 0.2, pan: 0, panJitter: 0.2, grain: [8, 13], xfade: 4, detune: 25, send: 0.35 },
  brookL: { asset: "amb-brook-a", level: 0.08, pan: -0.62, panJitter: 0.12, grain: [7, 11], xfade: 3, detune: 30, send: 0.35 },
  brookR: { asset: "amb-brook-b", level: 0.06, pan: 0.66, panJitter: 0.12, grain: [7, 11], xfade: 3, detune: 30, send: 0.35 },
};

/** the details, and how often each comes up (relative) */
const DETAILS: [kind: string, weight: number][] = [
  ["drip", 0.32],
  ["settle", 0.22],
  ["gust", 0.18],
  ["resonance", 0.17],
  ["clink", 0.11],
];

const FADE_N = 64;
const FADE_IN = new Float32Array(FADE_N);
const FADE_OUT = new Float32Array(FADE_N);
for (let i = 0; i < FADE_N; i++) {
  const x = i / (FADE_N - 1);
  FADE_IN[i] = Math.sin((x * Math.PI) / 2);
  FADE_OUT[i] = Math.cos((x * Math.PI) / 2);
}

class GrainLayer {
  readonly spec: LayerSpec;
  readonly out: GainNode;
  private next = -1;
  private walk = 1;
  private level: GainNode;

  constructor(ctx: ACtx, bus: Bus, spec: LayerSpec, dest: AudioNode) {
    this.spec = spec;
    this.level = ctx.createGain();
    this.level.gain.value = spec.level;
    this.out = ctx.createGain();
    this.out.gain.value = 1;
    if (spec.lp) {
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = spec.lp;
      lp.Q.value = 0.5;
      this.level.connect(lp);
      lp.connect(this.out);
    } else this.level.connect(this.out);
    this.out.connect(dest);
    if (spec.send > 0) {
      const s = ctx.createGain();
      s.gain.value = spec.send;
      this.out.connect(s);
      s.connect(bus.verbIn);
    }
    if (spec.far) {
      const f = ctx.createGain();
      f.gain.value = spec.far;
      this.out.connect(f);
      f.connect(bus.farIn);
    }
  }

  /** a multiplier on the layer level (motion, vault, swells) */
  set(ctx: ACtx, mult: number, at: number, tc = 1.2) {
    this.level.gain.setTargetAtTime(this.spec.level * mult * this.walk, at, tc);
  }

  pump(ctx: ACtx, a: Asset, rnd: () => number, now: number, lookahead: number) {
    if (this.next < 0) this.next = now + 0.05;
    while (this.next <= now + lookahead) {
      const t = Math.max(this.next, now);
      const [g0, g1] = this.spec.grain;
      const D = g0 + (g1 - g0) * rnd();
      const X = Math.min(this.spec.xfade, D / 2.5);
      const rate = (this.spec.rate ?? 1) * Math.pow(2, ((rnd() * 2 - 1) * this.spec.detune) / 1200);
      const lo = a.def.loop ? a.def.loop[0] : 0.2;
      const hi = (a.def.loop ? a.def.loop[1] : a.def.dur - 0.2) - D * rate;
      const off = lo + Math.max(0, hi - lo) * rnd() + a.shift;
      const src = ctx.createBufferSource();
      src.buffer = a.buf;
      src.playbackRate.value = rate;
      const g = ctx.createGain();
      g.gain.value = 0;
      // equal-power in, hold at 1 (the curve's last value), equal-power out
      g.gain.setValueCurveAtTime(FADE_IN, t, X);
      g.gain.setValueCurveAtTime(FADE_OUT, t + D - X, X);
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, this.spec.pan + (rnd() * 2 - 1) * this.spec.panJitter));
      src.connect(g);
      g.connect(p);
      p.connect(this.level);
      src.start(t, off, D * rate + 0.05);
      src.stop(t + D + 0.1);
      this.next = t + D - X;
      // the layer's own slow random walk in level, one step per grain (a world that breathes)
      this.walk = 0.78 + 0.44 * rnd();
    }
  }
}

export class Field {
  private ctx: ACtx;
  private bus: Bus;
  private bank: SampleBank;
  private picker: Picker;
  private rnd: () => number;
  private layers = new Map<string, GrainLayer>();
  private started = false;
  private on = true;
  private chord: Chord | null = null;

  private motion = 0;
  private pressure = 0;
  private vault = 1;
  private nextWhale = -1;
  private swellUntil = -1;
  private duck = 1;
  private gustUntil = -1;
  private nextDetail = -1;
  private lastDetail = "";
  /** harness only: hear one layer alone */
  solo: string | null = null;
  /** the bed's level: kept low so it sits behind everything */
  level = 0.3;
  /** first whale this many seconds after the world starts (then every 60-120 s) */
  firstWhale = [20, 34];

  /**
   * The bed layers and the spot sounds (details, whales) each leave through their own trio of gains (dry,
   * hall, far hall), so a level scales everything they send, reverb included.
   */
  private bedOut: { bus: Bus; g: GainNode[] };
  private spotOut: { bus: Bus; g: GainNode[] };
  /** the details' and whales' level: sparse events in the same world, a little forward of the bed */
  spotLevel = 0.6;

  constructor(ctx: ACtx, bus: Bus, bank: SampleBank, picker: Picker, seed = 0xf1e1d) {
    this.ctx = ctx;
    this.bus = bus;
    this.bank = bank;
    this.picker = picker;
    this.rnd = mulberry32(seed);
    this.bedOut = this.trio();
    this.spotOut = this.trio();
  }

  private trio(): { bus: Bus; g: GainNode[] } {
    const mk = (to: AudioNode) => {
      const g = this.ctx.createGain();
      g.gain.value = 0;
      g.connect(to);
      return g;
    };
    const g = [mk(this.bus.input), mk(this.bus.verbIn), mk(this.bus.farIn)];
    return { bus: { input: g[0], verbIn: g[1], farIn: g[2] }, g };
  }

  private levels(at: number, tc: number) {
    const k = this.on && this.started ? this.duck : 0;
    for (const x of this.bedOut.g) x.gain.setTargetAtTime(this.level * k, at, tc);
    for (const x of this.spotOut.g) x.gain.setTargetAtTime(this.spotLevel * k, at, tc);
  }

  /** true once the recorded ambience is playing (the synth wind/water can step back) */
  get active(): boolean {
    return this.started && this.on;
  }

  setChord(c: Chord) {
    this.chord = c;
  }
  setMotion(m: number) {
    this.motion = Math.max(0, Math.min(1, m));
  }
  setPressure(p: number) {
    this.pressure = Math.max(0, Math.min(1, p));
  }
  setVault(v: number) {
    this.vault = Math.max(0, Math.min(1.25, v));
  }
  /** layer switch (the offline harness renders the context sounds solo) */
  setOn(on: boolean, at = this.ctx.currentTime) {
    this.on = on;
    this.levels(at, 0.8);
  }

  /** step the whole world back (0..1) while something must be heard over it (the demo's narration) */
  setDuck(d: number, at = this.ctx.currentTime) {
    this.duck = Math.max(0, Math.min(1, d));
    this.levels(at, 0.6);
  }

  /** the brooks rise for a few seconds (a deposit refills the vault) */
  swell(at: number) {
    this.swellUntil = at + 5;
  }

  pump(now: number, lookahead = 0.6) {
    const ctx = this.ctx;
    if (!this.started) {
      // start as soon as the room and at least one outdoor layer are decoded
      if (!this.bank.has("amb-room") || !this.bank.has("amb-wind")) return;
      this.started = true;
      for (const [k, spec] of Object.entries(LAYERS)) this.layers.set(k, new GrainLayer(ctx, this.bedOut.bus, spec, this.bedOut.bus.input));
      this.levels(now, 1.5);
      this.nextWhale = now + this.firstWhale[0] + (this.firstWhale[1] - this.firstWhale[0]) * this.rnd();
      this.nextDetail = now + 4 + 5 * this.rnd();
    }
    if (!this.on) return;
    const swell = now < this.swellUntil ? 1.6 : 1;
    const f = Math.min(1, this.vault);
    for (const [k, layer] of this.layers) {
      const a = this.bank.get(layer.spec.asset);
      if (!a) continue;
      layer.pump(ctx, a, this.rnd, now, lookahead);
      let m = 1;
      let tc = 1.2;
      if (k === "wind") m = (1 + 0.6 * this.motion + 0.35 * this.pressure) * (now < this.gustUntil ? 1.9 : 1);
      else if (k === "brookL" || k === "brookR") m = (0.75 + 0.3 * f) * swell;
      else if (k === "hollow") {
        // the hall breathes: a slow swell now and then (a gust in the details), otherwise a low, even presence
        m = now < this.gustUntil ? 1.7 : 0.75 + 0.25 * Math.sin(now * 0.07);
        tc = now < this.gustUntil ? 1.6 : 4;
      }
      if (this.solo && this.solo !== k) m = 0;
      layer.set(ctx, m, now, tc);
    }
    if (this.nextWhale > 0 && this.nextWhale <= now + lookahead) {
      this.whale(Math.max(this.nextWhale, now));
      this.nextWhale = Math.max(this.nextWhale, now) + 60 + 60 * this.rnd();
    }
    if (this.nextDetail > 0 && this.nextDetail <= now + lookahead && !this.solo) {
      const t = Math.max(this.nextDetail, now);
      const len = this.detail(t);
      this.nextDetail = t + len + 6 + 10 * this.rnd();
    }
  }

  /** one thing happening somewhere in the hall; returns how long it takes (s) */
  detail(t: number, only?: string): number {
    const free = DETAILS.filter(([k]) => k !== this.lastDetail && this.bank.has(this.assetFor(k)));
    if (!free.length) return 0;
    let kind = only ?? free[0][0];
    if (!only) {
      let r = this.rnd() * free.reduce((a, [, w]) => a + w, 0);
      for (const [k, w] of free) {
        r -= w;
        if (r <= 0) {
          kind = k;
          break;
        }
      }
    }
    this.lastDetail = kind;
    const side = this.rnd() < 0.5 ? -1 : 1;
    const pan = side * (0.25 + 0.6 * this.rnd());
    // distance: 0 near-ish .. 1 far; darker, quieter and wetter with distance
    const dist = 0.35 + 0.65 * this.rnd();
    const lp = 2600 - 1500 * dist;
    const j = (a: number, b: number) => a + (b - a) * this.rnd();
    const sliceOf = (name: string, role: string) => {
      const a = this.bank.get(name);
      if (!a?.def.slices?.length) return null;
      const keys = a.def.slices.map((_, i) => name + ":" + i);
      const i = this.picker.choose(role, keys);
      return { a, i, key: keys[i] };
    };
    const go = (name: string, role: string, at: number, o: { gain: number; rate?: number; pan?: number; panTo?: number; lp?: number; attack?: number; release?: number; dur?: number; offset?: number }) => {
      const c = sliceOf(name, role);
      const a = c?.a ?? this.bank.get(name);
      if (!a) return 0;
      const rate = this.picker.rate(role, c?.key ?? name, o.rate ?? 1);
      const v = play(this.ctx, this.spotOut.bus, a, {
        at,
        slice: c?.i,
        rate,
        gain: o.gain * (1 - 0.35 * dist),
        pan: o.pan ?? pan,
        panTo: o.panTo,
        lp: o.lp ?? lp,
        hp: 110,
        dry: 0.3 - 0.2 * dist,
        send: 0.42,
        far: 0.6 + 0.7 * dist,
        attack: o.attack,
        release: o.release,
        dur: o.dur,
        offset: o.offset,
      });
      this.picker.played(role, c?.key ?? name, at, v.end, rate);
      return v.end - at;
    };
    switch (kind) {
      case "drip": {
        // water dripping somewhere in the hall, sometimes a second drop after it
        let len = go("drip", "far-drip", t, { gain: j(0.08, 0.12), rate: j(0.85, 1.0), lp: 1500 });
        if (this.rnd() < 0.45) len = Math.max(len, 0.5 + go("drip", "far-drip", t + j(0.45, 1.3), { gain: j(0.05, 0.09), rate: j(0.85, 1.0), lp: 1400 }));
        return len;
      }
      case "settle":
        // the old wood of the hall settling: a deep, soft knock, mostly heard as its echo
        return go("knock", "far-settle", t, { gain: j(0.06, 0.09), rate: j(0.78, 0.92), lp: 650, release: 0.12 });
      case "gust":
        this.gustUntil = t + 4 + 4 * this.rnd();
        return this.gustUntil - t;
      case "resonance": {
        // a glass far off starts to sing on a tone of the chord, swells and fades (as if the air set it going)
        const a = this.bank.get("sing-a");
        if (!a) return 0;
        const pcs = this.chord?.pcs ?? [2, 5, 9];
        const note = nearestPc(pcs, 57 + 10 * this.rnd());
        const loop = a.def.loop ?? [0.5, a.def.dur - 0.5];
        const len = 3.5 + 2.5 * this.rnd();
        return go("sing-a", "far-sing", t, {
          gain: j(0.05, 0.08),
          rate: rateFor(a.def.baseHz ?? 790, note, 0.71, 1.41),
          lp: 1500,
          attack: 1.6,
          release: 2.2,
          dur: Math.min(len, loop[1] - loop[0]),
          // a random place inside the clean (seamless) stretch of the recording
          offset: loop[0] + (loop[1] - loop[0] - Math.min(len, loop[1] - loop[0])) * this.rnd(),
        });
      }
      case "clink": {
        // a glass touched somewhere, on a tone of the chord, pitched down
        const a = this.bank.get("glass-clink");
        if (!a) return 0;
        const pcs = this.chord?.pcs ?? [2, 5, 9];
        const note = nearestPc(pcs, 64 + 6 * this.rnd());
        return go("glass-clink", "far-clink", t, { gain: j(0.03, 0.045), rate: rateFor(a.def.baseHz ?? 1300, note + 12, 0.71, 1.41), lp: 2000, release: 0.6 });
      }
    }
    return 0;
  }

  private assetFor(kind: string): string {
    return ({ drip: "drip", settle: "knock", gust: "amb-wind", resonance: "sing-a", clink: "glass-clink" } as Record<string, string>)[kind] ?? kind;
  }

  /** a distant call (or two): pitched down 2-6 semitones onto a chord tone, deep in the far hall (an octave down would sound like the audio slowing) */
  whale(t: number, answer = true) {
    const a = this.bank.get("whale");
    if (!a || !a.def.slices?.length) return;
    const keys = a.def.slices.map((_, i) => "whale:" + i);
    const i = this.picker.choose("whale", keys);
    const sl = a.def.slices[i];
    const base = sl.hz ?? a.def.baseHz ?? 160;
    const pcs = this.chord?.pcs ?? [2, 5, 9];
    // try every shift in 2..6, keep the ones that land within 35 cents of a chord tone, pick one
    const m0 = ftom(base);
    const cands: number[] = [];
    for (let s = 2; s <= 6; s++) {
      const target = nearestPc(pcs, m0 - s);
      if (Math.abs(target - (m0 - s)) <= 0.5) cands.push(target - m0);
    }
    const shift = cands.length ? cands[Math.floor(this.rnd() * cands.length)] : -(2 + Math.floor(this.rnd() * 5));
    const rate = this.picker.rate("whale", keys[i], Math.pow(2, shift / 12));
    const pan = (this.rnd() * 2 - 1) * 0.7;
    const v = play(this.ctx, this.spotOut.bus, a, {
      at: t,
      slice: i,
      rate,
      gain: 0.15 + 0.05 * this.rnd(),
      pan,
      lp: 520 + 260 * this.rnd(),
      hp: 45,
      dry: 0.35,
      send: 0.25,
      far: 1.1,
      attack: 0.8,
      release: 1.6,
    });
    this.picker.played("whale", keys[i], t, v.end, rate);
    if (answer && this.rnd() < 0.4) {
      const t2 = t + 2.5 + 3 * this.rnd();
      const j = this.picker.choose("whale", keys);
      const sl2 = a.def.slices[j];
      const m2 = ftom(sl2.hz ?? base);
      const target = nearestPc(pcs, m2 - (2 + Math.floor(this.rnd() * 4)));
      const r2 = this.picker.rate("whale", keys[j], Math.pow(2, (target - m2) / 12));
      const v2 = play(this.ctx, this.spotOut.bus, a, {
        at: t2,
        slice: j,
        rate: r2,
        gain: 0.13,
        pan: -pan * 0.8,
        lp: 450 + 200 * this.rnd(),
        hp: 45,
        dry: 0.25,
        send: 0.2,
        far: 1.2,
        attack: 1.0,
        release: 1.8,
      });
      this.picker.played("whale", keys[j], t2, v2.end, r2);
    }
  }
}
