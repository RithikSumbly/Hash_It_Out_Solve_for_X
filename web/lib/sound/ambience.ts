/**
 * The world bed — the Looking-Glass country at night. Layers that never loop audibly, built the way
 * games build environments:
 *
 *   wind     two wide brown-noise layers, low-passed, wandering slowly, with occasional gusts that
 *            swell and fall at random (3–6 s, every 9–26 s); opens a little with scroll motion
 *   water    the brooks dividing the fields — band-passed noise whose level and colour follow a
 *            random walk (a burble, not a tremolo), one brook each side
 *   trickles little clusters of 2–5 drips at random, panned to a brook
 *   giants   the giant pieces far off in the fog — very low, very muffled tolls on the bed's bass,
 *            drenched in reverb, every 16–42 s
 *   dust     a faint air layer
 *
 * The noise buffers are 7–12 s (a shorter loop is heard as a rhythm), shared between layers at unrelated
 * playback rates, and every fast movement is a seeded random walk rather than an LFO (which is heard as a machine).
 *
 * Pure Web Audio, no per-frame allocation; deterministic offline through pump(now).
 */
import { mtof, mulberry32, type Key } from "./theory";
import type { Chord } from "./bed";

type ACtx = BaseAudioContext;

export interface Bus {
  input: GainNode;
  verbIn: GainNode;
}

function lfo(ctx: ACtx, freq: number, depth: number, target: AudioParam) {
  const o = ctx.createOscillator();
  o.frequency.value = freq;
  const g = ctx.createGain();
  g.gain.value = depth;
  o.connect(g);
  g.connect(target);
  o.start();
  return o;
}

export class Ambience {
  private ctx: ACtx;
  private bus: Bus;
  private rnd: () => number;
  private brown: AudioBuffer;
  private white: AudioBuffer;

  private windGain: GainNode;
  private windLp: BiquadFilterNode[] = [];
  private waterGain: GainNode;
  private brook: { g: GainNode; bp: BiquadFilterNode; f: number }[] = [];

  private vault = 1;
  private pressure = 0;
  private motion = 0;
  private bass = 38;
  private sampled = false;
  private dustGain: GainNode;
  private on = true;

  private nextGiant = 6;
  private nextTrickle = 2.5;
  private nextGust = 7;
  private nextBurble = 0;

  constructor(ctx: ACtx, bus: Bus, _key: Key, seed = 0x51eed) {
    this.ctx = ctx;
    this.bus = bus;
    this.rnd = mulberry32(seed);

    // shared noise: long enough that a loop is never heard as a rhythm
    this.brown = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 11.7), ctx.sampleRate);
    {
      const d = this.brown.getChannelData(0);
      let last = 0;
      for (let i = 0; i < d.length; i++) {
        last = (last + 0.02 * (this.rnd() * 2 - 1)) / 1.02;
        d[i] = last * 3.2;
      }
    }
    this.white = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 7.3), ctx.sampleRate);
    {
      const d = this.white.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = this.rnd() * 2 - 1;
    }

    // --- night wind ---
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0.04;
    this.windGain.connect(bus.input);
    this.windGain.connect(bus.verbIn);
    [-0.7, 0.7].forEach((pan, i) => {
      const src = this.source(this.brown, 0.83 + i * 0.29);
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 300;
      lp.Q.value = 0.5;
      const g = ctx.createGain();
      g.gain.value = 0.7;
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      src.connect(lp);
      lp.connect(g);
      g.connect(p);
      p.connect(this.windGain);
      lfo(ctx, 0.019 + i * 0.0137, 110, lp.frequency); // very slow, incommensurate drift
      lfo(ctx, 0.013 + i * 0.0171, 0.25, g.gain);
      this.windLp.push(lp);
    });

    // --- water brooks ---
    this.waterGain = ctx.createGain();
    this.waterGain.gain.value = 0.026;
    this.waterGain.connect(bus.input);
    this.waterGain.connect(bus.verbIn);
    [-0.85, 0.85].forEach((pan, i) => {
      const src = this.source(this.white, 0.91 + i * 0.13);
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 520 + i * 120;
      bp.Q.value = 3;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 1300;
      const g = ctx.createGain();
      g.gain.value = 0.5;
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      src.connect(bp);
      bp.connect(lp);
      lp.connect(g);
      g.connect(p);
      p.connect(this.waterGain);
      this.brook.push({ g, bp, f: 520 + i * 120 });
    });

    // --- dust ---
    const dustSrc = this.source(this.brown, 1.37);
    const dustBp = ctx.createBiquadFilter();
    dustBp.type = "bandpass";
    dustBp.frequency.value = 650;
    dustBp.Q.value = 0.8;
    const dustG = ctx.createGain();
    dustG.gain.value = 0.01;
    this.dustGain = ctx.createGain();
    dustSrc.connect(dustBp);
    dustBp.connect(dustG);
    dustG.connect(this.dustGain);
    this.dustGain.connect(bus.input);
    lfo(ctx, 0.031, 0.006, dustG.gain);
  }

  private source(buf: AudioBuffer, rate: number): AudioBufferSourceNode {
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.playbackRate.value = rate;
    src.start();
    return src;
  }

  setVault(frac: number) {
    this.vault = Math.max(0, Math.min(1.25, frac));
  }
  setPressure(p: number) {
    this.pressure = Math.max(0, Math.min(1, p));
  }
  setMix(motion: number) {
    this.motion = Math.max(0, Math.min(1, motion));
  }
  /** the recorded world is playing: the synthesized wind, water and dust fade out (the giants stay, softer) */
  setSampled(on: boolean) {
    this.sampled = on;
  }
  /** layer switch for the offline harness */
  setOn(on: boolean) {
    this.on = on;
  }
  setKey(_key: Key, _at?: number) {
    // the world follows the bed's chord (setChord), not the key directly
  }
  setChord(c: Chord) {
    this.bass = c.bass;
  }

  /** Apply the slow mix targets and fire the randomised one-shots up to `now`. */
  pump(now: number) {
    const synth = this.sampled || !this.on ? 0 : 1;
    this.windGain.gain.setTargetAtTime((0.034 + 0.026 * this.motion + 0.012 * this.pressure) * synth, now, synth ? 0.6 : 2);
    this.waterGain.gain.setTargetAtTime(0.026 * synth, now, synth ? 0.6 : 2);
    this.dustGain.gain.setTargetAtTime(synth, now, synth ? 0.6 : 2);

    // the brooks burble: a random walk on each brook's level and colour, a new step every ~0.1–0.3 s
    while (this.nextBurble <= now + 0.3) {
      const t = Math.max(this.nextBurble, now);
      for (const b of this.brook) {
        b.g.gain.setTargetAtTime(0.25 + this.rnd() * 0.5, t, 0.08 + this.rnd() * 0.1);
        b.bp.frequency.setTargetAtTime(b.f * (0.8 + this.rnd() * 0.45), t, 0.15);
      }
      this.nextBurble = t + 0.1 + this.rnd() * 0.2;
    }

    while (this.nextGust <= now + 0.3) {
      this.gust(Math.max(this.nextGust, now));
      this.nextGust += 9 + this.rnd() * 17;
    }
    while (this.nextGiant <= now + 0.3) {
      if (this.on) this.giant(Math.max(this.nextGiant, now));
      this.nextGiant += 16 + this.rnd() * 26;
    }
    while (this.nextTrickle <= now + 0.3) {
      const t = Math.max(this.nextTrickle, now);
      const n = 2 + Math.floor(this.rnd() * 4);
      const pan = this.rnd() < 0.5 ? -0.8 : 0.8;
      let at = t;
      for (let i = 0; i < n && synth; i++) {
        this.trickle(at, pan);
        at += 0.06 + this.rnd() * 0.16;
      }
      this.nextTrickle = t + 3 + this.rnd() * 6;
    }
  }

  private gust(t: number) {
    const rise = 2 + this.rnd() * 2;
    const fall = 2.5 + this.rnd() * 3;
    for (const lp of this.windLp) {
      lp.frequency.setTargetAtTime(380 + this.rnd() * 220, t, rise / 3);
      lp.frequency.setTargetAtTime(300, t + rise, fall / 3);
    }
  }

  private giant(t: number) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = "sine";
    const m = this.bass - 12;
    o.frequency.setValueAtTime(mtof(m), t);
    o.frequency.exponentialRampToValueAtTime(mtof(m - 0.6), t + 5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(this.sampled ? 0.045 : 0.08, t + 2.2);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 6.5);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 150;
    const p = ctx.createStereoPanner();
    p.pan.value = this.rnd() * 1.4 - 0.7;
    o.connect(g);
    g.connect(lp);
    lp.connect(p);
    p.connect(this.bus.input);
    const send = ctx.createGain();
    send.gain.value = 0.85;
    p.connect(send);
    send.connect(this.bus.verbIn);
    o.start(t);
    o.stop(t + 7);
  }

  private trickle(t: number, pan: number) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.white;
    src.playbackRate.value = 0.8 + this.rnd() * 0.4;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    const f0 = 480 + this.rnd() * 380;
    bp.frequency.setValueAtTime(f0, t);
    bp.frequency.linearRampToValueAtTime(f0 * (0.75 + this.rnd() * 0.15), t + 0.14);
    bp.Q.value = 7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.012 + this.rnd() * 0.014, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    const p = ctx.createStereoPanner();
    p.pan.value = pan + (this.rnd() * 2 - 1) * 0.15;
    src.connect(bp);
    bp.connect(g);
    g.connect(p);
    p.connect(this.bus.input);
    const send = ctx.createGain();
    send.gain.value = 0.3;
    p.connect(send);
    send.connect(this.bus.verbIn);
    src.start(t);
    src.stop(t + 0.2);
  }
}
