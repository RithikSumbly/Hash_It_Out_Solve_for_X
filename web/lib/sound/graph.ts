/**
 * Master signal chain and the hall — pure Web Audio nodes only.
 *
 * master.input  — everything dry goes here
 * master.verbIn — voices that want space also send here (the hall)
 * master.farIn  — distant things (the giants, far bells) send here: darker and later in the same hall
 *
 * The hall is a ConvolverNode with a procedurally generated stereo impulse response (space.ts) wherever
 * the context has one; the offline shim has none, so there the Freeverb-style network below stands in.
 *
 * After the sum: a 28 Hz high-pass (no sub rumble from pitched-down samples), a gentle high-shelf cut and
 * a soft 12 kHz low-pass so long listening never tires the ear, then a safety limiter (a fast
 * DynamicsCompressor set above where the mix normally peaks, so it only catches accidents and never
 * pumps) and a transparent ceiling that is linear below -2.5 dBFS and can never pass -1 dBFS.
 */
import { createSpace } from "./space";

// Minimal structural types so this file carries no DOM value imports (safe for Node type-stripping).
type ACtx = BaseAudioContext;

export interface Master {
  input: GainNode;
  /** reverb send: connect a voice here (post its own gain) to place it in the room. */
  verbIn: GainNode;
  /** far send: the same hall, heard from further away */
  farIn: GainNode;
  /** final output gain, just before the destination (already limited). */
  out: GainNode;
  /** true when the hall is the convolver (not the fallback network) */
  convolver: boolean;
  setRoom(wet: number, time: number): void;
}

/** Linear up to `knee`, then a tanh shoulder into `ceil`: transparent in normal use, a hard stop for accidents. */
function ceilingCurve(knee = 0.75, ceil = 0.89): Float32Array<ArrayBuffer> {
  const n = 4096;
  const c = new Float32Array(new ArrayBuffer(n * 4));
  const room = ceil - knee;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    const y = a <= knee ? a : knee + room * Math.tanh((a - knee) / room);
    c[i] = Math.sign(x) * y;
  }
  return c;
}

// Freeverb tunings (samples @ 44.1 kHz) -> seconds, scaled by sampleRate at build time.
const COMB = [1116, 1277, 1491, 1617];
const ALLPASS = [556, 341];
const STEREO_SPREAD = 23;

function makeReverb(ctx: ACtx, verbIn: GainNode, dest: AudioNode) {
  const sr = 44100;
  const wet = ctx.createGain();
  wet.gain.value = 0.22;

  const damp = { a: 0.22 }; // one-pole damping coefficient inside each comb
  let feedback = 0.84;

  const dampNodes: BiquadFilterNode[] = [];
  const fbNodes: GainNode[] = [];

  // a Schroeder comb filter: input + (lowpass(output) * feedback) -> delay -> output
  const comb = (delaySamples: number, pan: number) => {
    const d = ctx.createDelay(1.0);
    d.delayTime.value = delaySamples / sr;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 3200 + (1 - damp.a) * 4000;
    const fb = ctx.createGain();
    fb.gain.value = feedback;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    verbIn.connect(d);
    d.connect(lp);
    lp.connect(fb);
    fb.connect(d); // feedback loop, through the delay
    d.connect(p);
    p.connect(wet);
    dampNodes.push(lp);
    fbNodes.push(fb);
  };
  COMB.forEach((n, i) => {
    comb(n, -0.6 + (i / (COMB.length - 1)) * 1.2);
    comb(n + STEREO_SPREAD, 0.6 - (i / (COMB.length - 1)) * 1.2);
  });

  // two series Schroeder allpass diffusers on the summed wet bus
  let node: AudioNode = wet;
  for (const len of ALLPASS) {
    const g = 0.5;
    const d = ctx.createDelay(1.0);
    d.delayTime.value = len / sr;
    const din = ctx.createGain(); // x + g*bufout -> delay
    const fbg = ctx.createGain();
    fbg.gain.value = g;
    const xneg = ctx.createGain();
    xneg.gain.value = -g;
    const out = ctx.createGain();
    node.connect(din);
    din.connect(d);
    d.connect(fbg);
    fbg.connect(din);
    node.connect(xneg);
    xneg.connect(out);
    d.connect(out);
    node = out;
  }
  node.connect(dest);

  return {
    setRoom(w: number, time: number) {
      wet.gain.setTargetAtTime(Math.max(0, Math.min(0.5, w)), ctx.currentTime, 0.5);
      feedback = Math.max(0.6, Math.min(0.92, time));
      for (const fb of fbNodes) fb.gain.setTargetAtTime(feedback, ctx.currentTime, 0.5);
    },
  };
}

export function createMaster(ctx: ACtx, destination: AudioNode): Master {
  const input = ctx.createGain();
  input.gain.value = 1;
  const verbIn = ctx.createGain();
  verbIn.gain.value = 1;
  const farIn = ctx.createGain();
  farIn.gain.value = 1;
  const sum = ctx.createGain();
  input.connect(sum);

  const space = createSpace(ctx, { seconds: 6, preDelay: 0.032, rt60: 5.6 });
  let setRoom: (wet: number, time: number) => void;
  if (space) {
    verbIn.connect(space.input);
    farIn.connect(space.far);
    space.out.connect(sum);
    setRoom = (wet: number) => space.setWet(wet * 3);
    space.setWet(0.24 * 3);
  } else {
    const fallback = makeReverb(ctx, verbIn, sum);
    const farLp = ctx.createBiquadFilter();
    farLp.type = "lowpass";
    farLp.frequency.value = 1100;
    farIn.connect(farLp);
    farLp.connect(verbIn);
    setRoom = fallback.setRoom;
  }

  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 28;
  hp.Q.value = 0.6;

  // warmth: a gentle high-shelf cut and a soft top, so nothing is piercing over a long listen
  const tilt = ctx.createBiquadFilter();
  tilt.type = "highshelf";
  tilt.frequency.value = 3600;
  tilt.gain.value = -4.5;
  const top = ctx.createBiquadFilter();
  top.type = "lowpass";
  top.frequency.value = 12000;
  top.Q.value = 0.5;

  // safety limiter: above where the mix normally peaks (events land near -6 dBFS), so it rarely acts
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -5;
  comp.knee.value = 2;
  comp.ratio.value = 20;
  comp.attack.value = 0.002;
  comp.release.value = 0.35;

  const shaper = ctx.createWaveShaper();
  shaper.curve = ceilingCurve();
  shaper.oversample = "4x";

  // the compressor adds a fixed makeup gain (+2.3 dB at these settings, in every browser engine);
  // undo it so the chain is unity below the threshold
  const out = ctx.createGain();
  out.gain.value = 0.77;

  sum.connect(hp);
  hp.connect(tilt);
  tilt.connect(top);
  top.connect(comp);
  comp.connect(shaper);
  shaper.connect(out);
  out.connect(destination);

  return { input, verbIn, farIn, out, convolver: !!space, setRoom };
}
