"use client";
/**
 * The world round her: the Looking-Glass country. A night sky with a low moon, endless chessboard fields
 * divided by brooks of light that sink into the mist, giant pieces of an unfinished game standing far out in
 * the fields, and dust in the air. The board under her mirrors the sky, the moon and the giants.
 */
import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { scene } from "@/lib/scene";
import { BALL_R, BALL_T, TOP_T, canonicalRadius } from "@/lib/queen";
import { DUST_FRAG, DUST_VERT, PIECE_FRAG, PIECE_VERT, SKY_FRAG, SKY_VERT } from "./shaders";
import { gfx, LAYER_OPAQUE, LAYER_SCENERY } from "./gfx";
import { palette } from "./palette";

/**
 * The moon is her backlight. A few placements and tones to compare, chosen with ?moon=<name> (the default is
 * "side", the default); every one is reversible, nothing else depends on which is chosen.
 *   rise    low, rising behind her body, so it shines through the ribbons; pale and a little warm
 *   crown   behind her crown, cold blue-white with a wide corona
 *   side    small, high and to the right of her, out of the way
 *   classic the first version: large, plain, straight behind the crown
 */
const MOONS = {
  rise: { dir: [0.03, 0.065, -1], size: 0.06, tint: [0.97, 0.94, 0.88], glow: 1.15 },
  crown: { dir: [0.0, 0.118, -1], size: 0.038, tint: [0.82, 0.9, 1.0], glow: 1.6 },
  side: { dir: [0.34, 0.2, -1], size: 0.026, tint: [0.92, 0.924, 0.92], glow: 1.0 },
  classic: { dir: [0.0, 0.13, -1], size: 0.05, tint: [0.92, 0.924, 0.92], glow: 1.0 },
} as const;
export type MoonName = keyof typeof MOONS;
function pickMoon(): MoonName {
  if (typeof window === "undefined") return "side";
  const q = new URLSearchParams(window.location.search).get("moon");
  // own keys only: "constructor" or "toString" are `in` every object and crashed the page
  return q && Object.prototype.hasOwnProperty.call(MOONS, q) ? (q as MoonName) : "side";
}
const moon = MOONS[pickMoon()];

/** shared by every world material */
export const worldU = {
  uMoon: { value: new THREE.Vector3(...moon.dir).normalize() },
  uMoonSize: { value: moon.size },
  uMoonTint: { value: new THREE.Vector3(...moon.tint) },
  uMoonGlow: { value: moon.glow },
  uIvory: { value: palette.ivory },
  uCold: { value: palette.cold },
};

function useDim(u: { uDim: THREE.IUniform<number> }) {
  useFrame((_, dt) => {
    u.uDim.value += (scene.dim - u.uDim.value) * Math.min(1, dt * 3);
  });
}

// ------------------------------------------------------------------------------------------- sky + fields

export function Sky() {
  const ref = useRef<THREE.Mesh>(null);
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    return g;
  }, []);
  const u = useMemo(() => ({ ...worldU, uTime: { value: 0 }, uDim: { value: 0 }, uLamp: { value: gfx.touch.lamp } }), []);
  const mat = useMemo(
    () => new THREE.ShaderMaterial({ vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, uniforms: u, depthTest: false, depthWrite: false, side: THREE.DoubleSide }),
    [u],
  );
  useEffect(() => {
    ref.current?.layers.set(LAYER_SCENERY);
  }, []);
  useDim(u);
  useFrame((state) => {
    u.uTime.value = scene.reducedMotion ? 0 : state.clock.elapsedTime;
  });
  return <mesh ref={ref} geometry={geo} material={mat} frustumCulled={false} renderOrder={-100} />;
}

// ------------------------------------------------------------------------------------------- the giants

type Kind = "pawn" | "rook" | "bishop" | "king" | "queen";

const arc = (cy: number, r: number, from: number, to: number, n = 10): [number, number][] =>
  Array.from({ length: n + 1 }, (_, i) => {
    const a = from + ((to - from) * i) / n;
    return [Math.max(0, Math.cos(a) * r), cy + Math.sin(a) * r];
  });

const FOOT: [number, number][] = [
  [0, 0],
  [0.41, 0],
  [0.43, 0.03],
  [0.41, 0.07],
  [0.33, 0.09],
  [0.31, 0.13],
  [0.24, 0.17],
];

const PROFILES: Record<Exclude<Kind, "queen">, [number, number][]> = {
  pawn: [...FOOT, [0.16, 0.28], [0.12, 0.46], [0.22, 0.5], [0.22, 0.54], [0.13, 0.57], ...arc(0.75, 0.2, -1.2, Math.PI / 2, 12)],
  rook: [...FOOT, [0.22, 0.26], [0.21, 0.62], [0.27, 0.66], [0.27, 0.7], [0.24, 0.72], [0.29, 0.78], [0.31, 1.0], [0.22, 1.0], [0.22, 0.94], [0, 0.94]],
  bishop: [...FOOT, [0.14, 0.3], [0.11, 0.52], [0.2, 0.56], [0.2, 0.59], [0.12, 0.62], [0.16, 0.68], [0.18, 0.75], [0.16, 0.83], [0.11, 0.89], [0.05, 0.92], ...arc(0.955, 0.04, -1.2, Math.PI / 2, 6)],
  king: [...FOOT, [0.16, 0.3], [0.13, 0.58], [0.24, 0.62], [0.24, 0.65], [0.15, 0.68], [0.2, 0.8], [0.22, 0.84], [0.12, 0.86], [0.05, 0.87], [0, 0.87]],
};

function pieceGeometry(kind: Kind): THREE.BufferGeometry {
  let pts: [number, number][];
  if (kind === "queen") {
    // her own silhouette (the genesis queen), at a distance the crown points are not needed
    pts = Array.from({ length: 49 }, (_, i) => {
      const t = (i / 48) * TOP_T;
      return [canonicalRadius(t), t] as [number, number];
    });
    pts.push(...arc(BALL_T, BALL_R, -Math.PI / 2, Math.PI / 2, 8));
  } else pts = PROFILES[kind];
  const lathe = new THREE.LatheGeometry(
    pts.map(([r, y]) => new THREE.Vector2(r, y)),
    40,
  );
  if (kind !== "king") return lathe;
  // the king's cross
  const post = new THREE.BoxGeometry(0.05, 0.15, 0.05).translate(0, 0.94, 0);
  const bar = new THREE.BoxGeometry(0.16, 0.045, 0.05).translate(0, 0.955, 0);
  const g = mergeGeometries([lathe.toNonIndexed(), post.toNonIndexed(), bar.toNonIndexed()]);
  return g ?? lathe;
}

/** [kind, azimuth°, distance, height]. Spread round the whole orbit so every chapter has a horizon. */
const GIANTS: [Kind, number, number, number][] = [
  // the opening frame keeps clear behind the title: one far king on the horizon, a rook beyond the notes
  ["king", 207, 112, 26],
  ["rook", 168, 96, 18],
  // the vault
  ["queen", 229, 76, 18],
  ["pawn", 218, 54, 7.5],
  ["rook", 245, 98, 16],
  // your turn, looking up from the attacker's edge
  ["king", 299, 82, 23],
  ["bishop", 287, 62, 13],
  ["pawn", 314, 50, 7.5],
  ["rook", 324, 90, 17],
  // the record
  ["bishop", 341, 76, 15],
  ["pawn", 352, 58, 7.5],
  // generations
  ["rook", 21, 74, 15],
  ["pawn", 9, 54, 7.5],
  ["queen", 33, 96, 20],
  // is she learning
  ["king", 99, 84, 21],
  ["pawn", 111, 56, 7.5],
  ["bishop", 121, 68, 14],
  // back a bloodline
  ["rook", 138, 78, 15],
  ["pawn", 129, 52, 7],
];

export function DistantPieces() {
  const u = useMemo(() => ({ ...worldU, uDim: { value: 0 } }), []);
  const mat = useMemo(() => new THREE.ShaderMaterial({ vertexShader: PIECE_VERT, fragmentShader: PIECE_FRAG, uniforms: u, side: THREE.DoubleSide }), [u]);
  const groups = useMemo(() => {
    const kinds = Array.from(new Set(GIANTS.map((g) => g[0])));
    return kinds.map((kind) => {
      const list = GIANTS.filter((g) => g[0] === kind);
      const mesh = new THREE.InstancedMesh(pieceGeometry(kind), mat, list.length);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      list.forEach(([, az, dist, h], i) => {
        const a = (az * Math.PI) / 180;
        // stand each one in the middle of a field
        const x = (Math.floor((Math.sin(a) * dist) / 8) + 0.5) * 8;
        const z = (Math.floor((Math.cos(a) * dist) / 8) + 0.5) * 8;
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (i * 2.399 + az) % (Math.PI * 2));
        m.compose(new THREE.Vector3(x, 0, z), q, new THREE.Vector3(h, h, h));
        mesh.setMatrixAt(i, m);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.frustumCulled = false;
      mesh.layers.set(LAYER_SCENERY);
      return mesh;
    });
  }, [mat]);
  useDim(u);
  return (
    <group>
      {groups.map((g, i) => (
        <primitive key={i} object={g} />
      ))}
    </group>
  );
}

// ------------------------------------------------------------------------------------------- dust

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function Dust({ count = 700 }: { count?: number }) {
  const ref = useRef<THREE.Points>(null);
  const geo = useMemo(() => {
    const r = rng(7);
    const seed = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const rad = Math.sqrt(2.2 * 2.2 + r() * (17 * 17 - 2.2 * 2.2));
      const a = r() * Math.PI * 2;
      seed[i * 4] = Math.sin(a) * rad;
      seed[i * 4 + 1] = 0.1 + Math.pow(r(), 1.6) * 6.4;
      seed[i * 4 + 2] = Math.cos(a) * rad;
      seed[i * 4 + 3] = r();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    g.setAttribute("aSeed", new THREE.BufferAttribute(seed, 4));
    return g;
  }, [count]);
  const u = useMemo(
    () => ({ uTime: { value: 0 }, uPx: { value: 1 }, uIvory: { value: palette.ivory }, uDim: { value: 0 }, uRayO: { value: gfx.touch.rayO }, uRayD: { value: gfx.touch.rayD } }),
    [],
  );
  const mat = useMemo(
    () => new THREE.ShaderMaterial({ vertexShader: DUST_VERT, fragmentShader: DUST_FRAG, uniforms: u, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
    [u],
  );
  useEffect(() => {
    ref.current?.layers.set(LAYER_OPAQUE);
  }, []);
  useDim(u);
  useFrame((state) => {
    u.uTime.value = scene.reducedMotion ? 0 : state.clock.elapsedTime;
    u.uPx.value = gfx.dpr;
  });
  return <points ref={ref} geometry={geo} material={mat} frustumCulled={false} />;
}
