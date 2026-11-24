"use client";
/**
 * The ink controller: turns chain events, the cursor and scroll velocity into fluid splats on the board.
 * Board geometry: square of BOARD world units centred on the queen; uv (0..1) ↔ world (x, z):
 *   x = (u - 0.5) * BOARD,  z = (0.5 - v) * BOARD
 * An attacker at azimuth a sits in world direction (sin a, cos a).
 */
import { spendVerdict } from "@redqueen/sdk";
import { bus } from "@/lib/bus";
import { hash01 } from "@/lib/format";
import { scene } from "@/lib/scene";
import { arena } from "@/lib/store";
import type { Fluid } from "./fluid";

export const BOARD = 22;
export const TRAVEL = 0.9; // seconds from the board edge to the queen
export const START_R = 6.6; // world radius where attack jets appear
export const IMPACT_R = 0.66; // just outside the queen's foot

export const HOT: [number, number, number] = [0.9, 0.16, 0.12];
export const SILVER: [number, number, number] = [0.6, 0.62, 0.66];
export const COLD: [number, number, number] = [0.32, 0.55, 0.7];
/** brass, a payment held on its clock */
export const HELD: [number, number, number] = [0.62, 0.5, 0.3];

export function attackAngle(addr: string) {
  return hash01(addr.toLowerCase()) * Math.PI * 2;
}

export function toUv(x: number, z: number): [number, number] {
  return [x / BOARD + 0.5, 0.5 - z / BOARD];
}

interface Emitter {
  a: number; // azimuth
  r0: number;
  r1: number;
  t0: number;
  dur: number;
  color: [number, number, number];
  force: number;
  width: number;
  onDone?: () => void;
}

interface Pending {
  x: number;
  y: number;
  dx: number;
  dy: number;
  c: [number, number, number];
  r: number;
}

class Ink {
  private emitters: Emitter[] = [];
  private pending: Pending[] = [];
  private now = 0;
  private lastPointer: { u: number; v: number; t: number } | null = null;
  scrollVelocity = 0;

  /** world polar → uv */
  private uvAt(a: number, r: number) {
    return toUv(Math.sin(a) * r, Math.cos(a) * r);
  }

  splatPolar(a: number, r: number, speed: number, dirA: number, c: [number, number, number], radius = 0.012) {
    const [u, v] = this.uvAt(a, r);
    // world direction (sin, cos) maps to uv direction (sin, -cos)
    this.pending.push({ x: u, y: v, dx: Math.sin(dirA) * speed, dy: -Math.cos(dirA) * speed, c, r: radius });
  }

  splatUv(u: number, v: number, du: number, dv: number, c: [number, number, number], radius = 0.01) {
    this.pending.push({ x: u, y: v, dx: du, dy: dv, c, r: radius });
  }

  /** an attack jet from the board edge toward the queen, emitted every frame along its path */
  jet(a: number, r0: number, r1: number, dur: number, color: [number, number, number], force: number, width = 0.009, onDone?: () => void) {
    this.emitters.push({ a, r0, r1, t0: this.now, dur, color, force, width, onDone });
  }

  /** called by the pipeline every frame, before fluid.step */
  flush(fluid: Fluid, t: number, dtIn: number) {
    this.now = t;
    // after a hitch or a hidden tab, drop the backlog instead of pouring it onto the board in one frame
    if (dtIn > 0.5) {
      this.emitters = [];
      this.pending.length = 0;
    }
    const dt = Math.min(dtIn, 1 / 30);
    // emitters
    const keep: Emitter[] = [];
    for (const e of this.emitters) {
      const k = (t - e.t0) / e.dur;
      if (k >= 1) {
        e.onDone?.();
        continue;
      }
      const r = e.r0 + (e.r1 - e.r0) * k;
      const inward = e.r1 < e.r0;
      const dir = inward ? e.a + Math.PI : e.a;
      const c = e.color.map((x) => x * dt * 6) as [number, number, number];
      this.splatPolar(e.a, r, e.force, dir, c, e.width);
      keep.push(e);
    }
    this.emitters = keep;
    // scroll stirs the ink around the queen
    const sv = Math.max(-1, Math.min(1, this.scrollVelocity / 2400));
    if (Math.abs(sv) > 0.02 && !scene.reducedMotion) {
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + t * 0.7;
        this.splatPolar(a, 1.9, 260 * sv, a + Math.PI / 2, [0, 0, 0], 0.03);
      }
    }
    for (const p of this.pending.splice(0, 48)) fluid.splat(p.x, p.y, p.dx, p.dy, p.c, p.r);
    if (this.pending.length > 400) this.pending.length = 0;
  }

  /** cursor over the board (uv), from the raycast in the pipeline */
  pointer(u: number, v: number, t: number) {
    const last = this.lastPointer;
    this.lastPointer = { u, v, t };
    if (!last || scene.reducedMotion) return;
    const dt = Math.max(1 / 240, t - last.t);
    const du = u - last.u;
    const dv = v - last.v;
    if (Math.abs(du) + Math.abs(dv) < 1e-5 || dt > 0.25) return;
    this.splatUv(u, v, (du / dt) * 40, (dv / dt) * 40, [0.012, 0.012, 0.014], 0.006);
  }

  pointerOut() {
    this.lastPointer = null;
  }
}

export const ink = new Ink();

/** the queen refuses: red ink splashes back off her foot toward the attacker's side, then a spray */
export function splash(a: number, strength = 1) {
  const r = Math.random;
  for (let i = -3; i <= 3; i++) {
    const da = i * 0.2 + (r() - 0.5) * 0.08;
    const k = (1 - Math.abs(i) * 0.12) * strength;
    ink.splatPolar(a + da * 0.4, IMPACT_R + 0.1, 520 + r() * 160, a + da, HOT.map((x) => x * 1.05 * k) as [number, number, number], 0.011 + r() * 0.005);
  }
  for (let i = 0; i < 4; i++) {
    const da = (r() - 0.5) * 1.3;
    ink.splatPolar(a + da * 0.5, IMPACT_R + 0.35 + r() * 0.4, 300 + r() * 260, a + da, HOT.map((x) => x * 0.55 * strength) as [number, number, number], 0.005 + r() * 0.004);
  }
}

/** she holds it: a ring of brass curls round her foot on the attacker's side and lingers, nothing spills out */
export function holdRing(a: number, strength = 1) {
  for (let i = -5; i <= 5; i++) {
    const b = a + i * 0.15;
    ink.splatPolar(b, IMPACT_R + 0.06, 70, b + Math.PI / 2, HELD.map((x) => x * strength * (1 - Math.abs(i) * 0.06)) as [number, number, number], 0.009);
  }
}

/** chain events → ink choreography (live and replayed) */
export function wireInk() {
  return bus.on((e) => {
    if (e.type !== "chain" || scene.reducedMotion) return;
    const ev = e.event;
    if (ev.name === "Spend") {
      const a = attackAngle(String(ev.args.caller));
      const verdict = spendVerdict(ev);
      const f0 = Number(BigInt(ev.args.features as bigint) & 0xffffn) / 1000;
      // the attack: a pale jet across the board
      ink.jet(a, START_R, IMPACT_R, TRAVEL, [0.12, 0.12, 0.135], 140, 0.009, () => {
        if (verdict === 2) splash(a);
        else if (verdict === 1) holdRing(a);
        else {
          // it gets through: quicksilver spills out along the attacker's line, sized by the share taken
          const strength = 0.1 + Math.min(0.45, f0 * 1.2);
          ink.jet(a, 0.25, 4.2, 1.1, SILVER.map((x) => x * strength) as [number, number, number], 200, 0.009);
        }
      });
    } else if (ev.name === "Released" || ev.name === "Vetoed") {
      // a held payment settles: released, the quicksilver leaves along its sender's line; vetoed, the brass is stirred away
      const h = arena.get().holds.get(String(ev.args.id));
      const a = attackAngle(h?.from ?? String(ev.args.by));
      if (ev.name === "Released") ink.jet(a, 0.25, 4.2, 1.1, SILVER.map((x) => x * 0.3) as [number, number, number], 200, 0.009);
      else for (let i = -3; i <= 3; i++) ink.splatPolar(a + i * 0.2, IMPACT_R + 0.08, 160, a + i * 0.2 - Math.PI / 2, [0, 0, 0], 0.02);
    } else if (ev.name === "Deposit") {
      const a = Math.random() * Math.PI * 2;
      ink.jet(a, START_R, IMPACT_R, 1.2, COLD.map((x) => x * 0.6) as [number, number, number], 90, 0.01);
    } else if (ev.name === "PolicyInstalled" && !e.replay) {
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        ink.splatPolar(a, 0.9, 360, a, [0.05, 0.05, 0.055], 0.01);
      }
    } else if (ev.name === "EpochClosed" && !e.replay) {
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        ink.splatPolar(a, 2.6, 420, a + Math.PI / 2, [0, 0, 0], 0.04);
      }
    }
  });
}
