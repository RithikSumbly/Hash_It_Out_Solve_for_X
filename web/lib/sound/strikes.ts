/**
 * Chain events played with recordings, on the conductor's notes.
 *
 *   refusal     a struck glass pitched to the conductor's melody note (an octave up, where glass lives),
 *               quieter glasses on the stacked notes below it, a small clink on the colour tone for a
 *               clever attack, an ink splat, and a soft low thud (full on the first hit of a burst,
 *               faint inside one): a short pulse of tension that settles
 *   drain       glugs from a bottle, more and lower for a bigger share; dust amounts are a single drip
 *   epoch       a distant gong (pitched to the key's tonic) or a clock's bell chord, far in the hall
 *   policy      the crystal bowl, pitched to the new key's tonic
 *   child       a faint wind chime on a chord tone
 *   died        the gong, low and muffled
 *   deposit     a soft water splash (the brooks also swell, in Field)
 *
 * Glass and bells are only ever pitched DOWN (rates < 1): darker and larger, never shrill. Every method
 * returns false when its samples are not loaded, and the engine falls back to the synthesized voices.
 */
import { mulberry32, type Key } from "./theory";
import type { Chord } from "./bed";
import type { DrainPlan, RefusalPlan } from "./conductor";
import { belowPc, ftom, play, rateFor, type Bus, type Picker, type SampleBank } from "./samples";

type ACtx = BaseAudioContext;

interface GlassChoice {
  name: string;
  slice: number;
  key: string;
  rate: number;
}

export class Strikes {
  private ctx: ACtx;
  private bus: Bus;
  private bank: SampleBank;
  private pk: Picker;
  private rnd: () => number;

  constructor(ctx: ACtx, bus: Bus, bank: SampleBank, picker: Picker, seed = 0x57a1) {
    this.ctx = ctx;
    this.bus = bus;
    this.bank = bank;
    this.pk = picker;
    this.rnd = mulberry32(seed);
  }

  private j(a: number, b: number) {
    return a + (b - a) * this.rnd();
  }

  /** a glass slice that can sound `note` within [lo, hi) rate, chosen round-robin */
  private glass(note: number, names: string[], lo = 0.36, hi = 1.0): GlassChoice | null {
    const opts: GlassChoice[] = [];
    for (const name of names) {
      const a = this.bank.get(name);
      if (!a?.def.slices) continue;
      a.def.slices.forEach((sl, i) => {
        if (!sl.hz) return;
        const r = Math.pow(2, (note - ftom(sl.hz)) / 12);
        if (r >= lo && r < hi) opts.push({ name, slice: i, key: name + ":" + i, rate: r });
      });
    }
    if (!opts.length) {
      // nothing fits exactly: fold the note into the first glass's range
      const a = this.bank.get(names[0]);
      const sl = a?.def.slices?.[0];
      if (!a || !sl?.hz) return null;
      return { name: names[0], slice: 0, key: names[0] + ":0", rate: rateFor(sl.hz, note, lo, hi) };
    }
    const i = this.pk.choose("glass", opts.map((o) => o.key));
    return opts[i];
  }

  refusal(p: RefusalPlan): boolean {
    if (!this.bank.has("glass-ding")) return false;
    const t = p.t;
    // the melody note and the stack below it, struck an octave up (glass register), strummed
    p.notes.forEach((m, k) => {
      if (k > 2) return;
      const g = this.glass(m + 12, ["glass-ding", "glass-clink"]);
      if (!g || !this.pk.room("glass", t, 7)) return;
      const a = this.bank.get(g.name)!;
      const at = t + k * this.j(0.02, 0.034);
      const rate = this.pk.rate("glass", g.key, g.rate);
      const v = play(this.ctx, this.bus, a, {
        at,
        slice: g.slice,
        rate,
        gain: (0.44 / (1 + k * 0.7)) * p.level * this.j(0.9, 1.05),
        pan: p.pan * (k ? 0.6 : 0.85),
        lp: Math.min(4200, 2600 * p.bright),
        hp: 150,
        send: 0.42,
        far: 0.08,
        dur: 1.1 + 0.9 * p.decay,
        release: 0.45,
      });
      this.pk.played("glass", g.key, at, v.end, rate);
    });
    if (p.colour !== null) {
      const g = this.glass(p.colour + 12, ["glass-clink", "glass-ding"], 0.4, 1.0);
      if (g && this.pk.room("glass", t, 8)) {
        const a = this.bank.get(g.name)!;
        const at = t + 0.05 + 0.02 * this.rnd();
        const rate = this.pk.rate("glass", g.key, g.rate);
        const v = play(this.ctx, this.bus, a, { at, slice: g.slice, rate, gain: 0.12 * p.level, pan: -p.pan * 0.5, lp: 3200, hp: 300, send: 0.5, dur: 0.9, release: 0.35 });
        this.pk.played("glass", g.key, at, v.end, rate);
      }
    }
    // the ink lands
    const ink = this.bank.get("ink");
    if (ink?.def.slices?.length && this.pk.room("ink", t, 3)) {
      const keys = ink.def.slices.map((_, i) => "ink:" + i);
      const i = this.pk.choose("ink", keys);
      const at = t + this.j(0.003, 0.018);
      const rate = this.pk.rate("ink", keys[i], this.j(0.68, 0.92));
      const v = play(this.ctx, this.bus, ink, {
        at,
        slice: i,
        rate,
        gain: this.j(0.23, 0.3) * p.level * (p.body !== null ? 1 : 0.75),
        pan: p.pan,
        lp: this.j(1500, 2600),
        hp: 70,
        send: 0.2,
      });
      this.pk.played("ink", keys[i], at, v.end, rate);
    }
    // the queen's "no": a soft low thud, full on the head of a burst, faint inside it
    const thud = this.bank.get("thud");
    if (thud && this.pk.room("thud", t, 2)) {
      const head = p.body !== null;
      const rate = this.pk.rate("thud", "thud", this.j(0.86, 1.02));
      const v = play(this.ctx, this.bus, thud, {
        at: t,
        rate,
        gain: (head ? 0.5 : 0.17) * p.level,
        pan: p.pan * 0.3,
        lp: head ? 750 : 500,
        hp: 34,
        send: 0.22,
        dur: head ? 1.6 : 0.8,
        release: 0.5,
      });
      this.pk.played("thud", "thud", t, v.end, rate);
    }
    return true;
  }

  drain(p: DrainPlan): boolean {
    if (p.drip) {
      const a = this.bank.get("drip");
      if (!a?.def.slices?.length) return false;
      if (!this.pk.room("drip", p.t, 3)) return true;
      const keys = a.def.slices.map((_, i) => "drip:" + i);
      const i = this.pk.choose("drip", keys);
      const rate = this.pk.rate("drip", keys[i], this.j(0.82, 1.08));
      const v = play(this.ctx, this.bus, a, { at: p.t, slice: i, rate, gain: 0.26 * p.level, pan: p.pan, lp: 2800, hp: 160, send: 0.45 });
      this.pk.played("drip", keys[i], p.t, v.end, rate);
      return true;
    }
    const a = this.bank.get("glug");
    if (!a?.def.slices?.length) return false;
    const s = Math.max(0.02, Math.min(1.2, p.share));
    const n = 1 + Math.min(3, Math.floor(s * 5));
    const keys = a.def.slices.map((_, i) => "glug:" + i);
    let at = p.t;
    let r0 = this.j(0.92, 1.02) - 0.14 * Math.min(1, s);
    for (let k = 0; k < n; k++) {
      if (!this.pk.room("glug", at, 4)) break;
      const i = this.pk.choose("glug", keys);
      const rate = this.pk.rate("glug", keys[i], r0);
      const v = play(this.ctx, this.bus, a, {
        at,
        slice: i,
        rate,
        gain: (0.3 + 0.12 * Math.min(1, s)) * p.level * (1 - k * 0.12),
        pan: p.pan,
        lp: this.j(1900, 2900),
        hp: 80,
        send: 0.32,
      });
      this.pk.played("glug", keys[i], at, v.end, rate);
      at += this.j(0.13, 0.22);
      r0 *= this.j(0.92, 0.97); // the bottle empties: each glug a little lower
    }
    if (s > 0.35) {
      const th = this.bank.get("thud");
      if (th && this.pk.room("thud", p.t, 2)) {
        const rate = this.pk.rate("thud", "thud", this.j(0.76, 0.86));
        const v = play(this.ctx, this.bus, th, { at: p.t, rate, gain: 0.22 * p.level, pan: p.pan * 0.3, lp: 520, hp: 34, send: 0.2, dur: 1.2, release: 0.5 });
        this.pk.played("thud", "thud", p.t, v.end, rate);
      }
    }
    return true;
  }

  /** the epoch closes: a distant gong on the tonic, or a clock's bell chord, alternately */
  epoch(key: Key, chord: Chord, n: number, t: number): boolean {
    const useGong = n % 2 === 0 ? this.bank.has("gong") : !this.bank.has("chime");
    const a = this.bank.get(useGong ? "gong" : "chime");
    if (!a) return false;
    const base = a.def.baseHz ?? (useGong ? 110 : 260);
    const target = belowPc(useGong ? [key.pc] : chord.pcs.slice(0, 3), ftom(base));
    const name = useGong ? "gong" : "chime";
    const rate = this.pk.rate(name, name, Math.pow(2, (target - ftom(base)) / 12));
    const v = play(this.ctx, this.bus, a, {
      at: t,
      rate,
      gain: useGong ? 0.34 : 0.24,
      pan: (this.rnd() * 2 - 1) * 0.3,
      lp: useGong ? 1500 : 2600,
      hp: 40,
      dry: useGong ? 0.55 : 0.7,
      send: 0.3,
      far: useGong ? 0.9 : 0.45,
      attack: 0.006,
      release: 2.5,
    });
    this.pk.played(name, name, t, v.end, rate);
    return true;
  }

  /** a new champion: the crystal bowl on the new key's tonic (quieter when the same one is re-crowned) */
  policy(key: Key, changed: boolean, t: number): boolean {
    const a = this.bank.get("bowl");
    if (!a) return false;
    const base = a.def.baseHz ?? 316;
    const target = belowPc([key.pc], ftom(base));
    const rate = this.pk.rate("bowl", "bowl", Math.pow(2, (target - ftom(base)) / 12));
    const v = play(this.ctx, this.bus, a, {
      at: t,
      rate,
      gain: changed ? 0.3 : 0.17,
      pan: (this.rnd() * 2 - 1) * 0.2,
      lp: 2400,
      hp: 90,
      send: 0.55,
      far: 0.2,
      release: 3,
    });
    this.pk.played("bowl", "bowl", t, v.end, rate);
    return true;
  }

  /** a candidate was born: a faint wind chime on a chord tone */
  child(chord: Chord, pan: number, t: number): boolean {
    const a = this.bank.get("windchime");
    if (!a) return false;
    if (!this.pk.ready("child", t, 1.5)) return true;
    const base = a.def.baseHz ?? 586;
    const target = belowPc(chord.pcs, ftom(base) - 2 - 6 * this.rnd());
    const rate = this.pk.rate("child", "windchime", rateFor(base, target, 0.55, 1.0));
    const v = play(this.ctx, this.bus, a, { at: t, rate, gain: 0.09, pan: pan * 0.8, lp: 3000, hp: 250, send: 0.6, far: 0.3, release: 1.5, dur: 3.5 });
    this.pk.played("child", "windchime", t, v.end, rate);
    return true;
  }

  /** a policy died: the gong, low and muffled, far off */
  died(chord: Chord, t: number): boolean {
    const a = this.bank.get("gong");
    if (!a) return false;
    const base = a.def.baseHz ?? 110;
    const target = belowPc([chord.pcs[0]], ftom(base) - 5);
    const rate = this.pk.rate("gong", "gong", rateFor(base, target, 0.5, 0.85));
    const v = play(this.ctx, this.bus, a, { at: t, rate, gain: 0.22, pan: 0, lp: 520, hp: 35, dry: 0.4, send: 0.2, far: 1, release: 3, dur: 8 });
    this.pk.played("gong", "gong", t, v.end, rate);
    return true;
  }

  /** the vault was refilled: a soft splash of water */
  deposit(t: number): boolean {
    const a = this.bank.get("ink");
    if (!a?.def.slices?.length) return false;
    const i = a.def.slices.length > 1 ? 1 : 0;
    const rate = this.pk.rate("ink", "ink:" + i, this.j(0.6, 0.7));
    const v = play(this.ctx, this.bus, a, { at: t, slice: i, rate, gain: 0.16, pan: (this.rnd() * 2 - 1) * 0.3, lp: 1700, hp: 70, send: 0.45 });
    this.pk.played("ink", "ink:" + i, t, v.end, rate);
    return true;
  }
}
