#!/usr/bin/env python3
"""Build Red Queen Glass: Bodoni Moda recut as crystal for the Red Queen site.

Every thick stroke carries a channel of light down its core. The channel is computed from the outlines:
the medial axis of each glyph is traced, and a disc of radius rho = k * (r - r0) (r = the stroke's half
width there) is swept along it, so the light is widest in the heaviest part of a stem or bowl and tapers to
a point where the stroke thins towards a hairline. It is the inset core{p : dist(p, edge) > d} with a gain
k < 1, which turns the inset's blunt ends into clean points. The channel is cut out of the base glyph (a
browser without colour fonts still sees the crystal) and repeated as a COLRv0 layer on palette index 0, so
CSS can light it.

    python3 tools/font/build_font.py                 # fonts + specimens
    python3 tools/font/build_font.py --no-specimens  # fonts only

Needs: fontTools, skia-pathops, numpy, scipy, shapely, contourpy, brotli; uharfbuzz and matplotlib for the
specimens; opentype-sanitizer (optional) to run the same checks browsers run.
"""
from __future__ import annotations

import argparse
import io
import math
import sys
import time
from pathlib import Path

import numpy as np
import pathops
import shapely
from shapely.geometry import MultiLineString, Polygon
from scipy.interpolate import PchipInterpolator
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import dijkstra
from scipy.spatial import Voronoi
import contourpy
from fontTools.ttLib import TTFont
from fontTools.ttLib.tables._g_l_y_f import dropImpliedOnCurvePoints
from fontTools.varLib import instancer
from fontTools.pens.recordingPen import DecomposingRecordingPen, RecordingPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.basePen import decomposeQuadraticSegment
from fontTools.cu2qu import curve_to_quadratic
from fontTools.colorLib.builder import buildCOLR, buildCPAL

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
WEB = ROOT / "web"
SOURCE_DIR = HERE / "source"
OUT_DIR = WEB / "public" / "fonts"

FAMILY = "Red Queen Glass"
VERSION = "1.000"
STYLES = {
    "roman": dict(src="BodoniModa-latin-roman.woff2", sub="Regular", ps="RedQueenGlass-Regular",
                  out="red-queen-glass-roman.woff2"),
    "italic": dict(src="BodoniModa-latin-italic.woff2", sub="Italic", ps="RedQueenGlass-Italic",
                   out="red-queen-glass-italic.woff2"),
}

# Bodoni Moda's display cut: the largest optical size, a touch heavier than Regular.
INSTANCE = {"wght": 500, "opsz": 96}

# The channel. Lengths are fractions of W, the stem width of `l` in each style (208 units roman, 181 italic).
CHANNEL = dict(
    r0=0.27,         # half-widths below r0*W carry no light: strokes under 54% of a stem stay solid
    k=0.30,          # gain: channel half-width per unit of stroke half-width above r0
    cap=0.09,        # soft cap (tanh) on the channel half-width, so heavy bowls do not out-shine stems
    phi_lo=120.0,    # degrees: where the axis runs into a corner (object angle below this) it goes dark
    prune=0.5,       # side branches of the axis shorter than this are pruned
    kink_deg=28.0,   # the axis is cut where it turns more than this within kink_win (a corner prong)
    kink_win=0.08,
    mincomp=0.6,     # a lit piece of axis shorter than this is dropped (dots, ball terminals, spurs)
    min_rho=0.025,   # ...and so is one whose light never gets wider than 2*min_rho*W
    open=0.5,        # morphological opening of the radius along the axis: no beads where hairlines join
    smooth=0.1,      # diffusion of the width profile along the axis
    pos_smooth=0.3,  # low-pass (Taubin) smoothing of the axis position
    taper=1.2,       # the light tapers to a point over this length at every free end of the axis
    min_area=60.0,   # (units^2) fragments smaller than this are dropped
)
SITES = 4.0        # boundary sampling step for the Voronoi medial axis (font units)
FIELD_RES = 1.0    # raster step for the channel's distance field (font units)
FIT_TOL = 0.4      # cubic fit tolerance for the channel outline (font units)
QUAD_TOL = 0.3     # cubic-to-quadratic tolerance

# CPAL: palette 0 is the glass light, palette 1 the refusal. Index 0xFFFF (the body) follows CSS `color`.
PALETTES = [
    [(0xCF, 0xE9, 0xEF, 0xD9)],   # #cfe9ef at 85%: cool glass light
    [(0xE8, 0x37, 0x2C, 0xFF)],   # #e8372c: refused
]

# Q: the tail is redrawn as a ribbon that sweeps right under the next letter and thins to a hairline.
# Spine = cubic segments (font units); widths = (arc-length fraction, width) keyframes.
Q_TAIL = {
    "roman": dict(
        spine=[[(725, 40), (735, -200), (860, -420), (1150, -448)],
               [(1150, -448), (1400, -472), (1600, -440), (1790, -365)]],
        widths=[(0, 262), (0.10, 250), (0.22, 225), (0.35, 170), (0.47, 100), (0.62, 45), (0.77, 22),
                (0.90, 13), (1.0, 2)]),
    "italic": dict(
        spine=[[(615, 40), (560, -200), (700, -425), (990, -450)],
               [(990, -450), (1240, -472), (1460, -440), (1650, -362)]],
        widths=[(0, 262), (0.10, 250), (0.22, 225), (0.35, 170), (0.47, 100), (0.62, 45), (0.77, 22),
                (0.90, 13), (1.0, 2)]),
}
# i and j (and the Turkish i): the round tittle becomes a lozenge (width, height) centred where the dot was.
LOZENGE = dict(w=270, h=350)
LOZENGE_GLYPHS = ("i", "j", "i.loclTRK")


def log(*a):
    print(*a, flush=True)


# ============================================================================================ sources
def find_sources() -> dict[str, Path]:
    """The Bodoni Moda latin subsets live in tools/font/source. If they are missing, find them in the
    site's Next.js build (next/font/google writes them to web/.next/static/media) and copy them in."""
    want = {k: SOURCE_DIR / v["src"] for k, v in STYLES.items()}
    if all(p.exists() for p in want.values()):
        return want
    media = WEB / ".next" / "static" / "media"
    SOURCE_DIR.mkdir(parents=True, exist_ok=True)
    for f in sorted(media.glob("*.woff2")):
        t = TTFont(f, lazy=True)
        if t["name"].getDebugName(1) != "Bodoni Moda":
            continue
        cmap = t.getBestCmap()
        # Google's latin subset: Latin-1 (é), no Latin Extended-A (Ā) and no Vietnamese (Ạ).
        if 0xE9 not in cmap or 0x100 in cmap or 0x1EA0 in cmap:
            continue
        style = "italic" if t["post"].italicAngle != 0 else "roman"
        if not want[style].exists():
            want[style].write_bytes(f.read_bytes())
            log(f"  source {style}: {f.name} -> {want[style].name}")
    missing = [k for k, p in want.items() if not p.exists()]
    if missing:
        sys.exit(f"Bodoni Moda latin sources not found for {missing}; build the site once (next build).")
    return want


# ============================================================================================ outlines
def path_from_rec(rec, path=None) -> pathops.Path:
    path = path if path is not None else pathops.Path()
    pen = path.getPen()
    for op, args in rec:
        getattr(pen, op)(*args)
    return path


def rec_of(path: pathops.Path):
    r = RecordingPen()
    path.draw(r)
    return r.value


def simplify(path: pathops.Path) -> pathops.Path:
    # clockwise=True gives TrueType's convention: outer contours clockwise, counters anticlockwise.
    return pathops.simplify(path, fix_winding=True, keep_starting_points=True, clockwise=True)


def nonzero_area(contours) -> float:
    """Filled area of polylines under the nonzero rule: the reference every outline operation is checked
    against (Skia's path ops can silently drop shapes whose contours share edges). One scanline in the middle
    of every interval between vertex heights, so it is exact wherever contours do not cross."""
    if not contours:
        return 0.0
    E = np.vstack([np.hstack([c, np.roll(c, -1, 0)]) for c in contours])
    E = E[E[:, 1] != E[:, 3]]
    if not len(E):
        return 0.0
    ys = np.unique(np.concatenate([E[:, 1], E[:, 3]]))
    mids, dys = (ys[:-1] + ys[1:]) / 2, np.diff(ys)
    i0 = np.searchsorted(mids, np.minimum(E[:, 1], E[:, 3]))
    i1 = np.searchsorted(mids, np.maximum(E[:, 1], E[:, 3]))
    n = np.maximum(i1 - i0, 0)
    k = np.repeat(i0, n) + (np.arange(n.sum()) - np.repeat(np.cumsum(n) - n, n))
    e = E[np.repeat(np.arange(len(E)), n)]
    x = e[:, 0] + (mids[k] - e[:, 1]) / (e[:, 3] - e[:, 1]) * (e[:, 2] - e[:, 0])
    w = np.where(e[:, 3] > e[:, 1], 1, -1)
    o = np.lexsort((x, k))
    k, x, w = k[o], x[o], w[o]
    fill = (np.cumsum(w)[:-1] != 0) & (k[1:] == k[:-1])  # every scanline's winding returns to 0
    return float(np.sum(np.diff(x)[fill] * dys[k[:-1][fill]]))


def remove_overlaps(path: pathops.Path) -> pathops.Path:
    """simplify(), checked against the nonzero area; contours that share edges are nudged apart by a
    hundredth of a unit (gone again when coordinates are rounded) and retried."""
    rec = rec_of(path)
    ref = nonzero_area(flatten(rec, 1.0))
    ok = lambda out: abs(nonzero_area(flatten(rec_of(out), 1.0)) - ref) <= 0.001 * ref + 10
    out = simplify(path)
    if ok(out):
        return out
    nudged = pathops.Path()
    for i, contour in enumerate(split_contours(rec)):
        pen = TransformPen(nudged.getPen(), (1, 0, 0, 1, 0.011 * i, 0.007 * i))
        for op, args in contour:
            getattr(pen, op)(*args)
    out = simplify(nudged)
    if ok(out):
        return out
    raise RuntimeError(f"overlap removal failed (area {path_area(out):.0f}, expected {ref:.0f})")


def split_contours(rec):
    out, cur = [], []
    for op, args in rec:
        cur.append((op, args))
        if op in ("closePath", "endPath"):
            out.append(cur)
            cur = []
    return out


def flatten(rec, step=2.0):
    """Pen recording -> list of closed polylines (N,2), first point not repeated."""
    contours, cur = [], []

    def add(pts):
        cur.extend(map(tuple, pts))

    for op, args in rec:
        if op == "moveTo":
            cur = [tuple(args[0])]
        elif op == "lineTo":
            p0, p1 = np.asarray(cur[-1], float), np.asarray(args[0], float)
            n = max(1, int(math.ceil(np.linalg.norm(p1 - p0) / step)))
            t = np.linspace(0, 1, n + 1)[1:, None]
            add((1 - t) * p0 + t * p1)
        elif op == "qCurveTo":
            if args[-1] is None:  # closed contour of off-curve points only
                offs = [np.asarray(p, float) for p in args[:-1]]
                m0 = tuple((offs[-1] + offs[0]) / 2)
                cur = [m0]
                args = tuple(map(tuple, offs)) + (m0,)
            for a, b in decomposeQuadraticSegment(args):
                p0, p1, p2 = np.asarray(cur[-1], float), np.asarray(a, float), np.asarray(b, float)
                n = max(2, int(math.ceil((np.linalg.norm(p1 - p0) + np.linalg.norm(p2 - p1)) / step)))
                t = np.linspace(0, 1, n + 1)[1:, None]
                add((1 - t) ** 2 * p0 + 2 * (1 - t) * t * p1 + t ** 2 * p2)
        elif op == "curveTo":
            p0 = np.asarray(cur[-1], float)
            p1, p2, p3 = (np.asarray(p, float) for p in args)
            L = np.linalg.norm(p1 - p0) + np.linalg.norm(p2 - p1) + np.linalg.norm(p3 - p2)
            n = max(2, int(math.ceil(L / step)))
            t = np.linspace(0, 1, n + 1)[1:, None]
            add((1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t ** 2 * p2 + t ** 3 * p3)
        elif op in ("closePath", "endPath"):
            if len(cur) > 1 and np.allclose(cur[0], cur[-1]):
                cur = cur[:-1]
            if len(cur) >= 3:
                contours.append(np.array(cur, float))
            cur = []
    return contours


def signed_area(c) -> float:
    x, y = c[:, 0], c[:, 1]
    return 0.5 * float(np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y))


def path_area(path: pathops.Path) -> float:
    """Filled area of an overlap-free path (nonzero = even-odd once simplified)."""
    return abs(sum(signed_area(c) for c in flatten(rec_of(path), 1.0)))


def resample(c, s):
    cc = np.vstack([c, c[:1]])
    cum = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(cc, axis=0), axis=1))])
    n = max(8, int(round(cum[-1] / s)))
    t = np.linspace(0, cum[-1], n, endpoint=False)
    return np.stack([np.interp(t, cum, cc[:, 0]), np.interp(t, cum, cc[:, 1])], 1)


def to_polygon(contours):
    g = None
    for c in contours:
        p = Polygon(c).buffer(0)
        g = p if g is None else g.symmetric_difference(p)
    return g


# ============================================================================================ medial axis
def medial_axis(contours, poly, s=SITES, phi_min_deg=60.0):
    """Voronoi approximation of the medial axis. Returns vertices V, radii r, edges E (index pairs) and the
    object angle phi of each edge (180 deg: the two touching points face each other, as in a stem)."""
    sites = np.vstack([resample(c, s) for c in contours])
    vor = Voronoi(sites)
    V = vor.vertices
    rv = np.array(vor.ridge_vertices)
    rp = vor.ridge_points
    ok = (rv[:, 0] >= 0) & (rv[:, 1] >= 0)
    rv, rp = rv[ok], rp[ok]
    inside = shapely.contains_xy(poly, V[:, 0], V[:, 1])
    ok = inside[rv[:, 0]] & inside[rv[:, 1]]
    rv, rp = rv[ok], rp[ok]
    r = np.full(len(V), -1.0)
    used = np.unique(rv)
    bnd = MultiLineString([np.vstack([c, c[:1]]) for c in contours])
    r[used] = shapely.distance(shapely.points(V[used]), bnd)
    chord = np.linalg.norm(sites[rp[:, 0]] - sites[rp[:, 1]], axis=1)
    rmax = np.maximum(r[rv[:, 0]], r[rv[:, 1]])
    phi = 2 * np.degrees(np.arcsin(np.clip(chord / (2 * np.maximum(rmax, 1e-9)), 0, 1)))
    ok = phi >= phi_min_deg
    return V, r, rv[ok], phi[ok]


class Graph:
    def __init__(self, edges):
        self.adj: dict[int, set[int]] = {}
        for a, b in edges:
            if a != b:
                self.adj.setdefault(a, set()).add(b)
                self.adj.setdefault(b, set()).add(a)

    def remove(self, n):
        for m in self.adj.pop(n, ()):
            self.adj[m].discard(n)

    def edges(self):
        return [(a, b) for a in self.adj for b in self.adj[a] if a < b]

    def components(self):
        seen, comps = set(), []
        for n in self.adj:
            if n in seen:
                continue
            stack, comp = [n], []
            seen.add(n)
            while stack:
                m = stack.pop()
                comp.append(m)
                for q in self.adj[m]:
                    if q not in seen:
                        seen.add(q)
                        stack.append(q)
            comps.append(comp)
        return comps


def prune_spurs(G: Graph, V, min_len):
    """Repeatedly remove leaf branches shorter than min_len that hang off a junction."""
    changed = True
    while changed:
        changed = False
        for leaf in [n for n, nb in G.adj.items() if len(nb) == 1]:
            if leaf not in G.adj or len(G.adj[leaf]) != 1:
                continue
            chain, prev, cur, length = [leaf], None, leaf, 0.0
            while True:
                nbs = [m for m in G.adj[cur] if m != prev]
                if not nbs:
                    break
                nxt = nbs[0]
                length += float(np.linalg.norm(V[nxt] - V[cur]))
                prev, cur = cur, nxt
                if len(G.adj[cur]) != 2:
                    break
                chain.append(cur)
            if len(G.adj.get(cur, ())) >= 3 and length < min_len:
                for n in chain:
                    G.remove(n)
                changed = True


def _walk(G: Graph, V, start, first, length):
    prev, cur, acc = start, first, float(np.linalg.norm(V[first] - V[start]))
    while acc < length and len(G.adj[cur]) == 2:
        nxt = [m for m in G.adj[cur] if m != prev][0]
        acc += float(np.linalg.norm(V[nxt] - V[cur]))
        prev, cur = cur, nxt
    return cur, acc


def cut_kinks(G: Graph, V, win, max_deg):
    """Cut the axis where it turns sharply: that is the axis running off into a corner, not a stroke."""
    cos_max = math.cos(math.radians(max_deg))
    cut = []
    for v, nb in G.adj.items():
        if len(nb) != 2:
            continue
        a, b = list(nb)
        pa, la = _walk(G, V, v, a, win)
        pb, lb = _walk(G, V, v, b, win)
        if la < 0.5 * win or lb < 0.5 * win:
            continue
        d1, d2 = V[v] - V[pa], V[pb] - V[v]
        if float(np.dot(d1, d2) / (np.linalg.norm(d1) * np.linalg.norm(d2) + 1e-9)) < cos_max:
            cut.append(v)
    for v in cut:
        G.remove(v)


def smoothstep(x):
    x = np.clip(x, 0, 1)
    return x * x * (3 - 2 * x)


def lit_axis(V, r, E, phi, W, P=CHANNEL):
    """The part of the medial axis that carries light, as segments (a, b, rho_a, rho_b)."""
    r0 = P["r0"] * W
    ok = (r[E[:, 0]] > r0) & (r[E[:, 1]] > r0) & (phi >= P["phi_lo"])
    G = Graph([tuple(e) for e in E[ok]])
    prune_spurs(G, V, P["prune"] * W)
    cut_kinks(G, V, P["kink_win"] * W, P["kink_deg"])
    prune_spurs(G, V, P["prune"] * W)
    for comp in G.components():
        length = sum(np.linalg.norm(V[a] - V[b]) for a in comp for b in G.adj[a] if a < b)
        if length < P["mincomp"] * W:
            for n in comp:
                G.remove(n)
    Ed = G.edges()
    if not Ed:
        return []
    nodes = sorted(G.adj)
    idx = {n: i for i, n in enumerate(nodes)}
    ea = np.array([idx[a] for a, b in Ed])
    eb = np.array([idx[b] for a, b in Ed])
    w = np.linalg.norm(V[[a for a, b in Ed]] - V[[b for a, b in Ed]], axis=1) + 1e-6
    n = len(nodes)
    M = coo_matrix((np.r_[w, w], (np.r_[ea, eb], np.r_[eb, ea])), shape=(n, n)).tocsr()
    A = (M > 0).astype(float)
    deg = np.asarray(A.sum(1)).ravel()
    h = float(np.mean(w))

    rv = r[nodes].copy()
    if P["open"]:  # min then max filter within a geodesic radius
        D = dijkstra(M, directed=False, limit=P["open"] * W)
        within = np.isfinite(D)
        mn = np.where(within, rv[None, :], np.inf).min(1)
        rv = np.where(within, mn[None, :], -np.inf).max(1)
    rho = P["k"] * np.maximum(0.0, rv - r0)
    if P["cap"]:
        cap = P["cap"] * W
        rho = cap * np.tanh(rho / cap)
    if P["smooth"]:
        for _ in range(min(int((P["smooth"] * W / h) ** 2 / 0.5) + 1, 4000)):
            rho = 0.5 * rho + 0.5 * (A @ rho) / np.maximum(deg, 1)
    ends = [idx[q] for q in nodes if len(G.adj[q]) == 1]
    if ends:
        dist = dijkstra(M, directed=False, indices=ends, min_only=True)
        rho = rho * smoothstep(dist / (P["taper"] * W))
    X = V[nodes].copy()
    if P["pos_smooth"]:
        free = (deg >= 2)[:, None]
        for it in range(min(int((P["pos_smooth"] * W / h) ** 2 / 0.5) + 1, 6000)):
            lam = 0.5 if it % 2 == 0 else -0.5025  # Taubin: low-pass without shrinking the curve
            X = X + np.where(free, lam * ((A @ X) / np.maximum(deg, 1)[:, None] - X), 0.0)
    # drop pieces whose light never gets wide enough to see
    keep = np.ones(n, bool)
    for comp in G.components():
        ii = [idx[q] for q in comp]
        if rho[ii].max() < P["min_rho"] * W:
            keep[ii] = False
    return [(X[idx[a]], X[idx[b]], rho[idx[a]], rho[idx[b]]) for a, b in Ed if keep[idx[a]] and keep[idx[b]]]


def channel_rings(segs, res=FIELD_RES, min_area=CHANNEL["min_area"]):
    """Union of the discs swept along the lit axis, as closed polylines (via a distance-like field)."""
    if not segs:
        return []
    S = np.array([[*a, *b, ra, rb] for a, b, ra, rb in segs])
    rmax = S[:, 4:6].max()
    m = rmax + 4 * res
    x0, x1 = min(S[:, 0].min(), S[:, 2].min()) - m, max(S[:, 0].max(), S[:, 2].max()) + m
    y0, y1 = min(S[:, 1].min(), S[:, 3].min()) - m, max(S[:, 1].max(), S[:, 3].max()) + m
    xs = np.arange(x0, x1 + res, res)
    ys = np.arange(y0, y1 + res, res)
    F = np.full((len(ys), len(xs)), -1e3, np.float32)
    for ax, ay, bx, by, ra, rb in S:
        n = max(1, int(math.ceil(math.hypot(bx - ax, by - ay) / (0.5 * res))))
        for t in np.linspace(0, 1, n + 1):
            cx, cy, rr = ax + (bx - ax) * t, ay + (by - ay) * t, ra + (rb - ra) * t
            if rr <= 0.05:
                continue
            i0 = max(0, int((cy - rr - 2 - y0) / res)); i1 = min(len(ys), int((cy + rr + 2 - y0) / res) + 2)
            j0 = max(0, int((cx - rr - 2 - x0) / res)); j1 = min(len(xs), int((cx + rr + 2 - x0) / res) + 2)
            gx = xs[j0:j1][None, :] - cx
            gy = ys[i0:i1][:, None] - cy
            np.maximum(F[i0:i1, j0:j1], rr - np.sqrt(gx * gx + gy * gy), out=F[i0:i1, j0:j1])
    rings = []
    for line in contourpy.contour_generator(xs, ys, F).lines(0.0):
        line = np.asarray(line, float)
        if len(line) > 1 and np.allclose(line[0], line[-1]):
            line = line[:-1]
        if len(line) >= 4 and abs(signed_area(line)) > min_area:
            rings.append(line)
    return rings


# ============================================================================================ curve fitting
def _bez(c, t):
    t = t[:, None]; m = 1 - t
    return m ** 3 * c[0] + 3 * m * m * t * c[1] + 3 * m * t * t * c[2] + t ** 3 * c[3]


def _bez1(c, t):
    t = t[:, None]; m = 1 - t
    return 3 * m * m * (c[1] - c[0]) + 6 * m * t * (c[2] - c[1]) + 3 * t * t * (c[3] - c[2])


def _bez2(c, t):
    t = t[:, None]
    return 6 * (1 - t) * (c[2] - 2 * c[1] + c[0]) + 6 * t * (c[3] - 2 * c[2] + c[1])


def _unit(v):
    n = float(np.linalg.norm(v))
    return v / n if n > 1e-9 else v


def _generate(pts, u, t1, t2):
    p0, p3 = pts[0], pts[-1]
    b1 = (3 * (1 - u) ** 2 * u)[:, None]
    b2 = (3 * (1 - u) * u ** 2)[:, None]
    A1, A2 = t1[None, :] * b1, t2[None, :] * b2
    c00, c01, c11 = np.sum(A1 * A1), np.sum(A1 * A2), np.sum(A2 * A2)
    tmp = pts - _bez(np.array([p0, p0, p3, p3]), u)
    x0, x1 = np.sum(A1 * tmp), np.sum(A2 * tmp)
    det = c00 * c11 - c01 * c01
    seg = float(np.linalg.norm(p3 - p0))
    if abs(det) > 1e-12:
        a1 = (x0 * c11 - x1 * c01) / det
        a2 = (c00 * x1 - c01 * x0) / det
    else:
        a1 = a2 = seg / 3
    if a1 < 1e-6 * seg or a2 < 1e-6 * seg:
        a1 = a2 = seg / 3
    return np.array([p0, p0 + t1 * a1, p3 + t2 * a2, p3])


def fit_cubics(pts, t1, t2, tol, depth=0):
    """Schneider's least-squares fit of a polyline with cubic Beziers (G1 at the splits)."""
    n = len(pts)
    if n == 2 or depth > 40:
        d = float(np.linalg.norm(pts[-1] - pts[0])) / 3
        return [np.array([pts[0], pts[0] + t1 * d, pts[-1] + t2 * d, pts[-1]])]
    cum = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(pts, axis=0), axis=1))])
    u = cum / cum[-1]
    c = _generate(pts, u, t1, t2)
    for it in range(10):
        d = np.sum((_bez(c, u) - pts) ** 2, 1)
        i = int(np.argmax(d[1:-1])) + 1
        err = math.sqrt(d[i])
        if err < tol:
            return [c]
        if err > 8 * tol:
            break
        q = _bez(c, u) - pts
        q1, q2 = _bez1(c, u), _bez2(c, u)
        den = np.sum(q1 * q1, 1) + np.sum(q * q2, 1)
        u = np.clip(u - np.where(np.abs(den) > 1e-12, np.sum(q * q1, 1) / den, 0), 0, 1)
        u[0], u[-1] = 0.0, 1.0
        c = _generate(pts, u, t1, t2)
    d = np.sum((_bez(c, u) - pts) ** 2, 1)
    i = min(max(int(np.argmax(d[1:-1])) + 1, 1), n - 2)
    tc = _unit(pts[max(0, i - 3)] - pts[min(n - 1, i + 3)])
    return fit_cubics(pts[: i + 1], t1, tc, tol, depth + 1) + fit_cubics(pts[i:], -tc, t2, tol, depth + 1)


def _tangent(pts, i, step, dist=3.0):
    n, j, acc = len(pts), i, 0.0
    while 0 <= j + step < n and acc < dist:
        acc += float(np.linalg.norm(pts[j + step] - pts[j]))
        j += step
    return _unit(pts[j] - pts[i])


def ring_corners(P, win=4.0, max_turn=50.0):
    """Indices where a closed polyline turns more than max_turn degrees within +-win units (the tips)."""
    cc = np.vstack([P, P[:1]])
    cum = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(cc, axis=0), axis=1))])
    L = cum[-1]
    if L < 6 * win:
        return []

    def at(sq):
        sq = np.mod(sq, L)
        return np.stack([np.interp(sq, cum, cc[:, 0]), np.interp(sq, cum, cc[:, 1])], 1)

    s = cum[:-1]
    d1 = P - at(s - win)
    d2 = at(s + win) - P
    cos = np.sum(d1 * d2, 1) / (np.linalg.norm(d1, axis=1) * np.linalg.norm(d2, axis=1) + 1e-12)
    turn = np.degrees(np.arccos(np.clip(cos, -1, 1)))
    corners = []
    for i in np.where(turn > max_turn)[0]:
        near = np.where((np.abs(s - s[i]) <= win) | (np.abs(s - s[i]) >= L - win))[0]
        if turn[i] >= turn[near].max() and not any(min(abs(s[i] - s[j]), L - abs(s[i] - s[j])) < win for j in corners):
            corners.append(int(i))
    return sorted(corners)


def fit_ring(P, tol=FIT_TOL, corner_turn=50.0):
    """Closed polyline -> list of cubic segments; sharp points (the channel's tips) stay sharp."""
    corners = ring_corners(P, max_turn=corner_turn)
    N = len(P)
    segs = []
    if not corners:
        i0 = int(np.argmax(P[:, 0]))
        Q = np.vstack([P[i0:], P[:i0], P[i0:i0 + 1]])
        t = _unit(Q[min(3, len(Q) - 1)] - Q[-4])
        return fit_cubics(Q, t, -t, tol)
    for a, b in zip(corners, corners[1:] + [corners[0] + N]):
        idx = np.arange(a, b + 1) % N
        Q = P[idx]
        if len(Q) < 2:
            continue
        segs += fit_cubics(Q, _tangent(Q, 0, 1), _tangent(Q, len(Q) - 1, -1), tol)
    return segs


def cubics_to_path(cubic_lists, path=None) -> pathops.Path:
    """Closed cubic splines -> pathops path made of quadratic segments."""
    path = path if path is not None else pathops.Path()
    for cubics in cubic_lists:
        start = cubics[0][0]
        path.moveTo(float(start[0]), float(start[1]))
        for c in cubics:
            q = curve_to_quadratic([tuple(map(float, p)) for p in c], QUAD_TOL)
            offs, end = q[1:-1], q[-1]
            for j in range(len(offs) - 1):
                mid = ((offs[j][0] + offs[j + 1][0]) / 2, (offs[j][1] + offs[j + 1][1]) / 2)
                path.quadTo(offs[j][0], offs[j][1], *mid)
            path.quadTo(offs[-1][0], offs[-1][1], end[0], end[1])
        path.close()
    return path


def polygon_path(points, path=None) -> pathops.Path:
    path = path if path is not None else pathops.Path()
    path.moveTo(*map(float, points[0]))
    for p in points[1:]:
        path.lineTo(*map(float, p))
    path.close()
    return path


# ============================================================================================ signature glyphs
def _cubic(seg, t):
    P = np.asarray(seg, float); t = t[:, None]; m = 1 - t
    return m ** 3 * P[0] + 3 * m * m * t * P[1] + 3 * m * t * t * P[2] + t ** 3 * P[3]


def _cubic_d(seg, t):
    P = np.asarray(seg, float); t = t[:, None]; m = 1 - t
    return 3 * m * m * (P[1] - P[0]) + 6 * m * t * (P[2] - P[1]) + 3 * t * t * (P[3] - P[2])


def ribbon_outline(spine, widths, n=1200):
    """A stroke of varying width along a cubic spine: a closed polygon (flat start, pointed end)."""
    B, D = [], []
    for i, seg in enumerate(spine):
        t = np.linspace(0, 1, n // len(spine), endpoint=(i == len(spine) - 1))
        B.append(_cubic(seg, t))
        D.append(_cubic_d(seg, t))
    B, D = np.vstack(B), np.vstack(D)
    s = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(B, axis=0), axis=1))])
    ku, kw = zip(*widths)
    w = PchipInterpolator(ku, kw)(s / s[-1])
    T = D / np.linalg.norm(D, axis=1, keepdims=True)
    N = np.stack([-T[:, 1], T[:, 0]], 1)
    left, right = B + N * (w / 2)[:, None], B - N * (w / 2)[:, None]
    return np.vstack([left, right[::-1][1:]])  # the tip point is shared


def draw_q(rec, style) -> pathops.Path:
    """Bodoni Moda's Q with its tail replaced by a long sweeping ribbon."""
    contours = split_contours(rec)
    flat = [flatten(c)[0] for c in contours]
    tail_i = int(np.argmin([f[:, 1].min() for f in flat]))
    rest = [i for i in range(len(contours)) if i != tail_i]
    outer_i = max(rest, key=lambda i: abs(signed_area(flat[i])))
    counter_i = [i for i in rest if i != outer_i][0]
    spec = Q_TAIL[style]
    poly = ribbon_outline(spec["spine"], spec["widths"])
    tip = len(poly) // 2
    # fit the ribbon: corners at the start cap and at the tip
    tail = cubics_to_path([fit_cubics(poly[: tip + 1], _tangent(poly, 0, 1), _tangent(poly, tip, -1), 0.5)
                           + fit_cubics(poly[tip:], _tangent(poly, tip, 1), _tangent(poly, len(poly) - 1, -1), 0.5)
                           + [np.array([poly[-1], poly[-1] + (poly[0] - poly[-1]) / 3,
                                        poly[0] + (poly[-1] - poly[0]) / 3, poly[0]])]])
    bowl = path_from_rec(contours[outer_i])
    shape = pathops.op(bowl, tail, pathops.PathOp.UNION, fix_winding=True, clockwise=True)
    counter = path_from_rec(contours[counter_i])
    return pathops.op(shape, counter, pathops.PathOp.DIFFERENCE, fix_winding=True, clockwise=True)


def draw_lozenge_tittle(rec, italic_angle) -> pathops.Path:
    """i and j: the round dot becomes a lozenge cut like a gem (slanted with the italic)."""
    contours = split_contours(rec)
    path = pathops.Path()
    for c in contours:
        f = flatten(c)[0]
        if f[:, 1].min() > 1000:  # the tittle sits above the x-height (920)
            cx, cy = (f[:, 0].min() + f[:, 0].max()) / 2, (f[:, 1].min() + f[:, 1].max()) / 2
            w, h = LOZENGE["w"] / 2, LOZENGE["h"] / 2
            sl = math.tan(math.radians(-italic_angle))
            pts = [(cx + sl * h, cy + h), (cx + w, cy), (cx - sl * h, cy - h), (cx - w, cy)]  # clockwise
            polygon_path(pts, path)
        else:
            path_from_rec(c, path)
    return path


# ============================================================================================ glyphs
def stem_width(gs) -> float:
    """W: twice the median medial-axis radius in the middle of `l`."""
    path = pathops.Path()
    gs["l"].draw(path.getPen(glyphSet=gs))
    c = flatten(rec_of(remove_overlaps(path)))
    V, r, E, phi = medial_axis(c, to_polygon(c))
    sel = np.unique(E)
    sel = sel[(V[sel, 1] > 350) & (V[sel, 1] < 650)]
    return 2 * float(np.median(r[sel]))


def channel_for(body: pathops.Path, W) -> list[np.ndarray]:
    contours = flatten(rec_of(body))
    if not contours:
        return []
    poly = to_polygon(contours)
    if poly is None or poly.is_empty:
        return []
    V, r, E, phi = medial_axis(contours, poly)
    return channel_rings(lit_axis(V, r, E, phi, W))


def glyph_from_path(path: pathops.Path):
    pen = TTGlyphPen(None)
    path.draw(pen)
    g = pen.glyph()
    if g.numberOfContours > 0:
        dropImpliedOnCurvePoints(g)
    return g


class _AnyName:
    def __contains__(self, name):
        return True


def composite(components):
    pen = TTGlyphPen(_AnyName())
    for name, transform in components:
        pen.addComponent(name, transform)
    return pen.glyph()


def components_overlap(gs, glyph) -> bool:
    paths = []
    for comp in glyph.components:
        name, tr = comp.getComponentInfo()
        p = pathops.Path()
        gs[name].draw(TransformPen(p.getPen(glyphSet=gs), tr))
        paths.append(remove_overlaps(p))
    for i in range(len(paths)):
        for j in range(i + 1, len(paths)):
            inter = pathops.op(paths[i], paths[j], pathops.PathOp.INTERSECTION)
            if path_area(inter) > 1.0:
                return True
    return False


def build_style(style: str, src: Path):
    t0 = time.time()
    font = instancer.instantiateVariableFont(TTFont(src), INSTANCE)
    font.flavor = None
    font.recalcTimestamp = False
    # read every outline from an untouched copy: glyphs are rewritten (with holes) as we go
    gs = TTFont(io.BytesIO(to_bytes(font))).getGlyphSet()
    glyf, hmtx = font["glyf"], font["hmtx"]
    order = font.getGlyphOrder()
    W = stem_width(gs)
    italic_angle = font["post"].italicAngle
    log(f"[{style}] instance {INSTANCE}, stem W = {W:.1f} units, {len(order)} glyphs")

    new_glyphs: dict[str, object] = {}
    lit: dict[str, bool] = {}
    stats = {"lit": 0, "rings": 0}
    simple = [n for n in order if not glyf[n].isComposite()]
    comps = [n for n in order if glyf[n].isComposite()]
    # composites whose parts overlap (e.g. oe) are merged and lit as one glyph; so is the Turkish i
    simple += [n for n in comps if n in LOZENGE_GLYPHS or components_overlap(gs, glyf[n])]
    comps = [n for n in comps if n not in simple]

    for name in simple:
        rec = RecordingPen()
        gs[name].draw(rec)  # decomposed
        if not rec.value:
            lit[name] = False
            continue
        if name == "Q":
            body = remove_overlaps(draw_q(rec.value, style))
        elif name in LOZENGE_GLYPHS:
            body = remove_overlaps(draw_lozenge_tittle(rec.value, italic_angle))
        else:
            p = pathops.Path()
            gs[name].draw(p.getPen(glyphSet=gs))
            body = remove_overlaps(p)
        rings = channel_for(body, W)
        if rings:
            cubic_rings = [fit_ring(rg) for rg in rings]
            glass = simplify(cubics_to_path(cubic_rings))
            # cut the light out of the body: same contours, opposite turning (holes)
            holes = pathops.Path()
            glass.draw(holes.getPen())
            holes.reverse()
            cut = pathops.Path()
            body.draw(cut.getPen())
            holes.draw(cut.getPen())
            base = simplify(cut)
            a_body, a_glass, a_base = path_area(body), path_area(glass), path_area(base)
            if abs(a_body - a_glass - a_base) > 0.02 * a_glass + 50:
                raise RuntimeError(f"{name}: channel not cut cleanly ({a_body:.0f} - {a_glass:.0f} != {a_base:.0f})")
            glyf[name] = glyph_from_path(base)
            new_glyphs[name + ".glass"] = glyph_from_path(glass)
            lit[name] = True
            stats["lit"] += 1
            stats["rings"] += len(rings)
        else:
            glyf[name] = glyph_from_path(body)
            lit[name] = False

    def is_lit(name):
        if name in lit:
            return lit[name]
        g = glyf[name]
        lit[name] = g.isComposite() and any(is_lit(c.glyphName) for c in g.components)
        if lit[name]:
            new_glyphs[name + ".glass"] = composite(
                [(c.glyphName + ".glass", c.getComponentInfo()[1]) for c in g.components if is_lit(c.glyphName)])
        return lit[name]

    for name in comps:
        is_lit(name)

    color_glyphs = {}
    for name in order:
        if lit.get(name):
            new_glyphs[name + ".body"] = composite([(name, (1, 0, 0, 1, 0, 0))])
            color_glyphs[name] = [(name + ".body", 0xFFFF), (name + ".glass", 0)]

    # add the layer glyphs after every existing glyph (glyph IDs, cmap, kerning untouched)
    for name, g in sorted(new_glyphs.items(), key=lambda kv: (kv[0].endswith(".body"), kv[0])):
        glyf[name] = g
    font.setGlyphOrder(glyf.glyphOrder)
    for name in new_glyphs:
        base = name.rsplit(".", 1)[0]
        hmtx[name] = (hmtx[base][0], 0)
    for name in font.getGlyphOrder():
        g = glyf[name]
        g.recalcBounds(glyf)
        hmtx[name] = (hmtx[name][0], getattr(g, "xMin", 0) if g.numberOfContours else 0)

    font["CPAL"] = buildCPAL([[tuple(c / 255 for c in col) for col in pal] for pal in PALETTES])
    font["COLR"] = buildCOLR(color_glyphs, version=0, glyphMap=font.getReverseGlyphMap())
    set_names(font, style)
    font["post"].formatType = 2.0
    log(f"[{style}] {stats['lit']} glyphs lit ({stats['rings']} channels), {len(color_glyphs)} colour glyphs, "
        f"{time.time() - t0:.0f}s")
    return font


def set_names(font, style):
    s = STYLES[style]
    if "STAT" in font:
        del font["STAT"]
    name = font["name"]
    name.names = []
    full = f"{FAMILY} {s['sub']}"
    records = {
        0: ("Copyright 2020 The Bodoni Moda Project Authors (https://github.com/indestructible-type/Bodoni). "
            "Red Queen Glass modifications copyright 2026 The Red Queen Project Authors."),
        1: FAMILY,
        2: s["sub"],
        3: f"{VERSION};NONE;{s['ps']}",
        4: full,
        5: f"Version {VERSION}; Red Queen Glass, cut from Bodoni Moda 2.005 at opsz {INSTANCE['opsz']}, "
           f"wght {INSTANCE['wght']}",
        6: s["ps"],
        13: ("This Font Software is licensed under the SIL Open Font License, Version 1.1. This license is "
             "available with a FAQ at: https://openfontlicense.org"),
        14: "https://openfontlicense.org",
    }
    for nid, text in records.items():
        name.setName(text, nid, 3, 1, 0x409)
    font["head"].fontRevision = float(VERSION)
    font["OS/2"].achVendID = "NONE"


# ============================================================================================ checks
def glyph_area(gs, name, perimeter=False):
    rec = DecomposingRecordingPen(gs)
    gs[name].draw(rec)
    contours = flatten(rec.value, 1.0)
    area = nonzero_area(contours)
    if not perimeter:
        return area
    return area, sum(float(np.linalg.norm(np.diff(np.vstack([c, c[:1]]), axis=0), axis=1).sum()) for c in contours)


def check_font(font: TTFont, ref: TTFont, style: str):
    """1. Nothing lost: for every glyph not redrawn on purpose, base + channel = Bodoni Moda's area.
    2. Every lit glyph: a point inside its light is a hole in the base glyph and lit in the channel layer
       (nonzero winding, as browsers fill).
    3. OTS, the parser Chrome and Firefox run on web fonts, accepts it."""
    gs = font.getGlyphSet()
    rgs = ref.getGlyphSet()
    lost = []
    for name in ref.getGlyphOrder():
        if name == "Q" or name in LOZENGE_GLYPHS:
            continue
        a_ref, perimeter = glyph_area(rgs, name, perimeter=True)
        a_new = glyph_area(gs, name) + (glyph_area(gs, name + ".glass") if name + ".glass" in gs else 0.0)
        # Rounding the corners that overlap removal creates moves the edge a fraction of a unit (a few hundred
        # units^2 on a long hairline glyph like #); a real loss is a whole contour.
        if abs(a_new - a_ref) > 0.003 * a_ref + 0.1 * perimeter + 20:
            lost.append(f"{name} ({a_new:.0f} vs {a_ref:.0f})")
    if lost:
        raise RuntimeError(f"[{style}] outlines changed: {', '.join(lost)}")
    log(f"[{style}] areas: every glyph's base + channel matches Bodoni Moda")
    colr = font["COLR"]
    layers = colr.ColorLayers if hasattr(colr, "ColorLayers") else {}
    bad = []
    for base in layers:
        gp = pathops.Path(); gs[base].draw(gp.getPen(glyphSet=gs))
        cp = pathops.Path(); gs[base + ".glass"].draw(cp.getPen(glyphSet=gs))
        rings = flatten(rec_of(simplify(cp)))
        if not rings:
            bad.append(base)
            continue
        poly = to_polygon(rings)
        pt = poly.representative_point()
        if gp.contains((pt.x, pt.y)) or not cp.contains((pt.x, pt.y)):
            bad.append(base)
    if bad:
        raise RuntimeError(f"[{style}] channel not a hole in: {bad}")
    try:
        import ots  # opentype-sanitizer: the parser Chrome and Firefox run on web fonts
        buf = io.BytesIO(); f2 = TTFont(io.BytesIO(to_bytes(font))); f2.flavor = "woff2"; f2.save(buf)
        tmp = HERE / f".ots-{style}.woff2"
        tmp.write_bytes(buf.getvalue())
        res = ots.sanitize(str(tmp), str(tmp) + ".out", capture_output=True)
        tmp.unlink(missing_ok=True)
        Path(str(tmp) + ".out").unlink(missing_ok=True)
        if res.returncode != 0:
            raise RuntimeError(f"[{style}] OTS rejected the font: {res.stderr.decode()[:500]}")
        log(f"[{style}] OTS sanitizer: ok")
    except ImportError:
        log(f"[{style}] (opentype-sanitizer not installed; skipped the browser parser check)")


def to_bytes(font: TTFont) -> bytes:
    buf = io.BytesIO()
    font.save(buf)
    return buf.getvalue()


# ============================================================================================ specimens
INK, IVORY, HOT = "#050608", "#efe8da", "#e8372c"


class Face:
    def __init__(self, data: bytes, label: str):
        import uharfbuzz as hb
        self.hb_mod = hb
        self.tt = TTFont(io.BytesIO(data))
        self.gs = self.tt.getGlyphSet()
        self.order = self.tt.getGlyphOrder()
        self.upm = self.tt["head"].unitsPerEm
        self.hb = hb.Font(hb.Face(hb.Blob(data)))
        self.label = label
        colr = self.tt.get("COLR")
        self.layers = colr.ColorLayers if colr is not None else {}
        cpal = self.tt.get("CPAL")
        self.palettes = ([[(c.red, c.green, c.blue, c.alpha) for c in p] for p in cpal.palettes]
                         if cpal is not None else [])

    def shape(self, text):
        hb = self.hb_mod
        buf = hb.Buffer()
        buf.add_str(text)
        buf.guess_segment_properties()
        hb.shape(self.hb, buf, {"kern": True, "liga": True})
        return [(self.order[i.codepoint], p.x_advance, p.x_offset, p.y_offset)
                for i, p in zip(buf.glyph_infos, buf.glyph_positions)]

    def width(self, text, size):
        return sum(a for _, a, _, _ in self.shape(text)) * size / self.upm


def _draw(gs, name, tx, ty, sc, verts, codes):
    from matplotlib.path import Path as MPath
    rec = DecomposingRecordingPen(gs)
    gs[name].draw(rec)
    T = lambda p: (tx + p[0] * sc, ty - p[1] * sc)
    for op, args in rec.value:
        if op == "moveTo":
            verts.append(T(args[0])); codes.append(MPath.MOVETO)
        elif op == "lineTo":
            verts.append(T(args[0])); codes.append(MPath.LINETO)
        elif op == "qCurveTo":
            if args[-1] is None:
                offs = [np.asarray(p, float) for p in args[:-1]]
                m0 = tuple((offs[-1] + offs[0]) / 2)
                verts.append(T(m0)); codes.append(MPath.MOVETO)
                args = tuple(map(tuple, offs)) + (m0,)
            for a, b in decomposeQuadraticSegment(args):
                verts += [T(a), T(b)]; codes += [MPath.CURVE3] * 2
        elif op == "curveTo":
            verts += [T(p) for p in args]; codes += [MPath.CURVE4] * 3
        elif op in ("closePath", "endPath"):
            verts.append((0, 0)); codes.append(MPath.CLOSEPOLY)


def render(lines, out: Path, width=None, title=None):
    """lines: dicts(face, text, size, mode in {'solid','hollow','colr'}, glass=hex, label)."""
    import matplotlib
    matplotlib.use("Agg")
    from matplotlib.figure import Figure
    from matplotlib.backends.backend_agg import FigureCanvasAgg
    from matplotlib.path import Path as MPath
    from matplotlib.patches import PathPatch

    margin = 56
    W = width or int(max(l["face"].width(l["text"], l["size"]) for l in lines) + 2 * margin)
    heights = [int(l["size"] * 1.45) + 34 for l in lines]
    H = sum(heights) + 2 * margin + (40 if title else 0)
    fig = Figure(figsize=(W / 100, H / 100), dpi=100)
    FigureCanvasAgg(fig)
    fig.patch.set_facecolor(INK)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_xlim(0, W); ax.set_ylim(H, 0); ax.axis("off")
    y = margin
    if title:
        ax.text(margin, y, title, color=IVORY, alpha=0.7, fontsize=13, va="top", family="DejaVu Sans")
        y += 40
    for l, h in zip(lines, heights):
        face, size, mode = l["face"], l["size"], l["mode"]
        ax.text(margin, y, l.get("label", ""), color=IVORY, alpha=0.46, fontsize=10.5, va="top",
                family="DejaVu Sans")
        base_y = y + 30 + size * 0.98
        sc = size / face.upm
        x = margin
        body_v, body_c, glass_v, glass_c = [], [], [], []
        for name, adv, xo, yo in face.shape(l["text"]):
            tx, ty = x + xo * sc, base_y - yo * sc
            if mode == "colr" and name in face.layers:
                for layer in face.layers[name]:
                    if layer.colorID == 0xFFFF:
                        _draw(face.gs, layer.name, tx, ty, sc, body_v, body_c)
                    else:
                        _draw(face.gs, layer.name, tx, ty, sc, glass_v, glass_c)
            else:
                _draw(face.gs, name, tx, ty, sc, body_v, body_c)
            x += adv * sc
        if body_v:
            ax.add_patch(PathPatch(MPath(body_v, body_c), facecolor=IVORY, edgecolor="none", lw=0))
        if glass_v:
            pal = face.palettes[0][0] if face.palettes else (0xCF, 0xE9, 0xEF, 0xD9)
            col = l.get("glass") or "#%02x%02x%02x" % pal[:3]
            alpha = l.get("glass_alpha", pal[3] / 255)
            ax.add_patch(PathPatch(MPath(glass_v, glass_c), facecolor=col, alpha=alpha, edgecolor="none", lw=0))
        y += h
    out.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out, dpi=100, facecolor=INK)
    log(f"  specimen {out.relative_to(ROOT) if out.is_relative_to(ROOT) else out} ({W}x{H})")


def specimens(built: dict[str, bytes], sources: dict[str, Path]):
    R = Face(built["roman"], "Red Queen Glass")
    I = Face(built["italic"], "Red Queen Glass Italic")
    orig = TTFont(sources["roman"])
    orig = instancer.instantiateVariableFont(orig, INSTANCE)
    orig.flavor = None
    O = Face(to_bytes(orig), "Bodoni Moda 96/500")
    colr = "COLR: body ivory (CSS color), channel #cfe9ef at 85% (palette 0)"
    hollow = "base glyph (no colour support): the channel is a hole"
    out = HERE

    lines = [
        ("Red Queen", R), ("Bred, not written.", R), ("It refused 14,706 of 26,207.", R),
        ("Refused.", I), ("0123456789", R), ("ABCDEFGHIJKLMNOPQRSTUVWXYZ", R),
        ("abcdefghijklmnopqrstuvwxyz", R), ("ABCDEFGHIJKLMNOPQRSTUVWXYZ", I), ("abcdefghijklmnopqrstuvwxyz", I),
    ]
    for size in (180, 64):
        for mode, note in (("colr", colr), ("hollow", hollow)):
            render([dict(face=f, text=t, size=size, mode=mode,
                         label=f"{f.label} · {size}px · {note}") for t, f in lines],
                   out / f"specimen-{size}-{mode}.png")
    hero = []
    for size in (180, 64):
        hero += [dict(face=O, text="Red Queen", size=size, mode="solid", label=f"before: Bodoni Moda (opsz 96, wght 500) · {size}px"),
                 dict(face=R, text="Red Queen", size=size, mode="hollow", label=f"Red Queen Glass · {size}px · {hollow}"),
                 dict(face=R, text="Red Queen", size=size, mode="colr", label=f"Red Queen Glass · {size}px · {colr}")]
    hero += [dict(face=I, text="Refused.", size=180, mode="colr", glass=HOT, glass_alpha=1.0,
                  label="Red Queen Glass Italic · 180px · palette 1 (or override-colors: 0 #e8372c): the light turns red")]
    render(hero, out / "specimen-hero.png")
    detail = []
    for f in (R, I):
        for mode, note in (("hollow", hollow), ("colr", colr)):
            detail.append(dict(face=f, text="oeasgRQB038", size=400, mode=mode, label=f"{f.label} · 400px · {note}"))
    render(detail, out / "specimen-detail.png")


# ============================================================================================ main
def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--no-specimens", action="store_true")
    ap.add_argument("--ttf", type=Path, help="also write TTFs to this folder")
    args = ap.parse_args()
    sources = find_sources()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    built = {}
    for style in STYLES:
        font = build_style(style, sources[style])
        data = to_bytes(font)
        font = TTFont(io.BytesIO(data))
        # the reference is compiled too, so both sides have the same integer coordinates
        ref = TTFont(io.BytesIO(to_bytes(instancer.instantiateVariableFont(TTFont(sources[style]), INSTANCE))))
        check_font(font, ref, style)
        built[style] = data
        woff2 = TTFont(io.BytesIO(data))
        woff2.flavor = "woff2"
        dest = OUT_DIR / STYLES[style]["out"]
        woff2.save(dest)
        log(f"[{style}] wrote {dest.relative_to(ROOT)} ({dest.stat().st_size / 1024:.1f} KB)")
        if args.ttf:
            args.ttf.mkdir(parents=True, exist_ok=True)
            (args.ttf / (STYLES[style]["ps"] + ".ttf")).write_bytes(data)
    write_license()
    if not args.no_specimens:
        specimens(built, sources)


def write_license():
    upstream = (SOURCE_DIR / "OFL.txt").read_text()
    body = upstream.split("\n", 1)[1]  # drop the upstream copyright line, keep the licence text
    text = ("Copyright 2020 The Bodoni Moda Project Authors (https://github.com/indestructible-type/Bodoni)\n"
            "Copyright 2026 The Red Queen Project Authors (Red Queen Glass, a Modified Version of Bodoni Moda: "
            "the light channels cut through the thick strokes, the Q tail and the i/j lozenge tittles)\n"
            + body)
    (OUT_DIR / "OFL.txt").write_text(text)


if __name__ == "__main__":
    main()
