/**
 * The hall: a ConvolverNode fed by a procedurally generated stereo impulse response.
 *
 * The atmosphere asks for a vast, empty, echoing hall that is always present and never oppressive. A
 * recorded church IR would bring its own colour and cost megabytes; this one is computed in a few
 * milliseconds from a seeded noise generator, so it is free to ship and identical offline and live:
 *
 *   - a short pre-delay (the far wall), then a dozen sparse early reflections, so the space has a size;
 *   - a diffuse tail of decorrelated noise per channel (wide), decaying exponentially (RT60 ~5.5 s);
 *   - frequency-dependent decay: a 12 dB/oct low-pass inside the tail closes from ~4 kHz to ~250 Hz
 *     over the first second, so the highs die quickly and the long tail is dark and soft (stone and
 *     air, not tin): RT60 ~6 s below 300 Hz, ~2 s above 3 kHz;
 *   - a gentle high-pass so the tail never builds low rumble, and a faded end.
 *
 * The IR is energy-normalised by hand (normalize = false) so its gain is the same in every browser.
 * The convolver takes a mono sum (a hall has one source position per sound; the stereo comes from the
 * two decorrelated tails), so a sound panned hard left still fills the whole room.
 */
import { mulberry32 } from "./theory";

type ACtx = BaseAudioContext;

export interface SpaceOpts {
  seconds?: number;
  preDelay?: number;
  rt60?: number;
  /** tail low-pass at the start / end of the decay (Hz) */
  bright?: number;
  dark?: number;
  /** how fast the tail darkens (s) */
  darken?: number;
  seed?: number;
}

export function makeImpulse(ctx: ACtx, o: SpaceOpts = {}): AudioBuffer {
  const sr = ctx.sampleRate;
  const seconds = o.seconds ?? 6;
  const pre = Math.floor((o.preDelay ?? 0.032) * sr);
  const rt60 = o.rt60 ?? 5.5;
  const bright = o.bright ?? 4200;
  const dark = o.dark ?? 240;
  const darken = o.darken ?? 0.55;
  const n = Math.floor(seconds * sr);
  const ir = ctx.createBuffer(2, n, sr);
  const rnd = mulberry32(o.seed ?? 0x5ace);
  const hpA = Math.exp((-2 * Math.PI * 70) / sr);

  let energy = 0;
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    // early reflections: sparse, decaying, different per side
    for (let k = 0; k < 13; k++) {
      const tt = 0.006 + 0.11 * Math.pow(rnd(), 1.4);
      const i = pre + Math.floor(tt * sr);
      if (i < n) d[i] += (rnd() < 0.5 ? -1 : 1) * 0.55 * (1 - k / 15) * Math.exp(-tt / 0.18);
    }
    // the diffuse tail
    let lp = 0;
    let lp2 = 0;
    let a = 0;
    let hpX = 0;
    let hpY = 0;
    const fadeStart = Math.floor(n * 0.86);
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / sr;
      if (((i - pre) & 63) === 0) {
        const fc = dark + (bright - dark) * Math.exp(-t / darken);
        a = 1 - Math.exp((-2 * Math.PI * fc) / sr);
      }
      // two one-pole low-passes (12 dB/oct): the highs die fast, the lows ring on
      lp += a * (rnd() * 2 - 1 - lp);
      lp2 += a * (lp - lp2);
      // half-compensate the level the narrowing low-pass removes, so the dark tail stays long
      const comp = Math.pow((2 - a) / a, 0.5);
      const env = Math.pow(10, (-3 * t) / rt60) * (t < 0.07 ? 0.5 - 0.5 * Math.cos((Math.PI * t) / 0.07) : 1);
      let v = lp2 * comp * env * 0.35;
      if (i > fadeStart) v *= 0.5 + 0.5 * Math.cos((Math.PI * (i - fadeStart)) / (n - fadeStart));
      // one-pole high-pass (no rumble build-up)
      hpY = hpA * (hpY + v - hpX);
      hpX = v;
      d[i] += hpY;
    }
    for (let i = 0; i < n; i++) energy += d[i] * d[i];
  }
  // unit energy per channel: a steady input comes out of the hall at about its own level
  const k = 1 / Math.sqrt(energy / 2 || 1);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    for (let i = 0; i < n; i++) d[i] *= k;
  }
  return ir;
}

export interface Space {
  /** near send: straight into the hall */
  input: GainNode;
  /** far send: darker and a little later, for the giants and distant bells */
  far: GainNode;
  /** the wet output */
  out: GainNode;
  setWet(w: number): void;
}

/** null when the context has no ConvolverNode (the offline shim): the caller keeps the Freeverb. */
export function createSpace(ctx: ACtx, o: SpaceOpts = {}): Space | null {
  if (typeof (ctx as { createConvolver?: unknown }).createConvolver !== "function") return null;
  const conv = ctx.createConvolver();
  conv.normalize = false;
  try {
    conv.channelCount = 1;
    conv.channelCountMode = "explicit";
  } catch {
    /* some implementations only allow 2: a stereo input is fine too */
  }
  conv.buffer = makeImpulse(ctx, o);

  const input = ctx.createGain();
  const far = ctx.createGain();
  const farLp = ctx.createBiquadFilter();
  farLp.type = "lowpass";
  farLp.frequency.value = 1100;
  farLp.Q.value = 0.5;
  const farDelay = ctx.createDelay(0.5);
  farDelay.delayTime.value = 0.045;
  far.connect(farLp);
  farLp.connect(farDelay);
  farDelay.connect(conv);
  input.connect(conv);

  const out = ctx.createGain();
  out.gain.value = 0.5;
  conv.connect(out);
  return {
    input,
    far,
    out,
    setWet(w: number) {
      out.gain.setTargetAtTime(Math.max(0, Math.min(1.2, w)), ctx.currentTime, 0.6);
    },
  };
}
