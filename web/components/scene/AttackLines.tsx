"use client";
import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { bus } from "@/lib/bus";
import { arena } from "@/lib/store";
import { radii, radiusAt } from "@/lib/shape";
import { scene } from "@/lib/scene";
import { attackAngle } from "./Shield";

const POOL = 48;
const TRAVEL = 0.9; // seconds from the edge to the rim (matches the shield's ripple delay)

/**
 * Attack vectors arrive from the edges as traced lines toward the vault. Refused ones stop at the rim
 * (the shield shatters them); passing ones pierce through to the core. Every line is a real Spend.
 * In the attack field the scroll scrubs the last 60 s of real events in slow motion.
 */
export function AttackLines() {
  const geo = useMemo(() => {
    const segs = 96;
    const g = new THREE.BufferGeometry();
    const t: number[] = [];
    const side: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i <= segs; i++) {
      t.push(i / segs, i / segs);
      side.push(-1, 1);
      if (i < segs) {
        const a = i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    g.setAttribute("aT", new THREE.Float32BufferAttribute(t, 1));
    g.setAttribute("aSide", new THREE.Float32BufferAttribute(side, 1));
    g.setAttribute("position", new THREE.Float32BufferAttribute(new Array(t.length * 3).fill(0), 3));
    g.setIndex(idx);
    return g;
  }, []);

  const mats = useMemo(
    () =>
      Array.from(
        { length: POOL },
        () =>
          new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide,
            blending: THREE.AdditiveBlending,
            uniforms: {
              uA: { value: new THREE.Vector3() },
              uB: { value: new THREE.Vector3() },
              uC: { value: new THREE.Vector3() },
              uHead: { value: -1 },
              uFade: { value: 0 },
              uRefused: { value: 0 },
              uWidth: { value: 0.012 },
              uOwn: { value: 0 },
              uBone: { value: new THREE.Color("#e8e4da") },
              uCold: { value: new THREE.Color("#7cc8ff") },
              uHot: { value: new THREE.Color("#ff3b1f") },
            },
            vertexShader: /* glsl */ `
              uniform vec3 uA; uniform vec3 uB; uniform vec3 uC; uniform float uWidth;
              attribute float aT; attribute float aSide;
              varying float vT;
              void main() {
                // path: edge A -> rim B (s 0..0.8), then rim B -> core C (s 0.8..1)
                vec3 p; vec3 d;
                if (aT <= 0.8) {
                  float u = aT / 0.8;
                  vec3 ctrl = mix(uA, uB, 0.5) + vec3(-(uB - uA).y, (uB - uA).x, 0.0) * 0.12;
                  p = mix(mix(uA, ctrl, u), mix(ctrl, uB, u), u);
                  d = normalize(mix(ctrl - uA, uB - ctrl, u));
                } else {
                  float u = (aT - 0.8) / 0.2;
                  p = mix(uB, uC, u);
                  d = normalize(uC - uB + vec3(1e-4));
                }
                vec3 n = normalize(vec3(-d.y, d.x, 0.0));
                p += n * aSide * uWidth;
                vT = aT;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
              }`,
            fragmentShader: /* glsl */ `
              uniform float uHead; uniform float uFade; uniform float uRefused; uniform float uOwn;
              uniform vec3 uBone; uniform vec3 uCold; uniform vec3 uHot;
              varying float vT;
              void main() {
                if (uHead < 0.0 || vT > uHead) discard;
                float trail = 0.42;
                float k = clamp(1.0 - (uHead - vT) / trail, 0.0, 1.0);
                float head = smoothstep(0.985, 1.0, 1.0 - (uHead - vT));
                vec3 c = mix(uBone, uCold, uOwn);
                c = mix(c, uHot, uRefused * smoothstep(0.7, 0.8, uHead) * head);
                float a = (k * k * 0.75 + head) * (1.0 - uFade);
                gl_FragColor = vec4(c * a, a);
              }`,
          }),
      ),
    [],
  );

  const meshes = useRef<(THREE.Mesh | null)[]>([]);
  const lines = useRef(
    Array.from({ length: POOL }, () => ({ start: -100, refused: false, active: false, own: false, angle: 0 })),
  );
  const next = useRef(0);
  const now = useRef(0);
  const me = useRef<string | null>(null);

  const place = (j: number, angle: number, refused: boolean, own: boolean) => {
    const m = mats[j].uniforms;
    const genes = scene.overrideGenes ?? arena.get().snapshot?.live.genes ?? new Array(32).fill(0);
    const R = radiusAt(radii(genes), angle) * 1.02;
    const dir = new THREE.Vector3(Math.sin(angle), Math.cos(angle), 0);
    m.uA.value.copy(dir).multiplyScalar(7.5).setZ(1.2);
    m.uB.value.copy(dir).multiplyScalar(R).setZ(0.18);
    m.uC.value.set(0, 0, 0.2);
    m.uRefused.value = refused ? 1 : 0;
    m.uOwn.value = own ? 1 : 0;
    m.uWidth.value = own ? 0.024 : 0.011;
  };

  useEffect(() => {
    const onWin = (e: Event) => (me.current = ((e as CustomEvent).detail as string | null)?.toLowerCase() ?? null);
    window.addEventListener("rq:me", onWin);
    const off = bus.on((e) => {
      if (e.type !== "chain" || e.event.name !== "Spend") return;
      if (scene.reducedMotion) return;
      const caller = String(e.event.args.caller).toLowerCase();
      const j = next.current++ % POOL;
      const angle = attackAngle(caller);
      const own = me.current === caller;
      place(j, angle, Boolean(e.event.args.refused), own);
      lines.current[j] = { start: now.current, refused: Boolean(e.event.args.refused), active: true, own, angle };
    });
    return () => {
      off();
      window.removeEventListener("rq:me", onWin);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useFrame((state) => {
    now.current = state.clock.elapsedTime;
    const scrub = scene.scrubTime;
    if (scrub !== null) {
      // slow-motion replay of real events from the last 60 s, positioned by chain time
      const spends = arena.get().spends;
      const window = spends.filter((s) => s.t <= scrub && s.t > scrub - 6).slice(-POOL);
      for (let j = 0; j < POOL; j++) {
        const m = mats[j].uniforms;
        const s = window[j];
        const mesh = meshes.current[j];
        if (!s) {
          m.uHead.value = -1;
          if (mesh) mesh.visible = false;
          continue;
        }
        if (mesh) mesh.visible = true;
        place(j, attackAngle(s.caller), s.refused, me.current === s.caller.toLowerCase());
        const age = (scrub - s.t) / 3; // 3x slower than live
        setHead(m, age, s.refused);
      }
      return;
    }
    for (let j = 0; j < POOL; j++) {
      const L = lines.current[j];
      const m = mats[j].uniforms;
      const mesh = meshes.current[j];
      if (!L.active) {
        m.uHead.value = -1;
        if (mesh) mesh.visible = false;
        continue;
      }
      if (mesh) mesh.visible = true;
      const age = now.current - L.start;
      if (age > 3) {
        L.active = false;
        continue;
      }
      setHead(m, age, L.refused);
    }
  });

  return (
    <group>
      {mats.map((m, j) => (
        <mesh
          key={j}
          ref={(el) => {
            meshes.current[j] = el;
          }}
          geometry={geo}
          material={m}
          frustumCulled={false}
          renderOrder={4}
          visible={false}
        />
      ))}
    </group>
  );
}

function setHead(m: { [k: string]: THREE.IUniform }, age: number, refused: boolean) {
  const reach = age / TRAVEL; // 0..1 to the rim
  if (refused) {
    m.uHead.value = Math.min(0.8, reach * 0.8);
    m.uFade.value = Math.max(0, (age - TRAVEL) / 0.5);
  } else {
    m.uHead.value = reach <= 1 ? reach * 0.8 : Math.min(1, 0.8 + (age - TRAVEL) / 0.35 * 0.2);
    m.uFade.value = Math.max(0, (age - TRAVEL - 0.35) / 1.2);
  }
  if (m.uFade.value >= 1) m.uHead.value = -1;
}
