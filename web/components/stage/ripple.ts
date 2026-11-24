/**
 * The water on the board: a thin film over the looking-glass that the cursor moves.
 *
 * A height field on the GPU (the classic two-value wave scheme, as in Evan Wallace's WebGL Water: each
 * texel keeps a height and a vertical velocity; velocity is pulled toward the neighbours' average, damped,
 * then integrated). It is shallow water, so ripples are small, slowish and die within a couple of seconds.
 * Her foot stands in it: the film is held still against the pedestal, so rings bounce off her.
 *
 * What disturbs it, and nothing else:
 *   the cursor  a wake of soft drops along its path over the board, stronger the faster it moves;
 *               a press drops a heavier ring
 *   attacks     each attack runs a small wake from the board's edge to her foot; a refusal lands a hard
 *               drop where it hits, a drain spills a ring from her foot
 *   the film    a rare, tiny drip somewhere near her, so the surface never looks frozen
 *
 * Board mapping (same as the ink): uv (0..1) ↔ world (x, z): x = (u − 0.5)·BOARD, z = (0.5 − v)·BOARD.
 */
import * as THREE from "three";
import { bus } from "@/lib/bus";
import { scene } from "@/lib/scene";
import { BOARD, IMPACT_R, START_R, TRAVEL, attackAngle, toUv } from "./ink";

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const STEP = /* glsl */ `
  precision highp float;
  uniform sampler2D uState;
  uniform vec2 uTexel;
  uniform float uDamp;
  uniform float uFoot;
  varying vec2 vUv;
  void main() {
    vec4 s = texture2D(uState, vUv);
    float avg = 0.25 * (
      texture2D(uState, vUv + vec2(uTexel.x, 0.0)).r + texture2D(uState, vUv - vec2(uTexel.x, 0.0)).r +
      texture2D(uState, vUv + vec2(0.0, uTexel.y)).r + texture2D(uState, vUv - vec2(0.0, uTexel.y)).r);
    s.g += (avg - s.r) * 2.0;
    s.g *= uDamp;
    s.r += s.g;
    s.r *= 0.9985;
    // her foot holds the film still, so rings reflect off the pedestal
    float d = length(vUv - 0.5);
    float hold = smoothstep(uFoot, uFoot + uTexel.x * 3.0, d);
    // the far edges soak the waves up instead of mirroring them back
    vec2 e = min(vUv, 1.0 - vUv);
    hold *= smoothstep(0.0, 0.06, min(e.x, e.y));
    s.rg *= hold;
    gl_FragColor = vec4(s.rg, 0.0, 1.0);
  }`;

const MAX_DROPS = 12;

const DROP = /* glsl */ `
  precision highp float;
  #define N ${MAX_DROPS}
  uniform sampler2D uState;
  uniform vec4 uDrops[N];
  uniform int uCount;
  varying vec2 vUv;
  void main() {
    vec4 s = texture2D(uState, vUv);
    for (int i = 0; i < N; i++) {
      if (i >= uCount) break;
      vec4 d = uDrops[i];
      float k = max(0.0, 1.0 - length(vUv - d.xy) / d.z);
      k = 0.5 - cos(k * 3.14159265) * 0.5;
      s.r += k * d.w;
    }
    gl_FragColor = vec4(s.rg, 0.0, 1.0);
  }`;

function target(size: number) {
  return new THREE.WebGLRenderTarget(size, size, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
  });
}

interface Wake {
  a: number;
  r0: number;
  r1: number;
  t0: number;
  dur: number;
  s: number;
  last: number;
}

export class Ripple {
  readonly size: number;
  read: THREE.WebGLRenderTarget;
  private write: THREE.WebGLRenderTarget;
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad: THREE.Mesh;
  private stepMat: THREE.ShaderMaterial;
  private dropMat: THREE.ShaderMaterial;
  private drops: THREE.Vector4[] = [];
  private acc = 0;
  private wakes: Wake[] = [];
  private last: { x: number; z: number; t: number } | null = null;
  private carry = 0;
  private nextDrip = 2;
  private nextVoice = 0;
  private herPrev = 0;
  private herPulse = 0;
  private now = 0;
  private hz = 120;
  /** the cursor's speed over the water (world units/s, smoothed): the sound reads it */
  speed = 0;
  private off: () => void;

  constructor(private gl: THREE.WebGLRenderer, size = 512) {
    this.size = size;
    this.hz = (120 * size) / 512;
    this.read = target(size);
    this.write = target(size);
    const texel = new THREE.Vector2(1 / size, 1 / size);
    this.stepMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: STEP,
      // a coarser grid steps less often (waves cross one cell per step, so speed in the world stays the same) and
      // damps a little more per step (so ripples fade in the same time): 384 cells at 90 Hz stand in for 512 at 120
      uniforms: { uState: { value: null }, uTexel: { value: texel }, uDamp: { value: Math.pow(0.986, 512 / size) }, uFoot: { value: 0.56 / BOARD } },
      depthTest: false,
      depthWrite: false,
    });
    this.dropMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: DROP,
      uniforms: { uState: { value: null }, uDrops: { value: Array.from({ length: MAX_DROPS }, () => new THREE.Vector4()) }, uCount: { value: 0 } },
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.stepMat);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
    for (const t of [this.read, this.write]) {
      gl.setRenderTarget(t);
      gl.clear(true, false, false);
    }
    gl.setRenderTarget(null);
    this.off = this.wire();
  }

  /** a drop at world (x, z): radius in world units, strength in height units (negative pushes down) */
  drop(x: number, z: number, radius: number, strength: number) {
    if (scene.reducedMotion) return;
    const [u, v] = toUv(x, z);
    if (u < 0 || u > 1 || v < 0 || v > 1) return;
    if (this.drops.length >= 48) this.drops.shift();
    this.drops.push(new THREE.Vector4(u, v, radius / BOARD, strength));
  }

  /** the cursor over the board (world x, z); call every frame while it is there */
  pointer(x: number, z: number, t: number) {
    const last = this.last;
    this.last = { x, z, t };
    if (!last) return;
    const dt = Math.max(1 / 240, t - last.t);
    if (dt > 0.25) return;
    const dx = x - last.x;
    const dz = z - last.z;
    const dist = Math.hypot(dx, dz);
    const inst = dist / dt;
    this.speed = this.speed * 0.8 + inst * 0.2;
    if (dist < 1e-4) return;
    // drops every ~0.09 units along the path, so a fast stroke leaves an unbroken wake
    const step = 0.09;
    const s = Math.min(1, inst / 9);
    let d = this.carry;
    while (d < dist) {
      const k = d / dist;
      this.drop(last.x + dx * k, last.z + dz * k, 0.16 + 0.06 * s, -(0.012 + 0.03 * s));
      d += step;
    }
    this.carry = d - dist;
  }

  pointerOut() {
    this.last = null;
    this.speed *= 0.5;
  }

  /** a press on the board */
  press(x: number, z: number) {
    this.drop(x, z, 0.32, -0.16);
  }

  private wire() {
    return bus.on((e) => {
      if (e.type !== "chain" || scene.reducedMotion) return;
      const ev = e.event;
      if (ev.name === "Spend") {
        const a = attackAngle(String(ev.args.caller));
        const refused = Boolean(ev.args.refused);
        // a held payment stops at her foot: a small, still ring
        const held = Number(ev.args.verdict ?? 0) === 1;
        this.wakes.push({ a, r0: START_R, r1: IMPACT_R, t0: this.now, dur: TRAVEL, s: 0.022, last: START_R });
        setTimeout(() => {
          const x = Math.sin(a) * (IMPACT_R + 0.12);
          const z = Math.cos(a) * (IMPACT_R + 0.12);
          if (refused) this.drop(x, z, 0.42, -0.26);
          else if (held) this.drop(x, z, 0.26, -0.1);
          else this.drop(x * 0.9, z * 0.9, 0.3, 0.14);
        }, TRAVEL * 1000);
      } else if (ev.name === "Deposit") {
        const a = Math.random() * Math.PI * 2;
        this.wakes.push({ a, r0: START_R, r1: IMPACT_R, t0: this.now, dur: 1.2, s: 0.014, last: START_R });
      }
    });
  }

  step(dtIn: number, t: number) {
    this.now = t;
    const gl = this.gl;
    const prev = gl.getRenderTarget();
    // attack wakes: drops along the path, like the cursor's
    const keep: Wake[] = [];
    for (const w of this.wakes) {
      const k = (t - w.t0) / w.dur;
      const r = w.r0 + (w.r1 - w.r0) * Math.min(1, Math.max(0, k));
      for (let q = w.last; q > r; q -= 0.12) this.drop(Math.sin(w.a) * q, Math.cos(w.a) * q, 0.14, -w.s);
      w.last = Math.min(w.last, r);
      if (k < 1) keep.push(w);
    }
    this.wakes = keep;
    // while she listens, your voice reaches her across the water: drops at the near edge, as loud as you speak
    // (her line in your voice lands here too: it comes from your side, not from her)
    const you = Math.max(scene.mic, scene.echo ? scene.voice : 0);
    if (!scene.reducedMotion && you > 0.06 && t > this.nextVoice) {
      this.nextVoice = t + 0.07;
      this.drop((Math.random() - 0.5) * 2.6, 3.1 + Math.random() * 0.7, 0.12 + you * 0.1, -(0.008 + you * 0.05));
    }
    // as she speaks, rings run out across the water from under her, one per stressed syllable
    const v = scene.echo ? 0 : scene.voice;
    if (!scene.reducedMotion && v > 0.2 && v - this.herPrev > 0.05 && t - this.herPulse > 0.22) {
      this.herPulse = t;
      this.drop(0, 0, 1.05, -(0.05 + v * 0.11));
    }
    this.herPrev = v;
    // a rare tiny drip near her, so the film never looks frozen
    if (t > this.nextDrip) {
      this.nextDrip = t + 2.5 + Math.random() * 4;
      const a = Math.random() * Math.PI * 2;
      const r = 1.1 + Math.random() * 3.2;
      this.drop(Math.sin(a) * r, Math.cos(a) * r, 0.1, -0.03);
    }
    // drops, a batch per pass
    while (this.drops.length) {
      const batch = this.drops.splice(0, MAX_DROPS);
      const u = this.dropMat.uniforms;
      batch.forEach((d, i) => u.uDrops.value[i].copy(d));
      u.uCount.value = batch.length;
      u.uState.value = this.read.texture;
      this.pass(this.dropMat);
    }
    // fixed steps (120 Hz at 512 cells; at most 4 a frame; a hidden tab simply skips ahead)
    const h = 1 / this.hz;
    this.acc = Math.min(this.acc + Math.min(dtIn, 0.1), 4 * h);
    while (this.acc >= h) {
      this.acc -= h;
      this.stepMat.uniforms.uState.value = this.read.texture;
      this.pass(this.stepMat);
    }
    gl.setRenderTarget(prev);
    this.speed *= Math.exp(-dtIn * 2);
  }

  private pass(mat: THREE.ShaderMaterial) {
    this.quad.material = mat;
    this.gl.setRenderTarget(this.write);
    this.gl.render(this.scene, this.cam);
    const t = this.read;
    this.read = this.write;
    this.write = t;
  }

  dispose() {
    this.off();
    this.read.dispose();
    this.write.dispose();
    this.stepMat.dispose();
    this.dropMat.dispose();
  }
}
