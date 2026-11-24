"use client";
import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { bus } from "@/lib/bus";
import { arena } from "@/lib/store";
import { scene } from "@/lib/scene";
import { attackAngle } from "./Shield";

/**
 * 2,000 particles in two populations:
 *  - ambient dust whose visible density tracks the vault balance (and becomes the vault's orbit when the
 *    camera pulls back to the vault)
 *  - a burst ring-buffer driven by Spend / Deposit events: outflow streams, inflow streams, refusal shards
 */
export function Particles({ count = 2000 }: { count?: number }) {
  const ambientN = Math.floor(count * 0.68);
  const burstN = count - ambientN;

  const ambient = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const seed = new Float32Array(ambientN * 4);
    for (let i = 0; i < ambientN * 4; i++) seed[i] = Math.random();
    g.setAttribute("aSeed", new THREE.BufferAttribute(seed, 4));
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(ambientN * 3), 3));
    return g;
  }, [ambientN]);

  const ambientMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uTime: { value: 0 },
          uFill: { value: 0.6 },
          uVault: { value: 0 },
          uPx: { value: 1 },
          uDim: { value: 0 },
          uBone: { value: new THREE.Color("#e8e4da") },
          uCold: { value: new THREE.Color("#7cc8ff") },
        },
        vertexShader: /* glsl */ `
          uniform float uTime; uniform float uFill; uniform float uVault; uniform float uPx;
          attribute vec4 aSeed;
          varying float vA; varying float vCold;
          void main() {
            // dust field: a loose shell around the shield
            float th = aSeed.x * 6.28318530718 + uTime * (0.006 + aSeed.z * 0.01);
            float ph = acos(2.0 * aSeed.y - 1.0);
            float rr = 1.7 + pow(aSeed.z, 0.7) * 4.6;
            vec3 dust = vec3(sin(ph) * cos(th), cos(ph) * 0.8, sin(ph) * sin(th) * 0.6) * rr;
            // vault orbit: a flattened ring around the plinth below the shield
            float oa = aSeed.x * 6.28318530718 + uTime * (0.05 + 0.18 / (1.0 + aSeed.z * 3.0));
            float orr = 1.45 + aSeed.z * 2.4;
            vec3 orbit = vec3(cos(oa) * orr, -2.15 + (aSeed.y - 0.5) * 0.18 + sin(oa * 3.0 + aSeed.w * 6.0) * 0.03, sin(oa) * orr);
            vec3 p = mix(dust, orbit, smoothstep(0.0, 1.0, uVault));
            float on = step(aSeed.w, uFill);
            vA = on * (0.12 + 0.5 * aSeed.y) * (0.55 + 0.45 * sin(uTime * (0.6 + aSeed.x * 1.4) + aSeed.w * 30.0));
            vCold = step(0.93, aSeed.y);
            vec4 mv = modelViewMatrix * vec4(p, 1.0);
            gl_PointSize = (1.2 + aSeed.z * 1.8) * uPx * (6.0 / -mv.z);
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: /* glsl */ `
          uniform vec3 uBone; uniform vec3 uCold; uniform float uDim;
          varying float vA; varying float vCold;
          void main() {
            float d = length(gl_PointCoord - 0.5);
            float a = smoothstep(0.5, 0.0, d) * vA * (1.0 - uDim * 0.6);
            gl_FragColor = vec4(mix(uBone, uCold, vCold) * a, a);
          }`,
      }),
    [],
  );

  // ---------------------------------------------------------------- bursts
  const burst = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("aStart", new THREE.BufferAttribute(new Float32Array(burstN * 3), 3));
    g.setAttribute("aVel", new THREE.BufferAttribute(new Float32Array(burstN * 3), 3));
    const birth = new Float32Array(burstN).fill(-100);
    g.setAttribute("aBirth", new THREE.BufferAttribute(birth, 1));
    g.setAttribute("aKind", new THREE.BufferAttribute(new Float32Array(burstN), 1));
    g.setAttribute("aLife", new THREE.BufferAttribute(new Float32Array(burstN).fill(1), 1));
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(burstN * 3), 3));
    return g;
  }, [burstN]);

  const burstMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uTime: { value: 0 },
          uPx: { value: 1 },
          uBone: { value: new THREE.Color("#e8e4da") },
          uCold: { value: new THREE.Color("#7cc8ff") },
          uHot: { value: new THREE.Color("#ff3b1f") },
        },
        vertexShader: /* glsl */ `
          uniform float uTime; uniform float uPx;
          attribute vec3 aStart; attribute vec3 aVel; attribute float aBirth; attribute float aKind; attribute float aLife;
          varying float vA; varying float vKind; varying float vSpin;
          void main() {
            float age = uTime - aBirth;
            float alive = step(0.0, age) * step(age, aLife);
            float k = age / aLife;
            vec3 p = aStart + aVel * age;
            if (aKind > 1.5 && aKind < 2.5) { p = aStart + aVel * (1.0 - exp(-age * 3.0)) / 3.0; p.y -= age * age * 0.35; }
            if (aKind > 0.5 && aKind < 1.5) { p = mix(aStart, vec3(0.0), smoothstep(0.0, 1.0, k)); }
            vA = alive * (1.0 - k) * (aKind > 1.5 && aKind < 2.5 ? 1.0 : 0.7);
            vKind = aKind;
            vSpin = aBirth * 13.0 + age * 6.0;
            vec4 mv = modelViewMatrix * vec4(p, 1.0);
            float size = aKind > 1.5 && aKind < 2.5 ? 7.0 : 2.6;
            gl_PointSize = size * uPx * (6.0 / -mv.z) * alive;
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: /* glsl */ `
          uniform vec3 uBone; uniform vec3 uCold; uniform vec3 uHot;
          varying float vA; varying float vKind; varying float vSpin;
          void main() {
            vec2 q = gl_PointCoord - 0.5;
            float a;
            vec3 c;
            if (vKind > 1.5 && vKind < 2.5) {
              // shard: a spinning sliver of the membrane
              float cs = cos(vSpin), sn = sin(vSpin);
              q = mat2(cs, -sn, sn, cs) * q;
              a = step(abs(q.x) * 3.2 + q.y, 0.32) * step(-0.38, q.y);
              c = uHot;
            } else {
              a = smoothstep(0.5, 0.0, length(q));
              c = vKind > 0.5 && vKind < 1.5 ? uCold : uBone;
            }
            gl_FragColor = vec4(c * a * vA, a * vA);
          }`,
      }),
    [],
  );

  const cursor = useRef(0);
  const clock = useRef(0);

  useEffect(() => {
    const start = burst.getAttribute("aStart") as THREE.BufferAttribute;
    const vel = burst.getAttribute("aVel") as THREE.BufferAttribute;
    const birth = burst.getAttribute("aBirth") as THREE.BufferAttribute;
    const kind = burst.getAttribute("aKind") as THREE.BufferAttribute;
    const life = burst.getAttribute("aLife") as THREE.BufferAttribute;

    const emit = (n: number, f: (i: number) => { s: [number, number, number]; v: [number, number, number]; k: number; l: number; d?: number }) => {
      const t0 = clock.current;
      for (let i = 0; i < n; i++) {
        const j = cursor.current++ % burstN;
        const p = f(i);
        start.setXYZ(j, ...p.s);
        vel.setXYZ(j, ...p.v);
        birth.setX(j, t0 + (p.d ?? 0));
        kind.setX(j, p.k);
        life.setX(j, p.l);
      }
      for (const a of [start, vel, birth, kind, life]) a.needsUpdate = true;
    };

    return bus.on((e) => {
      if (e.type !== "chain" || scene.reducedMotion) return;
      const ev = e.event;
      if (ev.name === "Spend") {
        const ang = attackAngle(String(ev.args.caller));
        const dir: [number, number] = [Math.sin(ang), Math.cos(ang)];
        const f0 = Number((BigInt(ev.args.features as bigint) & 0xffffn)) / 1000;
        setTimeout(() => {
          if (ev.args.refused) {
            // shards break off the rim where the attack hit
            emit(9 + Math.floor(Math.random() * 6), () => {
              const spread = (Math.random() - 0.5) * 1.6;
              const a = ang + spread * 0.5;
              const sp = 1.4 + Math.random() * 2.2;
              return { s: [dir[0] * 1.08, dir[1] * 1.08, 0.12], v: [Math.sin(a) * sp, Math.cos(a) * sp, (Math.random() - 0.3) * 1.2], k: 2, l: 1.1 + Math.random() * 0.6 };
            });
          } else {
            // the vault bleeds: a stream out along the attacker's line, sized by the share taken
            const n = Math.min(120, 8 + Math.floor(f0 * 260));
            emit(n, (i) => {
              const a = ang + (Math.random() - 0.5) * 0.35;
              const sp = 1.2 + Math.random() * 2.6;
              return { s: [(Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.3, 0.2], v: [Math.sin(a) * sp, Math.cos(a) * sp, (Math.random() - 0.5) * 0.4], k: 0, l: 1.6 + Math.random() * 1.2, d: i * 0.008 };
            });
          }
        }, 900);
      } else if (ev.name === "Deposit") {
        emit(60, (i) => {
          const a = Math.random() * Math.PI * 2;
          const r = 4.5 + Math.random() * 2;
          return { s: [Math.sin(a) * r, Math.cos(a) * r, (Math.random() - 0.5) * 2], v: [0, 0, 0], k: 1, l: 1.8 + Math.random() * 0.8, d: i * 0.01 };
        });
      }
    });
  }, [burst, burstN]);

  useFrame((state, dt) => {
    clock.current = state.clock.elapsedTime;
    const px = state.gl.getPixelRatio() * (state.size.height / 900);
    ambientMat.uniforms.uTime.value = state.clock.elapsedTime;
    ambientMat.uniforms.uPx.value = px;
    burstMat.uniforms.uTime.value = state.clock.elapsedTime;
    burstMat.uniforms.uPx.value = px;
    const s = arena.get().snapshot;
    // density follows the vault: full when holding its epoch-start balance
    const fill = s && s.epochStartBalance > 0n ? Math.min(1, Number((s.vaultBalance * 1000n) / s.epochStartBalance) / 1000) : 0.6;
    const u = ambientMat.uniforms;
    u.uFill.value += (0.15 + 0.85 * fill - u.uFill.value) * Math.min(1, dt * 2);
    const vaultTarget = scene.stage >= 1.6 && scene.stage <= 3.4 ? 1 : 0;
    u.uVault.value += (vaultTarget - u.uVault.value) * Math.min(1, dt * 1.6);
    u.uDim.value = scene.dim;
  });

  return (
    <group>
      <points geometry={ambient} material={ambientMat} frustumCulled={false} />
      <points geometry={burst} material={burstMat} frustumCulled={false} renderOrder={5} />
    </group>
  );
}
