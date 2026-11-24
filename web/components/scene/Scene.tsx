"use client";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useRef } from "react";
import { Shield } from "./Shield";
import { Particles } from "./Particles";
import { AttackLines } from "./AttackLines";
import { CameraRig, PostFX, VaultBase } from "./Rig";

/** Keeps 60 fps on modest hardware: lowers the pixel ratio when frames run long, raises it when there is headroom. */
function AdaptiveDpr() {
  const { gl } = useThree();
  const acc = useRef({ t: 0, n: 0, dpr: Math.min(2, typeof window !== "undefined" ? window.devicePixelRatio : 1) });
  useFrame((_, dt) => {
    const a = acc.current;
    a.t += dt;
    a.n++;
    if (a.t > 1.5) {
      const fps = a.n / a.t;
      const max = Math.min(2, window.devicePixelRatio);
      if (fps < 52 && a.dpr > 0.75) a.dpr = Math.max(0.75, a.dpr - 0.25);
      else if (fps > 58 && a.dpr < max) a.dpr = Math.min(max, a.dpr + 0.125);
      if (Math.abs(gl.getPixelRatio() - a.dpr) > 0.01) gl.setPixelRatio(a.dpr);
      a.t = 0;
      a.n = 0;
    }
  });
  return null;
}

/** Exposes the renderer on window.__rq for headless verification (pixel read-back). */
function DebugHandle() {
  const three = useThree();
  const w = window as unknown as { __rq?: Record<string, unknown> };
  w.__rq = { ...(w.__rq ?? {}), three };
  return null;
}

/** The single WebGL canvas behind the DOM. It is mounted once and never unmounted. */
export default function Scene() {
  return (
    <Canvas
      className="!fixed inset-0"
      style={{ position: "fixed", inset: 0, zIndex: 0 }}
      dpr={[0.75, 2]}
      gl={{ antialias: false, alpha: false, powerPreference: "high-performance", stencil: false }}
      camera={{ fov: 35, near: 0.1, far: 100, position: [0, 0, 5.6] }}
      aria-hidden
    >
      <color attach="background" args={["#060708"]} />
      <AdaptiveDpr />
      <DebugHandle />
      <CameraRig />
      <Particles count={2000} />
      <VaultBase />
      <Shield />
      <AttackLines />
      <PostFX />
    </Canvas>
  );
}
