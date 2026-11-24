/**
 * Context foley: what the cursor is touching, up close and real.
 *
 *   text       a very soft paper touch on entering a new block of text; a soft pencil stroke while text
 *              is being selected
 *   controls   a chess piece of crystal: a light
 *              tap with a short ring on hover, tuned to a tone of the bed's chord by where the control sits
 *              (left low, right high); set down more firmly on press, with a lower glass under it. A
 *              wooden piece and a longer-ringing crystal are available as alternatives (pieceStyle; ?piece= on
 *              the site)
 *   the queen  the singing-glass recording, held while the cursor rests on her and pitched to a tone of
 *              the bed's chord by the cursor's height (her foot low, her crown high), with a quieter
 *              second glass a chord tone below; a soft glass rub as the cursor arrives on her; a struck
 *              glass and a soft knock when she is pressed
 *   the board  a pawn's wooden click when the cursor crosses into a new square (squares are 1.1 world
 *              units), louder for brisker moves but spaced out as the cursor speeds up, and a
 *              little water under it (the board carries a thin film of water); on fast sweeps the
 *              occasional soft felt slide; out on the fields beyond the board, fainter and further away
 *   the water  moving through the film: a real water recording (the gurgling brook) that swells with the
 *              cursor's speed, small bubbles rising as it goes (synthesised: a sine chirping upward as a
 *              bubble does), and a splash where it presses
 *   air        soft swooshes on scroll flings, scaled by velocity; a deep swoosh when a fling carries the
 *              camera to a new section
 *
 * Every sound is a recording from the bank: round-robin slices, pitch / level / filter jitter, cooldowns
 * and voice limits, so a hundred hovers never sound like one sample a hundred times. Each method returns
 * false when its samples are not loaded yet (the engine then uses its synthesized fallback, if any).
 */
import { ladder, mtof, mulberry32 } from "./theory";
import type { Chord } from "./bed";
import { play, rateFor, span, type Asset, type Bus, type Picker, type SampleBank } from "./samples";

type ACtx = BaseAudioContext;

const SQUARE = 1.1;
const BOARD_HALF = 11;

interface Lane {
  src: AudioBufferSourceNode;
  gain: GainNode;
  rate: number;
}

/** a held, looping glass voice that changes note by crossfading between two lanes (no glide) */
class SingVoice {
  private lanes: Lane[] = [];
  private cur = 0;
  private note = -1;
  private lastSwitch = -1;

  constructor(ctx: ACtx, a: Asset, dest: AudioNode, startRate: number, offset: number) {
    const [ls, le] = a.def.loop ?? [0, a.def.dur];
    for (let i = 0; i < 2; i++) {
      const src = ctx.createBufferSource();
      src.buffer = a.buf;
      src.loop = true;
      src.loopStart = ls + a.shift;
      src.loopEnd = le + a.shift;
      src.playbackRate.value = startRate;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(gain);
      gain.connect(dest);
      src.start(ctx.currentTime, ls + a.shift + ((offset + i * 0.37) % 1) * (le - ls) * 0.9);
      this.lanes.push({ src, gain, rate: startRate });
    }
  }

  /** move to `note` (rate `rate`); true if it switched */
  set(note: number, rate: number, at: number, minGap = 0.45): boolean {
    if (note === this.note) return false;
    if (this.note >= 0 && at - this.lastSwitch < minGap) return false;
    const first = this.note < 0;
    this.note = note;
    this.lastSwitch = at;
    const prev = this.lanes[this.cur];
    if (!first) this.cur = 1 - this.cur;
    const next = this.lanes[this.cur];
    next.src.playbackRate.setValueAtTime(rate, at);
    next.rate = rate;
    next.gain.gain.cancelScheduledValues(at);
    next.gain.gain.setTargetAtTime(1, at, 0.11);
    if (!first) {
      prev.gain.gain.cancelScheduledValues(at);
      prev.gain.gain.setTargetAtTime(0, at, 0.11);
    }
    return true;
  }
}

export type PieceStyle = "crystal" | "ring" | "wood";

export class Foley {
  /** what the chess pieces are made of */
  pieceStyle: PieceStyle = "crystal";
  private ctx: ACtx;
  private bus: Bus;
  private bank: SampleBank;
  private pk: Picker;
  private rnd: () => number;

  private high: number[] = [57, 62, 65, 69];
  private all: number[] = [45, 50, 53, 57, 62, 65, 69];

  // the queen
  private qGain: GainNode;
  private qPan: StereoPannerNode;
  private qLp: BiquadFilterNode;
  private main: SingVoice | null = null;
  private under: SingVoice | null = null;
  private underGain: GainNode;
  private qAmt = 0;
  private qInside = false;
  private lastRub = -10;

  // the board
  private bLast: { x: number; z: number; t: number; sx: number; sz: number } | null = null;
  private bSpeed = 0;
  private lastTick = -10;
  private lastSlide = -10;

  // the water
  private wSrc: AudioBufferSourceNode | null = null;
  private wGain: GainNode | null = null;
  private wLp: BiquadFilterNode | null = null;
  private wPan: StereoPannerNode | null = null;
  private lastBubble = -10;
  private wetOut: GainNode | null = null;
  private wLast = { s: -1, pan: 0 };

  // scroll
  private sArmed = true;
  private sLast = -10;
  private deepLast = -10;
  private sStage = -1;

  constructor(ctx: ACtx, bus: Bus, bank: SampleBank, picker: Picker, seed = 0xf0e1) {
    this.ctx = ctx;
    this.bus = bus;
    this.bank = bank;
    this.pk = picker;
    this.rnd = mulberry32(seed);

    this.qLp = ctx.createBiquadFilter();
    this.qLp.type = "lowpass";
    this.qLp.frequency.value = 1700;
    this.qLp.Q.value = 0.4;
    this.qGain = ctx.createGain();
    this.qGain.gain.value = 0;
    this.qPan = ctx.createStereoPanner();
    this.underGain = ctx.createGain();
    this.underGain.gain.value = 0.42;
    this.underGain.connect(this.qLp);
    this.qLp.connect(this.qGain);
    this.qGain.connect(this.qPan);
    this.qPan.connect(bus.input);
    const send = ctx.createGain();
    send.gain.value = 0.5;
    this.qPan.connect(send);
    send.connect(bus.verbIn);
  }

  setChord(c: Chord) {
    const h = ladder(c.pcs, 57, 71);
    if (h.length) this.high = h;
    const l = ladder(c.pcs, 45, 71);
    if (l.length) this.all = l;
  }

  get hasSing(): boolean {
    return this.bank.has("sing-a");
  }

  // ------------------------------------------------------------ helpers

  private sliced(role: string, name: string, at: number, maxVoices: number): { a: Asset; i: number; key: string } | null {
    const a = this.bank.get(name);
    if (!a || !a.def.slices?.length) return null;
    if (!this.pk.room(role, at, maxVoices)) return null;
    const keys = a.def.slices.map((_, i) => name + ":" + i);
    const i = this.pk.choose(role, keys);
    return { a, i, key: keys[i] };
  }

  private j(a: number, b: number) {
    return a + (b - a) * this.rnd();
  }

  // ------------------------------------------------------------ text

  /**
   * The cursor's glass lens arriving on a new block of text: the ring of a wine glass without its strike (the
   * recording entered just past the attack and faded in), on a tone of the bed's chord, quiet and wet with the hall.
   */
  textTouch(pan: number, at = this.ctx.currentTime): boolean {
    const a = this.bank.get("glass-ding");
    if (!a?.def.slices?.length) return false;
    if (!this.pk.ready("text", at, 0.22)) return true;
    if (!this.pk.room("text", at, 3)) return true;
    const keys = a.def.slices.map((_, i) => "glass-ding:" + i);
    const i = this.pk.choose("text", keys);
    const sp = span(a, i);
    const note = this.toneAt(pan, 2) + 12;
    const rate = this.pk.rate("text", keys[i], rateFor(a.def.slices[i].hz ?? sp.hz ?? 600, note, 0.42, 0.95));
    const dur = Math.max(0.2, Math.min(sp.e - sp.s - 0.07, 0.75));
    const v = play(this.ctx, this.bus, a, {
      at,
      slice: i,
      offset: 0.07,
      dur,
      rate,
      gain: this.j(0.045, 0.06),
      pan: pan * 0.7,
      lp: 5200,
      hp: 420,
      send: 0.62,
      attack: 0.07,
      release: Math.min(0.5, dur * 0.6),
    });
    this.pk.played("text", keys[i], at, v.end, rate);
    return true;
  }

  /** text is being selected: amount 0..1 is how much the selection grew since the last stroke */
  textSelect(amount: number, pan: number, at = this.ctx.currentTime): boolean {
    if (!this.bank.has("pencil")) return false;
    if (!this.pk.ready("pencil", at, 0.13)) return true;
    const c = this.sliced("pencil", "pencil", at, 2);
    if (!c) return true;
    const amt = Math.max(0, Math.min(1, amount));
    const sp = span(c.a, c.i);
    const len = Math.min(sp.e - sp.s, 0.12 + 0.24 * amt);
    const off = Math.max(0, (sp.e - sp.s - len) * this.rnd());
    const rate = this.pk.rate("pencil", c.key, this.j(0.88, 1.03));
    const v = play(this.ctx, this.bus, c.a, {
      at,
      slice: c.i,
      offset: off,
      dur: len,
      rate,
      gain: 0.18 + 0.2 * amt,
      pan: pan * 0.6,
      lp: this.j(3400, 4400),
      hp: 300,
      send: 0.1,
      swell: true,
    });
    this.pk.played("pencil", c.key, at, v.end, rate);
    return true;
  }

  // ------------------------------------------------------------ crystal

  /** the chord tone for a place on screen (pan -1..1): left low, right high */
  private toneAt(pan: number, shift = 0): number {
    const h = this.high;
    const i = Math.max(0, Math.min(h.length - 1, Math.round(((pan + 1) / 2) * (h.length - 1)) + shift));
    return h[i];
  }

  /**
   * A struck crystal on MIDI `note` (one of the wine-glass strikes, pitched down onto it so it is never
   * shrill), ringing for about `ring` seconds of material, low-passed and wet with the hall.
   */
  private crystal(role: string, at: number, note: number, gain: number, pan: number, ring: number, send = 0.34, lp = 3600): boolean {
    const a = this.bank.get("glass-ding");
    if (!a?.def.slices?.length) return false;
    if (!this.pk.room(role, at, 4)) return true;
    const keys = a.def.slices.map((_, i) => "glass-ding:" + i);
    const i = this.pk.choose(role, keys);
    const sp = span(a, i);
    const rate = this.pk.rate(role, keys[i], rateFor(a.def.slices[i].hz ?? sp.hz ?? 600, note, 0.42, 0.95));
    const dur = Math.min(sp.e - sp.s, ring);
    const v = play(this.ctx, this.bus, a, {
      at,
      slice: i,
      rate,
      gain,
      pan,
      lp,
      hp: 240,
      send,
      dur,
      attack: 0.002,
      release: Math.min(0.6, dur * 0.45),
    });
    this.pk.played(role, keys[i], at, v.end, rate);
    return true;
  }

  // ------------------------------------------------------------ controls

  uiHover(pan: number, at = this.ctx.currentTime): boolean {
    if (this.pieceStyle !== "wood" && this.bank.has("glass-ding")) {
      if (!this.pk.ready("hover", at, 0.07)) return true;
      const ring = this.pieceStyle === "ring" ? 1.9 : 0.75;
      return this.crystal("hover", at, this.toneAt(pan) + 12, this.j(0.11, 0.14), pan * 0.8, ring, this.pieceStyle === "ring" ? 0.42 : 0.3);
    }
    if (!this.bank.has("chess")) return false;
    if (!this.pk.ready("hover", at, 0.065)) return true;
    const c = this.sliced("hover", "chess", at, 3);
    if (!c) return true;
    const rate = this.pk.rate("hover", c.key, this.j(0.98, 1.12));
    const v = play(this.ctx, this.bus, c.a, {
      at,
      slice: c.i,
      rate,
      gain: this.j(0.052, 0.07),
      pan: pan * 0.8,
      lp: this.j(3200, 4300),
      hp: 140,
      send: 0.12,
      release: 0.05,
    });
    this.pk.played("hover", c.key, at, v.end, rate);
    return true;
  }

  uiPress(pan: number, at = this.ctx.currentTime): boolean {
    if (this.pieceStyle !== "wood" && this.bank.has("glass-ding")) {
      if (!this.pk.ready("press", at, 0.06)) return true;
      const ring = this.pieceStyle === "ring" ? 2.2 : 1.1;
      const note = this.toneAt(pan, 1) + 12;
      this.crystal("press", at, note, this.j(0.17, 0.2), pan * 0.8, ring, 0.4);
      // set down on glass: a lower crystal a fifth or more under it, and the faintest knock for weight
      const below = [...this.all].reverse().find((m) => m <= note - 19 && m >= note - 26) ?? note - 24;
      this.crystal("press-low", at + 0.012, below, 0.09, pan * 0.6, ring * 0.8, 0.45, 2400);
      const k = this.sliced("press-knock", "knock", at, 2);
      if (k) {
        const r = this.pk.rate("press-knock", k.key, this.j(0.9, 1.05));
        const kv = play(this.ctx, this.bus, k.a, { at: at + 0.004, slice: k.i, rate: r, gain: 0.03, pan: pan * 0.6, lp: 1600, hp: 120, send: 0.15 });
        this.pk.played("press-knock", k.key, at + 0.004, kv.end, r);
      }
      return true;
    }
    if (!this.bank.has("chess")) return false;
    if (!this.pk.ready("press", at, 0.06)) return true;
    const c = this.sliced("press", "chess", at, 3);
    if (!c) return true;
    const rate = this.pk.rate("press", c.key, this.j(0.86, 0.98));
    const v = play(this.ctx, this.bus, c.a, {
      at,
      slice: c.i,
      rate,
      gain: this.j(0.09, 0.11),
      pan: pan * 0.8,
      lp: this.j(3600, 4600),
      hp: 90,
      send: 0.18,
    });
    this.pk.played("press", c.key, at, v.end, rate);
    // the board under the piece: a low wooden knock, a hair later
    const k = this.sliced("press-knock", "knock", at, 2);
    if (k) {
      const r = this.pk.rate("press-knock", k.key, this.j(0.72, 0.84));
      const kv = play(this.ctx, this.bus, k.a, { at: at + 0.006, slice: k.i, rate: r, gain: 0.07, pan: pan * 0.6, lp: 1500, hp: 70, send: 0.15 });
      this.pk.played("press-knock", k.key, at + 0.006, kv.end, r);
    }
    return true;
  }

  // ------------------------------------------------------------ the queen

  private buildSing(): boolean {
    if (this.main) return true;
    const a = this.bank.get("sing-a");
    if (!a) return false;
    const b = this.bank.get("sing-b") ?? a;
    this.main = new SingVoice(this.ctx, a, this.qLp, 0.4, this.rnd());
    this.under = new SingVoice(this.ctx, b, this.underGain, 0.4, this.rnd());
    return true;
  }

  /** the cursor on the glass queen: amt 0..1, height 0..1 up her body, pan -1..1 */
  queen(amt: number, heightFrac: number, pan: number, at = this.ctx.currentTime): boolean {
    if (!this.buildSing()) return false;
    const a = Math.max(0, Math.min(1, amt));
    const h = Math.max(0, Math.min(1, heightFrac));
    const note = this.high[Math.min(this.high.length - 1, Math.round(h * (this.high.length - 1)))];
    const sa = this.bank.get("sing-a")!;
    const sb = this.bank.get("sing-b") ?? sa;
    this.main!.set(note, rateFor(sa.def.baseHz ?? 790, note, 0.25, 0.7), at);
    // the glass below: the chord tone a third to a sixth under the main note
    const below = [...this.all].reverse().find((m) => m <= note - 3 && m >= note - 9) ?? note - 12;
    this.under!.set(below, rateFor(sb.def.baseHz ?? 693, below, 0.15, 0.75), at, 0.9);
    this.qGain.gain.setTargetAtTime(0.8 * a * a, at, a > this.qAmt ? 0.18 : 0.3);
    this.qPan.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan * 0.8)), at, 0.15);
    // arriving on her: a soft rub on the rim
    if (!this.qInside && a > 0.3) {
      this.qInside = true;
      if (at - this.lastRub > 1.2) {
        this.lastRub = at;
        this.rub(note, pan, at);
      }
    } else if (this.qInside && a < 0.12) this.qInside = false;
    this.qAmt = a;
    return true;
  }

  private rub(note: number, pan: number, at: number) {
    const r = this.bank.get("rub");
    if (!r) return;
    const rate = this.pk.rate("rub", "rub", rateFor(r.def.baseHz ?? 730, note + 12, 0.45, 0.9));
    const v = play(this.ctx, this.bus, r, {
      at,
      rate,
      gain: this.j(0.15, 0.19),
      pan: pan * 0.7,
      lp: 2000,
      hp: 200,
      send: 0.45,
      attack: 0.09,
      release: 0.8,
      dur: 2.2,
    });
    this.pk.played("rub", "rub", at, v.end, rate);
  }

  /** she was pressed: a struck glass at the touch note, a soft knock under it */
  queenPress(heightFrac: number, pan: number, at = this.ctx.currentTime): boolean {
    const a = this.bank.get("glass-ding");
    if (!a?.def.slices?.length) return false;
    const h = Math.max(0, Math.min(1, heightFrac));
    const note = this.high[Math.min(this.high.length - 1, Math.round(h * (this.high.length - 1)))];
    if (!this.pk.ready("queen-press", at, 0.15)) return true;
    const keys = a.def.slices.map((_, i) => "glass-ding:" + i);
    const i = this.pk.choose("glass", keys);
    const rate = this.pk.rate("glass", keys[i], rateFor(a.def.slices[i].hz ?? 600, note + 12, 0.36, 0.95));
    const v = play(this.ctx, this.bus, a, { at, slice: i, rate, gain: 0.48, pan: pan * 0.7, lp: 2800, hp: 160, send: 0.5 });
    this.pk.played("glass", keys[i], at, v.end, rate);
    const t = this.bank.get("thud");
    if (t) {
      const r = this.pk.rate("thud", "thud", this.j(1.05, 1.25));
      const tv = play(this.ctx, this.bus, t, { at, rate: r, gain: 0.16, pan: pan * 0.4, lp: 600, hp: 40, send: 0.2, dur: 0.9 });
      this.pk.played("thud", "thud", at, tv.end, r);
    }
    return true;
  }

  // ------------------------------------------------------------ the board

  /**
   * The cursor's lamp on the ground: world x, z and how lit it is (0..1). Call every pointer tick while
   * the cursor is over the open world (not over the queen: she takes priority).
   */
  board(x: number, z: number, lit: number, at = this.ctx.currentTime): boolean {
    if (!this.bank.has("chess")) return false;
    if (lit < 0.4) {
      this.bLast = null;
      this.bSpeed = 0;
      this.water(0, 0, at);
      return true;
    }
    const sx = Math.floor(x / SQUARE);
    const sz = Math.floor(z / SQUARE);
    const last = this.bLast;
    this.bLast = { x, z, t: at, sx, sz };
    if (!last) return true;
    const dt = Math.max(0.005, at - last.t);
    const inst = Math.hypot(x - last.x, z - last.z) / dt;
    this.bSpeed = this.bSpeed * 0.55 + inst * 0.45;
    const onWater = Math.max(Math.abs(x), Math.abs(z)) < BOARD_HALF - 0.3;
    this.water(onWater ? Math.min(1, this.bSpeed / 14) : 0, Math.max(-0.85, Math.min(0.85, x / 14)), at);
    if (sx === last.sx && sz === last.sz) return true;

    const off = Math.max(0, Math.max(Math.abs(x), Math.abs(z)) - BOARD_HALF); // beyond the board's edge
    if (off > 34) return true;
    const s = Math.min(1, this.bSpeed / 14);
    const near = 1 / (1 + off / 5);
    const pan = Math.max(-0.85, Math.min(0.85, x / 14));
    if (at - this.lastTick >= 0.075 + 0.12 * s && this.pieceStyle !== "wood" && this.bank.has("glass-ding")) {
      // a crystal piece moved across the glass board: each square rings on a tone of the chord (its
      // file and rank pick the tone), quieter and further off out on the fields, with water under it
      this.lastTick = at;
      const h = this.high;
      const note = h[(((sx + sz) % h.length) + h.length) % h.length] + 12;
      const ring = this.pieceStyle === "ring" ? 1.6 : 0.6;
      this.crystal("tick", at, note, (0.07 + 0.08 * s) * near * this.j(0.8, 1.05), pan, ring, 0.3 + 0.3 * (1 - near), (2600 + 1200 * s) * (0.6 + 0.4 * near));
      if (off === 0 && this.rnd() < 0.6) this.wet(at + this.j(0.008, 0.022), (0.025 + 0.035 * s) * this.j(0.8, 1.1), pan, this.j(1.0, 1.3));
    } else if (at - this.lastTick >= 0.075 + 0.12 * s && this.pieceStyle === "wood") {
      const knock = this.rnd() < 0.3 && this.bank.has("knock");
      const role = "tick";
      const c = this.sliced(role, knock ? "knock" : "chess", at, 4);
      if (c) {
        this.lastTick = at;
        const rate = this.pk.rate(role, c.key, this.j(0.92, 1.12) * (knock ? 0.9 : 1));
        const v = play(this.ctx, this.bus, c.a, {
          at,
          slice: c.i,
          rate,
          gain: (0.048 + 0.078 * s) * near * this.j(0.8, 1.05),
          pan,
          lp: (1800 + 1600 * s) * (0.55 + 0.45 * near),
          hp: 120,
          send: 0.12 + 0.3 * (1 - near),
          far: off > 0 ? 0.3 * (1 - near) : 0,
          release: 0.05,
        });
        this.pk.played(role, c.key, at, v.end, rate);
        // the pawn is set down in the film of water: a small wet touch under the click
        if (off === 0 && this.rnd() < 0.7) this.wet(at + this.j(0.008, 0.022), (0.03 + 0.04 * s) * this.j(0.8, 1.1), pan, this.j(1.0, 1.3));
      }
    }
    // a brisk sweep: now and then a felt piece slides
    if (this.bSpeed > 20 && at - this.lastSlide > 0.9 && this.rnd() < 0.35 && this.bank.has("slide")) {
      const sl = this.bank.get("slide")!;
      this.lastSlide = at;
      const n = Math.min(1, (this.bSpeed - 20) / 30);
      const rate = this.pk.rate("slide", "slide", this.j(0.88, 1.08));
      const sp = span(sl);
      const v = play(this.ctx, this.bus, sl, {
        at,
        rate,
        gain: (0.07 + 0.06 * n) * near,
        pan,
        lp: 2600,
        hp: 90,
        send: 0.2,
        swell: true,
        dur: Math.min(sp.e - sp.s, 0.5 + 0.6 * this.rnd()),
        offset: 0.05 * this.rnd(),
      });
      this.pk.played("slide", "slide", at, v.end, rate);
    }
    return true;
  }

  /** a press on the open board: a soft wooden knock, and a splash in the film of water */
  boardPress(x: number, at = this.ctx.currentTime): boolean {
    if (!this.pk.ready("board-press", at, 0.12)) return true;
    const c = this.sliced("board-press", "knock", at, 2);
    if (!c) return false;
    const pan = Math.max(-0.8, Math.min(0.8, x / 14));
    const rate = this.pk.rate("board-press", c.key, this.j(0.8, 0.95));
    const v = play(this.ctx, this.bus, c.a, { at, slice: c.i, rate, gain: this.pieceStyle === "wood" ? 0.12 : 0.05, pan, lp: 2000, hp: 80, send: 0.25 });
    this.pk.played("board-press", c.key, at, v.end, rate);
    if (this.pieceStyle !== "wood") this.crystal("board-press-c", at + 0.004, this.toneAt(pan, -1) + 12, 0.15, pan, this.pieceStyle === "ring" ? 2.2 : 1.2, 0.42);
    this.wet(at + 0.01, 0.13, pan, this.j(0.72, 0.86));
    for (let i = 0; i < 3; i++) this.bubble(at + 0.05 + 0.09 * i + 0.05 * this.rnd(), pan, 0.6 + 0.4 * this.rnd());
    return true;
  }

  // ------------------------------------------------------------ the water

  /** a drop of water: a drip recording, small and close */
  private wet(at: number, gain: number, pan: number, rate: number) {
    const c = this.sliced("wet", "drip", at, 3);
    if (!c) return;
    const r = this.pk.rate("wet", c.key, rate);
    const v = play(this.ctx, this.bus, c.a, { at, slice: c.i, rate: r, gain, pan, lp: this.j(2600, 3600), hp: 260, send: 0.2, release: 0.08 });
    this.pk.played("wet", c.key, at, v.end, r);
  }

  /** a small bubble rising: a sine whose pitch climbs a little as it nears the surface, gone in ~0.1 s */
  private bubble(at: number, pan: number, size: number) {
    const ctx = this.ctx;
    const f0 = 2300 - 1500 * size + 200 * this.rnd();
    const dur = 0.05 + 0.07 * size;
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(f0, at);
    o.frequency.exponentialRampToValueAtTime(f0 * (1.18 + 0.25 * this.rnd()), at + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime((0.012 + 0.016 * size) * this.j(0.7, 1.1), at + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    o.connect(g);
    g.connect(p);
    p.connect(this.wetBus());
    o.start(at);
    o.stop(at + dur + 0.02);
  }

  private wetBus(): AudioNode {
    if (!this.wetOut) {
      this.wetOut = this.ctx.createGain();
      this.wetOut.gain.value = 1;
      const lp = this.ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 4200;
      this.wetOut.connect(lp);
      lp.connect(this.bus.input);
      const s = this.ctx.createGain();
      s.gain.value = 0.18;
      lp.connect(s);
      s.connect(this.bus.verbIn);
    }
    return this.wetOut;
  }

  /**
   * Moving through the film: the gurgling brook recording, looped from a random place, swelling with
   * speed (0..1). Called with 0 when the cursor leaves the water.
   */
  private water(speed: number, pan: number, at: number) {
    const a = this.bank.get("amb-brook-a");
    if (!a) return;
    if (!this.wSrc) {
      if (speed <= 0) return;
      const ctx = this.ctx;
      const src = ctx.createBufferSource();
      src.buffer = a.buf;
      src.loop = true;
      const [ls, le] = a.def.loop ?? [0.3, a.def.dur - 0.3];
      src.loopStart = ls + a.shift;
      src.loopEnd = le + a.shift;
      src.playbackRate.value = 1.25;
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 320;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 1600;
      const g = ctx.createGain();
      g.gain.value = 0;
      const p = ctx.createStereoPanner();
      src.connect(hp);
      hp.connect(lp);
      lp.connect(g);
      g.connect(p);
      p.connect(this.wetBus());
      src.start(at, ls + a.shift + (le - ls) * this.rnd());
      this.wSrc = src;
      this.wGain = g;
      this.wLp = lp;
      this.wPan = p;
    }
    const s = Math.max(0, Math.min(1, speed));
    // quiet: a hand through a film of water, not a river. Only re-aim when something really changed, and
    // clear what was aimed before, so a long session never piles up thousands of automation events
    if (Math.abs(s - this.wLast.s) > 0.02 || Math.abs(pan - this.wLast.pan) > 0.05 || (s === 0) !== (this.wLast.s === 0)) {
      this.wLast = { s, pan };
      const aim = (p: AudioParam, v: number, tc: number) => {
        p.cancelScheduledValues(at);
        p.setTargetAtTime(v, at, tc);
      };
      aim(this.wGain!.gain, 0.16 * Math.pow(s, 0.8), s > 0.02 ? 0.06 : 0.25);
      aim(this.wLp!.frequency, 1100 + 2200 * s, 0.1);
      aim(this.wSrc.playbackRate, 1.15 + 0.3 * s, 0.2);
      aim(this.wPan!.pan, pan, 0.1);
    }
    // bubbles rise behind a moving cursor, more the faster it goes
    if (s > 0.08 && at - this.lastBubble > 0.06 + 0.3 * (1 - s) && this.rnd() < 0.55) {
      this.lastBubble = at;
      this.bubble(at + 0.01 * this.rnd(), pan + 0.1 * (this.rnd() - 0.5), 0.15 + 0.5 * this.rnd());
    }
  }

  // ------------------------------------------------------------ air

  /** scroll velocity (px/s, signed) and the camera's stage (scene.stage, continuous); call every tick */
  scroll(v: number, stageF: number, at = this.ctx.currentTime): boolean {
    if (!this.bank.has("whoosh")) return false;
    const stage = Math.round(stageF); // the section the camera is heading for
    const a = Math.abs(v);
    const stageMoved = this.sStage >= 0 && stage !== this.sStage;
    this.sStage = stage;
    if (this.sArmed && a > 650 && at - this.sLast > 0.7) {
      this.sArmed = false;
      this.sLast = at;
      const n = Math.min(1, (a - 450) / 3200);
      const c = this.sliced("whoosh", "whoosh", at, 2);
      if (c) {
        const rate = this.pk.rate("whoosh", c.key, this.j(0.98, 1.06) - 0.2 * n);
        const wv = play(this.ctx, this.bus, c.a, {
          at,
          slice: c.i,
          rate,
          gain: 0.09 + 0.2 * n,
          pan: Math.sign(v) * 0.25,
          lp: 1300 + 2000 * n,
          hp: 90,
          send: 0.3,
          attack: 0.04,
          release: 0.2,
        });
        this.pk.played("whoosh", c.key, at, wv.end, rate);
      }
    }
    if (a < 260) this.sArmed = true;
    // a fling that carries the camera to a new section: the deep swoosh, far and soft
    if (stageMoved && a > 900 && at - this.deepLast > 2.5 && this.bank.has("swoosh-deep")) {
      this.deepLast = at;
      const d = this.bank.get("swoosh-deep")!;
      const n = Math.min(1, (a - 900) / 3000);
      const rate = this.pk.rate("swoosh", "swoosh-deep", this.j(0.9, 1.05));
      const dv = play(this.ctx, this.bus, d, { at, rate, gain: 0.16 + 0.14 * n, pan: 0, lp: 1400, hp: 35, send: 0.35, attack: 0.08, release: 0.5 });
      this.pk.played("swoosh", "swoosh-deep", at, dv.end, rate);
    }
    return true;
  }

  /** for the harness: the singing glass's current main frequency */
  queenHz(): number {
    return mtof(this.high[0]);
  }
}
