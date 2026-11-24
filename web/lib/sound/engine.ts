/**
 * The sound engine: wires the master chain and the hall, the recorded world, the chord pad, the
 * synthesized fallbacks, the context foley and the event voices together, and exposes a small, pure
 * API. It knows nothing about the bus, the store, React or the DOM — it takes plain numbers, genomes and
 * a loader function — so the exact same object is driven live by `lib/sound.ts` and rendered offline by
 * the offline render harness.
 *
 * Layers:
 *   hall      a convolver with a generated 6 s dark impulse (graph.ts / space.ts)
 *   world     a hall heard the way a game hears a place: room tone, far murmurs that come and go, wind,
 *             brooks, sparse details (steps crossing, a distant game and its clock, a door) and distant
 *             whale calls — the giants singing (field.ts)
 *   pad       the generative chord pad: quiet harmonic glue that plays in phrases and then rests, so the
 *             hall is sometimes heard alone (bed.ts)
 *   foley     the cursor touching text, controls, the queen and the board; scroll swooshes (foley.ts)
 *   events    refusals, drains, epochs, policies on the conductor's notes (strikes.ts)
 *
 * Until the recordings have loaded (or if they fail), the synthesis carries everything: the synth
 * wind and water, the synth glass and the synth event voices. The bed owns the harmony; every pitched
 * sample is placed on its current chord, so the whole mix is one piece of music.
 */
import { createMaster, type Master } from "./graph";
import { Bed, type BedMix, type Chord } from "./bed";
import { Ambience } from "./ambience";
import { Interaction } from "./interaction";
import { Conductor } from "./conductor";
import { Field } from "./field";
import { Foley, type PieceStyle } from "./foley";
import { Strikes } from "./strikes";
import { Picker, SampleBank, type Bus, type Loader, type TraceEntry } from "./samples";
import * as V from "./voices";
import { chordPcs, genomeKey, homeKey, ladder, mulberry32, panForCaller, reasonBits, signatureMotif, type Key } from "./theory";

type ACtx = BaseAudioContext;

export type { Loader } from "./samples";

export interface Layers {
  /** the chord pad */
  bed?: boolean;
  /** the recorded world and the synth ambience under it */
  world?: boolean;
  /** the pointer-air swell */
  air?: boolean;
  /** harness only: one world layer alone (room, hallA, hallB, wind, brookL, brookR) */
  worldSolo?: string | null;
}

export class SoundEngine {
  readonly ctx: ACtx;
  private master: Master;
  private bed: Bed;
  private ambience: Ambience;
  private inter: Interaction;
  private cond: Conductor;
  private bank: SampleBank;
  private picker: Picker;
  private field: Field;
  private foley: Foley;
  private strikes: Strikes;
  private gate: GainNode;
  private key: Key;
  private pressure = 0;
  private lastPump = 0;
  private chordId = -1;
  private layers: Required<Layers> = { bed: true, world: true, air: true, worldSolo: null };
  private sampledWorld = false;
  /** the pad breathes: on for a phrase, then resting (only once the recorded world carries the room) */
  private padOn = true;
  private padNext = -1;
  private duckAmt = 1;
  private rnd = mulberry32(0xbea7);

  /**
   * @param ctx          an AudioContext (live) or OfflineAudioContext (render)
   * @param destination  where the master output goes (ctx.destination, or a capture node offline)
   * @param genes        the live genome, for the starting key
   */
  constructor(ctx: ACtx, destination: AudioNode, genes?: readonly number[]) {
    this.ctx = ctx;
    this.gate = ctx.createGain();
    this.gate.gain.value = 0; // muted by default
    this.gate.connect(destination);
    this.master = createMaster(ctx, this.gate);
    this.key = genes && genes.length ? genomeKey(genes) : homeKey();
    const bus = this.bus();
    this.bed = new Bed(ctx, this.master.input, this.master.verbIn, this.key);
    this.bed.start();
    this.ambience = new Ambience(ctx, bus, this.key);
    this.inter = new Interaction(ctx, bus, this.key);
    this.inter.start();
    this.cond = new Conductor(this.key);
    this.bank = new SampleBank(ctx);
    this.picker = new Picker(mulberry32(0x5a3e));
    this.field = new Field(ctx, bus, this.bank, this.picker);
    this.foley = new Foley(ctx, bus, this.bank, this.picker);
    this.strikes = new Strikes(ctx, bus, this.bank, this.picker);
    this.syncChord();
  }

  private bus(): Bus & V.Bus {
    return { input: this.master.input, verbIn: this.master.verbIn, farIn: this.master.farIn };
  }

  private chord(): Chord {
    return this.bed.chordNow();
  }

  private syncChord() {
    const c = this.chord();
    if (c.id === this.chordId) return;
    this.chordId = c.id;
    this.ambience.setChord(c);
    this.inter.setChord(c);
    this.field.setChord(c);
    this.foley.setChord(c);
  }

  /**
   * Fetch and decode the recordings (call once, on the first un-mute, so nothing is fetched while
   * muted). Resolves when every asset has settled; layers switch over as their assets arrive.
   */
  loadSamples(loader: Loader): Promise<void> {
    return this.bank.load(loader);
  }

  /** the conductor's recent decisions (for the offline harness) */
  trace() {
    return this.cond.trace;
  }

  /** every sample played: role, slice, rate (for the offline repetition check) */
  sampleTrace(): readonly TraceEntry[] {
    return this.picker.trace;
  }

  /** whether the hall is the convolver (true in browsers) */
  get convolver(): boolean {
    return this.master.convolver;
  }

  now(): number {
    return this.ctx.currentTime;
  }

  /** Open or close the master gate (the "mute" switch). */
  setEnabled(on: boolean, at = this.ctx.currentTime, ramp = 0.4) {
    this.gate.gain.setTargetAtTime(on ? 1 : 0, at, ramp);
  }

  /** switch layers off for solo renders (the harness); everything is on by default */
  setLayers(l: Layers) {
    this.layers = { ...this.layers, ...l };
    this.field.setOn(this.layers.world);
    this.field.solo = this.layers.worldSolo;
    this.ambience.setOn(this.layers.world);
    this.levels();
  }

  private levels() {
    const pad = this.sampledWorld ? (this.padOn ? 0.11 : 0) : 0.55;
    this.bed.setLevel(this.layers.bed ? pad * this.duckAmt : 0);
    this.inter.setAirLevel(this.layers.air ? (this.sampledWorld ? 0.26 : 0.6) * (0.4 + 0.6 * this.duckAmt) : 0);
  }

  /**
   * Step the whole soundscape back while something must be heard over it (the demo's narration):
   * d = 1 normal, 0.35 well under a voice.
   */
  duck(d: number, at = this.ctx.currentTime) {
    this.duckAmt = Math.max(0, Math.min(1, d));
    this.field.setDuck(0.3 + 0.7 * this.duckAmt, at);
    this.levels();
  }

  private analyser: AnalyserNode | null = null;
  private levelBuf: Float32Array<ArrayBuffer> | null = null;
  /** the output's level now (RMS, 0..1), for the header's sound glyph */
  level(): number {
    if (!this.analyser) {
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this.gate.connect(this.analyser);
      this.levelBuf = new Float32Array(new ArrayBuffer(512 * 4));
    }
    const b = this.levelBuf!;
    this.analyser.getFloatTimeDomainData(b);
    let sum = 0;
    for (let i = 0; i < b.length; i++) sum += b[i] * b[i];
    return Math.sqrt(sum / b.length);
  }

  private voiceNode: GainNode | null = null;
  /** where the narration goes: dry, with a little of the hall round it (the voice is in the room with you) */
  voiceIn(): GainNode {
    if (!this.voiceNode) {
      const g = this.ctx.createGain();
      g.gain.value = 0.9;
      const hp = this.ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 80;
      g.connect(hp);
      hp.connect(this.master.input);
      const send = this.ctx.createGain();
      send.gain.value = 0.14;
      hp.connect(send);
      send.connect(this.master.verbIn);
      this.voiceNode = g;
    }
    return this.voiceNode;
  }

  /** what the chess pieces (hover, press, the board) are made of: crystal (default), ring, wood */
  setPiece(style: PieceStyle) {
    this.foley.pieceStyle = style;
  }

  /** a detail in the hall now (harness): drip, settle, gust, resonance, clink */
  hallDetail(kind?: string, at = this.ctx.currentTime) {
    this.field.detail(at, kind);
  }

  /** force a distant whale call now (harness) */
  whale(at = this.ctx.currentTime) {
    this.field.whale(at);
  }

  // --- continuous state -------------------------------------------------

  setVault(frac: number) {
    this.bed.setVault(frac);
    this.ambience.setVault(frac);
    this.field.setVault(frac);
  }

  setMix(m: BedMix & { room?: number; roomTime?: number }) {
    this.bed.setMix({ motion: m.motion, cinema: m.cinema, calm: m.calm });
    this.ambience.setMix(m.motion);
    this.field.setMotion(m.motion);
    // a hollow hall: more of the room
    this.master.setRoom(m.cinema ? 0.34 : 0.3, m.cinema ? 0.88 : 0.84);
  }

  // --- the cursor ----------------------------------------------------------

  /** pointer movement: speed (0..1) and pan (-1..1), plus scroll velocity (0..1), drive the air swell. */
  setPointer(speed: number, pan: number, scroll = 0) {
    this.inter.setAir(speed, pan, scroll);
  }

  /** cursor on the glass queen: amt (0..1), heightFrac (0..1 up her body), pan (-1..1). */
  queenTouch(amt: number, heightFrac: number, pan: number, at = this.ctx.currentTime) {
    if (this.foley.queen(amt, heightFrac, pan, at)) this.inter.setQueen(0, heightFrac, pan);
    else this.inter.setQueen(amt, heightFrac, pan);
  }

  /** she was pressed. */
  queenPress(heightFrac: number, pan: number, at = this.ctx.currentTime) {
    if (!this.foley.queenPress(heightFrac, pan, at)) this.inter.press(heightFrac, pan, at);
  }

  /** the cursor crossed a button, link or card (kept for API compatibility: same as uiHover) */
  uiTick(pan: number, at = this.ctx.currentTime) {
    this.uiHover(pan, at);
  }

  /** the cursor entered an interactive element */
  uiHover(pan: number, at = this.ctx.currentTime) {
    if (!this.foley.uiHover(pan, at)) this.inter.uiTick(pan, at);
  }

  /** an interactive element was pressed */
  uiPress(pan: number, at = this.ctx.currentTime) {
    if (!this.foley.uiPress(pan, at)) this.inter.uiTick(pan, at);
  }

  /** the cursor entered a new block of text */
  textTouch(pan: number, at = this.ctx.currentTime) {
    this.foley.textTouch(pan, at);
  }

  /** the text selection grew or changed: amount 0..1 */
  textSelect(amount: number, pan: number, at = this.ctx.currentTime) {
    this.foley.textSelect(amount, pan, at);
  }

  /** the cursor's lamp on the ground (world x, z; lit 0..1), while it is over the open world */
  boardMove(x: number, z: number, lit: number, at = this.ctx.currentTime) {
    this.foley.board(x, z, lit, at);
  }

  /** a press on the open board */
  boardPress(x: number, at = this.ctx.currentTime) {
    this.foley.boardPress(x, at);
  }

  /** scroll velocity (px/s, signed) and the camera stage, every tick: swooshes on flings */
  setScroll(v: number, stage: number, at = this.ctx.currentTime) {
    this.foley.scroll(v, stage, at);
  }

  /**
   * Advance the schedulers and decay refusal pressure. Call on a coarse timer live
   * (now = currentTime) or step `now` forward offline.
   */
  pump(now: number, lookahead = 0.4) {
    const dt = this.lastPump ? Math.max(0, now - this.lastPump) : 0;
    this.pressure = Math.max(0, this.pressure - dt * 0.2);
    this.bed.setPressure(this.pressure);
    this.bed.pump(now, lookahead);
    this.syncChord();
    this.field.setPressure(this.pressure);
    this.field.pump(now, Math.max(0.6, lookahead));
    if (this.field.active !== this.sampledWorld) {
      this.sampledWorld = this.field.active;
      this.ambience.setSampled(this.sampledWorld);
      this.setLayers({});
    }
    // the pad's phrases and rests: 35-75 s of harmony, then 25-70 s of the hall alone
    if (this.padNext < 0) this.padNext = now + 45 + 30 * this.rnd();
    if (now >= this.padNext) {
      this.padOn = !this.padOn;
      this.padNext = now + (this.padOn ? 35 + 40 * this.rnd() : 25 + 45 * this.rnd());
      this.levels();
    }
    this.ambience.setPressure(this.pressure);
    this.ambience.pump(now);
    this.lastPump = now;
  }

  // --- key / generation -------------------------------------------------

  private setKey(key: Key, at: number) {
    this.key = key;
    this.bed.setKey(key, at);
    this.ambience.setKey(key, at);
    this.inter.setKey(key);
    this.cond.setKey(key);
  }

  /** A champion policy was installed: modulate the bed to its key and sound the bowl. */
  policyInstalled(genes: readonly number[], at = this.ctx.currentTime) {
    const next = genes && genes.length ? genomeKey(genes) : this.key;
    const changed = next.tonic !== this.key.tonic || next.mode !== this.key.mode;
    this.setKey(next, at);
    if (this.strikes.policy(next, changed, at)) return;
    // the same champion re-crowned every epoch gets a quieter bell on whatever the bed is holding
    const notes = changed
      ? [next.tonic + 12, next.tonic + 12 + 7].map((m) => Math.min(m, 67))
      : this.cond.figure(this.chord(), 55, 67, 2);
    V.policyBell(this.ctx, this.bus(), notes, at, changed ? 1 : 0.55);
  }

  /** Keep the key in sync with the live genome without a bell (e.g. on initial snapshot). */
  syncKey(genes: readonly number[]) {
    if (genes && genes.length) this.setKey(genomeKey(genes), this.ctx.currentTime);
  }

  // --- events -----------------------------------------------------------

  refusal(reason: bigint | number, caller = "0x", at = this.ctx.currentTime) {
    this.pressure = Math.min(1, this.pressure + 0.12);
    const plan = this.cond.refusal(at, reasonBits(reason), this.chord(), panForCaller(caller));
    if (plan && !this.strikes.refusal(plan)) V.refusal(this.ctx, this.bus(), plan);
  }

  extraction(amountShare: number, caller = "0x", at = this.ctx.currentTime) {
    const plan = this.cond.extraction(at, amountShare, this.chord(), panForCaller(caller));
    if (plan && !this.strikes.drain(plan)) V.extraction(this.ctx, this.bus(), plan);
  }

  epochClose(at = this.ctx.currentTime) {
    const n = this.cond.epoch();
    const four = ladder(chordPcs(this.key, 3), 50, 62).slice(0, 4);
    const one = ladder(chordPcs(this.key, 0), 45, 60).slice(0, 4);
    if (this.strikes.epoch(this.key, this.chord(), n, at)) {
      // the plagal settle stays, softly, under the bell
      V.epochSettle(this.ctx, this.bus(), four, one, at + 0.4, 0.6);
      return;
    }
    const sig = signatureMotif(this.key).map((m) => m - 24);
    const rot = n % sig.length;
    const motif = [...sig.slice(rot), ...sig.slice(0, rot)].slice(0, 4 + (n % 2));
    V.epochClose(this.ctx, this.bus(), four, one, motif, at);
  }

  childBorn(caller = "0x", at = this.ctx.currentTime) {
    if (this.strikes.child(this.chord(), panForCaller(caller), at)) return;
    V.childBorn(this.ctx, this.bus(), this.cond.figure(this.chord(), 55, 67, 3), panForCaller(caller), at);
  }

  policyDied(at = this.ctx.currentTime) {
    if (this.strikes.died(this.chord(), at)) return;
    V.policyDied(this.ctx, this.bus(), this.cond.figure(this.chord(), 43, 60, 4, true), at);
  }

  deposit(at = this.ctx.currentTime) {
    this.field.swell(at);
    const sampled = this.strikes.deposit(at);
    V.deposit(this.ctx, this.bus(), ladder(this.chord().pcs, 48, 62).slice(0, 4), at, sampled ? 0.6 : 1);
  }
}
