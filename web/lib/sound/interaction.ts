/**
 * The interaction layer — the sound of touching the world. This is what makes the page feel alive
 * under the cursor.
 *
 *   air      a wind/air swell that follows pointer speed and scroll velocity, panned by pointer x
 *   queen    a low singing-glass resonance while the cursor is on the glass queen; its note is the
 *            bed's chord tone nearest the cursor's height on her body (D3..E4), so it always agrees
 *            with the harmony and never climbs past the alto register
 *   press    a soft gel thunk + a decaying glass ring when she is pressed
 *   uiTick   a very soft low tick when the cursor crosses a button, link or card
 *
 * The persistent voices (air, queen) are built once and driven by parameter setters — no per-frame
 * allocation. Pure Web Audio. Deterministic offline (the harness drives the same setters).
 */
import { mtof, ladder, mulberry32, type Key } from "./theory";
import type { Chord } from "./bed";

type ACtx = BaseAudioContext;

export interface Bus {
  input: GainNode;
  verbIn: GainNode;
}

function brownBuffer(ctx: ACtx, seconds: number): AudioBuffer {
  const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < d.length; i++) {
    const w = Math.random() * 2 - 1;
    last = (last + 0.02 * w) / 1.02;
    d[i] = last * 3.2;
  }
  return buf;
}

export class Interaction {
  private ctx: ACtx;
  private bus: Bus;
  private key: Key;
  private rnd = mulberry32(0x7a9);
  private tones: number[] = [50, 53, 57, 62];
  private low: number[] = [45, 50, 53, 57];

  // air swell
  private airGain: GainNode;
  private airLp: BiquadFilterNode;
  private airPan: StereoPannerNode;

  // queen singing-glass resonance
  private queenGain: GainNode;
  private queenOsc: OscillatorNode[] = [];
  private queenPan: StereoPannerNode;
  private queenFilter: BiquadFilterNode;

  private airMult = 1;

  constructor(ctx: ACtx, bus: Bus, key: Key) {
    this.ctx = ctx;
    this.bus = bus;
    this.key = key;

    // --- air swell: looping brown noise, band-limited, pans and opens with motion ---
    const src = ctx.createBufferSource();
    src.buffer = brownBuffer(ctx, 3.1);
    src.loop = true;
    this.airLp = ctx.createBiquadFilter();
    this.airLp.type = "bandpass";
    this.airLp.frequency.value = 500;
    this.airLp.Q.value = 0.7;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 180;
    this.airGain = ctx.createGain();
    this.airGain.gain.value = 0.0001;
    this.airPan = ctx.createStereoPanner();
    src.connect(this.airLp);
    this.airLp.connect(hp);
    hp.connect(this.airGain);
    this.airGain.connect(this.airPan);
    this.airPan.connect(bus.input);
    const airSend = ctx.createGain();
    airSend.gain.value = 0.25;
    this.airPan.connect(airSend);
    airSend.connect(bus.verbIn);
    src.start();

    // --- queen singing glass: bowed partials through a high-Q band-pass, with a slow vibrato ---
    this.queenGain = ctx.createGain();
    this.queenGain.gain.value = 0.0001;
    this.queenFilter = ctx.createBiquadFilter();
    this.queenFilter.type = "bandpass";
    this.queenFilter.frequency.value = 400;
    this.queenFilter.Q.value = 3;
    this.queenPan = ctx.createStereoPanner();
    this.queenFilter.connect(this.queenGain);
    this.queenGain.connect(this.queenPan);
    this.queenPan.connect(bus.input);
    const qSend = ctx.createGain();
    qSend.gain.value = 0.45;
    this.queenPan.connect(qSend);
    qSend.connect(bus.verbIn);
    for (let i = 0; i < 3; i++) {
      const o = ctx.createOscillator();
      o.type = i === 0 ? "sine" : "triangle";
      const g = ctx.createGain();
      g.gain.value = [0.6, 0.16, 0.08][i];
      o.connect(g);
      g.connect(this.queenFilter);
      this.queenOsc.push(o);
    }
    // slow vibrato on the whole glass voice
    const vib = ctx.createOscillator();
    vib.frequency.value = 4.5;
    const vibG = ctx.createGain();
    vibG.gain.value = 3;
    vib.connect(vibG);
    this.queenOsc.forEach((o) => vibG.connect(o.detune));
    vib.start();

    this.applyQueenPitch(mtof(this.note(0.4)), ctx.currentTime);
  }

  start() {
    const t = this.ctx.currentTime;
    for (const o of this.queenOsc) o.start(t);
  }

  setKey(key: Key) {
    this.key = key;
  }

  /** scale the pointer-air swell (softer once the context foley is carrying the cursor) */
  setAirLevel(m: number) {
    this.airMult = Math.max(0, m);
  }

  /** the bed moved to a new chord: the glass and the ticks follow it */
  setChord(c: Chord) {
    const t = ladder(c.pcs, 50, 64);
    if (t.length) this.tones = t;
    const l = ladder(c.pcs, 43, 57);
    if (l.length) this.low = l;
  }

  private note(heightFrac: number): number {
    const h = Math.max(0, Math.min(1, heightFrac));
    return this.tones[Math.min(this.tones.length - 1, Math.round(h * (this.tones.length - 1)))];
  }

  /** pointer speed (0..1) and scroll velocity (0..1) open the air swell; pan follows pointer x (-1..1). */
  setAir(speed: number, pan: number, scroll: number) {
    const ctx = this.ctx;
    const s = Math.max(0, Math.min(1, speed));
    const sc = Math.max(0, Math.min(1, scroll));
    const level = 0.0001 + (0.045 * s + 0.06 * sc) * this.airMult;
    this.airGain.gain.setTargetAtTime(level, ctx.currentTime, 0.1);
    this.airLp.frequency.setTargetAtTime(340 + 520 * s + 380 * sc, ctx.currentTime, 0.12);
    this.airPan.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)), ctx.currentTime, 0.12);
  }

  /** cursor on the queen: amt (0..1) is loudness, heightFrac (0..1) sets the pitch, pan follows x. */
  setQueen(amt: number, heightFrac: number, pan: number) {
    const ctx = this.ctx;
    const a = Math.max(0, Math.min(1, amt));
    this.queenGain.gain.setTargetAtTime(0.0001 + 0.065 * a, ctx.currentTime, 0.12);
    const f = mtof(this.note(heightFrac));
    this.applyQueenPitch(f, ctx.currentTime, 0.14);
    this.queenPan.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)), ctx.currentTime, 0.12);
  }

  private applyQueenPitch(f: number, at: number, tc = 0.05) {
    this.queenFilter.frequency.setTargetAtTime(f * 1.25, at, tc);
    if (this.queenOsc[0]) this.queenOsc[0].frequency.setTargetAtTime(f, at, tc);
    if (this.queenOsc[1]) this.queenOsc[1].frequency.setTargetAtTime(f * 1.5, at, tc); // a fifth, quiet
    if (this.queenOsc[2]) this.queenOsc[2].frequency.setTargetAtTime(f * 0.5, at, tc); // an octave under
  }

  /** pressing the queen: a soft gel thunk plus a decaying glass ring at the touch pitch. */
  press(heightFrac: number, pan: number, at = this.ctx.currentTime) {
    const ctx = this.ctx;
    const p = Math.max(-1, Math.min(1, pan));
    const pn = ctx.createStereoPanner();
    pn.pan.value = p;
    pn.connect(this.bus.input);
    const send = ctx.createGain();
    send.gain.value = 0.4;
    pn.connect(send);
    send.connect(this.bus.verbIn);

    // gel thunk — a low sine dropping fast, soft
    const thunk = ctx.createOscillator();
    thunk.type = "sine";
    thunk.frequency.setValueAtTime(150, at);
    thunk.frequency.exponentialRampToValueAtTime(60, at + 0.12);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.0001, at);
    tg.gain.exponentialRampToValueAtTime(0.22, at + 0.006);
    tg.gain.exponentialRampToValueAtTime(0.0001, at + 0.22);
    thunk.connect(tg);
    tg.connect(pn);
    thunk.start(at);
    thunk.stop(at + 0.3);

    // glass ring — a resonant tone at the touch pitch, decaying
    const f = mtof(this.note(heightFrac));
    const o = ctx.createOscillator();
    o.type = "triangle";
    o.frequency.value = f;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = f * 1.5;
    bp.Q.value = 6;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 1100;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.09, at + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 1.4);
    o.connect(g);
    g.connect(bp);
    bp.connect(lp);
    lp.connect(pn);
    o.start(at);
    o.stop(at + 1.6);
  }

  /** a very soft low tick when the cursor crosses an interactive element. */
  uiTick(pan: number, at = this.ctx.currentTime) {
    const ctx = this.ctx;
    // a soft wooden tap on a low chord tone, never the same twice in a row
    const f = mtof(this.low[Math.floor(this.rnd() * this.low.length)]) * 2;
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(f, at);
    o.frequency.exponentialRampToValueAtTime(f * 0.74, at + 0.05);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.022 + this.rnd() * 0.012, at + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.06);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 1200;
    const pn = ctx.createStereoPanner();
    pn.pan.value = Math.max(-1, Math.min(1, pan));
    o.connect(g);
    g.connect(lp);
    lp.connect(pn);
    pn.connect(this.bus.input);
    o.start(at);
    o.stop(at + 0.1);
  }
}
