/**
 * The Red Queen's body IS the policy.
 *
 * A liquid-glass queen: a slender glowing stem on a stepped pedestal, wrapped by eight glass ribbons
 * that spiral up from the pedestal and gather under a collar, crowned with sixteen spikes and a cut gem.
 * The genome shapes her with one meaning per element:
 *
 *   8 ribbons, one per feature k (f0 amount … f7 epoch outflow)
 *     girth = weight w_k     a ribbon swings out from the stem when its feature is punished (w > 0) and
 *                            hugs it when the feature is trusted (w < 0)
 *   8 tall crown spikes = interactions v_j (pair j of the SDK's PAIRS); taller when the pair is punished,
 *                         each tipped with a glass bead. (8 shorter spikes between them are ornament.)
 *   the light inside her stem = the vault's balance against the start of the epoch.
 *   Gates and reserved genes have no form (gates are shown in the inspector and annotations).
 *
 * Values are signed-log normalised so sparse genomes and ±16..64 mutations stay visible:
 *   n(g) = sign(g) · log1p(|g|/s) / log1p(S/s), clamped to [−1, 1]
 * Shared by the WebGL piece, the 2D edition and every SVG silhouette.
 */

export const HEIGHT = 2.5;
export const TOP_T = 0.89;
/** the cut gem crowning her */
export const BALL_R = 0.02; // x HEIGHT
export const BALL_T = 0.918;
/** where the crown's rim is and where its spikes rise from */
export const CROWN_RIM_T = 0.845;
export const CROWN_RIM_R = 0.144; // x HEIGHT

/** the turned body: pedestal, stem, collar, neck and crown cup (radius x HEIGHT at height fraction t) */
const ENVELOPE: [number, number][] = [
  [0.0, 0.196],
  [0.02, 0.2],
  [0.045, 0.19],
  [0.07, 0.172],
  [0.09, 0.15],
  [0.1, 0.11],
  [0.112, 0.075],
  [0.13, 0.055],
  [0.2, 0.042],
  [0.3, 0.034],
  [0.4, 0.031],
  [0.5, 0.032],
  [0.56, 0.037],
  [0.6, 0.044],
  [0.63, 0.052],
  [0.66, 0.052],
  [0.69, 0.046],
  [0.705, 0.05],
  [0.72, 0.058],
  [0.733, 0.064],
  // inside the hollow crown: a slender stem carrying the gem
  [0.742, 0.03],
  [0.755, 0.019],
  [0.8, 0.0165],
  [0.86, 0.016],
  [0.878, 0.019],
  [0.886, 0.012],
  [0.89, 0.0],
];

/** [centre t, half-width t, height (x HEIGHT, negative = a cove), profile exponent (2 round bead, 6 flat disc)] */
const MOLDINGS: [number, number, number, number][] = [
  // the pedestal: three soft stepped tiers, each finished with a bead
  [0.014, 0.014, 0.022, 5],
  [0.03, 0.0035, 0.01, 2],
  [0.047, 0.011, 0.016, 5],
  [0.06, 0.003, 0.008, 2],
  [0.076, 0.009, 0.012, 5],
  [0.088, 0.003, 0.007, 2],
  // the collar the ribbons gather into
  [0.632, 0.004, 0.012, 2],
  [0.648, 0.011, 0.05, 6],
  [0.666, 0.0045, 0.022, 2],
  [0.68, 0.006, 0.03, 5],
  [0.878, 0.004, 0.008, 2], // the ring under the gem
];

/**
 * The crown is a hollow flared ring of glass round the top of her (built in components/stage/Queen.tsx):
 * its cross-section, [radius x HEIGHT, height t], outside up the flare, across the rim, inside back down.
 */
export const CROWN_SECTION: [number, number][] = [
  [0.07, 0.729],
  [0.081, 0.745],
  [0.101, 0.78],
  [0.124, 0.815],
  [0.14, 0.838],
  [0.144, 0.845],
  [0.138, 0.848],
  [0.128, 0.843],
  [0.112, 0.818],
  [0.09, 0.783],
  [0.071, 0.749],
  [0.06, 0.733],
  [0.064, 0.727],
];

function moldingAt(t: number): number {
  let d = 0;
  for (const [c, w, h, p] of MOLDINGS) {
    const x = Math.abs(t - c) / w;
    if (x < 1) d += h * Math.pow(1 - Math.pow(x, p), 1 / p);
  }
  return d;
}

// ---------------------------------------------------------------- the ribbons

/** the ribbons run from the pedestal (u = 0) to the collar (u = 1) */
export const RIB_T0 = 0.098;
export const RIB_T1 = 0.645;
const RIB_ENV: [number, number][] = [
  [0.0, 0.142],
  [0.07, 0.158],
  [0.18, 0.142],
  [0.33, 0.104],
  [0.48, 0.076],
  [0.6, 0.07],
  [0.72, 0.078],
  [0.86, 0.074],
  [1.0, 0.05],
];

function interp(C: [number, number][], x: number): number {
  if (x <= C[0][0]) return C[0][1];
  if (x >= C[C.length - 1][0]) return C[C.length - 1][1];
  let i = 0;
  while (i < C.length - 2 && C[i + 1][0] < x) i++;
  const a = C[i];
  const b = C[i + 1];
  const u = (x - a[0]) / (b[0] - a[0]);
  return catmull(C[Math.max(0, i - 1)][1], a[1], b[1], C[Math.min(C.length - 1, i + 2)][1], u);
}

/** which way ribbon k turns (+1 / -1): they alternate, so they cross and weave */
export function ribbonTurn(k: number): number {
  return k % 2 === 0 ? 1 : -1;
}

/**
 * The centre line of ribbon k at u (0 pedestal → 1 collar), in local units x HEIGHT: [x, t, z].
 * Its distance from the axis follows the ribbon envelope, swung out (or in) by the feature's weight in
 * the middle of its run; its ends stay anchored in the pedestal and the collar.
 */
export function ribbonPoint(s: Shape, k: number, u: number): [number, number, number] {
  const turn = ribbonTurn(k);
  const a0 = (k / 8) * Math.PI * 2;
  const a = a0 + turn * Math.PI * 1.4 * u;
  const bell = Math.sin(Math.PI * Math.min(1, Math.max(0, u)));
  const r = interp(RIB_ENV, u) * (1 + (s.girth[k] - 1) * 1.7 * bell);
  return [Math.sin(a) * r, RIB_T0 + (RIB_T1 - RIB_T0) * u, Math.cos(a) * r];
}

/** ribbon width and thickness at u (x HEIGHT): broad petals at the foot, slender at the collar */
export function ribbonSize(u: number): [number, number] {
  return [0.064 * (1 - u) + 0.022 * u, 0.011 - 0.003 * u];
}

/** the widest the ribbons reach at height t (for hit-testing the cursor and the 2D silhouette) */
export function ribbonReach(s: Shape, t: number): number {
  if (t < RIB_T0 || t > RIB_T1) return 0;
  const u = (t - RIB_T0) / (RIB_T1 - RIB_T0);
  let m = 0;
  for (let k = 0; k < 8; k++) {
    const p = ribbonPoint(s, k, u);
    m = Math.max(m, Math.hypot(p[0], p[2]) + ribbonSize(u)[0] * 0.5);
  }
  return m;
}

/** her outline at height t: the stem or the ribbons, whichever reaches further */
export function outerRadius(s: Shape, t: number): number {
  return Math.max(radiusAt(s, t), ribbonReach(s, t));
}

/** the eight features, as heights up her (used to place labels: band k is where ribbon k is labelled) */
export const BAND_T0 = RIB_T0;
export const BAND_T1 = RIB_T1;
export const BAND_H = (BAND_T1 - BAND_T0) / 8;

const ROLE_SCALE: Record<"w" | "v" | "t" | "r", [number, number]> = { w: [60, 2000], v: [30, 1000], t: [30, 1000], r: [30, 1000] };

export function norm(g: number, role: "w" | "v" | "t" | "r"): number {
  const [s, S] = ROLE_SCALE[role];
  const v = (Math.sign(g) * Math.log1p(Math.abs(g) / s)) / Math.log1p(S / s);
  return Math.max(-1, Math.min(1, v));
}

export interface Shape {
  /** band girth multipliers (8) */
  girth: number[];
  /** gate rings: signed position within the band, −1..1 (sign = direction) */
  gate: number[];
  /** crown point heights (x HEIGHT), 8 */
  points: number[];
}

export function shapeOf(genes: number[]): Shape {
  return {
    girth: Array.from({ length: 8 }, (_, k) => 1 + 0.13 * norm(genes[k] ?? 0, "w")),
    gate: Array.from({ length: 8 }, (_, k) => Math.max(-1, Math.min(1, (genes[16 + k] ?? 0) / 1000))),
    points: Array.from({ length: 8 }, (_, j) => {
      const n = norm(genes[8 + j] ?? 0, "v");
      // a regal crown first, data second: the spikes vary within a band, so a crown never looks broken
      return 0.1 + 0.036 * n;
    }),
  };
}

export function lerpShape(a: Shape, b: Shape, k: number): Shape {
  const l = (x: number[], y: number[]) => x.map((v, i) => v + (y[i] - v) * k);
  return { girth: l(a.girth, b.girth), gate: l(a.gate, b.gate), points: l(a.points, b.points) };
}

function catmull(p0: number, p1: number, p2: number, p3: number, t: number) {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/** the smooth body without its moldings (the quicksilver column follows this) */
export function envelopeRadius(t: number): number {
  const C = ENVELOPE;
  if (t <= 0) return C[0][1];
  if (t >= C[C.length - 1][0]) return 0;
  let i = 0;
  while (i < C.length - 2 && C[i + 1][0] < t) i++;
  const a = C[i];
  const b = C[i + 1];
  const p0 = C[Math.max(0, i - 1)][1];
  const p3 = C[Math.min(C.length - 1, i + 2)][1];
  const u = (t - a[0]) / (b[0] - a[0]);
  return Math.max(0, catmull(p0, a[1], b[1], p3, u));
}

export function canonicalRadius(t: number): number {
  if (t >= TOP_T) return 0;
  return Math.max(0, envelopeRadius(t) + moldingAt(Math.max(0, t)));
}

/**
 * Row heights for the lathe mesh, spaced by arc length of the silhouette so the moldings get many rows
 * (crisp edges) and the plain stem few.
 */
export function rowHeights(rows: number): number[] {
  const N = 6000;
  const cum = new Float64Array(N + 1);
  let prev = canonicalRadius(0);
  for (let i = 1; i <= N; i++) {
    const t = (i / N) * TOP_T;
    const r = canonicalRadius(t);
    const dt = TOP_T / N;
    cum[i] = cum[i - 1] + Math.hypot(dt, (r - prev) * 7) + dt * 0.6;
    prev = r;
  }
  const out: number[] = [];
  let j = 0;
  for (let k = 0; k <= rows; k++) {
    const target = (k / rows) * cum[N];
    while (j < N && cum[j + 1] < target) j++;
    const f = cum[j + 1] > cum[j] ? (target - cum[j]) / (cum[j + 1] - cum[j]) : 0;
    out.push(Math.min(TOP_T, ((j + f) / N) * TOP_T));
  }
  out[0] = 0;
  out[rows] = TOP_T;
  return out;
}

/** smooth girth multiplier at height fraction t (each band holds its value; Catmull-Rom between band centres) */
export function girthAt(s: Shape, t: number): number {
  const x = (t - BAND_T0) / BAND_H - 0.5;
  if (x <= 0) return s.girth[0];
  if (x >= 7) return s.girth[7];
  const i = Math.floor(x);
  const u = x - i;
  const g = s.girth;
  return catmull(g[Math.max(0, i - 1)], g[i], g[Math.min(7, i + 1)], g[Math.min(7, i + 2)], u);
}

/** gate rings: a narrow cut (t ≥ 0) or bead (t < 0) at the gate height inside each band */
export function gateAt(s: Shape, t: number): number {
  let d = 0;
  for (let k = 0; k < 8; k++) {
    const gk = s.gate[k];
    const tg = BAND_T0 + k * BAND_H + Math.abs(gk) * BAND_H * 0.92 + BAND_H * 0.04;
    const w = Math.exp(-Math.pow((t - tg) / 0.0042, 2));
    d += (gk >= 0 ? -0.034 : 0.03) * w;
  }
  return d;
}

/** final radius of the turned body (x HEIGHT) at height fraction t. The weights live in the ribbons. */
export function radiusAt(_s: Shape, t: number): number {
  return canonicalRadius(t);
}

/** kept for older callers: the crown is its own hollow piece now, nothing is raised on the body */
export function crownBump(_points: number[], _a: number, _t: number): number {
  return 0;
}

/**
 * Height (x HEIGHT) of the crown's spike at azimuth a: 16 cut spikes, the 8 tall ones are the interaction
 * weights (one per pair), the 8 between them shorter ornament (55% of their neighbours' average).
 */
export function crownSpike(points: number[], a: number): number {
  const x = ((((a / (Math.PI * 2)) % 1) + 1) % 1) * 16;
  const k = Math.round(x) % 16;
  const d = x - Math.round(x);
  const h = k % 2 === 0 ? points[k / 2] : 0.55 * 0.5 * (points[(k - 1) / 2] + points[((k + 1) / 2) % 8]);
  return h * Math.pow(Math.max(0, 1 - Math.abs(d) * 1.9), 1.3);
}

function smooth(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export function featureAtT(t: number): number {
  if (t < BAND_T0 || t > BAND_T1) return -1;
  return Math.min(7, Math.floor((t - BAND_T0) / BAND_H));
}

export function bandCentre(k: number): number {
  return BAND_T0 + (k + 0.5) * BAND_H;
}

/** the crown point a pair index sits on (azimuth, radians) */
export function pointAngle(j: number): number {
  return (j / 8) * Math.PI * 2;
}

/** liquid cavity: from the top of the foot to the bottom of the neck */
export const CAVITY_T0 = 0.11;
export const CAVITY_T1 = 0.62;
export const WALL = 0.8;

// ---------------------------------------------------------------- back-compat helpers used by older modules

export function multipliers(genes: number[]): Shape {
  return shapeOf(genes);
}
export function crownPoints(genes: number[]): number[] {
  return shapeOf(genes).points;
}

/**
 * SVG silhouette of the queen for a genome, fitting a w × h box. Front view: right edge up, the crown
 * points across the front, left edge down, then the ball.
 */
export function queenPath(genes: number[], w: number, h: number, pad = 0.06): string {
  const s = shapeOf(genes);
  const H = (h * (1 - pad * 2)) / (BALL_T + BALL_R);
  const cx = w / 2;
  const base = h - h * pad;
  const N = 120;
  const right: string[] = [];
  const left: string[] = [];
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * CROWN_RIM_T;
    const r = outerRadius(s, t) * H;
    const y = base - t * H;
    right.push(`${(cx + r).toFixed(2)},${y.toFixed(2)}`);
    left.push(`${(cx - r).toFixed(2)},${y.toFixed(2)}`);
  }
  const rim = CROWN_RIM_R * H;
  const crownY = base - CROWN_RIM_T * H;
  const tops: string[] = [];
  const P = 10;
  for (let j = P; j >= -P; j--) {
    const a = (j / P) * (Math.PI / 2);
    const x = cx + Math.sin(a) * rim;
    const y = crownY - crownSpike(s.points, a) * H * Math.cos(a * 0.6);
    tops.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  const ballC = base - BALL_T * H;
  const br = BALL_R * H;
  return (
    `M${right[0]} L${right.join(" L")} L${tops.join(" L")} L${left.reverse().join(" L")} Z ` +
    `M${cx.toFixed(2)},${(ballC - br * 1.3).toFixed(2)} L${(cx + br).toFixed(2)},${ballC.toFixed(2)} L${cx.toFixed(2)},${(ballC + br * 1.3).toFixed(2)} L${(cx - br).toFixed(2)},${ballC.toFixed(2)} Z`
  );
}
