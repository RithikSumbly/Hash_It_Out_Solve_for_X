"use client";
import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { bus } from "@/lib/bus";
import { arena, liveGenes } from "@/lib/store";
import { radii, VERTEX_GENE } from "@/lib/shape";
import { scene } from "@/lib/scene";
import { hash01 } from "@/lib/format";
import { easeOut } from "@/lib/motion";
import { SHIELD_FRAG, SHIELD_VERT, HALO_FRAG, HALO_VERT } from "./glsl";

const BONE = new THREE.Color("#e8e4da");
const COLD = new THREE.Color("#7cc8ff");
const HOT = new THREE.Color("#ff3b1f");

function polarGeometry(rings: number, segments: number, r0: number, r1: number) {
  const g = new THREE.BufferGeometry();
  const polar: number[] = [];
  const index: number[] = [];
  for (let i = 0; i <= rings; i++) {
    const r = r0 + (r1 - r0) * Math.pow(i / rings, 0.85);
    for (let j = 0; j <= segments; j++) polar.push(r, (j / segments) * Math.PI * 2);
  }
  const row = segments + 1;
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      const a = i * row + j;
      const b = a + row;
      index.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  g.setAttribute("aPolar", new THREE.Float32BufferAttribute(polar, 2));
  g.setAttribute("position", new THREE.Float32BufferAttribute(new Array((polar.length / 2) * 3).fill(0), 3));
  g.setIndex(index);
  return g;
}

/** angle on the rim an attacker's line arrives from (stable per address) */
export function attackAngle(caller: string) {
  return hash01(caller.toLowerCase()) * Math.PI * 2;
}

function agitation(genes: number[]) {
  return VERTEX_GENE.map((g) => Math.min(1, Math.abs(genes[g] ?? 0) / 1400));
}

export function Shield() {
  const shieldGeo = useMemo(() => polarGeometry(56, 256, 0, 1), []);
  const haloGeo = useMemo(() => polarGeometry(24, 256, 0, 1), []);
  const start = useMemo(() => radii(liveGenes(arena.get())), []);

  const uniforms = useMemo(
    () => ({
      uRadA: { value: Float32Array.from(start) },
      uRadB: { value: Float32Array.from(start) },
      uMorph: { value: 1 },
      uTime: { value: 0 },
      uBreath: { value: 0.024 },
      uScale: { value: 0.0001 },
      uRipples: { value: Array.from({ length: 12 }, () => new THREE.Vector4(0, -100, 0, 1)) },
      uAgit: { value: Float32Array.from(agitation(liveGenes(arena.get()))) },
      uFlash: { value: 0 },
      uFlashAngle: { value: 0 },
      uLive: { value: 0 },
      uBone: { value: BONE },
      uCold: { value: COLD },
      uHot: { value: HOT },
      uDim: { value: 0 },
      // halo
      uShocks: { value: Array.from({ length: 4 }, () => new THREE.Vector4(-100, 0, 0, 0)) },
      uLab: { value: new Float32Array(8) },
      uLabRefused: { value: new Float32Array(8) },
      uLabCount: { value: 0 },
      uIntro: { value: 0 },
    }),
    [start],
  );

  // build the materials imperatively so they share THIS uniforms object with the frame loop
  const shieldMat = useMemo(() => new THREE.ShaderMaterial({ vertexShader: SHIELD_VERT, fragmentShader: SHIELD_FRAG, uniforms, side: THREE.DoubleSide }), [uniforms]);
  const haloMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: HALO_VERT,
        fragmentShader: HALO_FRAG,
        uniforms,
        side: THREE.DoubleSide,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    [uniforms],
  );

  const st = useRef({
    morphStart: -1,
    morphDur: 1.8,
    current: start.slice(),
    target: start.slice(),
    rip: 0,
    shock: 0,
    flash: 0,
    liveBeat: 0,
    lastGenesKey: "",
  });

  // choreography: chain events -> shield responses
  useEffect(() => {
    const morphTo = (genes: number[]) => {
      const key = genes.join(",");
      if (key === st.current.lastGenesKey) return;
      st.current.lastGenesKey = key;
      const s = st.current;
      // freeze the current interpolated shape as A
      const t = s.morphStart < 0 ? 1 : easeOut((uniforms.uTime.value - s.morphStart) / s.morphDur);
      const now = s.current.map((a, i) => a + (s.target[i] - a) * t);
      s.current = now;
      s.target = radii(genes);
      uniforms.uRadA.value.set(now);
      uniforms.uRadB.value.set(s.target);
      uniforms.uAgit.value.set(agitation(genes));
      s.morphStart = uniforms.uTime.value;
      s.morphDur = scene.reducedMotion ? 0.001 : 1.8;
      // a ripple from every gene at once
      for (let k = 0; k < 4; k++) ripple((k / 4) * Math.PI * 2, 0.9, 0);
    };
    const ripple = (angle: number, strength: number, from = 1) => {
      if (scene.reducedMotion) return;
      const r = uniforms.uRipples.value[st.current.rip++ % 12];
      r.set(angle, uniforms.uTime.value, strength, from);
    };
    const shock = (angle: number, strength: number) => {
      const s = uniforms.uShocks.value[st.current.shock++ % 4];
      s.set(uniforms.uTime.value, strength, angle, 0);
    };
    st.current.lastGenesKey = liveGenes(arena.get()).join(",");
    return bus.on((e) => {
      if (e.type === "snapshot") {
        if (!scene.overrideGenes) morphTo(e.snapshot.live.genes);
        return;
      }
      if (e.type === "lab-preview") {
        uniforms.uLabCount.value = e.steps.length;
        e.steps.slice(0, 8).forEach((s, i) => {
          uniforms.uLab.value[i] = s.ratio;
          uniforms.uLabRefused.value[i] = s.refused ? 1 : 0;
        });
        return;
      }
      if (e.type !== "chain") return;
      const ev = e.event;
      if (ev.name === "Spend") {
        const angle = attackAngle(String(ev.args.caller));
        const refused = Boolean(ev.args.refused);
        // the ripple arrives with the attack line (~0.9 s of travel)
        const delay = scene.reducedMotion ? 0 : 900;
        setTimeout(() => {
          ripple(angle, refused ? 1.0 : 0.55);
          if (refused) {
            st.current.flash = 1;
            uniforms.uFlashAngle.value = angle;
            shock(angle, 1);
          }
        }, delay);
      } else if (ev.name === "PolicyInstalled" && !e.replay) {
        if (!scene.overrideGenes) {
          const g = [] as number[];
          const lo = ev.args.lo as bigint;
          const hi = ev.args.hi as bigint;
          for (let i = 0; i < 16; i++) {
            const a = Number((lo >> BigInt(i * 16)) & 0xffffn);
            const b = Number((hi >> BigInt(i * 16)) & 0xffffn);
            g[i] = a >= 0x8000 ? a - 0x10000 : a;
            g[i + 16] = b >= 0x8000 ? b - 0x10000 : b;
          }
          morphTo(g);
        }
        st.current.liveBeat = 1;
      }
    });
  }, [uniforms]);

  // time machine override
  const lastOverride = useRef<string>("");
  useFrame((state, dt) => {
    const t = state.clock.elapsedTime;
    uniforms.uTime.value = t;
    const s = st.current;
    // morph progress
    if (s.morphStart >= 0) {
      const p = easeOut((t - s.morphStart) / s.morphDur);
      uniforms.uMorph.value = p;
      if (p >= 1) {
        s.current = s.target.slice();
        uniforms.uRadA.value.set(s.current);
        uniforms.uMorph.value = 1;
        s.morphStart = -1;
      }
    }
    const ov = scene.overrideGenes ? scene.overrideGenes.join(",") : "";
    if (ov !== lastOverride.current) {
      lastOverride.current = ov;
      const genes = scene.overrideGenes ?? liveGenes(arena.get());
      const r = radii(genes);
      uniforms.uRadA.value.set(s.current.map((a, i) => a + (s.target[i] - a) * uniforms.uMorph.value));
      s.current = Array.from(uniforms.uRadA.value);
      s.target = r;
      uniforms.uRadB.value.set(r);
      uniforms.uAgit.value.set(agitation(genes));
      s.morphStart = t;
      s.morphDur = scene.overrideGenes ? 0.5 : 1.2;
      s.lastGenesKey = genes.join(",");
    }
    s.flash = Math.max(0, s.flash - dt * 4.2);
    s.liveBeat = Math.max(0, s.liveBeat - dt * 0.8);
    uniforms.uFlash.value = s.flash;
    uniforms.uLive.value = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * Math.PI * 0.5)) * (scene.reducedMotion ? 0 : 1) + s.liveBeat;
    uniforms.uBreath.value = scene.reducedMotion ? 0 : 0.024;
    // loader: the membrane unfolds after the genes have spread (intro 0.45 -> 1)
    const fold = easeOut(Math.max(0, (scene.intro - 0.42) / 0.58));
    uniforms.uScale.value = Math.max(0.0001, fold);
    uniforms.uIntro.value = fold;
    uniforms.uDim.value += (scene.dim - uniforms.uDim.value) * Math.min(1, dt * 3);
  });

  return (
    <group>
      <mesh geometry={shieldGeo} material={shieldMat} frustumCulled={false} renderOrder={1} />
      <mesh geometry={haloGeo} material={haloMat} frustumCulled={false} renderOrder={2} position={[0, 0, -0.01]} />
      <GenePoints uniforms={uniforms} />
    </group>
  );
}

/** Loader: one point divides into 32 genes that fly to their rim positions, then stay as faint markers. */
function GenePoints({ uniforms }: { uniforms: { uRadA: { value: Float32Array }; uRadB: { value: Float32Array }; uMorph: { value: number } } }) {
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const idx = new Float32Array(32).map((_, i) => i);
    g.setAttribute("aIndex", new THREE.BufferAttribute(idx, 1));
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(96), 3));
    return g;
  }, []);
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uIntro: { value: 0 },
          uRad: { value: new Float32Array(32).fill(1) },
          uPx: { value: 1 },
          uColor: { value: BONE },
        },
        vertexShader: /* glsl */ `
          uniform float uIntro;
          uniform float uRad[32];
          uniform float uPx;
          attribute float aIndex;
          varying float vA;
          void main() {
            int i = int(aIndex);
            float phi = (aIndex + 0.5) / 32.0 * 6.28318530718;
            float split = smoothstep(0.08, 0.42, uIntro);
            float spiral = (1.0 - split) * 2.4;
            float rr = uRad[i] * split;
            vec3 p = vec3(sin(phi + spiral) * rr, cos(phi + spiral) * rr, 0.06);
            vA = mix(1.0, 0.55, smoothstep(0.6, 1.0, uIntro));
            gl_PointSize = (uIntro < 0.08 ? 12.0 : 5.0) * uPx;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
          }`,
        fragmentShader: /* glsl */ `
          uniform vec3 uColor;
          varying float vA;
          void main() {
            float d = length(gl_PointCoord - 0.5);
            float a = smoothstep(0.5, 0.0, d);
            gl_FragColor = vec4(uColor * a * vA, a * vA);
          }`,
      }),
    [],
  );
  useFrame((state) => {
    mat.uniforms.uIntro.value = scene.intro;
    mat.uniforms.uPx.value = state.gl.getPixelRatio();
    const m = uniforms.uMorph.value;
    const out = mat.uniforms.uRad.value as Float32Array;
    for (let i = 0; i < 32; i++) out[i] = (uniforms.uRadA.value[i] + (uniforms.uRadB.value[i] - uniforms.uRadA.value[i]) * m) * 1.012;
  });
  return <points geometry={geo} material={mat} frustumCulled={false} renderOrder={3} />;
}
