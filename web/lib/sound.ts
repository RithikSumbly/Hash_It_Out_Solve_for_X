"use client";
/**
 * Sound for the Red Queen arena.
 *
 * Muted by default; one tap enables it; never required for anything on the page. The engine lives in
 * ./sound/** (pure Web Audio: a generated hall, recorded ambience and foley from public/sound, a chord
 * pad, synthesized fallbacks). This file is the client shell: it owns the real AudioContext, loads the
 * recordings on the first un-mute (nothing is fetched while muted), and translates the event bus, the
 * arena store, the scene and the cursor into engine calls. The public API is sound.enable(),
 * sound.disable() and sound.enabled.
 *
 * The cursor is classified by what it is over:
 *   text      (p, h1-h3, li, blockquote, figcaption, dd, dt; not inside a control) — a soft paper touch
 *             on entering a new block, a pencil stroke while selecting
 *   controls  (button, a, [role=radio], input, .card, ...) — a crystal chess piece struck on hover-enter,
 *             a firmer placement on press
 *   the world (the stage canvas is what the cursor sees: no opaque panel above it at that point) — the
 *             queen's singing glass when the cursor is on her (gfx.touch), wooden ticks as the cursor's
 *             lamp crosses board squares
 *   scrolling — soft swooshes on flings (scene.scrollV), a deep one when a fling changes section
 * An element can override the guess with data-sound="none" | "world" | "text" | "ui".
 */
import { unpack } from "@redqueen/sdk";
import { bus } from "./bus";
import { arena, liveGenes } from "./store";
import { scene } from "./scene";
import { gfx } from "../components/stage/gfx";
import { SoundEngine } from "./sound/engine";
import { TRAVEL } from "../components/stage/ink";

const INTERACTIVE = "button, a, [role=radio], [role=button], [role=tab], [role=switch], input, select, textarea, label, summary, .card";
const TEXT = "p, h1, h2, h3, li, blockquote, figcaption, dd, dt";
const SOUND_BASE = "/sound/";

type Zone = "none" | "text" | "ui" | "world" | "panel";

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

class Sound {
  enabled = false;
  private ctx: AudioContext | null = null;
  private engine: SoundEngine | null = null;
  private offBus: (() => void) | null = null;
  private loop: ReturnType<typeof setInterval> | null = null;
  private interLoop: ReturnType<typeof setInterval> | null = null;
  private suspendTimer: ReturnType<typeof setTimeout> | null = null;
  private keyed = false;
  private loading = false;

  // cursor state, updated by DOM listeners (no allocation), applied in the interaction loop
  private moveAccum = 0;
  private pointerX = 0;
  private lastCX: number | null = null;
  private lastCY = 0;
  private lastPressed = false;
  private zone: Zone = "none";
  private uiEl: Element | null = null;
  private lastUi: Element | null = null;
  private uiT = 0;
  private textEl: Element | null = null;
  private recentText: { el: Element; t: number }[] = [];
  private selDirty = false;
  private recheck = 0;
  private selLen = 0;
  private opaqueCache = new WeakMap<Element, boolean>();
  private listeners: [EventTarget, string, EventListener][] = [];

  enable() {
    if (!this.engine) this.build();
    if (this.suspendTimer) {
      clearTimeout(this.suspendTimer);
      this.suspendTimer = null;
    }
    void this.ctx!.resume();
    this.engine!.setEnabled(true, this.ctx!.currentTime);
    this.enabled = true;
    this.startLoops();
    // the recordings are fetched on the first un-mute only; until they arrive the synthesis plays
    if (!this.loading) {
      this.loading = true;
      void this.engine!.loadSamples((p) =>
        fetch(SOUND_BASE + p).then((r) => {
          if (!r.ok) throw new Error(`${r.status} ${p}`);
          return r.arrayBuffer();
        }),
      );
    }
  }

  // ------------------------------------------------------------ the narration (the demo's voice)
  private voiceBufs = new Map<string, Promise<AudioBuffer | null>>();
  private voiceSrc: AudioBufferSourceNode | null = null;
  private voiceToken = 0;

  private voiceMeter: AnalyserNode | null = null;
  private meterBuf: Float32Array<ArrayBuffer> | null = null;
  private voiceDone: ((played: boolean) => void) | null = null;

  /** her voice's own level (RMS, 0..1) while she speaks: her light and the audience's ring follow it */
  voiceLevel(): number {
    const m = this.voiceMeter;
    const b = this.meterBuf;
    if (!m || !b || !this.voiceSrc) return 0;
    m.getFloatTimeDomainData(b);
    let e = 0;
    for (let i = 0; i < b.length; i++) e += b[i] * b[i];
    return Math.sqrt(e / b.length);
  }

  /**
   * Speak one clip and resolve when it ends (true) or is cut off or cannot play (false). `onStart` receives its
   * length so captions can pace themselves; `duck` is how far the world steps back while it plays. The world stays
   * ducked afterwards (a reply is several clips in a row): call `unduck()` when the speaker is done.
   */
  speak(url: string, { onStart, duck = 0.35 }: { onStart?: (dur: number) => void; duck?: number } = {}): Promise<boolean> {
    if (!this.enabled || !this.ctx || !this.engine) return Promise.resolve(false);
    const token = ++this.voiceToken;
    this.stopVoice();
    return this.loadVoice(url).then(
      (buf) =>
        new Promise<boolean>((resolve) => {
          const ctx = this.ctx;
          const eng = this.engine;
          if (!buf || token !== this.voiceToken || !this.enabled || !ctx || !eng) return resolve(false);
          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.connect(eng.voiceIn());
          if (!this.voiceMeter) {
            this.voiceMeter = ctx.createAnalyser();
            this.voiceMeter.fftSize = 512;
            this.meterBuf = new Float32Array(512);
          }
          src.connect(this.voiceMeter);
          if (ctx.state !== "running") void ctx.resume().catch(() => {});
          src.start(ctx.currentTime + 0.02);
          eng.duck(duck);
          this.voiceDone = resolve;
          // A suspended context (sound not yet allowed by a gesture, or a phone that paused audio) never fires
          // onended: after the clip's length she is done anyway (its caption has shown), so she never hangs speaking.
          const guard = setTimeout(() => {
            if (this.voiceSrc !== src) return;
            this.voiceSrc = null;
            this.voiceDone = null;
            if (ctx.state !== "running") {
              try {
                src.stop();
              } catch {
                /* never started */
              }
            }
            resolve(true);
          }, (buf.duration + 1.5) * 1000);
          src.onended = () => {
            clearTimeout(guard);
            if (this.voiceSrc !== src) return;
            this.voiceSrc = null;
            this.voiceDone = null;
            resolve(true);
          };
          this.voiceSrc = src;
          onStart?.(buf.duration);
        }),
    );
  }

  /** the world comes back up after a speaker is done */
  unduck() {
    this.engine?.duck(1);
  }

  /** everything silent while the visitor is recorded (the microphone runs without echo cancelling), then back */
  silence(on: boolean) {
    if (!this.enabled || !this.engine) return;
    this.engine.setEnabled(!on, this.engine.now(), on ? 0.03 : 0.25);
  }

  /** the output level (RMS, 0..1) while sound is on; 0 when off */
  level(): number {
    return this.enabled && this.engine ? this.engine.level() : 0;
  }

  /** fetch and decode a narration clip once (only while sound is on); null if it cannot */
  loadVoice(url: string): Promise<AudioBuffer | null> {
    const hit = this.voiceBufs.get(url);
    if (hit) return hit;
    if (!this.ctx) return Promise.resolve(null);
    const ctx = this.ctx;
    const p = fetch(url)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then((b) => ctx.decodeAudioData(b))
      .catch(() => {
        this.voiceBufs.delete(url);
        return null;
      });
    this.voiceBufs.set(url, p);
    return p;
  }

  /** speak a clip from `offset` seconds, over a quieter world; replaces whatever she was saying */
  say(url: string, offset = 0) {
    if (!this.enabled || !this.ctx || !this.engine) return;
    const token = ++this.voiceToken;
    this.stopVoice();
    void this.loadVoice(url).then((buf) => {
      const ctx = this.ctx;
      const eng = this.engine;
      if (!buf || token !== this.voiceToken || !this.enabled || !ctx || !eng) return;
      const off = Math.max(0, offset);
      if (off >= buf.duration - 0.05) return;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(eng.voiceIn());
      src.start(ctx.currentTime + 0.02, off);
      eng.duck(0.35);
      src.onended = () => {
        if (this.voiceSrc !== src) return;
        this.voiceSrc = null;
        this.engine?.duck(1);
      };
      this.voiceSrc = src;
    });
  }

  /** stop speaking (pause, skip, leave) */
  hush() {
    this.voiceToken++;
    this.stopVoice();
    this.engine?.duck(1);
  }

  private stopVoice() {
    const s = this.voiceSrc;
    this.voiceSrc = null;
    const done = this.voiceDone;
    this.voiceDone = null;
    done?.(false);
    if (s) {
      s.onended = null;
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
  }

  disable() {
    this.hush();
    this.enabled = false;
    if (this.engine && this.ctx) this.engine.setEnabled(false, this.ctx.currentTime);
    if (this.loop) {
      clearInterval(this.loop);
      this.loop = null;
    }
    if (this.interLoop) {
      clearInterval(this.interLoop);
      this.interLoop = null;
    }
    // once the fade is done, stop the audio thread entirely (the hall and the grains cost CPU)
    if (this.suspendTimer) clearTimeout(this.suspendTimer);
    this.suspendTimer = setTimeout(() => {
      this.suspendTimer = null;
      if (!this.enabled) void this.ctx?.suspend();
    }, 900);
  }

  private pan(clientX: number): number {
    const w = (typeof window !== "undefined" && window.innerWidth) || 1;
    return ((clientX / w) * 2 - 1) * 0.8;
  }

  /** does this element paint an opaque background (alpha >= 0.85)? */
  private paints(el: Element): boolean {
    const hit = this.opaqueCache.get(el);
    if (hit !== undefined) return hit;
    let o = false;
    const bg = getComputedStyle(el).backgroundColor;
    if (bg && bg !== "transparent" && bg.indexOf("(") >= 0) {
      // rgb(), rgba(), and modern space/slash syntaxes (oklch(... / a), color(... / a))
      const inner = bg.slice(bg.indexOf("(") + 1, bg.lastIndexOf(")"));
      let alpha = 1;
      if (inner.includes("/")) alpha = parseFloat(inner.split("/")[1]);
      else {
        const parts = inner.split(",");
        if (parts.length === 4) alpha = parseFloat(parts[3]);
      }
      if (alpha > 1) alpha /= 100; // a percentage
      o = alpha >= 0.85;
    }
    this.opaqueCache.set(el, o);
    return o;
  }

  /**
   * Is the 3D world what the cursor sees at (x, y)? Walk the hit-test stack from the top: the stage
   * canvas (a canvas covering a good part of the viewport) before any opaque background means yes.
   */
  private worldAt(x: number, y: number): boolean {
    if (typeof document === "undefined" || !document.elementsFromPoint) return false;
    const area = (window.innerWidth || 1) * (window.innerHeight || 1);
    for (const el of document.elementsFromPoint(x, y)) {
      if (el.tagName === "CANVAS") {
        const r = el.getBoundingClientRect();
        return r.width * r.height >= 0.4 * area;
      }
      if (el === document.body || el === document.documentElement) return false;
      if (this.paints(el)) return false;
    }
    return false;
  }

  private classify(t: Element | null, x: number, y: number): { zone: Zone; el: Element | null } {
    if (!t || !t.closest) return { zone: "none", el: null };
    const ui = t.closest(INTERACTIVE);
    const tx = t.closest(TEXT);
    // an explicit hint (data-sound="none" | "world" | "text" | "ui") decides, unless a control or a text
    // block sits inside the hinted element (then that nearer element decides)
    const hinted = t.closest("[data-sound]");
    const within = (inner: Element | null, outer: Element) => !!inner && inner !== outer && outer.contains(inner);
    if (hinted && !within(ui, hinted) && !within(tx, hinted)) {
      const z = hinted.getAttribute("data-sound");
      if (z === "none") return { zone: "panel", el: null };
      if (z === "world") return { zone: "world", el: null };
      if (z === "text" || z === "ui") return { zone: z, el: hinted };
    }
    if (ui) return { zone: "ui", el: ui };
    if (tx) return { zone: "text", el: tx };
    return { zone: this.worldAt(x, y) ? "world" : "panel", el: null };
  }

  private build() {
    // 32 kHz is plenty for a mix rolled off above 12 kHz, and it cuts the decoded recordings (~51 MB
    // instead of ~76 MB at 48 kHz) and the hall's CPU by a third; older engines fall back to the default
    let ctx: AudioContext;
    try {
      // "balanced", not "interactive": a slightly larger buffer, so a heavy 3D frame can't starve the mix (crackle)
      ctx = new AudioContext({ sampleRate: 32000, latencyHint: "balanced" });
    } catch {
      ctx = new AudioContext();
    }
    this.ctx = ctx;
    const genes = liveGenes(arena.get());
    const engine = new SoundEngine(ctx, ctx.destination, genes);
    this.engine = engine;
    // compare the chess pieces live: ?piece=crystal (the default), ?piece=ring, ?piece=wood
    const piece = new URLSearchParams(window.location.search).get("piece");
    if (piece === "crystal" || piece === "ring" || piece === "wood") engine.setPiece(piece);
    if (genes && genes.some((g) => g !== 0)) this.keyed = true;

    this.offBus = bus.on((e) => {
      if (!this.enabled || !this.engine || e.type !== "chain") return;
      const ev = e.event;
      const t0 = this.ctx!.currentTime;
      switch (ev.name) {
        case "Spend": {
          // attacks hit the queen TRAVEL seconds after the event — land the sound with the ink impact
          const t = t0 + TRAVEL;
          const caller = String(ev.args.caller ?? "0x");
          if (ev.args.refused) {
            this.engine.refusal(BigInt((ev.args.reason as bigint | number) ?? 0), caller, t);
          } else if (Number(ev.args.verdict ?? 0) === 1) {
            // held, nothing has left yet; it drains only when it is released
          } else {
            const share = Number(BigInt((ev.args.features as bigint | number) ?? 0n) & 0xffffn) / 1000;
            this.engine.extraction(share, caller, t);
          }
          break;
        }
        case "PolicyInstalled": {
          const genes = unpack(BigInt((ev.args.lo as bigint) ?? 0n), BigInt((ev.args.hi as bigint) ?? 0n));
          this.engine.policyInstalled(genes, t0 + 0.03);
          this.keyed = true;
          break;
        }
        case "EpochClosed":
          this.engine.epochClose(t0 + 0.03);
          break;
        case "ChildBorn":
          this.engine.childBorn(String(ev.args.submitter ?? ev.args.id ?? "0x"), t0 + 0.03);
          break;
        case "PolicyDied":
          this.engine.policyDied(t0 + 0.03);
          break;
        case "Deposit":
          this.engine.deposit(t0 + 0.03);
          break;
        case "Released": {
          // a held payment leaves the vault now
          const h = arena.get().holds.get(String(ev.args.id));
          this.engine.extraction(0.2, h?.from ?? String(ev.args.by ?? "0x"), t0 + 0.03);
          break;
        }
      }
    });

    // --- cursor listeners (client only; build() runs on the enabling tap) ---
    if (typeof window === "undefined") return;
    const on = <E extends Event>(target: EventTarget, type: string, fn: (e: E) => void) => {
      const l = fn as unknown as EventListener;
      target.addEventListener(type, l, { passive: true });
      this.listeners.push([target, type, l]);
    };
    on<PointerEvent>(window, "pointermove", (e) => {
      if (this.lastCX !== null) this.moveAccum += Math.hypot(e.clientX - this.lastCX, e.clientY - this.lastCY);
      this.lastCX = e.clientX;
      this.lastCY = e.clientY;
      this.pointerX = this.pan(e.clientX) / 0.8;
    });
    on<PointerEvent>(window, "pointerover", (e) => {
      const { zone, el } = this.classify(e.target as Element | null, e.clientX, e.clientY);
      this.zone = zone;
      if (!this.enabled || !this.engine) return;
      const now = performance.now();
      const pan = this.pan(e.clientX);
      if (zone === "ui") {
        // a new control clicks; slipping off and straight back onto the same one does not
        const again = el === this.lastUi && now - this.uiT < 300;
        if (el !== this.uiEl && !again) this.engine.uiHover(pan);
        this.uiEl = el;
        this.lastUi = el;
        this.uiT = now;
        this.textEl = null;
        return;
      }
      if (zone === "text" && el && el !== this.textEl) {
        this.textEl = el;
        this.recentText = this.recentText.filter((r) => now - r.t < 1500);
        if (!this.recentText.some((r) => r.el === el)) this.engine.textTouch(pan);
        this.recentText.push({ el, t: now });
        if (this.recentText.length > 4) this.recentText.shift();
      }
      if (zone !== "text") this.textEl = null;
      if (this.uiEl) this.uiT = now;
      this.uiEl = null;
    });
    on<PointerEvent>(window, "pointerout", (e) => {
      if (!e.relatedTarget) this.zone = "none"; // left the window
    });
    on<PointerEvent>(window, "pointerdown", (e) => {
      if (!this.enabled || !this.engine) return;
      const pan = this.pan(e.clientX);
      if (this.zone === "ui") this.engine.uiPress(pan);
      else if (this.zone === "world" && !gfx.touch.touching && gfx.touch.lamp.z > 0.4) this.engine.boardPress(gfx.touch.lamp.x);
    });
    on<Event>(document, "selectionchange", () => {
      this.selDirty = true;
    });
  }

  private startLoops() {
    if (!this.loop) {
      const step = () => {
        const eng = this.engine;
        const ctx = this.ctx;
        if (!eng || !ctx) return;
        const st = arena.get();
        const s = st.snapshot;
        let frac = 1;
        if (s) {
          frac = s.epochStartBalance > 0n ? Number((s.vaultBalance * 1000n) / s.epochStartBalance) / 1000 : 1;
          if (!this.keyed) {
            eng.syncKey(liveGenes(st));
            this.keyed = (s.live?.genes ?? []).some((g) => g !== 0);
          }
        }
        eng.setVault(frac);
        eng.setMix({
          motion: Math.min(1, Math.abs(scene.scrollV) / 3000),
          cinema: scene.cinema,
          calm: scene.reducedMotion,
        });
        eng.pump(ctx.currentTime, 0.4);
      };
      step();
      this.loop = setInterval(step, 120);
    }

    if (!this.interLoop) {
      const inter = () => {
        const eng = this.engine;
        if (!eng) return;
        // pointer speed = distance moved since the last tick, normalised; decays to 0 at rest
        const speed = Math.min(1, this.moveAccum / (0.045 * 2200));
        this.moveAccum = 0;
        const scroll = Math.min(1, Math.abs(scene.scrollV) / 2500);
        eng.setPointer(speed, this.pointerX, scroll);

        // re-classify quietly every ~270 ms: the page scrolls under a resting cursor, and one big
        // transparent container can sit over the stage in one place and over a panel in another
        if (this.zone !== "none" && this.lastCX !== null && ++this.recheck % 6 === 0) {
          const c = this.classify(document.elementFromPoint(this.lastCX, this.lastCY), this.lastCX, this.lastCY);
          if (c.zone !== this.zone) {
            this.zone = c.zone;
            if (c.zone !== "ui") this.uiEl = null;
            if (c.zone !== "text") this.textEl = null;
          }
        }
        const touch = gfx.touch;
        const world = this.zone === "world";
        const seen = 1 - 0.8 * clamp(scene.dim, 0, 1); // the world behind a dimmed section is quieter

        // the cursor on the glass queen
        const amt = world ? (touch.amt || 0) * seen : 0;
        const heightFrac = clamp((touch.point?.y ?? 1.2) / 2.5, 0, 1);
        const qpan = ((touch.screen?.x ?? 0.5) * 2 - 1) * 0.8;
        eng.queenTouch(amt, heightFrac, qpan);

        // pressing her: trigger on the rising edge
        const pressed = world && !!touch.pressed && !!touch.touching;
        if (pressed && !this.lastPressed) eng.queenPress(heightFrac, qpan);
        this.lastPressed = pressed;

        // the cursor's lamp on the board and the fields (the queen takes priority)
        const onBoard = world && !touch.touching && amt < 0.3;
        eng.boardMove(touch.lamp.x, touch.lamp.y, onBoard ? touch.lamp.z * seen : 0);

        // scroll flings and section changes
        eng.setScroll(scene.scrollV, scene.stage);

        // text selection: a pencil stroke as it grows or changes
        if (this.selDirty) {
          this.selDirty = false;
          const sel = typeof document !== "undefined" ? document.getSelection() : null;
          const len = sel && !sel.isCollapsed && sel.rangeCount ? Math.min(5000, sel.toString().length) : 0;
          if (len > 0 && len !== this.selLen) eng.textSelect(clamp(Math.abs(len - this.selLen) / 40, 0.1, 1), this.pointerX * 0.8);
          this.selLen = len;
        }
      };
      this.interLoop = setInterval(inter, 45);
    }
  }

  dispose() {
    this.offBus?.();
    if (this.loop) clearInterval(this.loop);
    if (this.interLoop) clearInterval(this.interLoop);
    if (this.suspendTimer) clearTimeout(this.suspendTimer);
    for (const [t, type, l] of this.listeners) t.removeEventListener(type, l);
    this.listeners = [];
  }
}

export const sound = new Sound();
