"use client";
import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { scene } from "@/lib/scene";
import { arena } from "@/lib/store";
import { bus } from "@/lib/bus";
import { damp } from "@/lib/motion";

/** Camera keyframes per section stage (0 loader … 10 proof): [x, y, z, lookY, roll]. */
const KEYS: [number, number, number, number, number][] = [
  [0, -0.12, 6.4, 0, 0], // 0 loader
  [0, -0.12, 6.4, 0, 0], // 1 hero
  [0, 1.35, 9.2, -0.95, 0], // 2 vault: pull back, look down at the plinth
  [0, 0.2, 10.5, 0, 0], // 3 attack field: wide
  [1.55, 0.85, 9.4, 0, 0], // 4 try it: shield sits lower-left of the panel
  [2.6, 0.9, 11.5, 0, 0], // 5 kill feed: shield lower-left, under the heading
  [0, 0.6, 12.5, 0, 0.03], // 6 generations
  [-4.6, -2.4, 17, 0, -0.02], // 7 lineage: the shield recedes to the upper right
  [3.2, 1.6, 13.5, 0, 0], // 8 charts: lower left, beside the text
  [-3.4, 2.3, 12.5, 0, 0], // 9 bet: the shield watches from the lower right
  [1.9, 0.5, 6.2, 0, 0], // 10 proof: close on the shield, beside the record
];

export function CameraRig() {
  const { camera } = useThree();
  const cur = useRef({ x: 0, y: 0, z: 5.6, look: 0, roll: 0, orbit: 0, cine: 0 });
  useEffect(() => {
    return bus.on((e) => {
      if (e.type === "chain" && e.event.name === "EpochClosed" && scene.cinema && !e.replay) {
        cur.current.cine = 6; // 6-second cinematic orbit
      }
    });
  }, []);
  useFrame((state, dt) => {
    const s = Math.max(0, Math.min(KEYS.length - 1, scene.stage));
    const i = Math.floor(s);
    const f = s - i;
    const a = KEYS[i];
    const b = KEYS[Math.min(KEYS.length - 1, i + 1)];
    const k = f * f * (3 - 2 * f);
    let tx = a[0] + (b[0] - a[0]) * k;
    let ty = a[1] + (b[1] - a[1]) * k;
    let tz = a[2] + (b[2] - a[2]) * k;
    let look = a[3] + (b[3] - a[3]) * k;
    const roll = a[4] + (b[4] - a[4]) * k;
    if (scene.cinema) {
      tx = 0;
      ty = 0;
      tz = 4.3;
      look = 0;
    }
    const c = cur.current;
    // pointer parallax (off for reduced motion)
    const par = scene.reducedMotion ? 0 : 0.18;
    tx += scene.pointer.nx * par;
    ty += scene.pointer.ny * par * 0.6;
    const lam = scene.reducedMotion ? 20 : 3.2;
    c.x = damp(c.x, tx, lam, dt);
    c.y = damp(c.y, ty, lam, dt);
    c.z = damp(c.z, tz, lam, dt);
    c.look = damp(c.look, look, lam, dt);
    c.roll = damp(c.roll, roll, lam, dt);
    // cinema: orbit around the shield during an epoch close
    if (c.cine > 0) {
      c.cine = Math.max(0, c.cine - dt);
      c.orbit += dt * (Math.PI * 2) / 6;
    } else {
      c.orbit = damp(c.orbit, Math.round(c.orbit / (Math.PI * 2)) * Math.PI * 2, 2, dt);
    }
    const ox = Math.sin(c.orbit) * c.z * 0.45;
    const oz = Math.cos(c.orbit) * c.z;
    camera.position.set(c.x + ox, c.y, oz);
    camera.lookAt(c.x * 0.15, c.look, 0);
    camera.rotation.z += c.roll;
  });
  return null;
}

/** The vault the shield sits on: a 32-sided plinth with a balance gauge ring. Revealed by the pull-back. */
export function VaultBase() {
  const group = useRef<THREE.Group>(null);
  const plinth = useMemo(() => new THREE.CylinderGeometry(1.25, 1.42, 0.55, 32, 1, false), []);
  const edges = useMemo(() => new THREE.EdgesGeometry(plinth, 1), [plinth]);
  const ring = useMemo(() => new THREE.RingGeometry(1.6, 1.64, 256, 1), []);
  const ringMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        uniforms: { uFrac: { value: 1 }, uTime: { value: 0 }, uVis: { value: 0 }, uBone: { value: new THREE.Color("#e8e4da") }, uCold: { value: new THREE.Color("#7cc8ff") } },
        vertexShader: `varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: /* glsl */ `
          uniform float uFrac; uniform float uTime; uniform float uVis; uniform vec3 uBone; uniform vec3 uCold;
          varying vec2 vP;
          void main(){
            float a = fract(atan(vP.x, vP.y) / 6.28318530718 + 1.0);
            float on = step(a, uFrac);
            float ticks = step(0.92, fract(a * 128.0));
            vec3 c = mix(uBone * 0.25, uCold, on);
            float al = (0.25 + 0.75 * on) * (1.0 - ticks * 0.6) * uVis;
            gl_FragColor = vec4(c * al, al);
          }`,
      }),
    [],
  );
  const plinthMat = useMemo(() => new THREE.MeshBasicMaterial({ color: "#0b0d10" }), []);
  const edgeMat = useMemo(() => new THREE.LineBasicMaterial({ color: "#e8e4da", transparent: true, opacity: 0.0 }), []);
  useFrame((state, dt) => {
    const vis = scene.stage > 1.35 && scene.stage < 2.75 ? 1 : 0;
    const u = ringMat.uniforms;
    u.uVis.value = damp(u.uVis.value, vis, 3, dt);
    edgeMat.opacity = u.uVis.value * 0.22;
    const s = arena.get().snapshot;
    const frac = s && s.epochStartBalance > 0n ? Math.min(1, Number((s.vaultBalance * 10000n) / s.epochStartBalance) / 10000) : 1;
    u.uFrac.value = damp(u.uFrac.value, frac, 2, dt);
    u.uTime.value = state.clock.elapsedTime;
    if (group.current) group.current.visible = u.uVis.value > 0.01;
  });
  return (
    <group ref={group} position={[0, -2.4, 0]}>
      <mesh geometry={plinth} material={plinthMat} />
      <lineSegments geometry={edges} material={edgeMat} />
      <mesh geometry={ring} material={ringMat} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.3, 0]} />
    </group>
  );
}

/** Post pass: refusal chromatic offset (1 frame + tail), screen shockwave, vignette. Renders the frame. */
export function PostFX() {
  const { gl, size, scene: s3, camera } = useThree();
  const rt = useMemo(() => {
    const t = new THREE.WebGLRenderTarget(1, 1, { samples: 4, type: THREE.HalfFloatType });
    return t;
  }, []);
  const quad = useMemo(() => {
    const sc = new THREE.Scene();
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: rt.texture },
        uChroma: { value: 0 },
        uShock: { value: new THREE.Vector4(0.5, 0.5, -10, 0) },
        uTime: { value: 0 },
        uAspect: { value: 1 },
      },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tScene; uniform float uChroma; uniform vec4 uShock; uniform float uTime; uniform float uAspect;
        varying vec2 vUv;
        void main(){
          vec2 uv = vUv;
          // screen shockwave from the shield on refusal
          float age = uTime - uShock.z;
          if (age > 0.0 && age < 0.9) {
            vec2 d = uv - uShock.xy; d.x *= uAspect;
            float r = length(d);
            float front = age * 1.1;
            float w = exp(-pow((r - front) * 18.0, 2.0)) * (1.0 - age / 0.9) * uShock.w;
            uv -= normalize(d + 1e-5) * w * 0.012 / vec2(uAspect, 1.0);
          }
          vec2 off = (uv - 0.5) * uChroma * 0.012;
          vec3 c;
          c.r = texture2D(tScene, uv + off).r;
          c.g = texture2D(tScene, uv).g;
          c.b = texture2D(tScene, uv - off).b;
          // vignette
          vec2 q = vUv - 0.5;
          c *= 1.0 - dot(q, q) * 0.9;
          gl_FragColor = vec4(c, 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    sc.add(mesh);
    return { sc, cam, mat };
  }, [rt]);

  const fx = useRef({ chroma: 0, frames: 0 });

  useEffect(() => {
    const dpr = gl.getPixelRatio();
    rt.setSize(Math.floor(size.width * dpr), Math.floor(size.height * dpr));
    quad.mat.uniforms.uAspect.value = size.width / size.height;
  }, [gl, size, rt, quad]);

  useEffect(() => {
    return bus.on((e) => {
      if (e.type !== "chain" || e.event.name !== "Spend" || !e.event.args.refused || scene.reducedMotion) return;
      setTimeout(() => {
        fx.current.frames = 1; // one frame of full chromatic offset
        fx.current.chroma = 1;
        const p = new THREE.Vector3(0, 0, 0).project(camera);
        quad.mat.uniforms.uShock.value.set(p.x * 0.5 + 0.5, p.y * 0.5 + 0.5, quad.mat.uniforms.uTime.value, 1);
      }, 900);
    });
  }, [camera, quad]);

  useFrame((state, dt) => {
    const u = quad.mat.uniforms;
    u.uTime.value = state.clock.elapsedTime;
    if (fx.current.frames > 0) {
      u.uChroma.value = 1;
      fx.current.frames--;
    } else {
      fx.current.chroma = Math.max(0, fx.current.chroma - dt * 9);
      u.uChroma.value = fx.current.chroma * 0.35;
    }
    gl.setRenderTarget(rt);
    gl.render(s3, camera);
    gl.setRenderTarget(null);
    gl.render(quad.sc, quad.cam);
  }, 1);
  return null;
}
