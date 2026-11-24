"use client";
/**
 * The cursor is a drop of her glass.
 *
 * A small lens of the same liquid glass the queen is made of. It really refracts what is under it (an SVG
 * displacement map applied as a backdrop filter): a gentle magnification in the middle and, at the rim,
 * the surroundings squeezed in, with a hair of colour fringing, the way a bead of glass bends a page.
 * Over text it opens into a reading lens sized to the type, so the words swell as it passes over them;
 * over a control it settles into a small bead; on press it gives like a drop and springs back (the brand's
 * gel spring, k 170, c 13). The 3D stage still reads the pointer from here (her lean, the camera's parallax).
 *
 * Browsers that cannot filter a backdrop through SVG (Safari, Firefox) get the same drop without the
 * refraction: a clear bead with a rim and a soft brightening.
 */
import { useEffect, useRef } from "react";
import { scene } from "@/lib/scene";

/** the lens box is this much larger than the visible lens, so the rim can pull in what lies just outside */
const K = 1.5;
/** text the lens reads */
const TEXT = "main p, main h1, main h2, main h3, main li, main blockquote, main figcaption, main dd, main dt, [data-tour] p, [data-tour] h2, [data-read]";
const CONTROL = "a,button,input,select,label,[role=button],[data-cursor]";

const BEAD = 20;
const CONTROL_SIZE = 38;

/** The displacement map: R/G hold where each pixel samples from (0.5 = in place). */
function lensMap(n = 256, m = 1.45, out = 1.4): string {
  const c = document.createElement("canvas");
  c.width = c.height = n;
  const g2 = c.getContext("2d");
  if (!g2) return "";
  const im = g2.createImageData(n, n);
  const rl = 1 / K;
  const ss = (a: number, b: number, v: number) => {
    const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const u = ((i + 0.5) / n) * 2 - 1;
      const v = ((j + 0.5) / n) * 2 - 1;
      const r = Math.hypot(u, v);
      let g = 0;
      if (r < 1e-4) g = 1 - 1 / m;
      else if (r < rl) {
        // magnified in the middle; towards the rim the sample radius swings outward past the lens edge
        const e = Math.pow(ss(0.55 * rl, rl, r), 2.2);
        const rho = (r / m) * (1 - e) + e * r * out;
        g = 1 - rho / r;
      }
      const k = (j * n + i) * 4;
      im.data[k] = Math.round(255 * Math.min(1, Math.max(0, 0.5 - 0.5 * u * g)));
      im.data[k + 1] = Math.round(255 * Math.min(1, Math.max(0, 0.5 - 0.5 * v * g)));
      im.data[k + 2] = 128;
      im.data[k + 3] = 255;
    }
  g2.putImageData(im, 0, 0);
  return c.toDataURL();
}

function refracts(): boolean {
  const brands = (navigator as Navigator & { userAgentData?: { brands?: { brand: string }[] } }).userAgentData?.brands;
  return !!brands?.some((b) => /Chromium|Google Chrome|Microsoft Edge/.test(b.brand));
}

export function Cursor() {
  const glass = useRef<HTMLDivElement>(null);
  const rim = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (!window.matchMedia("(pointer: fine)").matches) return;
    const root = document.documentElement;
    root.classList.add("has-cursor");
    const canRefract = refracts();
    // full screen moves the page onto another compositing path where the refracting backdrop (it re-reads the 3D
    // canvas every frame) lags the whole site: there the lens keeps its light but not its refraction
    let live = canRefract && !document.fullscreenElement;
    const filt = svg.current?.querySelector("filter");
    const img = svg.current?.querySelector("feImage");
    const maps = svg.current ? Array.from(svg.current.querySelectorAll("feDisplacementMap")) : [];
    if (canRefract && img) img.setAttribute("href", lensMap());
    const applyLens = () => {
      if (glass.current) glass.current.style.backdropFilter = live ? "url(#rq-lens) brightness(1.1)" : "brightness(1.18) saturate(1.1)";
    };
    applyLens();
    const onFullscreen = () => {
      live = canRefract && !document.fullscreenElement;
      lastBox = -1;
      applyLens();
    };

    let x = innerWidth / 2;
    let y = innerHeight / 2;
    let lx = x;
    let ly = y;
    let size = 0; // the drawn lens size (sprung)
    let vel = 0;
    let target = BEAD;
    let press = 1;
    let shown = 0;
    let want = 0;
    let lastBox = -1;
    let raf = 0;

    const sizeFor = (el: Element | null): number => {
      if (!el) return BEAD;
      if (el.closest(CONTROL)) return CONTROL_SIZE;
      const t = el.closest<HTMLElement>(TEXT);
      if (t) {
        const fs = parseFloat(getComputedStyle(t).fontSize) || 16;
        return Math.max(64, Math.min(150, fs * 4.2));
      }
      return BEAD;
    };

    const onMove = (e: PointerEvent) => {
      x = e.clientX;
      y = e.clientY;
      want = 1;
      scene.pointer.x = x;
      scene.pointer.y = y;
      scene.pointer.nx = (x / innerWidth) * 2 - 1;
      scene.pointer.ny = -((y / innerHeight) * 2 - 1);
      target = sizeFor(e.target as Element);
    };
    const onDown = () => (press = 0.82);
    const onUp = () => (press = 1);
    const onLeave = () => (want = 0);

    const setBox = (s: number) => {
      // the filter works in the element's own pixels, so its size follows the lens (whole pixels only)
      const B = Math.max(8, Math.round(s * K));
      if (B === lastBox) return;
      lastBox = B;
      if (glass.current) {
        glass.current.style.width = glass.current.style.height = `${B}px`;
        glass.current.style.clipPath = `circle(${(B / K / 2).toFixed(1)}px at 50% 50%)`;
      }
      if (live && filt && img) {
        filt.setAttribute("width", String(B));
        filt.setAttribute("height", String(B));
        img.setAttribute("width", String(B));
        img.setAttribute("height", String(B));
        const ca = [1, 1.05, 0.95];
        maps.forEach((m, i) => m.setAttribute("scale", String(B * ca[i])));
      }
    };

    let last = performance.now();
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      // position: close behind the pointer, a liquid lag rather than a float
      const f = 1 - Math.exp(-dt * 32);
      lx += (x - lx) * f;
      ly += (y - ly) * f;
      // size: the gel spring, so it wobbles open like a drop
      const goal = target * press;
      const acc = 170 * (goal - size) - 13 * vel;
      vel += acc * dt;
      size += vel * dt;
      if (size < 0) size = 0;
      shown += (want - shown) * (1 - Math.exp(-dt * 10));
      setBox(size);
      const B = lastBox;
      const s = B / K;
      if (glass.current) {
        glass.current.style.transform = `translate3d(${(lx - B / 2).toFixed(1)}px,${(ly - B / 2).toFixed(1)}px,0)`;
        glass.current.style.opacity = shown.toFixed(3);
      }
      if (rim.current) {
        rim.current.style.width = rim.current.style.height = `${s.toFixed(1)}px`;
        rim.current.style.transform = `translate3d(${(lx - s / 2).toFixed(1)}px,${(ly - s / 2).toFixed(1)}px,0)`;
        rim.current.style.opacity = shown.toFixed(3);
      }
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerdown", onDown, { passive: true });
    window.addEventListener("pointerup", onUp, { passive: true });
    document.addEventListener("pointerleave", onLeave);
    document.addEventListener("fullscreenchange", onFullscreen);
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointerleave", onLeave);
      document.removeEventListener("fullscreenchange", onFullscreen);
      root.classList.remove("has-cursor");
    };
  }, []);

  return (
    <div aria-hidden className="pointer-events-none fixed left-0 top-0 z-[90] hidden [@media(pointer:fine)]:block">
      <svg ref={svg} width="0" height="0" className="absolute">
        <filter id="rq-lens" x="0" y="0" width="30" height="30" filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feImage x="0" y="0" width="30" height="30" preserveAspectRatio="none" result="map" />
          <feDisplacementMap in="SourceGraphic" in2="map" scale="30" xChannelSelector="R" yChannelSelector="G" result="g" />
          <feDisplacementMap in="SourceGraphic" in2="map" scale="31" xChannelSelector="R" yChannelSelector="G" result="r" />
          <feDisplacementMap in="SourceGraphic" in2="map" scale="29" xChannelSelector="R" yChannelSelector="G" result="b" />
          <feColorMatrix in="r" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="rr" />
          <feColorMatrix in="g" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="gg" />
          <feColorMatrix in="b" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="bb" />
          <feComposite in="rr" in2="gg" operator="arithmetic" k2="1" k3="1" result="rg" />
          <feComposite in="rg" in2="bb" operator="arithmetic" k2="1" k3="1" />
        </filter>
      </svg>
      <div ref={glass} className="lens-glass" style={{ opacity: 0 }} />
      <div ref={rim} className="lens-rim" style={{ opacity: 0 }} />
    </div>
  );
}
