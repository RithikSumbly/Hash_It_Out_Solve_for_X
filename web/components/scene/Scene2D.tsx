"use client";
/**
 * The designed 2D-canvas edition, for phones and devices without WebGL. Same information as the WebGL
 * stage: the queen's live silhouette (morphing on install), the quicksilver level, refusals lighting the
 * bands the contract named, attack traces from the attacker's side, shards, drains and a field of flecks.
 */
import { useEffect, useRef } from "react";
import { bus } from "@/lib/bus";
import { arena, liveGenes } from "@/lib/store";
import { scene } from "@/lib/scene";
import { hash01 } from "@/lib/format";
import { easeOut } from "@/lib/motion";
import { BALL_R, BALL_T, BAND_H, BAND_T0, CAVITY_T0, CAVITY_T1, CROWN_RIM_R, CROWN_RIM_T, lerpShape, outerRadius, shapeOf, type Shape } from "@/lib/queen";

const IVORY = "239,232,218";
const COLD = "159,212,224";
const HOT = "232,55,44";
const HELD = "214,182,126";

interface Trace {
  a: number;
  start: number;
  refused: boolean;
  /** held at her foot, nothing spilled */
  held: boolean;
  own: boolean;
}
interface Bit {
  x: number;
  y: number;
  vx: number;
  vy: number;
  birth: number;
  life: number;
  kind: 0 | 1 | 2;
}

const STAGE_X = [0, 0.16, -0.18, 0.12, -0.2, -0.22, 0.2, 0.26, -0.2, 0, 0.16];
const STAGE_S = [1, 1, 1.15, 0.7, 0.9, 0.85, 0.95, 0.6, 0.6, 0.65, 1];

export default function Scene2D({ phone = false }: { phone?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current!;
    const ctx = cv.getContext("2d")!;
    let raf = 0;
    let w = 0;
    let h = 0;
    let dpr = 1;
    const resize = () => {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      w = cv.clientWidth;
      h = cv.clientHeight;
      cv.width = Math.floor(w * dpr);
      cv.height = Math.floor(h * dpr);
    };
    resize();
    window.addEventListener("resize", resize);

    const N = phone ? 800 : 2000;
    const dust = Array.from({ length: N }, () => ({ x: Math.random(), y: Math.random(), s: Math.random(), p: Math.random() * 6.28 }));
    let cur: Shape = shapeOf(liveGenes(arena.get()));
    let from = cur;
    let to = cur;
    let morphStart = -1;
    let key = liveGenes(arena.get()).join(",");
    let ovKey = "";
    let flash = 0;
    let flashA = 0;
    const hit = new Array(8).fill(0);
    let fill = 0.9;
    let fillTarget = 0.9;
    const traces: Trace[] = [];
    const bits: Bit[] = [];
    let me: string | null = null;
    const onMe = (e: Event) => (me = ((e as CustomEvent).detail as string | null)?.toLowerCase() ?? null);
    window.addEventListener("rq:me", onMe);
    const t0 = performance.now();
    const now = () => (performance.now() - t0) / 1000;

    const morphTo = (genes: number[]) => {
      const k = genes.join(",");
      if (k === key) return;
      key = k;
      from = cur;
      to = shapeOf(genes);
      morphStart = now();
    };

    const off = bus.on((e) => {
      if (e.type === "snapshot") {
        if (!scene.overrideGenes) morphTo(e.snapshot.live.genes);
        const sn = e.snapshot;
        fillTarget = sn.epochStartBalance > 0n ? Math.max(0.04, Math.min(1, Number((sn.vaultBalance * 1000n) / sn.epochStartBalance) / 1000)) : 0.9;
        return;
      }
      if (e.type !== "chain") return;
      const ev = e.event;
      if (ev.name === "Spend") {
        const caller = String(ev.args.caller).toLowerCase();
        const a = hash01(caller) * Math.PI * 2;
        const refused = Boolean(ev.args.refused);
        const held = Number(ev.args.verdict ?? 0) === 1;
        const reason = BigInt(ev.args.reason as bigint);
        if (scene.reducedMotion) {
          if (refused) flash = 1;
          return;
        }
        traces.push({ a, start: now(), refused, held, own: caller === me });
        if (traces.length > 36) traces.shift();
        setTimeout(() => {
          if (refused) {
            flash = 1;
            flashA = a;
            for (let k = 0; k < 8; k++) hit[k] = (reason >> BigInt(k)) & 1n ? 1 : 0;
            for (let i = 0; i < 12; i++) {
              const b = a + Math.PI + (Math.random() - 0.5) * 1.2;
              bits.push({ x: Math.sin(a) * 0.32, y: 0, vx: Math.sin(b) * (0.4 + Math.random() * 0.6), vy: -0.3 - Math.random() * 0.5, birth: now(), life: 1 + Math.random() * 0.6, kind: 2 });
            }
          } else if (!held) {
            for (let i = 0; i < 30; i++)
              bits.push({ x: 0, y: -0.25, vx: Math.sin(a) * (0.6 + Math.random()), vy: (Math.random() - 0.3) * 0.25, birth: now() + i * 0.01, life: 1.4 + Math.random(), kind: 0 });
          }
          if (bits.length > 700) bits.splice(0, bits.length - 700);
        }, 900);
      } else if (ev.name === "PolicyInstalled" && !scene.overrideGenes && !e.replay) {
        const lo = ev.args.lo as bigint;
        const hi = ev.args.hi as bigint;
        const g: number[] = [];
        for (let i = 0; i < 16; i++) {
          const x = Number((lo >> BigInt(i * 16)) & 0xffffn);
          const y = Number((hi >> BigInt(i * 16)) & 0xffffn);
          g[i] = x >= 0x8000 ? x - 0x10000 : x;
          g[i + 16] = y >= 0x8000 ? y - 0x10000 : y;
        }
        morphTo(g);
      }
    });

    let sx = 0;
    let ss = 1;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const t = now();
      const rm = scene.reducedMotion;
      const si = Math.max(0, Math.min(10, scene.stage));
      const i0 = Math.floor(si);
      const f = si - i0;
      const tx = phone ? 0 : STAGE_X[i0] + (STAGE_X[Math.min(10, i0 + 1)] - STAGE_X[i0]) * f;
      const ts = scene.cinema ? 1.15 : STAGE_S[i0] + (STAGE_S[Math.min(10, i0 + 1)] - STAGE_S[i0]) * f;
      sx += (tx - sx) * 0.08;
      ss += (ts - ss) * 0.08;
      const ov = scene.overrideGenes ? scene.overrideGenes.join(",") : "";
      if (ov !== ovKey) {
        ovKey = ov;
        morphTo(scene.overrideGenes ?? liveGenes(arena.get()));
      }
      if (morphStart >= 0) {
        const p = rm ? 1 : easeOut((t - morphStart) / 1.6);
        cur = lerpShape(from, to, p);
        if (p >= 1) morphStart = -1;
      }
      fill += (fillTarget - fill) * 0.04;
      flash = Math.max(0, flash - 1 / 50);

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#050608";
      ctx.fillRect(0, 0, w, h);
      const dim = 1 - scene.dim * 0.6;

      // the queen's frame: height in px, foot position
      const QH = Math.min(h * (phone ? 0.5 : 0.7), w * 1.1) * ss;
      const cx = w / 2 + sx * w;
      const foot = phone ? h * 0.58 : h * 0.5 + QH * 0.5;
      const intro = easeOut(Math.max(0, (scene.intro - 0.3) / 0.7));

      // floor: a faint board receding to the horizon, and her reflection pool
      const horizon = foot - QH * 0.06;
      for (let k = 0; k < 9; k++) {
        const yy = horizon + Math.pow(k / 8, 2) * (h - horizon);
        ctx.strokeStyle = `rgba(${IVORY},${0.03 * dim})`;
        ctx.beginPath();
        ctx.moveTo(0, yy);
        ctx.lineTo(w, yy);
        ctx.stroke();
      }
      const pool = ctx.createRadialGradient(cx, foot, 0, cx, foot, QH * 0.6);
      pool.addColorStop(0, `rgba(${IVORY},${0.06 * dim})`);
      pool.addColorStop(1, `rgba(${IVORY},0)`);
      ctx.fillStyle = pool;
      ctx.fillRect(cx - QH, foot - QH * 0.3, QH * 2, QH * 0.6);

      // flecks
      for (const d of dust) {
        const yy = horizon + (d.y * 0.9 + 0.05) * (h - horizon);
        const xx = (((d.x + (rm ? 0 : t * 0.004 * (d.s - 0.5))) % 1) + 1) % 1;
        const al = (0.06 + d.s * 0.18) * (0.6 + 0.4 * Math.sin(t * 0.8 + d.p)) * dim;
        ctx.fillStyle = `rgba(${IVORY},${al})`;
        ctx.fillRect(xx * w, yy, 1.3, 1.3);
      }

      // traces across the floor
      for (const L of traces) {
        const age = t - L.start;
        if (age > 2.4) continue;
        const ex = cx + Math.sin(L.a) * w * 0.7;
        const ey = foot + Math.cos(L.a) * QH * 0.18 + 6;
        const reach = Math.min(1, age / 0.9);
        const hx = ex + (cx + Math.sin(L.a) * QH * 0.1 - ex) * reach;
        const hy = ey + (foot - ey) * reach;
        const fade = L.refused ? Math.max(0, 1 - Math.max(0, age - 0.9) / 0.5) : L.held ? Math.max(0, 1 - Math.max(0, age - 1.6) / 0.8) : Math.max(0, 1 - Math.max(0, age - 1.3) / 1.0);
        const g = ctx.createLinearGradient(ex, ey, hx, hy);
        const c = L.own ? COLD : IVORY;
        g.addColorStop(0, `rgba(${c},0)`);
        g.addColorStop(1, `rgba(${L.refused && age > 0.85 ? HOT : L.held && age > 0.85 ? HELD : c},${0.85 * fade})`);
        ctx.strokeStyle = g;
        ctx.lineWidth = L.own ? 2.4 : 1.2;
        ctx.beginPath();
        ctx.moveTo(ex + (hx - ex) * 0.45, ey + (hy - ey) * 0.45);
        ctx.lineTo(hx, hy);
        ctx.stroke();
      }

      // the queen: silhouette path from her live shape
      if (intro > 0.001) {
        const H = QH / (BALL_T + BALL_R);
        const N = 140;
        const pts: [number, number][] = [];
        for (let i = 0; i <= N; i++) {
          const tt = (i / N) * CROWN_RIM_T * intro;
          pts.push([outerRadius(cur, tt) * H, foot - tt * H]);
        }
        const body = new Path2D();
        body.moveTo(cx + pts[0][0], pts[0][1]);
        for (const [r, y] of pts) body.lineTo(cx + r, y);
        // crown points across the front
        const rim = CROWN_RIM_R * H;
        const crownY = foot - CROWN_RIM_T * H * intro;
        for (let j = 6; j >= -6; j--) {
          const a = (j / 6) * (Math.PI / 2);
          const k = (((Math.round((a / (Math.PI * 2)) * 8) % 8) + 8) % 8);
          const onPt = Math.abs((a / (Math.PI * 2)) * 8 - Math.round((a / (Math.PI * 2)) * 8)) < 0.15;
          body.lineTo(cx + Math.sin(a) * rim, crownY - (onPt ? cur.points[k] * H * intro : 0));
        }
        for (let i = N; i >= 0; i--) body.lineTo(cx - pts[i][0], pts[i][1]);
        body.closePath();

        // quicksilver, clipped to her body
        ctx.save();
        ctx.clip(body);
        const lvl = foot - (CAVITY_T0 + (CAVITY_T1 - CAVITY_T0) * fill * intro) * H;
        const lg = ctx.createLinearGradient(cx - QH * 0.15, 0, cx + QH * 0.15, 0);
        lg.addColorStop(0, `rgba(170,176,186,${0.75 * dim})`);
        lg.addColorStop(0.42, `rgba(236,238,242,${0.95 * dim})`);
        lg.addColorStop(1, `rgba(120,126,136,${0.75 * dim})`);
        ctx.fillStyle = lg;
        ctx.fillRect(cx - QH, lvl, QH * 2, foot - CAVITY_T0 * H - lvl);
        // glass body tint and a tall highlight
        ctx.fillStyle = `rgba(${IVORY},${0.035 * dim})`;
        ctx.fillRect(cx - QH, foot - QH * 1.1, QH * 2, QH * 1.2);
        const hl = ctx.createLinearGradient(cx - QH * 0.12, 0, cx - QH * 0.02, 0);
        hl.addColorStop(0, `rgba(${IVORY},0)`);
        hl.addColorStop(0.5, `rgba(${IVORY},${0.16 * dim})`);
        hl.addColorStop(1, `rgba(${IVORY},0)`);
        ctx.fillStyle = hl;
        ctx.fillRect(cx - QH * 0.12, foot - QH, QH * 0.1, QH);
        // refusals light the bands the contract named
        if (flash > 0)
          for (let k = 0; k < 8; k++) {
            if (!hit[k]) continue;
            const y0 = foot - (BAND_T0 + (k + 1) * BAND_H) * H;
            ctx.fillStyle = `rgba(${HOT},${0.55 * flash})`;
            ctx.fillRect(cx - QH, y0, QH * 2, BAND_H * H);
          }
        ctx.restore();
        ctx.lineWidth = 1.4;
        ctx.strokeStyle = `rgba(${IVORY},${0.9 * dim})`;
        ctx.stroke(body);
        if (flash > 0) {
          ctx.strokeStyle = `rgba(${HOT},${flash})`;
          ctx.lineWidth = 2.2;
          ctx.stroke(body);
        }
        // the ball
        if (intro > 0.95) {
          ctx.beginPath();
          ctx.arc(cx, foot - BALL_T * H, BALL_R * H, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(${IVORY},${0.9 * dim})`;
          ctx.stroke();
        }
        // 4 level ticks
        for (let q = 1; q <= 4; q++) {
          const yy = foot - (CAVITY_T0 + (CAVITY_T1 - CAVITY_T0) * q * 0.25) * H;
          ctx.fillStyle = `rgba(${IVORY},0.25)`;
          ctx.fillRect(cx - QH * 0.03, yy, QH * 0.06, 1);
        }
      }

      // shards and spills
      for (const b of bits) {
        const age = t - b.birth;
        if (age < 0 || age > b.life) continue;
        const k = age / b.life;
        const px = cx + (b.x + b.vx * age * 0.6) * QH;
        const py = foot + (b.y + b.vy * age * 0.5 + age * age * 0.25) * QH * 0.4;
        if (b.kind === 2) {
          ctx.save();
          ctx.translate(px, py);
          ctx.rotate(age * 6 + b.vx * 10);
          ctx.fillStyle = `rgba(${HOT},${1 - k})`;
          ctx.beginPath();
          ctx.moveTo(0, -5);
          ctx.lineTo(2, 3);
          ctx.lineTo(-2, 3);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        } else {
          ctx.fillStyle = `rgba(225,228,234,${(1 - k) * 0.8})`;
          ctx.fillRect(px, py, 2, 2);
        }
      }
      void flashA;
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      off();
      window.removeEventListener("resize", resize);
      window.removeEventListener("rq:me", onMe);
    };
  }, [phone]);

  return <canvas ref={ref} aria-hidden className="fixed inset-0 h-full w-full" style={{ zIndex: 0 }} />;
}
