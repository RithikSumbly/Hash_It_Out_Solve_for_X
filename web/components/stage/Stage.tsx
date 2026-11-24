"use client";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useRef } from "react";
import { Pipeline } from "./Pipeline";
import { Orbit } from "./Orbit";
import { Backdrop, Board, Flecks, Traces } from "./Board";
import { DistantPieces, Dust, Sky } from "./World";
import { Queen } from "./Queen";
import { AnchorTracker } from "./Anchors";
import { scene } from "@/lib/scene";

/**
 * Keeps the frame rate without giving up sharpness: never below the screen's own CSS resolution on a desktop
 * (she went soft at 0.7–0.8), steps down only after two slow windows in a row (< 50 fps), and climbs back as
 * soon as there is headroom (≥ 54 fps), so one slow moment does not leave her blurred for good.
 */
function AdaptiveDpr({ floor }: { floor: number }) {
  const { setDpr } = useThree();
  const acc = useRef({ t: 0, n: 0, slow: 0, dpr: typeof window !== "undefined" ? Math.min(1.25, window.devicePixelRatio) : 1 });
  useFrame((_, dt) => {
    const a = acc.current;
    a.t += dt;
    a.n++;
    if (a.t < 1.5) return;
    const fps = a.n / a.t;
    a.t = 0;
    a.n = 0;
    // (1.25 at most: the internal passes are capped there, so more would only cost the final pass)
    // full screen: no more than the screen's own resolution, and on a big screen it may go below it (a pixel
    // budget of about 1.6 million) rather than lag
    const fs = !!document.fullscreenElement;
    const max = Math.min(fs ? 1 : 1.25, window.devicePixelRatio);
    const budget = fs ? Math.max(0.6, Math.sqrt(1.6e6 / (innerWidth * innerHeight))) : floor;
    const lo = Math.min(floor, budget, max);
    if (a.dpr > max) a.slow = 2;
    let next = a.dpr;
    // (steps down below 50 fps: a busy laptop can sit in the 40s, laggy but never adapting)
    a.slow = fps < 50 ? a.slow + 1 : 0;
    if (a.slow >= 2 && a.dpr > lo) {
      next = Math.max(lo, a.dpr - 0.125);
      a.slow = 0;
    } else if (fps >= 54 && a.dpr < max) next = Math.min(max, a.dpr + 0.1);
    if (Math.abs(next - a.dpr) > 0.01) {
      a.dpr = next;
      setDpr(next);
    }
  });
  return null;
}

/** Counts the stage's first frames: the first few compile every shader, which is when a reload would stutter. */
function Warm() {
  const n = useRef(0);
  useFrame(() => {
    if (!scene.stageWarm && ++n.current >= 12) scene.stageWarm = true;
  });
  return null;
}

function DebugHandle() {
  const three = useThree();
  const w = window as unknown as { __rq?: Record<string, unknown> };
  w.__rq = { ...(w.__rq ?? {}), three };
  return null;
}

/** The single WebGL stage behind the DOM. Mounted once; the queen is never unmounted. Phones get a lighter tier. */
export default function Stage({ phone = false }: { phone?: boolean }) {
  return (
    <Canvas
      style={{ position: "fixed", inset: 0, zIndex: 0 }}
      dpr={phone ? [0.7, 1.25] : [1, 1.25]}
      gl={{ antialias: false, alpha: false, powerPreference: "high-performance", stencil: false, depth: true }}
      camera={{ fov: 30, near: 0.05, far: 240, position: [0, 1.3, 5.9] }}
      aria-hidden
    >
      <AdaptiveDpr floor={phone ? 0.7 : 1} />
      <Warm />
      <DebugHandle />
      <Orbit />
      <Sky />
      <DistantPieces />
      <Backdrop />
      <Board />
      <Flecks />
      <Traces />
      <Dust count={phone ? 360 : 700} />
      <Queen />
      <AnchorTracker />
      <Pipeline quality={phone ? 0 : 1} />
    </Canvas>
  );
}
