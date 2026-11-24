/**
 * Her name, sculpted: clear glass in Mona Sans. The hero's "Red Queen" is not styled text but a piece of clear glass in the 3D stage, drawn by the pipeline
 * after the queen.
 *
 * The letters are cast from the page's own layout (the h1 stays in the DOM, hidden, for reading and for screen
 * readers): drawn on a canvas, every corner softened the way liquid would round it, turned into a distance field
 * for their edges, and given a height (the softened letters blurred), so each stroke is a flat face that rolls
 * over into rounded rims. Through it the world is bent, hardest at the rims where the glass acts as a lens, with
 * the three colours a little apart; the face is frosted a touch and brightened. The rims mirror the studio's
 * lights (a softbox overhead, a strip to the upper left, a cold window), glints come from a key light and from a
 * light above the cursor, and a fine bright line runs where glass meets air (faintly warm on the far side, her
 * red caught in it). Beneath it, a soft shadow. Clear glass over black reads as obsidian (nothing to bend), so a
 * faint warm light hangs behind the letters, laid into the opaque pass, and the glass bends it.
 *
 * On first load the glass pours into the letters from their spines outward. It fades with the page (the menu,
 * cinema) and is not drawn when the hero is off screen. Without WebGL the DOM title keeps its CSS glass.
 */
import * as THREE from "three";
import { gfx } from "./gfx";
import { scene } from "@/lib/scene";

const VERT = /* glsl */ `
uniform vec4 uBox;
uniform vec2 uRes;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec2 p = uBox.xy + uv * uBox.zw;
  gl_Position = vec4(p / uRes * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAG = /* glsl */ `
uniform sampler2D tSDF; // r: signed distance to the letters' edge (CSS px, + inside); g: their rounded height (0..1)
uniform sampler2D tScene;
uniform vec2 uRes;
uniform vec2 uTexel;
uniform float uTexCss;
uniform float uCss;
uniform float uR;
uniform float uGrow;
uniform float uLift;
uniform vec3 uLight;
uniform float uLightAmt;
uniform float uDim;
uniform float uShadowUv;
varying vec2 vUv;

float sdf(vec2 uv) { return texture2D(tSDF, uv).r; }
float hf(vec2 uv) { return texture2D(tSDF, uv).g; }

// the lights the glass mirrors: a long softbox overhead, a narrow strip to the upper left, a cold window to
// the right, a dim floor below
vec3 studio(vec3 r) {
  float top = smoothstep(0.35, 0.85, r.y);
  float strip = exp(-pow((r.x + 0.6 + 0.25 * r.y) / 0.1, 2.0)) * smoothstep(-0.3, 0.5, r.y);
  float win = exp(-pow((r.x - 0.68) / 0.12, 2.0)) * smoothstep(-0.1, 0.6, r.y);
  float low = smoothstep(-0.1, -0.75, r.y);
  return vec3(1.0, 0.985, 0.98) * (top * 1.15 + strip * 1.7) + vec3(0.78, 0.9, 1.0) * win * 0.6 + vec3(0.32, 0.3, 0.32) * low * 0.35;
}

void main() {
  float sd = sdf(vUv) - uGrow;
  float aa = max(fwidth(sd), 1e-3) * 0.8;
  float cov = smoothstep(-aa, aa, sd);

  // outside: a soft shadow cast down (clear glass lifts off the page; no glow)
  float od = max(-(sdf(vUv + vec2(0.0, uShadowUv)) - uGrow), 0.0);
  float shadow = pow(1.0 - smoothstep(0.0, 2.6 * uR, od), 2.0) * 0.28;
  vec4 outside = vec4(0.0, 0.0, 0.0, shadow);

  vec4 inside = vec4(0.0);
  if (cov > 0.0) {
    // the surface: a flat face that rolls over into rounded rims (its height is the letters blurred)
    // (as the glass pours in, the rims swell up from flat: uLift runs 0 → 1 with the reveal)
    float h = hf(vUv) * uLift;
    vec2 e = uTexel * 3.0;
    vec2 gh = uLift * vec2(hf(vUv + vec2(e.x, 0.0)) - hf(vUv - vec2(e.x, 0.0)), hf(vUv + vec2(0.0, e.y)) - hf(vUv - vec2(0.0, e.y))) / (6.0 * uTexCss);
    vec3 n = normalize(vec3(-gh * 11.0 * uR, 1.0));
    vec2 out2 = -normalize(gh + 1e-5);
    float rimZone = 1.0 - smoothstep(0.2, 0.95, h);

    // clear glass: the world behind it, bent hardest at the rounded rims (the lens), a little magnified in the
    // face, frosted a touch and barely brightened, three colours a little apart
    vec2 frag = gl_FragCoord.xy;
    vec2 suv = frag / uRes;
    vec2 o = -n.xy * (10.0 + 26.0 * rimZone) * uCss / uRes;
    vec3 bg;
    bg.r = textureLod(tScene, suv + o * 1.1, 1.0).r;
    bg.g = textureLod(tScene, suv + o, 1.0).g;
    bg.b = textureLod(tScene, suv + o * 0.9, 1.0).b;
    vec3 col = bg * 1.18 + vec3(0.01);
    // depth: the rim away from the light holds a little shade
    vec2 toL = normalize(vec2(-0.5, 0.85));
    col *= 1.0 - 0.15 * rimZone * smoothstep(-0.1, 0.8, dot(out2, -toL));
    // the studio in its surface, strongest where the rims turn away from you
    vec3 V = vec3(0.0, 0.0, 1.0);
    float fres = 0.04 + 0.96 * pow(1.0 - max(dot(n, V), 0.0), 2.6);
    col += studio(reflect(-V, n)) * fres * 2.0;
    // glints: the key light, and the light above the cursor
    vec3 Lk = normalize(vec3(-0.45, 0.65, 0.62));
    float spk = pow(max(dot(n, normalize(Lk + V)), 0.0), 60.0);
    vec3 Lc = normalize(vec3(uLight.xy - frag, uLight.z));
    float spc = pow(max(dot(n, normalize(Lc + V)), 0.0), 120.0) * uLightAmt;
    col += vec3(1.0) * (spk * 1.9 + spc * 2.4);
    // the edge where glass meets air: a fine bright line, full toward the light, softer (and faintly warm,
    // her red caught in it) on the far side
    float line = 1.0 - smoothstep(0.0, 1.1, sd);
    float facing = smoothstep(-0.4, 0.8, dot(out2, toL));
    col += mix(vec3(1.0, 0.62, 0.68) * 0.5, vec3(1.0), facing) * line * (0.45 + 0.75 * facing);
    inside = vec4(col, 1.0) * cov;
  }
  gl_FragColor = (inside + outside * (1.0 - cov)) * uDim;
}`;

/** the light behind her name: clear glass needs something to bend, so a faint warm light hangs behind the letters */
const GLOW_FRAG = /* glsl */ `
uniform vec4 uL; // the letters' box, target px (x, y from the bottom, w, h)
uniform float uAmt;
varying vec2 vUv;
void main() {
  vec2 c = uL.xy + uL.zw * vec2(0.5, 0.46);
  vec2 d = (gl_FragCoord.xy - c) / (uL.zw * vec2(0.55, 0.58));
  float r2 = dot(d, d);
  // (a faint warm haze is enough for the glass to have something to bend)
  vec3 col = vec3(0.6, 0.12, 0.14) * exp(-r2 * 1.9) * 0.12 + vec3(1.0, 0.92, 0.9) * exp(-r2 * 7.0) * 0.045;
  gl_FragColor = vec4(col * uAmt, 1.0); // (additive: alpha 1 or nothing is added)
}`;

const INF = 1e20;

/** Felzenszwalb–Huttenlocher squared distance, one row or column (as TinySDF does it) */
function edt1d(grid: Float64Array, offset: number, stride: number, length: number, f: Float64Array, v: Uint16Array, z: Float64Array) {
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  f[0] = grid[offset];
  for (let q = 1, k = 0, s = 0; q < length; q++) {
    f[q] = grid[offset + q * stride];
    const q2 = q * q;
    do {
      const r = v[k];
      s = (f[q] - f[r] + q2 - r * r) / (q - r) / 2;
    } while (s <= z[k] && --k > -1);
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  for (let q = 0, k = 0; q < length; q++) {
    while (z[k + 1] < q) k++;
    const r = v[k];
    const qr = q - r;
    grid[offset + q * stride] = f[r] + qr * qr;
  }
}
function edt(data: Float64Array, w: number, h: number) {
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const v = new Uint16Array(n);
  const z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) edt1d(data, x, w, h, f, v, z);
  for (let y = 0; y < h; y++) edt1d(data, y * w, 1, w, f, v, z);
}

interface Cast {
  tex: THREE.DataTexture;
  /** the cast's box relative to the h1's border box, CSS px */
  x: number;
  y: number;
  w: number;
  h: number;
  /** rounding radius and the deepest point of the strokes, CSS px */
  r: number;
  deep: number;
}

export class SculptedTitle {
  private el: HTMLElement | null = null;
  private cast: Cast | null = null;
  private key = "";
  private dirty = true;
  private fontsReady = false;
  private shown = false;
  private revealAt = -1;
  private ro: ResizeObserver | null = null;
  readonly mat: THREE.ShaderMaterial;
  private glow: THREE.ShaderMaterial;
  private scene = new THREE.Scene();
  private glowScene = new THREE.Scene();
  private reveal = 0;
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private onFonts = () => {
    this.fontsReady = true;
    this.dirty = true;
  };

  constructor() {
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        tSDF: { value: null },
        tScene: { value: null },
        uBox: { value: new THREE.Vector4() },
        uRes: { value: new THREE.Vector2(1, 1) },
        uTexel: { value: new THREE.Vector2(1, 1) },
        uTexCss: { value: 1 },
        uCss: { value: 1 },
        uR: { value: 12 },
        uGrow: { value: 0 },
        uLift: { value: 1 },
        uLight: { value: new THREE.Vector3() },
        uLightAmt: { value: 0.35 },
        uDim: { value: 1 },
        uShadowUv: { value: 0 },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    const q = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.mat);
    q.frustumCulled = false;
    this.scene.add(q);
    this.glow = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: GLOW_FRAG,
      uniforms: { uBox: { value: new THREE.Vector4() }, uRes: { value: new THREE.Vector2(1, 1) }, uL: { value: new THREE.Vector4() }, uAmt: { value: 0 } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const gq = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.glow);
    gq.frustumCulled = false;
    this.glowScene.add(gq);
    if (typeof window !== "undefined") {
      // a debug handle, for tuning the glass live (like __rq.three)
      const w = window as unknown as { __rq?: Record<string, unknown> };
      w.__rq = { ...(w.__rq ?? {}), title: this };
    }
    if (typeof document !== "undefined") {
      document.fonts.load('48px "Red Queen Glass"').then(this.onFonts, this.onFonts);
      document.fonts.addEventListener("loadingdone", this.onFonts);
    }
  }

  private attach(): HTMLElement | null {
    if (this.el && this.el.isConnected) return this.el;
    this.el = document.querySelector<HTMLElement>(".hero-title");
    this.ro?.disconnect();
    if (this.el) {
      this.ro = new ResizeObserver(() => (this.dirty = true));
      this.ro.observe(this.el);
      this.dirty = true;
    }
    return this.el;
  }

  /** cast the letters from the page's layout: draw them where the page sets them, then measure every pixel's distance to the edge */
  private build(el: HTMLElement) {
    const words = Array.from(el.querySelectorAll<HTMLElement>(".ruby"));
    if (!words.length) return;
    const cs = getComputedStyle(words[0]);
    const fs = parseFloat(cs.fontSize) || 120;
    // each word's place in the h1's layout, summed up the offset chain: while a line still carries its entrance
    // transform it is the word's offset parent, so one hop would measure both lines from their own tops
    const at = new Map<HTMLElement, { x: number; y: number }>();
    for (const w of words) {
      let x = 0;
      let y = 0;
      let e: HTMLElement | null = w;
      while (e && e !== el) {
        x += e.offsetLeft;
        y += e.offsetTop;
        e = e.offsetParent as HTMLElement | null;
      }
      if (!e) {
        const a = w.getBoundingClientRect();
        const b = el.getBoundingClientRect();
        x = a.left - b.left;
        y = a.top - b.top;
      }
      at.set(w, { x, y });
    }
    const key = `${el.offsetWidth}x${el.offsetHeight}@${fs}:${words.map((w) => `${at.get(w)!.x},${at.get(w)!.y},${w.textContent}`).join("|")}`;
    if (key === this.key && this.cast) return;
    const m = fs * 0.22;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const w of words) {
      const q = at.get(w)!;
      x0 = Math.min(x0, q.x);
      y0 = Math.min(y0, q.y);
      x1 = Math.max(x1, q.x + w.offsetWidth);
      y1 = Math.max(y1, q.y + w.offsetHeight);
    }
    x0 -= m;
    y0 -= m;
    x1 += m;
    y1 += m;
    const bw = x1 - x0;
    const bh = y1 - y0;
    const s = Math.min(1.5, 1600 / bw);
    const W = Math.max(8, Math.ceil(bw * s));
    const H = Math.max(8, Math.ceil(bh * s));
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const g = c.getContext("2d", { willReadFrequently: true });
    if (!g) return;
    g.scale(s, s);
    g.translate(-x0, -y0);
    g.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    g.letterSpacing = cs.letterSpacing === "normal" ? "0px" : cs.letterSpacing;
    g.fillStyle = "#fff";
    for (const w of words) {
      const ws = getComputedStyle(w);
      const pl = parseFloat(ws.paddingLeft) || 0;
      const pt = parseFloat(ws.paddingTop) || 0;
      const pb = parseFloat(ws.paddingBottom) || 0;
      const t = (w.textContent ?? "").trim();
      const mt = g.measureText(t);
      const lh = w.offsetHeight - pt - pb;
      const q = at.get(w)!;
      g.fillText(t, q.x + pl, q.y + pt + (lh - (mt.fontBoundingBoxAscent + mt.fontBoundingBoxDescent)) / 2 + mt.fontBoundingBoxAscent);
    }
    // the rounded height: the letters blurred (a stroke's middle stands highest, a hairline barely rises)
    const c2 = document.createElement("canvas");
    c2.width = W;
    c2.height = H;
    const g2 = c2.getContext("2d", { willReadFrequently: true });
    if (!g2) return;
    g2.filter = `blur(${(fs * 0.028 * s).toFixed(2)}px)`;
    let hmax = 1;
    // TinySDF's sub-pixel start, then the exact Euclidean transform inside and out
    const a = g.getImageData(0, 0, W, H).data;
    const outer = new Float64Array(W * H);
    const inner = new Float64Array(W * H);
    for (let i = 0; i < W * H; i++) {
      const al = a[i * 4 + 3] / 255;
      if (al <= 0) {
        outer[i] = INF;
        inner[i] = 0;
      } else if (al >= 1) {
        outer[i] = 0;
        inner[i] = INF;
      } else {
        const d = 0.5 - al;
        outer[i] = d > 0 ? d * d : 0;
        inner[i] = d < 0 ? d * d : 0;
      }
    }
    edt(outer, W, H);
    edt(inner, W, H);
    // sculpt: soften every corner the way liquid would (erode by rr, measure again, grow back by rr, so
    // convex corners become arcs of radius rr), then take the height from the softened letters
    const rr = fs * 0.035 * s;
    for (let i = 0; i < W * H; i++) {
      const d = Math.sqrt(inner[i]) - Math.sqrt(outer[i]) - rr;
      const al = Math.max(0, Math.min(1, d + 0.5));
      if (al <= 0) {
        outer[i] = INF;
        inner[i] = 0;
      } else if (al >= 1) {
        outer[i] = 0;
        inner[i] = INF;
      } else {
        const q = 0.5 - al;
        outer[i] = q > 0 ? q * q : 0;
        inner[i] = q < 0 ? q * q : 0;
      }
    }
    edt(outer, W, H);
    edt(inner, W, H);
    const soft = g.createImageData(W, H);
    for (let i = 0; i < W * H; i++) {
      const d = Math.sqrt(inner[i]) - Math.sqrt(outer[i]) + rr;
      soft.data[i * 4 + 3] = Math.round(255 * Math.max(0, Math.min(1, d + 0.5)));
    }
    const c3 = document.createElement("canvas");
    c3.width = W;
    c3.height = H;
    c3.getContext("2d")?.putImageData(soft, 0, 0);
    g2.clearRect(0, 0, W, H);
    g2.drawImage(c3, 0, 0);
    const hb2 = g2.getImageData(0, 0, W, H).data;
    hmax = 1;
    for (let i = 3; i < hb2.length; i += 4) if (hb2[i] > hmax) hmax = hb2[i];
    // half floats: the distance in CSS px (positive inside) and the height; rows flipped so v runs up like the screen
    const data = new Uint16Array(W * H * 2);
    let deep = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const d = (Math.sqrt(inner[i]) - Math.sqrt(outer[i]) + rr) / s;
        if (d > deep) deep = d;
        const j = ((H - 1 - y) * W + x) * 2;
        data[j] = THREE.DataUtils.toHalfFloat(Math.max(-m, Math.min(m, d)));
        data[j + 1] = THREE.DataUtils.toHalfFloat(hb2[i * 4 + 3] / hmax);
      }
    const tex = new THREE.DataTexture(data, W, H, THREE.RGFormat, THREE.HalfFloatType);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    this.cast?.tex.dispose();
    this.cast = { tex, x: x0, y: y0, w: bw, h: bh, r: Math.max(3, fs * 0.085), deep: Math.max(2, deep) };
    this.key = key;
    const u = this.mat.uniforms;
    u.tSDF.value = tex;
    u.uTexel.value.set(1 / W, 1 / H);
    u.uTexCss.value = 1 / s;
  }

  /** the light behind her name, laid into the opaque pass before anything glass reads it */
  backlight(gl: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget, cssW: number, cssH: number) {
    const el = this.el;
    const c = this.cast;
    if (!el || !c || !this.shown) return;
    const r = el.getBoundingClientRect();
    const left = r.left + c.x;
    const top = r.top + c.y;
    if (top - c.h > cssH || top + 2 * c.h < 0) return;
    const px = target.width / cssW;
    const u = this.glow.uniforms;
    const lx = left * px;
    const ly = (cssH - top - c.h) * px;
    const lw = c.w * px;
    const lh = c.h * px;
    u.uL.value.set(lx, ly, lw, lh);
    // (only as far as the glow is visible)
    u.uBox.value.set(lx - lw * 0.35, ly - lh * 0.45, lw * 1.7, lh * 1.9);
    u.uRes.value.set(target.width, target.height);
    u.uAmt.value = this.mat.uniforms.uDim.value * this.reveal;
    const autoClear = gl.autoClear;
    gl.autoClear = false;
    gl.setRenderTarget(target);
    gl.render(this.glowScene, this.cam);
    gl.autoClear = autoClear;
  }

  /** draw her name into the glass pass (after the queen, before bloom) */
  frame(gl: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget, sceneTex: THREE.Texture, cssW: number, cssH: number) {
    const el = this.attach();
    if (!el || !this.fontsReady) return;
    if (this.dirty) {
      this.dirty = false;
      this.build(el);
    }
    const c = this.cast;
    if (!c) return;
    const r = el.getBoundingClientRect();
    const left = r.left + c.x;
    const top = r.top + c.y;
    if (top > cssH || top + c.h < 0 || left > cssW || left + c.w < 0) return;
    // the page's own fades (the menu, cinema, the film) apply to her name too
    let dim = 1;
    for (let a: HTMLElement | null = el; a && dim > 0.001; a = a.parentElement) dim *= parseFloat(getComputedStyle(a).opacity) || 0;
    if (dim <= 0.001) return;

    const now = performance.now() / 1000;
    if (this.revealAt < 0) this.revealAt = now + 0.25;
    const p = scene.reducedMotion ? 1 : Math.min(1, Math.max(0, (now - this.revealAt) / 2.2));
    const reveal = 1 - Math.pow(1 - p, 3);
    this.reveal = reveal;

    const px = target.width / cssW;
    const u = this.mat.uniforms;
    u.tScene.value = sceneTex;
    u.uRes.value.set(target.width, target.height);
    u.uBox.value.set(left * px, (cssH - top - c.h) * px, c.w * px, c.h * px);
    u.uCss.value = px;
    u.uR.value = c.r;
    u.uGrow.value = (1 - reveal) * (c.deep + 1);
    u.uLift.value = 0.15 + 0.85 * reveal;
    u.uShadowUv.value = (c.r * 0.55) / c.h;
    u.uDim.value = dim;
    const t = gfx.touch;
    u.uLight.value.set(t.screen.x * target.width, t.screen.y * target.height + 140 * px, 300 * px);
    u.uLightAmt.value = scene.reducedMotion ? 0.35 : t.lightAmt;

    const autoClear = gl.autoClear;
    gl.autoClear = false;
    gl.setRenderTarget(target);
    gl.render(this.scene, this.cam);
    gl.autoClear = autoClear;
    if (!this.shown) {
      this.shown = true;
      el.setAttribute("data-sculpted", "");
    }
  }

  dispose() {
    this.ro?.disconnect();
    if (typeof document !== "undefined") document.fonts.removeEventListener("loadingdone", this.onFonts);
    this.el?.removeAttribute("data-sculpted");
    this.cast?.tex.dispose();
    this.mat.dispose();
    this.glow.dispose();
  }
}
