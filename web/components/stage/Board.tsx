"use client";
import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { bus } from "@/lib/bus";
import { arena } from "@/lib/store";
import { scene } from "@/lib/scene";
import { BACKDROP_FRAG, BACKDROP_VERT, BOARD_FRAG, BOARD_VERT, FLECK_FRAG, FLECK_UPDATE, FLECK_VERT, FULL_VERT, TRACE_FRAG, TRACE_VERT } from "./shaders";
import { BOARD, IMPACT_R, START_R, TRAVEL, attackAngle } from "./ink";
import { gfx } from "./gfx";
import { palette } from "./palette";
import { worldU } from "./World";

/**
 * The light behind her (see BACKDROP_FRAG). Additive and drawn through the mist over the board (no depth
 * test), so wherever the camera stands her whole body has light behind it to bend.
 */
export function Backdrop() {
  const geo = useMemo(() => new THREE.PlaneGeometry(2, 2), []);
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: BACKDROP_VERT,
        fragmentShader: BACKDROP_FRAG,
        uniforms: {
          uCenter: { value: new THREE.Vector3(0, 1.3, 0) },
          uPush: { value: 5 },
          uSize: { value: 5.5 },
          uAmt: { value: 0.22 },
          uDim: { value: 0 },
          uIvory: { value: palette.ivory },
        },
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
      }),
    [],
  );
  useFrame((state, dt) => {
    mat.uniforms.uDim.value += (scene.dim - mat.uniforms.uDim.value) * Math.min(1, dt * 3);
    // keep the same size on screen at any camera distance, so the glass always has its light behind it
    const d = state.camera.position.distanceTo(mat.uniforms.uCenter.value);
    // portrait screens are narrow: a smaller, softer halo, so the copy below her keeps a dark ground
    const portrait = Math.min(1, state.size.width / state.size.height / 1.2);
    mat.uniforms.uPush.value = d * 0.68;
    mat.uniforms.uSize.value = d * 0.75 * (0.55 + 0.45 * portrait);
    mat.uniforms.uAmt.value = 0.085 * (0.6 + 0.4 * portrait);
  });
  return <mesh geometry={geo} material={mat} frustumCulled={false} renderOrder={-1} />;
}

/** The looking-glass chessboard: a mirror flooded with ink. */
export function Board() {
  const geo = useMemo(() => new THREE.PlaneGeometry(BOARD, BOARD, 1, 1).rotateX(-Math.PI / 2), []);
  const u = useMemo(
    () => ({
      tDye: { value: null as THREE.Texture | null },
      tVel: { value: null as THREE.Texture | null },
      tReflect: { value: null as THREE.Texture | null },
      uRes: { value: new THREE.Vector2(1, 1) },
      uTime: { value: 0 },
      uShocks: { value: Array.from({ length: 4 }, () => new THREE.Vector4(-100, 0, 0, 0)) },
      uDim: { value: 0 },
      uReflect: { value: 0.85 },
      uDyeTexel: { value: 1 / 512 },
      uIvory: { value: palette.ivory },
      uHot: { value: palette.hot },
      uMask: { value: new THREE.Vector4(0, 0, 0.5, 1) },
      uMaskAmt: { value: 0 },
      uLamp: { value: gfx.touch.lamp },
      uCore: gfx.core,
      uCold: { value: palette.cold },
      tRipple: { value: null as THREE.Texture | null },
      uRippleTexel: { value: 1 / 512 },
      uWater: { value: 0 },
      uMoon: worldU.uMoon,
    }),
    [],
  );
  const mat = useMemo(() => new THREE.ShaderMaterial({ vertexShader: BOARD_VERT, fragmentShader: BOARD_FRAG, uniforms: u }), [u]);
  const shock = useRef(0);
  useEffect(() => {
    return bus.on((e) => {
      if (e.type !== "chain" || e.event.name !== "Spend" || !e.event.args.refused || scene.reducedMotion) return;
      const a = attackAngle(String(e.event.args.caller));
      setTimeout(() => u.uShocks.value[shock.current++ % 4].set(u.uTime.value, 1, a, 0), TRAVEL * 1000);
    });
  }, [u]);
  useFrame((state, dt) => {
    u.uTime.value = state.clock.elapsedTime;
    u.tDye.value = gfx.fluid?.dye.read.texture ?? null;
    u.tVel.value = gfx.fluid?.velocity.read.texture ?? null;
    u.tReflect.value = gfx.reflect?.texture ?? null;
    const rp = gfx.ripple;
    u.tRipple.value = rp?.read.texture ?? null;
    u.uRippleTexel.value = 1 / (rp?.size ?? 512);
    // the film's slopes are measured per texel; scale so a coarser phone grid reads the same
    u.uWater.value = rp ? rp.size / 512 : 0;
    u.uRes.value.set(gfx.width, gfx.height);
    u.uDyeTexel.value = 1 / (gfx.fluid?.opts.dye ?? 512);
    u.uDim.value += (scene.dim - u.uDim.value) * Math.min(1, dt * 3);
    // text sits on the side opposite the queen; keep the board quiet behind it
    const f = scene.frame;
    const m = u.uMask.value;
    if (f > 0.05) m.set(0, 0, 0.5, 1);
    else if (f < -0.05) m.set(0.5, 0, 1, 1);
    else m.set(0, 0.45, 0.55, 1);
    u.uMaskAmt.value += ((scene.cinema ? 0 : 1) - u.uMaskAmt.value) * Math.min(1, dt * 2);
  });
  return <mesh geometry={geo} material={mat} frustumCulled={false} />;
}

/** 2,048 flecks floating on the ink, advected by the fluid's own velocity field (GPGPU). */
export function Flecks() {
  const W = 64;
  const H = 32;
  const sim = useMemo(() => {
    const mk = () =>
      new THREE.WebGLRenderTarget(W, H, { type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false });
    const a = mk();
    const b = mk();
    const init = new Float32Array(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      const ang = Math.random() * Math.PI * 2;
      const rad = 0.03 + Math.pow(Math.random(), 0.7) * 0.36;
      init[i * 4] = 0.5 + Math.cos(ang) * rad;
      init[i * 4 + 1] = 0.5 + Math.sin(ang) * rad;
      init[i * 4 + 2] = Math.random() * 6;
      init[i * 4 + 3] = 5 + Math.random() * 9;
    }
    const seed = new THREE.DataTexture(init, W, H, THREE.RGBAFormat, THREE.FloatType);
    seed.needsUpdate = true;
    const scene3 = new THREE.Scene();
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const upd = new THREE.ShaderMaterial({
      vertexShader: FULL_VERT,
      fragmentShader: FLECK_UPDATE,
      uniforms: { tPos: { value: seed }, tVel: { value: null }, uDt: { value: 0 }, uTime: { value: 0 }, uSim: { value: 128 } },
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), upd);
    quad.frustumCulled = false;
    scene3.add(quad);
    return { a, b, seed, scene3, cam, upd, seeded: false };
  }, []);
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const ref = new Float32Array(W * H * 2);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      ref[(y * W + x) * 2] = (x + 0.5) / W;
      ref[(y * W + x) * 2 + 1] = (y + 0.5) / H;
    }
    g.setAttribute("aRef", new THREE.BufferAttribute(ref, 2));
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(W * H * 3), 3));
    return g;
  }, []);
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: FLECK_VERT,
        fragmentShader: FLECK_FRAG,
        uniforms: { tPos: { value: null }, tDye: { value: null }, uBoard: { value: BOARD }, uPx: { value: 1 }, uDim: { value: 0 } },
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
      }),
    [],
  );
  useFrame((state, dt) => {
    const fl = gfx.fluid;
    if (!fl) return;
    const gl = state.gl;
    const prev = gl.getRenderTarget();
    sim.upd.uniforms.tPos.value = sim.seeded ? sim.a.texture : sim.seed;
    sim.upd.uniforms.tVel.value = fl.velocity.read.texture;
    sim.upd.uniforms.uDt.value = scene.reducedMotion ? 0 : Math.min(dt, 1 / 30);
    sim.upd.uniforms.uTime.value = state.clock.elapsedTime;
    sim.upd.uniforms.uSim.value = fl.opts.sim;
    gl.setRenderTarget(sim.b);
    gl.render(sim.scene3, sim.cam);
    gl.setRenderTarget(prev);
    const t = sim.a;
    sim.a = sim.b;
    sim.b = t;
    sim.seeded = true;
    mat.uniforms.tPos.value = sim.a.texture;
    mat.uniforms.tDye.value = fl.dye.read.texture;
    mat.uniforms.uPx.value = gfx.dpr * (gfx.height / gfx.dpr / 900);
    mat.uniforms.uDim.value = scene.dim;
  });
  return <points geometry={geo} material={mat} frustumCulled={false} renderOrder={3} />;
}

const POOL = 56;

/** Crisp traces over the ink so every attack reads instantly: edge → foot (refused) or → core (passed). */
export function Traces() {
  const geo = useMemo(() => {
    const segs = 80;
    const g = new THREE.BufferGeometry();
    const t: number[] = [];
    const side: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i <= segs; i++) {
      t.push(i / segs, i / segs);
      side.push(-1, 1);
      if (i < segs) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
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
            vertexShader: TRACE_VERT,
            fragmentShader: TRACE_FRAG,
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide,
            blending: THREE.AdditiveBlending,
            uniforms: {
              uA: { value: new THREE.Vector3() },
              uB: { value: new THREE.Vector3() },
              uC: { value: new THREE.Vector3() },
              uWidth: { value: 0.012 },
              uHead: { value: -1 },
              uFade: { value: 0 },
              uRefused: { value: 0 },
              uOwn: { value: 0 },
              uEmber: { value: 0 },
              uIvory: { value: palette.ivory },
              uCold: { value: palette.cold },
              uHot: { value: palette.hot },
            },
          }),
      ),
    [],
  );
  const meshes = useRef<(THREE.Mesh | null)[]>([]);
  // the verdict under the cursor in the record: its line is drawn and breathes until you move on
  const focusMat = useMemo(() => {
    const m = mats[0].clone();
    m.uniforms = THREE.UniformsUtils.clone(mats[0].uniforms);
    m.uniforms.uIvory.value = palette.ivory;
    m.uniforms.uCold.value = palette.cold;
    m.uniforms.uHot.value = palette.hot;
    return m;
  }, [mats]);
  const focusRef = useRef<THREE.Mesh>(null);
  const focusKey = useRef("");
  const focusAmt = useRef(0);
  const lines = useRef(Array.from({ length: POOL }, () => ({ start: -100, refused: false, active: false })));
  const next = useRef(0);
  const clock = useRef(0);
  const me = useRef<string | null>(null);

  const place = (j: number, a: number, refused: boolean, own: boolean) => {
    const m = mats[j].uniforms;
    const d = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
    m.uA.value.copy(d).multiplyScalar(START_R).setY(0.02);
    m.uB.value.copy(d).multiplyScalar(IMPACT_R).setY(0.02);
    m.uC.value.set(0, 0.02, 0);
    m.uRefused.value = refused ? 1 : 0;
    m.uOwn.value = own ? 1 : 0;
    m.uWidth.value = own ? 0.03 : 0.013;
  };

  useEffect(() => {
    const onMe = (e: Event) => (me.current = ((e as CustomEvent).detail as string | null)?.toLowerCase() ?? null);
    window.addEventListener("rq:me", onMe);
    const off = bus.on((e) => {
      if (e.type !== "chain" || e.event.name !== "Spend" || scene.reducedMotion) return;
      const caller = String(e.event.args.caller).toLowerCase();
      const j = next.current++ % POOL;
      place(j, attackAngle(caller), Boolean(e.event.args.refused), me.current === caller);
      lines.current[j] = { start: clock.current, refused: Boolean(e.event.args.refused), active: true };
    });
    return () => {
      off();
      window.removeEventListener("rq:me", onMe);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useFrame((state, dt) => {
    clock.current = state.clock.elapsedTime;
    const hv = scene.hoverSpend;
    const fu = focusMat.uniforms;
    if (hv) {
      const key = `${hv.caller}:${hv.refused}`;
      if (key !== focusKey.current) {
        focusKey.current = key;
        const d = new THREE.Vector3(Math.sin(attackAngle(hv.caller)), 0, Math.cos(attackAngle(hv.caller)));
        fu.uA.value.copy(d).multiplyScalar(START_R).setY(0.025);
        fu.uB.value.copy(d).multiplyScalar(IMPACT_R).setY(0.025);
        fu.uC.value.set(0, 0.025, 0);
        fu.uRefused.value = hv.refused ? 1 : 0;
        fu.uHead.value = hv.refused ? 0.8 : 1;
        fu.uFade.value = 1;
        fu.uWidth.value = 0.022;
      }
    }
    focusAmt.current += ((hv ? 1 : 0) - focusAmt.current) * Math.min(1, dt * 6);
    fu.uEmber.value = focusAmt.current * (0.42 + 0.12 * Math.sin(state.clock.elapsedTime * 4));
    if (focusRef.current) focusRef.current.visible = focusAmt.current > 0.01;
    const scrub = scene.scrubTime;
    if (scrub !== null) {
      const sp = arena.get().spends.filter((s) => s.t <= scrub && s.t > scrub - 7).slice(-POOL);
      for (let j = 0; j < POOL; j++) {
        const s = sp[j];
        const mesh = meshes.current[j];
        if (!s) {
          mats[j].uniforms.uHead.value = -1;
          if (mesh) mesh.visible = false;
          continue;
        }
        if (mesh) mesh.visible = true;
        place(j, attackAngle(s.caller), s.refused, me.current === s.caller.toLowerCase());
        head(mats[j].uniforms, (scrub - s.t) / 3, s.refused);
        mats[j].uniforms.uEmber.value = 0;
      }
      return;
    }
    for (let j = 0; j < POOL; j++) {
      const L = lines.current[j];
      const mesh = meshes.current[j];
      if (!L.active) {
        if (mesh) mesh.visible = false;
        continue;
      }
      const age = clock.current - L.start;
      if (age > SCAR) {
        L.active = false;
        mats[j].uniforms.uEmber.value = 0;
        continue;
      }
      if (mesh) mesh.visible = true;
      head(mats[j].uniforms, age, L.refused);
      // the strike settles into a scar that fades over a minute: the board keeps the last minute's siege
      mats[j].uniforms.uEmber.value = Math.min(1, Math.max(0, (age - 0.9) / 1.2)) * 0.085 * Math.pow(1 - age / SCAR, 1.5);
    }
  });

  return (
    <group>
      <mesh ref={focusRef} geometry={geo} material={focusMat} frustumCulled={false} visible={false} renderOrder={5} />
      {mats.map((m, j) => (
        <mesh
          key={j}
          ref={(el) => {
            meshes.current[j] = el;
          }}
          geometry={geo}
          material={m}
          frustumCulled={false}
          visible={false}
          renderOrder={4}
        />
      ))}
    </group>
  );
}

function head(m: { [k: string]: THREE.IUniform }, age: number, refused: boolean) {
  const reach = age / TRAVEL;
  if (refused) {
    m.uHead.value = Math.min(0.8, reach * 0.8);
    m.uFade.value = Math.max(0, (age - TRAVEL) / 0.45);
  } else {
    m.uHead.value = reach <= 1 ? reach * 0.8 : Math.min(1, 0.8 + ((age - TRAVEL) / 0.3) * 0.2);
    m.uFade.value = Math.max(0, (age - TRAVEL - 0.3) / 1.1);
  }
  // the bright strike is spent; the line stays drawn for its scar
  if (m.uFade.value >= 1) m.uHead.value = refused ? 0.8 : 1;
}

/** seconds a strike stays on the board as a scar */
const SCAR = 60;
