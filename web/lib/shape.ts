/**
 * The shield's shape IS the genome. 32 vertices, one per gene, interleaved so every feature owns a
 * sector of the rim: vertex 4k = weight w_k, 4k+1 = interaction v_k, 4k+2 = threshold t_k, 4k+3 = reserved.
 * The genesis (all-zero) genome is a perfect circle.
 */
export const VERTEX_GENE: number[] = Array.from({ length: 32 }, (_, v) => {
  const k = Math.floor(v / 4);
  const slot = v % 4;
  return slot === 0 ? k : slot === 1 ? 8 + k : slot === 2 ? 16 + k : 24 + k;
});

const SCALE = [900, 500, 700, 4000]; // per slot: weights, interactions, thresholds, reserved

export function radii(genes: number[]): number[] {
  return VERTEX_GENE.map((g, v) => 1 + 0.24 * Math.tanh((genes[g] ?? 0) / SCALE[v % 4]));
}

/** Periodic Catmull-Rom through the 32 radii. */
export function radiusAt(r: number[], theta: number): number {
  const n = r.length;
  const x = (((theta / (Math.PI * 2)) % 1) + 1) % 1 * n;
  const i = Math.floor(x);
  const t = x - i;
  const p0 = r[(i - 1 + n) % n];
  const p1 = r[i % n];
  const p2 = r[(i + 1) % n];
  const p3 = r[(i + 2) % n];
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/** SVG path of the silhouette, centred at (cx, cy) with base radius R. */
export function silhouettePath(genes: number[], cx: number, cy: number, R: number, samples = 128): string {
  const r = radii(genes);
  let d = "";
  for (let s = 0; s <= samples; s++) {
    const th = (s / samples) * Math.PI * 2 - Math.PI / 2;
    const rr = radiusAt(r, th + Math.PI / 2) * R;
    const x = cx + Math.cos(th) * rr;
    const y = cy + Math.sin(th) * rr;
    d += `${s === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
  }
  return d + "Z";
}

/** angle (radians, 0 = up, clockwise) of the rim sector owned by feature k */
export function featureAngle(k: number): number {
  return ((k * 4 + 1.5) / 32) * Math.PI * 2;
}
