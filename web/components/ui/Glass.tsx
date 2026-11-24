"use client";
/**
 * Her glass, for the page's own controls.
 *
 * The header's capsule, the primary buttons and the menu are made of the same liquid glass as the queen and
 * the cursor: within a few pixels of their rim the world behind them really bends (an SVG displacement map
 * used as a backdrop filter, with a hair of colour fringing), the middle stays clear and softly frosted.
 * Each element gets its own filter, sized to it in whole pixels and rebuilt when it resizes.
 *
 * Browsers that cannot filter a backdrop through SVG (Safari, Firefox) keep the CSS glass in globals.css: a
 * frosted pane with a lit rim, no bending.
 */
import { forwardRef, useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";

let host: SVGSVGElement | null = null;
let seq = 0;
const NS = "http://www.w3.org/2000/svg";

function defs(): SVGSVGElement {
  if (host && host.isConnected) return host;
  host = document.createElementNS(NS, "svg");
  host.setAttribute("width", "0");
  host.setAttribute("height", "0");
  host.setAttribute("aria-hidden", "true");
  host.style.position = "absolute";
  host.style.pointerEvents = "none";
  document.body.appendChild(host);
  return host;
}

export function refracts(): boolean {
  if (typeof navigator === "undefined") return false;
  const brands = (navigator as Navigator & { userAgentData?: { brands?: { brand: string }[] } }).userAgentData?.brands;
  return !!brands?.some((b) => /Chromium|Google Chrome|Microsoft Edge/.test(b.brand));
}

/**
 * The displacement map of a rounded rectangle w×h (corner radius r): zero in the middle; within `bevel` px of
 * the rim each pixel samples from further inside, more the nearer the edge, so the world behind seems to
 * swell over a thick, rounded edge. R/G hold the sample offset (0.5 = in place) at the given scale.
 */
function paneMap(w: number, h: number, r: number, bevel: number, scale: number): string {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d");
  if (!g) return "";
  const im = g.createImageData(w, h);
  const hw = w / 2;
  const hh = h / 2;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const px = x + 0.5 - hw;
      const py = y + 0.5 - hh;
      const qx = Math.abs(px) - (hw - r);
      const qy = Math.abs(py) - (hh - r);
      // signed distance to the rounded rectangle (negative inside)
      const sd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
      const d = -sd;
      let dx = 0;
      let dy = 0;
      if (d > 0 && d < bevel) {
        const t = 1 - d / bevel;
        const amt = t * t * (3 - 2 * t) * bevel * 0.85;
        // the outward normal of the rim at this pixel
        let nx = 0;
        let ny = 0;
        if (qx > 0 && qy > 0) {
          const l = Math.hypot(qx, qy) || 1;
          nx = (qx / l) * Math.sign(px);
          ny = (qy / l) * Math.sign(py);
        } else if (qx > qy) nx = Math.sign(px);
        else ny = Math.sign(py);
        // sample inward
        dx = -nx * amt;
        dy = -ny * amt;
      }
      const k = (y * w + x) * 4;
      im.data[k] = Math.round(255 * Math.min(1, Math.max(0, 0.5 + dx / scale)));
      im.data[k + 1] = Math.round(255 * Math.min(1, Math.max(0, 0.5 + dy / scale)));
      im.data[k + 2] = 128;
      im.data[k + 3] = 255;
    }
  g.putImageData(im, 0, 0);
  return c.toDataURL();
}

const CA = [1, 1.06, 0.94];

/**
 * Make an element refract what lies behind it. `bevel`: how far in from the rim the glass bends (px);
 * `frost`: the blur in the middle (px). Returns the ref to attach.
 */
export function useGlass<T extends HTMLElement>({ bevel = 14, frost = 6 }: { bevel?: number; frost?: number } = {}) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !refracts() || !window.matchMedia("(pointer: fine)").matches) return;
    const id = `rq-glass-${++seq}`;
    const f = document.createElementNS(NS, "filter");
    f.setAttribute("id", id);
    f.setAttribute("x", "0");
    f.setAttribute("y", "0");
    f.setAttribute("filterUnits", "userSpaceOnUse");
    f.setAttribute("primitiveUnits", "userSpaceOnUse");
    f.setAttribute("color-interpolation-filters", "sRGB");
    const img = document.createElementNS(NS, "feImage");
    img.setAttribute("x", "0");
    img.setAttribute("y", "0");
    img.setAttribute("preserveAspectRatio", "none");
    img.setAttribute("result", "map");
    f.appendChild(img);
    const maps = ["r", "g", "b"].map((ch) => {
      const m = document.createElementNS(NS, "feDisplacementMap");
      m.setAttribute("in", "SourceGraphic");
      m.setAttribute("in2", "map");
      m.setAttribute("xChannelSelector", "R");
      m.setAttribute("yChannelSelector", "G");
      m.setAttribute("result", "d" + ch);
      f.appendChild(m);
      return m;
    });
    const iso = [
      ["dr", "1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0", "cr"],
      ["dg", "0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0", "cg"],
      ["db", "0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0", "cb"],
    ];
    for (const [i, v, out] of iso) {
      const m = document.createElementNS(NS, "feColorMatrix");
      m.setAttribute("in", i);
      m.setAttribute("type", "matrix");
      m.setAttribute("values", v);
      m.setAttribute("result", out);
      f.appendChild(m);
    }
    const c1 = document.createElementNS(NS, "feComposite");
    c1.setAttribute("in", "cr");
    c1.setAttribute("in2", "cg");
    c1.setAttribute("operator", "arithmetic");
    c1.setAttribute("k2", "1");
    c1.setAttribute("k3", "1");
    c1.setAttribute("result", "crg");
    f.appendChild(c1);
    const c2 = document.createElementNS(NS, "feComposite");
    c2.setAttribute("in", "crg");
    c2.setAttribute("in2", "cb");
    c2.setAttribute("operator", "arithmetic");
    c2.setAttribute("k2", "1");
    c2.setAttribute("k3", "1");
    f.appendChild(c2);
    defs().appendChild(f);

    let lastW = -1;
    let lastH = -1;
    let raf = 0;
    const build = () => {
      raf = 0;
      const w = Math.round(el.offsetWidth);
      const h = Math.round(el.offsetHeight);
      if (w < 4 || h < 4 || (w === lastW && h === lastH)) return;
      lastW = w;
      lastH = h;
      const r = Math.min(parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0, h / 2, w / 2);
      const b = Math.min(bevel, h / 2 - 1, w / 2 - 1);
      const scale = b * 2;
      img.setAttribute("href", paneMap(w, h, r, b, scale));
      for (const node of [f, img]) {
        node.setAttribute("width", String(w));
        node.setAttribute("height", String(h));
      }
      maps.forEach((m, i) => m.setAttribute("scale", String(scale * CA[i])));
      el.style.backdropFilter = `url(#${id}) blur(${frost}px) saturate(1.35) brightness(1.06)`;
      el.style.setProperty("-webkit-backdrop-filter", el.style.backdropFilter);
    };
    const ro = new ResizeObserver(() => {
      if (!raf) raf = requestAnimationFrame(build);
    });
    ro.observe(el);
    build();
    return () => {
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
      f.remove();
      el.style.backdropFilter = "";
    };
  }, [bevel, frost]);
  return ref;
}

/** A quiet button of clear glass that bends the world behind it (the hero's second action, the theatre's). */
export function GlassButton({ className = "", children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) {
  const ref = useGlass<HTMLButtonElement>({ bevel: 11, frost: 3 });
  return (
    <button ref={ref} type="button" className={`btn btn-quiet ${className}`} {...rest}>
      {children}
    </button>
  );
}

/** The header's capsule: one pane of glass holding the controls, with a bead that slides to the item under the cursor. */
export const NavCapsule = forwardRef<HTMLElement, { children: ReactNode }>(function NavCapsule({ children }, _fwd) {
  const ref = useGlass<HTMLElement>({ bevel: 13, frost: 5 });
  const bead = useRef<HTMLSpanElement>(null);
  const place = (item: HTMLElement | null) => {
    const cap = ref.current;
    const b = bead.current;
    if (!cap || !b) return;
    if (!item) {
      cap.removeAttribute("data-bead");
      return;
    }
    const r = item.getBoundingClientRect();
    const c = cap.getBoundingClientRect();
    const fresh = !cap.hasAttribute("data-bead");
    if (fresh) b.style.transition = "none";
    b.style.transform = `translateX(${(r.left - c.left).toFixed(1)}px)`;
    b.style.width = `${r.width.toFixed(1)}px`;
    if (fresh) {
      void b.offsetWidth;
      b.style.transition = "";
    }
    cap.setAttribute("data-bead", "");
  };
  return (
    <nav
      ref={ref}
      aria-label="Site"
      className="glass nav-capsule"
      onPointerOver={(e) => {
        const it = (e.target as HTMLElement).closest<HTMLElement>(".nav-item");
        place(it && ref.current?.contains(it) ? it : null);
      }}
      onPointerLeave={() => place(null)}
    >
      <span ref={bead} className="nav-bead" aria-hidden />
      {children}
    </nav>
  );
});
