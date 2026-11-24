"use client";
import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { bus } from "@/lib/bus";
import { arena, liveGenes } from "@/lib/store";
import { scene } from "@/lib/scene";
import { ui } from "@/lib/ui";
import { easeOut } from "@/lib/motion";
import { BALL_R, BALL_T, BAND_H, BAND_T0, BAND_T1, CAVITY_T0, CAVITY_T1, CROWN_RIM_R, CROWN_RIM_T, CROWN_SECTION, HEIGHT, TOP_T, crownBump, crownSpike, envelopeRadius, lerpShape, pointAngle, radiusAt, ribbonPoint, ribbonSize, rowHeights, shapeOf, type Shape } from "@/lib/queen";
import { GLASS_FRAG, GLASS_VERT, RIBBON_FRAG, RIBBON_VERT } from "./shaders";
import { attackAngle, TRAVEL } from "./ink";
import { gfx, LAYER_GLASS, LAYER_RIBBON_BACK, LAYER_RIBBON_FRONT } from "./gfx";
import { worldU } from "./World";
import { palette } from "./palette";

const ROWS = 360;
const COLS = 128;
/** row heights spaced by the silhouette's arc length: the moldings get the rows, the plain stem few */
const ROW_T = rowHeights(ROWS);

export function genesFromWords(lo: bigint, hi: bigint) {
  const g: number[] = [];
  for (let i = 0; i < 16; i++) {
    const a = Number((lo >> BigInt(i * 16)) & 0xffffn);
    const b = Number((hi >> BigInt(i * 16)) & 0xffffn);
    g[i] = a >= 0x8000 ? a - 0x10000 : a;
    g[i + 16] = b >= 0x8000 ? b - 0x10000 : b;
  }
  return g;
}

function bodyGeometry() {
  const g = new THREE.BufferGeometry();
  const row = COLS + 1;
  const n = (ROWS + 1) * row + row + 1;
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  const aT = new Float32Array(n);
  const aA = new Float32Array(n);
  const idx: number[] = [];
  for (let i = 0; i <= ROWS; i++)
    for (let j = 0; j <= COLS; j++) {
      aT[i * row + j] = ROW_T[i];
      aA[i * row + j] = (j / COLS) * Math.PI * 2;
    }
  for (let i = 0; i < ROWS; i++)
    for (let j = 0; j < COLS; j++) {
      const a = i * row + j;
      idx.push(a, a + 1, a + row, a + row, a + 1, a + row + 1);
    }
  const capStart = (ROWS + 1) * row;
  const centre = capStart + row;
  for (let j = 0; j <= COLS; j++) aA[capStart + j] = (j / COLS) * Math.PI * 2;
  for (let j = 0; j < COLS; j++) idx.push(capStart + j, centre, capStart + j + 1);
  g.setAttribute("aT", new THREE.BufferAttribute(aT, 1));
  g.setAttribute("aA", new THREE.BufferAttribute(aA, 1));
  g.setIndex(idx);
  return g;
}

const SIN = Array.from({ length: COLS + 1 }, (_, j) => Math.sin((j / COLS) * Math.PI * 2));
const COS = Array.from({ length: COLS + 1 }, (_, j) => Math.cos((j / COLS) * Math.PI * 2));
/**
 * Cut crystal: the turned body is cut into 16 flat facets (a 16-gon in plan, corners on the turned
 * radius), so every facet refracts its own piece of the world and every edge catches light. The column
 * count is a multiple of 16, so the corners fall exactly on vertex columns and the edges stay crisp.
 */
const FACETS = 16;
const POLY = Array.from({ length: COLS + 1 }, (_, j) => {
  const step = (Math.PI * 2) / FACETS;
  const a = (j / COLS) * Math.PI * 2;
  const c = (Math.floor(a / step + 1e-6) + 0.5) * step;
  return Math.cos(step / 2) / Math.cos(a - c);
});

function writeBody(g: THREE.BufferGeometry, s: Shape) {
  const P = (g.getAttribute("position") as THREE.BufferAttribute).array as Float32Array;
  const Nn = (g.getAttribute("normal") as THREE.BufferAttribute).array as Float32Array;
  const row = COLS + 1;
  const H = HEIGHT;
  for (let i = 0; i <= ROWS; i++) {
    const t = ROW_T[i];
    const r = radiusAt(s, t) * H;
    for (let j = 0; j <= COLS; j++) {
      const a = (j / COLS) * Math.PI * 2;
      const k = (i * row + j) * 3;
      const cut = 0; // her body is liquid glass; the crown carries the facets
      const rf = r * (cut ? POLY[j] : 1);
      P[k] = SIN[j] * rf;
      P[k + 1] = t * H + crownBump(s.points, a, t) * H;
      P[k + 2] = COS[j] * rf;
    }
  }
  // normals from the final surface (moldings and crown points included), so every edge is lit truly
  const v = (i: number, j: number, c: number) => P[(i * row + j) * 3 + c];
  for (let i = 0; i <= ROWS; i++) {
    const i0 = Math.max(0, i - 1);
    const i1 = Math.min(ROWS, i + 1);
    for (let j = 0; j <= COLS; j++) {
      const j0 = j === 0 ? COLS - 1 : j - 1;
      const j1 = j === COLS ? 1 : j + 1;
      // tangent round the body (a) and up the profile (t)
      const ax = v(i, j1, 0) - v(i, j0, 0), ay = v(i, j1, 1) - v(i, j0, 1), az = v(i, j1, 2) - v(i, j0, 2);
      let tx = v(i1, j, 0) - v(i0, j, 0), ty = v(i1, j, 1) - v(i0, j, 1), tz = v(i1, j, 2) - v(i0, j, 2);
      if (tx * tx + ty * ty + tz * tz < 1e-12) {
        tx = 0;
        ty = 1;
        tz = 0;
      }
      let nx = ay * tz - az * ty;
      let ny = az * tx - ax * tz;
      let nz = ax * ty - ay * tx;
      const k = (i * row + j) * 3;
      // outward: same side as the radial direction (the apex and the foot fall back to the profile)
      const rad = SIN[j] * P[k] + COS[j] * P[k + 2];
      if (nx * SIN[j] + nz * COS[j] < 0 && rad > 1e-4) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }
      const len = Math.hypot(nx, ny, nz);
      if (len < 1e-9 || rad <= 1e-4) {
        Nn[k] = 0;
        Nn[k + 1] = i === 0 ? -1 : 1;
        Nn[k + 2] = 0;
      } else {
        Nn[k] = nx / len;
        Nn[k + 1] = ny / len;
        Nn[k + 2] = nz / len;
      }
    }
  }
  const capStart = (ROWS + 1) * row;
  const r0 = radiusAt(s, 0) * H;
  for (let j = 0; j <= COLS; j++) {
    const k = (capStart + j) * 3;
    P[k] = SIN[j] * r0;
    P[k + 1] = 0.001;
    P[k + 2] = COS[j] * r0;
    Nn[k] = 0;
    Nn[k + 1] = -1;
    Nn[k + 2] = 0;
  }
  const c = (capStart + row) * 3;
  P[c + 1] = 0.001;
  Nn[c + 1] = -1;
  (g.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
  (g.getAttribute("normal") as THREE.BufferAttribute).needsUpdate = true;
}

/** the quicksilver column's radius along the cavity (12 samples, local units), for the glass shader */
function stemRadii(s: Shape, out: number[]) {
  for (let k = 0; k < 12; k++) {
    const t = CAVITY_T0 + ((CAVITY_T1 - CAVITY_T0) * k) / 11;
    out[k] = envelopeRadius(t) * HEIGHT;
  }
}

// ---------------------------------------------------------------- the ribbons

const RIB_U = 150; // samples along each ribbon
const RIB_S = 14; // around its cross-section

function ribbonGeometry() {
  const g = new THREE.BufferGeometry();
  const ring = RIB_S + 1;
  const per = (RIB_U + 1) * ring;
  const n = per * 8;
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  const aT = new Float32Array(n);
  const aK = new Float32Array(n);
  const aU = new Float32Array(n);
  const idx: number[] = [];
  for (let k = 0; k < 8; k++)
    for (let i = 0; i <= RIB_U; i++)
      for (let j = 0; j <= RIB_S; j++) {
        const v = k * per + i * ring + j;
        aK[v] = k;
        aU[v] = i / RIB_U;
        if (i < RIB_U && j < RIB_S) idx.push(v, v + ring, v + 1, v + 1, v + ring, v + ring + 1);
      }
  g.setAttribute("aT", new THREE.BufferAttribute(aT, 1));
  g.setAttribute("aK", new THREE.BufferAttribute(aK, 1));
  g.setAttribute("aU", new THREE.BufferAttribute(aU, 1));
  g.setIndex(idx);
  return g;
}

/** sweep each ribbon's flat, rounded cross-section along its centre line */
function writeRibbons(g: THREE.BufferGeometry, s: Shape) {
  const P = (g.getAttribute("position") as THREE.BufferAttribute).array as Float32Array;
  const aT = (g.getAttribute("aT") as THREE.BufferAttribute).array as Float32Array;
  const H = HEIGHT;
  const ring = RIB_S + 1;
  const per = (RIB_U + 1) * ring;
  const C = new THREE.Vector3();
  const Cn = new THREE.Vector3();
  const Cp = new THREE.Vector3();
  const T = new THREE.Vector3();
  const R = new THREE.Vector3();
  const B = new THREE.Vector3();
  const at = (k: number, u: number, out: THREE.Vector3) => {
    const p = ribbonPoint(s, k, u);
    return out.set(p[0] * H, p[1] * H, p[2] * H);
  };
  const sgnPow = (x: number, e: number) => Math.sign(x) * Math.pow(Math.abs(x), e);
  for (let k = 0; k < 8; k++)
    for (let i = 0; i <= RIB_U; i++) {
      const u = i / RIB_U;
      at(k, u, C);
      at(k, Math.min(1, u + 0.004), Cn);
      at(k, Math.max(0, u - 0.004), Cp);
      T.subVectors(Cn, Cp).normalize();
      R.set(C.x, 0, C.z).normalize();
      R.addScaledVector(T, -R.dot(T)).normalize(); // the surface normal: out from her axis
      B.crossVectors(T, R).normalize(); // across the ribbon
      const [w, h] = ribbonSize(u);
      // the ribbon's ends taper into the pedestal and the collar
      const end = Math.min(1, u / 0.04, (1 - u) / 0.05);
      for (let j = 0; j <= RIB_S; j++) {
        const a = (j / RIB_S) * Math.PI * 2;
        const across = sgnPow(Math.cos(a), 0.45) * w * 0.5 * H * (0.35 + 0.65 * end);
        const thick = sgnPow(Math.sin(a), 0.6) * h * 0.5 * H;
        const v = k * per + i * ring + j;
        P[v * 3] = C.x + B.x * across + R.x * thick;
        P[v * 3 + 1] = C.y + B.y * across + R.y * thick;
        P[v * 3 + 2] = C.z + B.z * across + R.z * thick;
        aT[v] = P[v * 3 + 1] / H;
      }
    }
  (g.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
  (g.getAttribute("aT") as THREE.BufferAttribute).needsUpdate = true;
  g.computeVertexNormals();
  g.computeBoundingSphere();
}

// ---------------------------------------------------------------- the crown

/** a hollow flared ring of glass, its outside cut into 16 facets, its rim drawn up into 16 spikes */
function crownGeometry() {
  const g = new THREE.BufferGeometry();
  const rows = CROWN_SECTION.length;
  const ring = COLS + 1;
  const n = rows * ring;
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  const aT = new Float32Array(n);
  const aA = new Float32Array(n);
  const idx: number[] = [];
  for (let i = 0; i < rows; i++)
    for (let j = 0; j <= COLS; j++) {
      const v = i * ring + j;
      aA[v] = (j / COLS) * Math.PI * 2;
      const a = i * ring + j;
      const b = ((i + 1) % rows) * ring + j;
      if (j < COLS) idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  g.setAttribute("aT", new THREE.BufferAttribute(aT, 1));
  g.setAttribute("aA", new THREE.BufferAttribute(aA, 1));
  g.setIndex(idx);
  return g;
}

function writeCrown(g: THREE.BufferGeometry, s: Shape) {
  const P = (g.getAttribute("position") as THREE.BufferAttribute).array as Float32Array;
  const aT = (g.getAttribute("aT") as THREE.BufferAttribute).array as Float32Array;
  const ring = COLS + 1;
  const H = HEIGHT;
  const outerRows = 6; // the first six points of the section are its outside
  CROWN_SECTION.forEach(([r, t], i) => {
    const w = Math.min(1, Math.max(0, (t - 0.824) / (CROWN_RIM_T - 0.824)));
    const lift = w * w * (3 - 2 * w);
    for (let j = 0; j <= COLS; j++) {
      const a = (j / COLS) * Math.PI * 2;
      const rf = r * (i < outerRows ? POLY[j] : 1);
      const v = i * ring + j;
      const y = t + crownSpike(s.points, a) * lift;
      P[v * 3] = SIN[j] * rf * H;
      P[v * 3 + 1] = y * H;
      P[v * 3 + 2] = COS[j] * rf * H;
      aT[v] = y;
    }
  });
  (g.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
  (g.getAttribute("aT") as THREE.BufferAttribute).needsUpdate = true;
  g.computeVertexNormals();
  g.computeBoundingSphere();
}

/** the glass beads on the tips of the eight data spikes of her crown (local positions) */
function beadPositions(s: Shape): THREE.Vector3[] {
  const rim = CROWN_RIM_R * HEIGHT * 0.985;
  return Array.from({ length: 8 }, (_, j) => {
    const a = pointAngle(j);
    const y = (CROWN_RIM_T + crownSpike(s.points, a)) * HEIGHT + 0.012;
    return new THREE.Vector3(Math.sin(a) * rim, y, Math.cos(a) * rim);
  });
}

function gateT(s: Shape): number[] {
  return s.gate.map((gk, k) => BAND_T0 + k * BAND_H + Math.abs(gk) * BAND_H * 0.92 + BAND_H * 0.04);
}

export function Queen() {
  const body = useMemo(bodyGeometry, []);
  const ballGeo = useMemo(() => {
    // the finial is a cut gem: a stretched octahedron of flat facets, so it flashes as she turns
    const s = new THREE.OctahedronGeometry(BALL_R * HEIGHT, 0).scale(1, 1.5, 1); // already non-indexed: flat facets
    s.computeVertexNormals();
    const n = s.getAttribute("position").count;
    s.setAttribute("aT", new THREE.BufferAttribute(new Float32Array(n).fill(0.97), 1)); // > 0.95: a small solid lens
    s.setAttribute("aA", new THREE.BufferAttribute(new Float32Array(n), 1));
    return s;
  }, []);

  const beadGeo = useMemo(() => {
    const b = new THREE.SphereGeometry(0.011 * HEIGHT, 16, 12);
    const n = b.getAttribute("position").count;
    b.setAttribute("aT", new THREE.BufferAttribute(new Float32Array(n).fill(0.97), 1));
    b.setAttribute("aA", new THREE.BufferAttribute(new Float32Array(n), 1));
    return b;
  }, []);
  const ribbons = useMemo(ribbonGeometry, []);
  const crown = useMemo(crownGeometry, []);
  const genes0 = useMemo(() => liveGenes(arena.get()), []);
  const shape0 = useMemo(() => shapeOf(genes0), [genes0]);
  const st = useRef({
    a: shape0,
    b: shape0,
    cur: shape0,
    genes: genes0,
    morphStart: -1,
    morphDur: 1.8,
    key: genes0.join(","),
    fill: 0.9,
    fillTarget: 0.9,
    rip: 0,
    wave: 0,
    flash: 0,
    diff: 0,
    liveBeat: 0,
    // her voice: the last level, and when the last pulse ran through her
    voicePrev: 0,
    voicePulse: 0,
    echoPrev: 0,
    t: 0,
    rot: 0,
    slosh: 0,
    ovKey: "",
    tiltX: 0,
    tiltZ: 0,
    // the gel press: a damped spring (position, velocity), and whether the cursor was down last frame
    px: 0,
    pv: 0,
    wasPressed: false,
  });

  const glassU = useMemo(
    () => ({
      tScene: { value: null as THREE.Texture | null },
      uRes: { value: new THREE.Vector2(1, 1) },
      uTime: { value: 0 },
      uBreath: { value: 0.006 },
      uRipples: { value: Array.from({ length: 8 }, () => new THREE.Vector4(0, -100, 0, 0)) },
      uFlash: { value: 0 },
      uFlashA: { value: 0 },
      uIntro: { value: 0 },
      uBand: { value: -1 },
      uLive: { value: 0 },
      uDim: { value: 0 },
      uHit: { value: new Float32Array(8) },
      uHitP: { value: new Float32Array(8) },
      uDiff: { value: new Float32Array(8) },
      uDiffP: { value: new Float32Array(8) },
      uGateT: { value: Float32Array.from(gateT(shape0)) },
      uLab: { value: new Float32Array(8) },
      uTouch: { value: new THREE.Vector3(0, 1.2, 0) },
      uTouchAmt: { value: 0 },
      uStreak: { value: new THREE.Vector4(0, -100, 0, -100) },
      uCursorL: { value: new THREE.Vector3(-2, 2.5, 4) },
      uCursorAmt: { value: 0.35 },
      uCursorS: { value: new THREE.Vector2(0.3, 0.8) },
      uAspect: { value: 1.6 },
      uPress: { value: 0 },
      uFrost: { value: 0.6 },
      // the quicksilver, drawn by the glass itself: its top and the cavity floor (local y)
      uFill: { value: CAVITY_T0 * HEIGHT },
      uCav0: { value: CAVITY_T0 * HEIGHT },
      uCav1: { value: CAVITY_T1 * HEIGHT },
      uStemR: { value: new Float32Array(12) },
      uCore: gfx.core,
      uMoon: worldU.uMoon,
      uMoonSize: worldU.uMoonSize,
      uMoonTint: worldU.uMoonTint,
      uMoonGlow: worldU.uMoonGlow,
      uHot: { value: palette.hot },
      uCold: { value: palette.cold },
      uIvory: { value: palette.ivory },
    }),
    [shape0],
  );
  const glass = useMemo(() => new THREE.ShaderMaterial({ vertexShader: GLASS_VERT, fragmentShader: GLASS_FRAG, uniforms: glassU, side: THREE.FrontSide }), [glassU]);
  // the ribbons share the glass's live uniforms (flash, hits, diffs, cursor, intro); two halves
  const ribbonMats = useMemo(() => {
    const mk = (side: number) =>
      new THREE.ShaderMaterial({
        vertexShader: RIBBON_VERT,
        fragmentShader: RIBBON_FRAG,
        uniforms: {
          uSide: { value: side },
          uCenter: { value: new THREE.Vector3(0, 0, 0) },
          uIntro: glassU.uIntro,
          uDim: glassU.uDim,
          uFlash: glassU.uFlash,
          uHit: glassU.uHit,
          uDiff: glassU.uDiff,
          uBand: glassU.uBand,
          uHot: glassU.uHot,
          uCursorL: glassU.uCursorL,
          uCursorAmt: glassU.uCursorAmt,
          uCore: gfx.core,
          uStreak: glassU.uStreak,
          uTime: glassU.uTime,
          uMoon: worldU.uMoon,
          uMoonSize: worldU.uMoonSize,
          uMoonTint: worldU.uMoonTint,
          uMoonGlow: worldU.uMoonGlow,
          uIvory: glassU.uIvory,
          uCold: glassU.uCold,
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.CustomBlending,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
        side: THREE.DoubleSide,
      });
    const crownMk = (side: number) => {
      const m = mk(side);
      m.defines = { CROWN: 1 };
      m.uniforms.uHitP = glassU.uHitP;
      m.uniforms.uDiffP = glassU.uDiffP;
      m.uniforms.uLab = glassU.uLab;
      return m;
    };
    return { back: mk(-1), front: mk(1), crownBack: crownMk(-1), crownFront: crownMk(1) };
  }, [glassU]);
  useEffect(() => {
    gfx.glass = glass;
    return () => {
      if (gfx.glass === glass) gfx.glass = null;
    };
  }, [glass]);
  const beads = useMemo(() => beadPositions(shape0), [shape0]);
  useMemo(() => {
    writeBody(body, shape0);
    writeRibbons(ribbons, shape0);
    writeCrown(crown, shape0);
    const r: number[] = [];
    stemRadii(shape0, r);
    glassU.uStemR.value.set(r);
  }, [body, ribbons, crown, shape0, glassU]);

  const group = useRef<THREE.Group>(null);
  const bodyRef = useRef<THREE.Mesh>(null);
  const ballRef = useRef<THREE.Mesh>(null);

  const ribFront = useRef<THREE.Mesh>(null);
  const ribBack = useRef<THREE.Mesh>(null);
  const crownFront = useRef<THREE.Mesh>(null);
  const crownBack = useRef<THREE.Mesh>(null);
  const beadRefs = useRef<(THREE.Mesh | null)[]>([]);
  useEffect(() => {
    bodyRef.current?.layers.set(LAYER_GLASS);
    ballRef.current?.layers.set(LAYER_GLASS);
    ribFront.current?.layers.set(LAYER_RIBBON_FRONT);
    ribBack.current?.layers.set(LAYER_RIBBON_BACK);
    crownFront.current?.layers.set(LAYER_RIBBON_FRONT);
    crownBack.current?.layers.set(LAYER_RIBBON_BACK);
    beadRefs.current.forEach((b) => b?.layers.set(LAYER_GLASS));
  }, []);

  useEffect(() => {
    const s = st.current;
    const morphTo = (genes: number[], dur = 1.8) => {
      const key = genes.join(",");
      if (key === s.key) return;
      // under the loading curtain she simply is her live shape: no morph, no cold flash, no ripples
      const quiet = !scene.revealed;
      // light every gene that changed (cold, ~2 s), so even a +16 mutation is seen
      const old = s.genes;
      for (let k = 0; k < 8; k++) {
        glassU.uDiff.value[k] = old[k] !== genes[k] || old[16 + k] !== genes[16 + k] ? 1 : 0;
        glassU.uDiffP.value[k] = old[8 + k] !== genes[8 + k] ? 1 : 0;
      }
      s.diff = quiet ? 0 : 1;
      s.key = key;
      s.genes = genes.slice();
      s.a = s.cur;
      s.b = shapeOf(genes);
      s.morphStart = s.t;
      s.morphDur = scene.reducedMotion || quiet ? 0.001 : dur;
      if (!quiet) for (let k = 0; k < 4; k++) ripple((k / 4) * Math.PI * 2, 0.6, 0.05);
    };
    const ripple = (a: number, strength: number, tAt: number) => {
      if (scene.reducedMotion) return;
      glassU.uRipples.value[s.rip++ % 8].set(a, s.t, strength, tAt);
    };
    // a strike makes the quicksilver slosh: its level rocks and settles
    const wave = (_a: number, strength: number) => {
      if (scene.reducedMotion) return;
      s.slosh = Math.max(s.slosh, strength * 0.035);
    };
    (window as unknown as { __queen?: unknown }).__queen = { morphTo, state: s };
    return bus.on((e) => {
      if (e.type === "lab-preview") {
        for (let k = 0; k < 8; k++) labValues[k] = e.steps[k] ? (e.steps[k].refused ? 2 : e.steps[k].held ? 3 : 1) : 0;
        return;
      }
      if (e.type === "snapshot") {
        const sn = e.snapshot;
        if (!scene.overrideGenes) morphTo(sn.live.genes);
        s.fillTarget = sn.epochStartBalance > 0n ? Math.max(0.04, Math.min(1, Number((sn.vaultBalance * 1000n) / sn.epochStartBalance) / 1000)) : 0.9;
        return;
      }
      if (e.type === "queen-refuses") {
        // refused to your face: the red of a refusal, toward you, with nothing named (no transaction was judged)
        for (let k = 0; k < 8; k++) glassU.uHit.value[k] = glassU.uHitP.value[k] = 0;
        s.flash = 1;
        glassU.uFlashA.value = -s.rot;
        ripple(-s.rot, 0.7, 0.05);
        return;
      }
      if (e.type !== "chain") return;
      const ev = e.event;
      if (ev.name === "Spend") {
        const world = attackAngle(String(ev.args.caller));
        const refused = Boolean(ev.args.refused);
        // a held payment moves nothing yet: a firmer ripple than a payment, no wave of light leaving, no red
        const held = Number(ev.args.verdict ?? 0) === 1;
        const reason = BigInt(ev.args.reason as bigint);
        setTimeout(() => {
          const a = world - s.rot; // she turns slowly in place: the impact in her own frame
          ripple(a, refused ? 1 : held ? 0.75 : 0.55, 0.05);
          wave(a, refused ? 0.35 : held ? 0.2 : 1);
          if (refused) {
            // light exactly the features the contract named, so the refusal explains itself
            for (let k = 0; k < 8; k++) {
              glassU.uHit.value[k] = (reason >> BigInt(k)) & 1n ? 1 : 0;
              glassU.uHitP.value[k] = (reason >> BigInt(8 + k)) & 1n ? 1 : 0;
            }
            s.flash = 1;
            glassU.uFlashA.value = a;
          }
        }, scene.reducedMotion ? 0 : TRAVEL * 1000);
      } else if (ev.name === "PolicyInstalled" && !e.replay && !scene.overrideGenes) {
        morphTo(genesFromWords(ev.args.lo as bigint, ev.args.hi as bigint));
        s.liveBeat = 1;
      }
    });
  }, [glassU]);

  useFrame((state, dt) => {
    const s = st.current;
    const t = state.clock.elapsedTime;
    s.t = t;
    const ov = scene.overrideGenes ? scene.overrideGenes.join(",") : "";
    if (ov !== s.ovKey) {
      s.ovKey = ov;
      const genes = scene.overrideGenes ?? liveGenes(arena.get());
      const key = genes.join(",");
      if (key !== s.key) {
        s.key = key;
        s.genes = genes.slice();
        s.a = s.cur;
        s.b = shapeOf(genes);
        s.morphStart = t;
        s.morphDur = scene.reducedMotion ? 0.001 : 0.7;
      }
    }
    if (s.morphStart >= 0) {
      const k = easeOut((t - s.morphStart) / s.morphDur);
      s.cur = lerpShape(s.a, s.b, k);
      writeBody(body, s.cur);
      writeRibbons(ribbons, s.cur);
      writeCrown(crown, s.cur);
      beadPositions(s.cur).forEach((p, j) => beadRefs.current[j]?.position.copy(p));
      glassU.uGateT.value.set(gateT(s.cur));
      const r: number[] = [];
      stemRadii(s.cur, r);
      glassU.uStemR.value.set(r);

      if (k >= 1) s.morphStart = -1;
    }
    const prevFill = s.fill;
    s.fill += (s.fillTarget - s.fill) * Math.min(1, dt * 1.6);
    void prevFill;
    const grow = easeOut(Math.max(0, (scene.intro - 0.3) / 0.7));
    const topT = CAVITY_T0 + (CAVITY_T1 - CAVITY_T0) * s.fill * grow;
    s.slosh *= Math.exp(-dt * 2.4);
    glassU.uFill.value = grow > 0.02 ? topT * HEIGHT + Math.sin(t * 13) * s.slosh : CAVITY_T0 * HEIGHT - 1;
    gfx.core.value = s.fill * grow;

    s.flash = Math.max(0, s.flash - dt * 1.5);
    s.diff = Math.max(0, s.diff - dt * 0.5);
    s.liveBeat = Math.max(0, s.liveBeat - dt * 0.6);
    const g = glassU;
    for (let k = 0; k < 8; k++) {
      g.uDiff.value[k] *= s.diff > 0 ? 1 : 0;
      g.uDiffP.value[k] *= s.diff > 0 ? 1 : 0;
    }
    g.uTime.value = t;
    g.uFlash.value = s.flash;
    // scale the diff glow by its envelope
    if (s.diff > 0) for (let k = 0; k < 8; k++) {
      g.uDiff.value[k] = g.uDiff.value[k] > 0 ? s.diff : 0;
      g.uDiffP.value[k] = g.uDiffP.value[k] > 0 ? s.diff : 0;
    }
    g.uIntro.value = Math.max(0.001, grow * (BALL_T + BALL_R) + (grow >= 1 ? 0.2 : 0));
    // her line in your voice: she stands still and dark while it plays, and flares cold the moment it is hers again
    const echo = scene.echo;
    if (s.echoPrev && !echo) s.liveBeat = 1.6;
    s.echoPrev = echo;
    g.uLive.value = echo ? 0.05 : (scene.reducedMotion ? 0.4 : 0.35 + 0.35 * Math.sin(t * Math.PI * 0.5)) + s.liveBeat + scene.voice * 1.8;
    // as she speaks, each stressed syllable sends a pulse through her glass, toward you
    const v = echo ? 0 : scene.voice;
    if (!scene.reducedMotion && v > 0.2 && v - s.voicePrev > 0.05 && s.t - s.voicePulse > 0.22) {
      s.voicePulse = s.t;
      glassU.uRipples.value[s.rip++ % 8].set(-s.rot + (Math.random() - 0.5) * 0.9, s.t, 0.16 + v * 0.34, 0.02);
    }
    s.voicePrev = v;
    g.uBreath.value = scene.reducedMotion ? 0 : 0.006;
    g.uDim.value += (scene.dim - g.uDim.value) * Math.min(1, dt * 3);
    g.uBand.value = scene.band;
    // predictions show on the crown only while you are composing an attack
    const composing = scene.section === "try" || ui.get().lab;
    for (let k = 0; k < 8; k++) g.uLab.value[k] = composing ? labValues[k] : 0;
    g.tScene.value = gfx.opaque?.texture ?? null;
    g.uRes.value.set(gfx.width, gfx.height);
    s.rot = scene.reducedMotion ? 0 : t * 0.035;
    // the cursor: touch point, light, and a gentle lean toward you
    g.uTouch.value.copy(gfx.touch.point);
    g.uTouchAmt.value = gfx.touch.amt;
    g.uCursorL.value.copy(gfx.touch.light);
    g.uCursorAmt.value = gfx.touch.lightAmt;
    g.uCursorS.value.copy(gfx.touch.screen);
    g.uAspect.value = gfx.width / Math.max(1, gfx.height);
    // press her and the glass gives like gel, then springs back past rest and settles
    const pressed = gfx.touch.pressed && gfx.touch.touching && !scene.reducedMotion;
    if (pressed && !s.wasPressed) {
      const p = gfx.touch.point;
      g.uRipples.value[s.rip++ % 8].set(Math.atan2(p.x, p.z) - s.rot, t, 0.9, p.y / HEIGHT);
      // and a pulse of light runs through her from where she was struck
      g.uStreak.value.set(p.x, p.y, p.z, g.uTime.value);
    }
    s.wasPressed = pressed;
    const h = Math.min(dt, 1 / 30);
    s.pv += ((pressed ? 1 : 0) - s.px) * 170 * h - s.pv * 13 * h;
    s.px += s.pv * h;
    g.uPress.value = s.px;
    const lean = scene.reducedMotion ? 0 : 1;
    s.tiltX += ((-scene.pointer.ny * 0.045 * lean) - s.tiltX) * Math.min(1, dt * 2.2);
    s.tiltZ += ((-scene.pointer.nx * 0.035 * lean) - s.tiltZ) * Math.min(1, dt * 2.2);
    if (group.current) {
      group.current.rotation.set(s.tiltX, s.rot, s.tiltZ);
    }
    queenFrame.rot = s.rot;
    queenFrame.shape = s.cur;
    queenFrame.fill = s.fill;
  });

  return (
    <group ref={group}>
      <mesh ref={bodyRef} geometry={body} material={glass} frustumCulled={false} renderOrder={2} />
      <mesh ref={ballRef} geometry={ballGeo} material={glass} position={[0, BALL_T * HEIGHT, 0]} renderOrder={2} />
      {beads.map((p, j) => (
        <mesh key={j} ref={(m) => void (beadRefs.current[j] = m)} geometry={beadGeo} material={glass} position={p} renderOrder={2} />
      ))}
      <mesh ref={ribBack} geometry={ribbons} material={ribbonMats.back} frustumCulled={false} renderOrder={1} />
      <mesh ref={ribFront} geometry={ribbons} material={ribbonMats.front} frustumCulled={false} renderOrder={3} />
      <mesh ref={crownBack} geometry={crown} material={ribbonMats.crownBack} frustumCulled={false} renderOrder={1} />
      <mesh ref={crownFront} geometry={crown} material={ribbonMats.crownFront} frustumCulled={false} renderOrder={3} />
      <GeneHelix />
    </group>
  );
}

const labValues = new Float32Array(8);

/** Shared per-frame state so DOM annotations can find points on her body. */
export const queenFrame = { rot: 0, shape: null as Shape | null, fill: 0.9 };

/** Loader: one point of light divides into 32 genes that climb a helix to their stations, then fade into her. */
function GeneHelix() {
  const ref = useRef<THREE.Points>(null);
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(96), 3));
    return g;
  }, []);
  const mat = useMemo(
    () => new THREE.PointsMaterial({ color: palette.ivory.clone(), size: 4, sizeAttenuation: false, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
    [],
  );
  useEffect(() => {
    ref.current?.layers.set(LAYER_GLASS);
  }, []);
  useFrame(() => {
    const intro = scene.intro;
    if (!ref.current) return;
    ref.current.visible = intro < 0.999;
    if (!ref.current.visible) return;
    const P = (geo.getAttribute("position") as THREE.BufferAttribute).array as Float32Array;
    const split = easeOut(Math.min(1, intro / 0.35));
    const sh = shapeOf(liveGenes(arena.get()));
    for (let i = 0; i < 32; i++) {
      const t = BAND_T0 + (i / 31) * (BAND_T1 - BAND_T0);
      const a = i * 0.62 + intro * 2.0;
      const r = (radiusAt(sh, t) * HEIGHT + 0.06) * split;
      P[i * 3] = Math.sin(a) * r;
      P[i * 3 + 1] = 0.02 + t * HEIGHT * split;
      P[i * 3 + 2] = Math.cos(a) * r;
    }
    (geo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    mat.opacity = intro < 0.08 ? 1 : 1 - Math.max(0, (intro - 0.55) / 0.45);
    mat.size = (intro < 0.08 ? 7 : 3.5) * Math.min(2, window.devicePixelRatio);
  });
  return <points ref={ref} geometry={geo} material={mat} frustumCulled={false} />;
}
