"use client";
/**
 * Liquid glass, clear and set in Mona Sans: the display type.
 *
 * Every element with the class `ruby` becomes a word of red glass. In Chromium it is drawn in two layers over the
 * text itself, which stays in the page (clear) for reading, selection and screen readers:
 *  - the glass (::before): whatever lies behind the word, her 3D world included, seen through it and bent by the
 *    letters' own shape. A displacement map made from the glyphs makes the world swell over each stroke as
 *    through a rounded rod of glass, with a hair of colour fringing; it is also brightened a little.
 *  - the surface (::after): an SVG filter reads the letters and keeps their face clear (a touch of frost, more
 *    on small words), runs light along their edges, adds a gloss above and a little light below, a bright rim on
 *    the side facing the light and a softer one opposite, a glint where the light falls, and a soft shadow.
 * The light is still, high to the upper left. Words that hold live figures (rolling
 * digits) cannot be redrawn as a copy, so they keep their own text and take the surface filter directly, without
 * the bending. Other browsers keep the glass gradient in globals.css.
 *
 * The header's round controls (.lq) catch the same light: the bright arc of their rim turns toward it.
 *
 * Nothing is built for words off screen; maps are rebuilt only when a word changes size or text. The hero's
 * "Red Queen" is sculpted in the 3D stage instead (components/stage/title.ts); its DOM words are hidden then.
 */
import { useEffect } from "react";
import { scene } from "@/lib/scene";

const NS = "http://www.w3.org/2000/svg";
const POST = "blur(.6px) saturate(1.6) brightness(1.4)";

function chromium(): boolean {
  const brands = (navigator as Navigator & { userAgentData?: { brands?: { brand: string }[] } }).userAgentData?.brands;
  return !!brands?.some((b) => /Chromium|Google Chrome|Microsoft Edge/.test(b.brand));
}

let host: SVGSVGElement | null = null;
let seq = 0;
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

/** two ramps down a word's box, read by the surface filter: red is the gloss at the top, green the light below */
let ramps = "";
function rampsUrl(): string {
  if (ramps) return ramps;
  const c = document.createElement("canvas");
  c.width = 4;
  c.height = 256;
  const g = c.getContext("2d");
  if (!g) return "";
  const gr = g.createLinearGradient(0, 0, 0, 256);
  gr.addColorStop(0, "#ff0000");
  gr.addColorStop(0.38, "#000000");
  gr.addColorStop(0.62, "#000000");
  gr.addColorStop(1, "#00ff00");
  g.fillStyle = gr;
  g.fillRect(0, 0, 4, 256);
  return (ramps = c.toDataURL());
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const f2 = (v: number) => v.toFixed(2);

interface Surface {
  id: string;
  el: SVGFilterElement;
  img: SVGElement;
  light: SVGElement;
  o1: SVGElement;
  o2: SVGElement;
  r1: number;
  r2: number;
}

/**
 * The surface of a word set at `fs` px (k = fs / 190, the hero's size): clear glass. The letters come in
 * as black; the filter keeps their face clear (a touch of frost, more on small words so they stay legible), runs
 * light along their rounded edges, adds a gloss above and a little light below, a glint, a bright rim on the side
 * facing the light and a softer one opposite, and a soft shadow beneath.
 */
function surfaceFilter(fs: number): Surface {
  const k = fs / 190;
  const id = `rq-type-${++seq}`; // (Glass.tsx owns rq-glass-*)
  const bodyA = clamp(0.1 + ((120 - fs) / 80) * 0.7, 0.1, 0.8);
  const b = Math.max(0.9, 3 * k);
  const ss = Math.max(1.5, 5 * k);
  const f = document.createElementNS(NS, "filter") as SVGFilterElement;
  f.setAttribute("id", id);
  f.setAttribute("x", "-20%");
  f.setAttribute("y", "-30%");
  f.setAttribute("width", "140%");
  f.setAttribute("height", "170%");
  f.setAttribute("color-interpolation-filters", "sRGB");
  f.innerHTML = `
    <feImage href="${rampsUrl()}" x="0" y="0" width="1" height="1" preserveAspectRatio="none" result="ramp"/>
    <feGaussianBlur in="SourceAlpha" stdDeviation="${f2(b)}" result="h"/>
    <feComposite in="SourceAlpha" in2="h" operator="arithmetic" k2="1" k3="-1" result="e0"/>
    <feComponentTransfer in="e0" result="e"><feFuncA type="linear" slope="2.2"/></feComponentTransfer>
    <feFlood flood-color="#ffffff" flood-opacity=".55"/>
    <feComposite in2="e" operator="in" result="edge"/>
    <feFlood flood-color="#fff6f7" flood-opacity="${f2(bodyA)}"/>
    <feComposite in2="SourceAlpha" operator="in" result="body"/>
    <feColorMatrix in="ramp" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  .32 0 0 0 0" result="gl"/>
    <feComposite in="gl" in2="SourceAlpha" operator="in" result="gloss"/>
    <feColorMatrix in="ramp" type="matrix" values="0 0 0 0 1  0 0 0 0 .86  0 0 0 0 .88  0 .22 0 0 0" result="lo"/>
    <feComposite in="lo" in2="SourceAlpha" operator="in" result="low"/>
    <feSpecularLighting in="h" surfaceScale="${f2(ss)}" specularConstant="1.1" specularExponent="40" lighting-color="#ffffff" result="sp">
      <fePointLight x="0" y="-200" z="${Math.round(Math.max(60, 260 * k))}"/>
    </feSpecularLighting>
    <feComposite in="sp" in2="SourceAlpha" operator="in" result="spec"/>
    <feOffset in="SourceAlpha" dx="1" dy="1.4" result="o1"/>
    <feComposite in="SourceAlpha" in2="o1" operator="out" result="r1"/>
    <feFlood flood-color="#ffffff" flood-opacity=".95"/>
    <feComposite in2="r1" operator="in" result="rim1"/>
    <feOffset in="SourceAlpha" dx="-.8" dy="-1.1" result="o2"/>
    <feComposite in="SourceAlpha" in2="o2" operator="out" result="r2"/>
    <feFlood flood-color="#ffd6dc" flood-opacity=".5"/>
    <feComposite in2="r2" operator="in" result="rim2"/>
    <feGaussianBlur in="SourceAlpha" stdDeviation="${f2(Math.max(1, 6 * k))}" result="sb"/>
    <feOffset in="sb" dy="${f2(Math.max(1, 7 * k))}" result="sbo"/>
    <feFlood flood-color="#000000" flood-opacity=".38"/>
    <feComposite in2="sbo" operator="in" result="sh0"/>
    <feComposite in="sh0" in2="SourceAlpha" operator="out" result="shadow"/>
    <feMerge>
      <feMergeNode in="shadow"/><feMergeNode in="body"/><feMergeNode in="low"/><feMergeNode in="edge"/>
      <feMergeNode in="gloss"/><feMergeNode in="rim2"/><feMergeNode in="spec"/><feMergeNode in="rim1"/>
    </feMerge>`;
  defs().appendChild(f);
  const q = (s: string) => f.querySelector(s) as SVGElement;
  return {
    id,
    el: f,
    img: q("feImage"),
    light: q("fePointLight"),
    o1: q('feOffset[result="o1"]'),
    o2: q('feOffset[result="o2"]'),
    r1: Math.max(0.6, 1.7 * k),
    r2: Math.max(0.5, 1.35 * k),
  };
}

/**
 * The bending for a word of plain text, w×h px: the letters are drawn again on a canvas exactly where the page
 * sets them (line by line, from the font's own metrics, so a transform on the way in cannot shift them), blurred
 * into rounded rods, and the slope of each rod becomes how far the world behind is pulled toward its middle.
 */
function lensMap(el: HTMLElement, w: number, h: number, k: number): string | null {
  const cs = getComputedStyle(el);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d", { willReadFrequently: true });
  if (!g) return null;
  g.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  g.letterSpacing = cs.letterSpacing === "normal" ? "0px" : cs.letterSpacing;
  g.fillStyle = "#fff";
  g.textBaseline = "alphabetic";
  const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;

  // which words start a new line (the page's own layout decides; only the order of their left edges matters)
  const lines: string[][] = [];
  const range = document.createRange();
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let prevLeft = Infinity;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const re = /\S+/g;
    for (let m = re.exec(n.data); m; m = re.exec(n.data)) {
      range.setStart(n, m.index);
      range.setEnd(n, m.index + m[0].length);
      const r = range.getClientRects()[0];
      const left = r ? r.left : prevLeft + 1;
      if (!lines.length || left < prevLeft - 1) lines.push([]);
      lines[lines.length - 1].push(m[0]);
      prevLeft = left;
    }
  }
  if (!lines.length) return null;

  const pl = parseFloat(cs.paddingLeft) || 0;
  const pr = parseFloat(cs.paddingRight) || 0;
  const pt = parseFloat(cs.paddingTop) || 0;
  const pb = parseFloat(cs.paddingBottom) || 0;
  const cw = w - pl - pr;
  const lh = (h - pt - pb) / lines.length;
  const mt = g.measureText(text);
  const asc = mt.fontBoundingBoxAscent;
  const desc = mt.fontBoundingBoxDescent;
  lines.forEach((ws, i) => {
    const s = ws.join(" ");
    const lw = g.measureText(s).width;
    const x = cs.textAlign === "center" ? pl + (cw - lw) / 2 : cs.textAlign === "right" || cs.textAlign === "end" ? pl + cw - lw : pl;
    g.fillText(s, x, pt + i * lh + (lh - (asc + desc)) / 2 + asc);
  });

  const c2 = document.createElement("canvas");
  c2.width = w;
  c2.height = h;
  const g2 = c2.getContext("2d", { willReadFrequently: true });
  if (!g2) return null;
  g2.filter = `blur(${f2(Math.max(1.5, 6 * k))}px)`;
  g2.drawImage(c, 0, 0);
  g2.filter = "none";
  const H = g2.getImageData(0, 0, w, h).data;
  let maxg = 1e-3;
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4 + 3;
      const gx = H[i + 4] - H[i - 4];
      const gy = H[i + w * 4] - H[i - w * 4];
      const m = gx * gx + gy * gy;
      if (m > maxg) maxg = m;
    }
  const norm = 0.5 / Math.sqrt(maxg);
  const im = g2.createImageData(w, h);
  const D = im.data;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let dx = 0;
      let dy = 0;
      if (x > 0 && y > 0 && x < w - 1 && y < h - 1) {
        dx = (H[i + 7] - H[i - 1]) * norm;
        dy = (H[i + w * 4 + 3] - H[i - w * 4 + 3]) * norm;
      }
      D[i] = Math.round(255 * clamp(0.5 + dx, 0, 1));
      D[i + 1] = Math.round(255 * clamp(0.5 + dy, 0, 1));
      D[i + 2] = 128;
      D[i + 3] = 255;
    }
  g2.putImageData(im, 0, 0);
  return c2.toDataURL();
}

/** the backdrop filter for one word: three displacements (one per colour, slightly different) recombined */
function lensFilter(url: string, w: number, h: number, k: number): SVGFilterElement {
  const id = `rq-type-lens-${++seq}`;
  const s = Math.max(2, 10 * k);
  const f = document.createElementNS(NS, "filter") as SVGFilterElement;
  f.setAttribute("id", id);
  f.setAttribute("x", "0");
  f.setAttribute("y", "0");
  f.setAttribute("width", String(w));
  f.setAttribute("height", String(h));
  f.setAttribute("filterUnits", "userSpaceOnUse");
  f.setAttribute("primitiveUnits", "userSpaceOnUse");
  f.setAttribute("color-interpolation-filters", "sRGB");
  const ca = [1, 1.07, 0.93];
  f.innerHTML = `
    <feImage href="${url}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none" result="map"/>
    ${["r", "g", "b"].map((ch, i) => `<feDisplacementMap in="SourceGraphic" in2="map" scale="${f2(s * ca[i])}" xChannelSelector="R" yChannelSelector="G" result="d${ch}"/>`).join("")}
    <feColorMatrix in="dr" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="cr"/>
    <feColorMatrix in="dg" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="cg"/>
    <feColorMatrix in="db" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="cb"/>
    <feComposite in="cr" in2="cg" operator="arithmetic" k2="1" k3="1" result="crg"/>
    <feComposite in="crg" in2="cb" operator="arithmetic" k2="1" k3="1"/>`;
  defs().appendChild(f);
  return f;
}

interface Word {
  mode: "full" | "surface";
  w: number;
  h: number;
  fs: number;
  text: string;
  surf: Surface | null;
  lens: SVGFilterElement | null;
  seen: boolean;
}

/** Mount once. Turns every `.ruby` element into red glass as it comes on screen, and lights it all from the cursor. */
export function RubyField() {
  useEffect(() => {
    let lx = window.innerWidth * 0.2;
    let ly = -80;
    let raf = 0;
    const live = chromium() && CSS.supports("-webkit-mask-clip", "text");
    const words = new Map<HTMLElement, Word>();
    let fontsReady = false;

    const build = (el: HTMLElement) => {
      if (!live || !fontsReady || !el.isConnected) return;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      if (w < 4 || h < 4) return;
      const fs = parseFloat(getComputedStyle(el).fontSize) || 48;
      // (words under 56 px, the wordmark and the menu, take the surface only: the bending is invisible at that
      // size, and each lens re-filters the moving world behind it every frame)
      const mode: Word["mode"] = el.children.length || fs < 56 ? "surface" : "full";
      const text = el.textContent ?? "";
      let wd = words.get(el);
      if (wd && wd.surf && wd.w === w && wd.h === h && wd.fs === fs && wd.text === text && wd.mode === mode) return;
      if (!wd) {
        wd = { mode, w: 0, h: 0, fs: 0, text: "", surf: null, lens: null, seen: true };
        words.set(el, wd);
      }
      if (!wd.surf || Math.abs(wd.fs - fs) > 0.5) {
        wd.surf?.el.remove();
        wd.surf = surfaceFilter(fs);
      }
      wd.surf.img.setAttribute("width", String(w));
      wd.surf.img.setAttribute("height", String(h));
      el.style.setProperty("--lgf", `url(#${wd.surf.id})`);
      if (mode === "full") {
        el.dataset.text = text;
        const url = lensMap(el, w, h, fs / 190);
        wd.lens?.remove();
        wd.lens = null;
        if (url) {
          wd.lens = lensFilter(url, w, h, fs / 190);
          el.style.setProperty("--lens", `url(#${wd.lens.id}) ${POST}`);
        } else el.style.setProperty("--lens", POST);
      } else {
        wd.lens?.remove();
        wd.lens = null;
        el.style.removeProperty("--lens");
        delete el.dataset.text;
      }
      Object.assign(wd, { mode, w, h, fs, text });
      el.dataset.lg = mode;
      aim(el, wd);
    };

    // the light: still, high to the upper left of each word (moving it would re-render every visible word's
    // filter and cost about 10 fps; her sculpted name in the hero carries the moving light). The header's drops still turn their bright arc toward the cursor.
    const aim = (el: HTMLElement, wd: Word) => {
      const s = wd.surf;
      if (!s) return;
      const x = -0.1 * wd.w;
      const y = -1.1 * wd.h;
      s.light.setAttribute("x", x.toFixed(0));
      s.light.setAttribute("y", y.toFixed(0));
      let dx = x - wd.w / 2;
      let dy = y - wd.h / 2;
      const d = Math.hypot(dx, dy) || 1;
      dx /= d;
      dy /= d;
      s.o1.setAttribute("dx", f2(-dx * s.r1));
      s.o1.setAttribute("dy", f2(-dy * s.r1));
      s.o2.setAttribute("dx", f2(dx * s.r2));
      s.o2.setAttribute("dy", f2(dy * s.r2));
    };
    const light = () => {
      raf = 0;
      document.querySelectorAll<HTMLElement>(".lq").forEach((b) => {
        const r = b.getBoundingClientRect();
        const a = (Math.atan2(lx - (r.left + r.width / 2), -(ly - (r.top + r.height / 2))) * 180) / Math.PI;
        b.style.setProperty("--la", `${a.toFixed(1)}deg`);
      });
    };
    const kick = () => {
      if (!raf) raf = requestAnimationFrame(light);
    };

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const el = e.target as HTMLElement;
          if (e.isIntersecting) {
            build(el);
            const wd = words.get(el);
            if (wd) wd.seen = true;
          } else {
            const wd = words.get(el);
            if (wd) wd.seen = false;
          }
        }
        kick();
      },
      { rootMargin: "200px" },
    );
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const el = e.target as HTMLElement;
        if (words.get(el)?.seen) build(el);
      }
    });
    const watched = new Set<HTMLElement>();
    const watch = (root: ParentNode) => {
      root.querySelectorAll<HTMLElement>(".ruby").forEach((el) => {
        if (watched.has(el)) return;
        watched.add(el);
        io.observe(el);
        ro.observe(el);
      });
    };
    watch(document);
    const mo = new MutationObserver((ms) => {
      for (const m of ms) {
        if (m.type === "characterData") {
          const el = m.target.parentElement?.closest<HTMLElement>(".ruby");
          if (el && words.get(el)?.seen) build(el);
          continue;
        }
        m.addedNodes.forEach((n) => {
          if (!(n instanceof HTMLElement)) {
            const el = n.parentElement?.closest<HTMLElement>(".ruby");
            if (el && words.get(el)?.seen) build(el);
            return;
          }
          if (n.classList.contains("ruby")) watch(n.parentElement ?? document);
          else {
            watch(n);
            const el = n.closest<HTMLElement>(".ruby");
            if (el && words.get(el)?.seen) build(el);
          }
        });
        m.removedNodes.forEach((n) => {
          if (!(n instanceof HTMLElement)) return;
          for (const el of [n, ...Array.from(n.querySelectorAll<HTMLElement>(".ruby"))]) {
            const wd = words.get(el);
            if (!wd) continue;
            wd.surf?.el.remove();
            wd.lens?.remove();
            words.delete(el);
            watched.delete(el);
            io.unobserve(el);
            ro.unobserve(el);
          }
        });
      }
    });
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });

    // the lens maps are drawn with the page's own font, so they wait for it
    let alive = true;
    const rebuildAll = () => {
      if (!alive) return;
      fontsReady = true;
      for (const el of watched) {
        const wd = words.get(el);
        if (wd) wd.w = -1; // force
        if (!wd || wd.seen) build(el);
      }
      kick();
    };
    if (live) {
      document.fonts.load('48px "Red Queen Glass"').then(rebuildAll, rebuildAll);
      document.fonts.addEventListener("loadingdone", rebuildAll);
    }

    const onMove = (e: PointerEvent) => {
      if (scene.reducedMotion) return;
      lx = e.clientX;
      ly = e.clientY - 140; // the light hangs a little above the cursor, so the tops of the letters catch it
      kick();
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("scroll", kick, { passive: true });
    window.addEventListener("resize", kick, { passive: true });
    kick();
    return () => {
      alive = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("scroll", kick);
      window.removeEventListener("resize", kick);
      if (live) document.fonts.removeEventListener("loadingdone", rebuildAll);
      io.disconnect();
      ro.disconnect();
      mo.disconnect();
      if (raf) cancelAnimationFrame(raf);
      for (const [el, wd] of words) {
        wd.surf?.el.remove();
        wd.lens?.remove();
        delete el.dataset.lg;
        delete el.dataset.text;
        el.style.removeProperty("--lgf");
        el.style.removeProperty("--lens");
      }
    };
  }, []);
  return null;
}
