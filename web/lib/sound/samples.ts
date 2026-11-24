/**
 * The sample bank: the recordings in public/sound, decoded once, played as one-shots or grains.
 *
 * Nothing here is fetched until the engine is asked to load (the first un-mute), so a muted page costs
 * nothing. The bank reads manifest.json (written by tools/sound/process.py): every asset has a
 * role, a duration, and either slices (a sprite of one-shots with silent gaps), a loop region, or a whole
 * file; tonal ones carry baseHz so they can be pitched onto the bed's chord.
 *
 * MP3 decoders differ on the encoder delay: most trim it (gapless), some leave ~25 ms of silence at the
 * start. The bank compares the decoded length with the manifest's and shifts every slice by the delay
 * when it was left in, so slice starts stay on the attack in every browser.
 *
 * Anti-repetition lives here too: a round-robin picker that never plays the same slice twice running
 * (and avoids the one before that when the pool allows), pitch jitter that never lands on the previous
 * rate, per-role voice limits and cooldowns, and a trace the offline harness checks.
 */
type ACtx = BaseAudioContext;

export interface Slice {
  /** start / end in seconds within the file */
  s: number;
  e: number;
  /** residual loudness correction (linear) */
  g?: number;
  /** fundamental, for tonal slices */
  hz?: number;
}

export interface AssetDef {
  name: string;
  file: string;
  role: string;
  channels: number;
  dur: number;
  sr: number;
  gain: number;
  baseHz?: number | null;
  loop?: [number, number];
  slices?: Slice[];
}

export interface Manifest {
  version: number;
  assets: AssetDef[];
}

/** fetches a path relative to the sound folder ("manifest.json", "glug.mp3") */
export type Loader = (path: string) => Promise<ArrayBuffer>;

export interface Asset {
  def: AssetDef;
  buf: AudioBuffer;
  /** seconds to add to every manifest time (the encoder delay, when a decoder leaves it in) */
  shift: number;
}

export interface Bus {
  input: AudioNode;
  verbIn: AudioNode;
  farIn: AudioNode;
}

/** the order assets are fetched in: the world first, then the things the cursor touches, then the rest */
const PRIORITY = ["ambience", "chess", "paper", "glass", "ink", "thud", "knock", "sing", "rub", "whoosh", "glug", "drip"];

export class SampleBank {
  private ctx: ACtx;
  private assets = new Map<string, Asset>();
  private loading: Promise<void> | null = null;
  manifest: Manifest | null = null;
  /** asset names that failed to load (the engine falls back to synthesis for them) */
  readonly failed: string[] = [];

  constructor(ctx: ACtx) {
    this.ctx = ctx;
  }

  get(name: string): Asset | undefined {
    return this.assets.get(name);
  }

  has(name: string): boolean {
    return this.assets.has(name);
  }

  /** every loaded asset with this role */
  role(role: string): Asset[] {
    const out: Asset[] = [];
    this.assets.forEach((a) => {
      if (a.def.role === role) out.push(a);
    });
    return out;
  }

  /** Fetch and decode everything (once). Resolves when all assets have settled; never rejects. */
  load(loader: Loader, concurrency = 4): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      let m: Manifest;
      try {
        const raw = await loader("manifest.json");
        m = JSON.parse(new TextDecoder().decode(raw)) as Manifest;
      } catch {
        this.failed.push("manifest.json");
        return;
      }
      this.manifest = m;
      const rank = (d: AssetDef) => {
        const i = PRIORITY.indexOf(d.role);
        return i < 0 ? PRIORITY.length : i;
      };
      const queue = [...m.assets].sort((a, b) => rank(a) - rank(b));
      const worker = async () => {
        for (;;) {
          const def = queue.shift();
          if (!def) return;
          try {
            const ab = await loader(def.file);
            const buf = await this.decode(ab);
            const extra = buf.duration - def.dur;
            const shift = extra > 0.012 ? 1105 / def.sr : 0;
            this.assets.set(def.name, { def, buf, shift });
          } catch {
            this.failed.push(def.name);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
    })();
    return this.loading;
  }

  private decode(ab: ArrayBuffer): Promise<AudioBuffer> {
    return new Promise<AudioBuffer>((resolve, reject) => {
      // both the callback and the promise form, for older Safari
      const p = this.ctx.decodeAudioData(ab, resolve, reject) as Promise<AudioBuffer> | undefined;
      if (p && typeof p.then === "function") p.then(resolve, reject);
    });
  }
}

// ------------------------------------------------------------------ anti-repetition

export interface TraceEntry {
  t: number;
  role: string;
  slice: string;
  rate: number;
}

/**
 * Round-robin slice choice and pitch jitter with memory, per role. Seeded, so offline renders are
 * reproducible.
 */
export class Picker {
  private rnd: () => number;
  private hist = new Map<string, string[]>();
  private lastRate = new Map<string, { key: string; rate: number }>();
  private ends = new Map<string, number[]>();
  private cool = new Map<string, number>();
  readonly trace: TraceEntry[] = [];

  constructor(rnd: () => number) {
    this.rnd = rnd;
  }

  random(): number {
    return this.rnd();
  }

  /** a value in [a, b) */
  range(a: number, b: number): number {
    return a + (b - a) * this.rnd();
  }

  /**
   * choose one of `keys` for `role`: never the last one, and not the one before when there are 4+.
   * With only two, a strict A-B-A-B alternation would itself be a pattern, so either may come (the rate
   * check then keeps a repeat from being identical).
   */
  choose(role: string, keys: string[]): number {
    if (keys.length <= 1) return 0;
    if (keys.length === 2) {
      const i = this.rnd() < 0.5 ? 0 : 1;
      this.hist.set(role, [...(this.hist.get(role) ?? []).slice(-3), keys[i]]);
      return i;
    }
    const h = this.hist.get(role) ?? [];
    const avoid = new Set(h.slice(keys.length >= 4 ? -2 : -1));
    const ok: number[] = [];
    keys.forEach((k, i) => {
      if (!avoid.has(k)) ok.push(i);
    });
    const pool = ok.length ? ok : keys.map((_, i) => i);
    const i = pool[Math.floor(this.rnd() * pool.length)];
    h.push(keys[i]);
    if (h.length > 4) h.shift();
    this.hist.set(role, h);
    return i;
  }

  /**
   * Final playback rate for `key` in `role`: if it would repeat the previous play of the same slice at
   * (almost) the same pitch, nudge it by a few cents so no two consecutive plays are identical.
   */
  rate(role: string, key: string, rate: number): number {
    const last = this.lastRate.get(role);
    let r = rate;
    if (last && last.key === key && Math.abs(Math.log2(r / last.rate)) * 1200 < 8) {
      r *= Math.pow(2, ((this.rnd() < 0.5 ? -1 : 1) * (12 + this.rnd() * 10)) / 1200);
    }
    this.lastRate.set(role, { key, rate: r });
    return r;
  }

  /** voice limit: true if fewer than `max` voices of `role` are still sounding at `t` */
  room(role: string, t: number, max: number): boolean {
    const e = (this.ends.get(role) ?? []).filter((x) => x > t);
    this.ends.set(role, e);
    return e.length < max;
  }

  /** cooldown: true (and arms it) if `gap` seconds have passed since the role last fired */
  ready(role: string, t: number, gap: number): boolean {
    const last = this.cool.get(role) ?? -1e9;
    if (t - last < gap) return false;
    this.cool.set(role, t);
    return true;
  }

  played(role: string, key: string, t: number, end: number, rate: number) {
    const e = this.ends.get(role) ?? [];
    e.push(end);
    this.ends.set(role, e);
    this.trace.push({ t: +t.toFixed(4), role, slice: key, rate: +rate.toFixed(5) });
    if (this.trace.length > 4000) this.trace.shift();
  }
}

// ------------------------------------------------------------------ playback

export interface PlayOpts {
  at: number;
  /** slice index (sprite assets); omitted for whole/loop assets */
  slice?: number;
  rate?: number;
  /** peak gain applied to the sample (before the slice's own loudness correction) */
  gain: number;
  pan?: number;
  /** low-pass cutoff (Hz) */
  lp?: number;
  /** high-pass cutoff (Hz) */
  hp?: number;
  /** send to the hall (0..1) */
  send?: number;
  /** send to the far hall (distant: pre-filtered, later) */
  far?: number;
  /** glide the pan to this value over the sound (something moving across the hall) */
  panTo?: number;
  /** dry level multiplier (1 = full dry; 0 for sounds heard only in the hall) */
  dry?: number;
  attack?: number;
  release?: number;
  /** play only the first `dur` seconds of material (before rate) */
  dur?: number;
  /** start this many seconds into the slice */
  offset?: number;
  /** a soft gain curve over the whole sound (e.g. a stroke that swells), instead of attack/hold */
  swell?: boolean;
}

export interface Voice {
  src: AudioBufferSourceNode;
  gain: GainNode;
  end: number;
}

/** the playable span of an asset/slice in seconds (shifted for the decoder), and its loudness correction */
export function span(a: Asset, slice?: number): { s: number; e: number; g: number; hz: number | null } {
  const sl = slice !== undefined && a.def.slices ? a.def.slices[slice] : undefined;
  if (sl) return { s: sl.s + a.shift, e: sl.e + a.shift, g: sl.g ?? 1, hz: sl.hz ?? a.def.baseHz ?? null };
  return { s: a.shift, e: a.def.dur + a.shift, g: a.def.gain ?? 1, hz: a.def.baseHz ?? null };
}

/** Play an asset (or one of its slices) with an envelope, filters, pan and sends. */
export function play(ctx: ACtx, bus: Bus, a: Asset, o: PlayOpts): Voice {
  const sp = span(a, o.slice);
  const rate = o.rate ?? 1;
  const off = Math.max(0, sp.s - 0.004 + (o.offset ?? 0));
  const len = Math.max(0.02, Math.min(sp.e - off, o.dur ?? Infinity));
  const playDur = len / rate;
  const t = o.at;
  const end = t + playDur;

  const src = ctx.createBufferSource();
  src.buffer = a.buf;
  src.playbackRate.value = rate;

  let node: AudioNode = src;
  if (o.hp) {
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = o.hp;
    hp.Q.value = 0.6;
    node.connect(hp);
    node = hp;
  }
  if (o.lp) {
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = o.lp;
    lp.Q.value = 0.5;
    node.connect(lp);
    node = lp;
  }
  const g = ctx.createGain();
  const peak = Math.max(0, o.gain * sp.g);
  const atk = Math.max(0.002, o.attack ?? 0.003);
  const rel = Math.min(playDur * 0.5, Math.max(0.01, o.release ?? 0.04));
  g.gain.setValueAtTime(0, t);
  if (o.swell) {
    // a soft rise and fall across the whole sound (strokes, slides)
    g.gain.linearRampToValueAtTime(peak, t + Math.max(atk, playDur * 0.35));
    g.gain.setValueAtTime(peak, t + Math.max(atk, playDur * 0.45));
    g.gain.linearRampToValueAtTime(0, end);
  } else {
    g.gain.linearRampToValueAtTime(peak, t + atk);
    g.gain.setValueAtTime(peak, Math.max(t + atk, end - rel));
    g.gain.linearRampToValueAtTime(0, end);
  }
  node.connect(g);

  const pan = ctx.createStereoPanner();
  pan.pan.value = Math.max(-1, Math.min(1, o.pan ?? 0));
  if (o.panTo !== undefined) {
    pan.pan.setValueAtTime(pan.pan.value, t);
    pan.pan.linearRampToValueAtTime(Math.max(-1, Math.min(1, o.panTo)), end);
  }
  g.connect(pan);
  const dry = o.dry ?? 1;
  if (dry > 0) {
    if (dry === 1) pan.connect(bus.input);
    else {
      const d = ctx.createGain();
      d.gain.value = dry;
      pan.connect(d);
      d.connect(bus.input);
    }
  }
  if (o.send) {
    const s = ctx.createGain();
    s.gain.value = o.send;
    pan.connect(s);
    s.connect(bus.verbIn);
  }
  if (o.far) {
    const f = ctx.createGain();
    f.gain.value = o.far;
    pan.connect(f);
    f.connect(bus.farIn);
  }
  src.start(t, off, len);
  src.stop(end + 0.05);
  return { src, gain: g, end };
}

/** MIDI of a frequency (fractional) */
export function ftom(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
}

/**
 * The rate that puts a sample with fundamental `baseHz` on MIDI `note`, moved by octaves so the rate
 * falls inside [lo, hi). Glass and bells are pitched down (rates < 1): darker, larger, never shrill.
 */
export function rateFor(baseHz: number, note: number, lo = 0.42, hi = 0.84): number {
  let r = Math.pow(2, (note - ftom(baseHz)) / 12);
  for (let i = 0; i < 8 && r >= hi; i++) r /= 2;
  for (let i = 0; i < 8 && r < lo; i++) r *= 2;
  return r;
}

/** The highest MIDI note at or just above `near` (within a quarter-tone) whose pitch class is in `pcs`:
 * pitching a bell or bowl onto it never raises it by more than a few cents. */
export function belowPc(pcs: readonly number[], near: number): number {
  for (let m = Math.floor(near + 0.25); m > near - 13; m--) if (pcs.includes(((m % 12) + 12) % 12)) return m;
  return Math.round(near);
}

/** The nearest MIDI note to `near` whose pitch class is in `pcs`. */
export function nearestPc(pcs: readonly number[], near: number): number {
  let best = Math.round(near);
  let bd = Infinity;
  for (let m = Math.floor(near) - 7; m <= Math.ceil(near) + 7; m++) {
    if (!pcs.includes(((m % 12) + 12) % 12)) continue;
    const d = Math.abs(m - near);
    if (d < bd) {
      bd = d;
      best = m;
    }
  }
  return best;
}
