/**
 * GPU stable fluids (Stam 1999) on render targets: the ink that floods the Red Queen's board.
 * Formulation after Pavel Dobryakov's WebGL-Fluid-Simulation (MIT): curl → vorticity confinement →
 * divergence → Jacobi pressure → gradient subtraction → semi-Lagrangian advection of velocity and dye.
 *
 * Nothing in it is decoration: velocity and dye are injected only by chain events (attack jets, refusals,
 * drains, deposits, installs), the visitor's cursor, and scroll velocity.
 */
import * as THREE from "three";

const VERT = /* glsl */ `
  varying vec2 vUv; varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB;
  uniform vec2 texelSize;
  void main() {
    vUv = uv;
    vL = vUv - vec2(texelSize.x, 0.0);
    vR = vUv + vec2(texelSize.x, 0.0);
    vT = vUv + vec2(0.0, texelSize.y);
    vB = vUv - vec2(0.0, texelSize.y);
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }`;

const HEAD = /* glsl */ `
  precision highp float;
  varying vec2 vUv; varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB;
`;

const SPLAT = HEAD + /* glsl */ `
  uniform sampler2D uTarget; uniform vec3 color; uniform vec2 point; uniform float radius;
  void main() {
    vec2 p = vUv - point;
    vec3 s = exp(-dot(p, p) / radius) * color;
    gl_FragColor = vec4(texture2D(uTarget, vUv).xyz + s, 1.0);
  }`;

const ADVECT = HEAD + /* glsl */ `
  uniform sampler2D uVelocity; uniform sampler2D uSource; uniform vec2 texelSize; uniform float dt; uniform float dissipation; uniform float chroma;
  void main() {
    vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
    vec4 c = texture2D(uSource, coord);
    // coloured ink (red refusals, cold deposits) fades faster than neutral ink: red stays an event.
    // Neutral ink also fades faster the denser it is, so the same attack lines struck all evening
    // settle to a soft grey instead of building up into a white flood.
    float n = min(c.r, min(c.g, c.b));
    vec3 neutral = vec3(n) / (1.0 + (dissipation + chroma * 3.0 * n * n) * dt);
    vec3 tint = (c.rgb - n) / (1.0 + (dissipation + chroma) * dt);
    gl_FragColor = vec4(neutral + tint, c.a / (1.0 + dissipation * dt));
  }`;

const DIVERGENCE = HEAD + /* glsl */ `
  uniform sampler2D uVelocity;
  void main() {
    float L = texture2D(uVelocity, vL).x;
    float R = texture2D(uVelocity, vR).x;
    float T = texture2D(uVelocity, vT).y;
    float B = texture2D(uVelocity, vB).y;
    vec2 C = texture2D(uVelocity, vUv).xy;
    if (vL.x < 0.0) L = -C.x;
    if (vR.x > 1.0) R = -C.x;
    if (vT.y > 1.0) T = -C.y;
    if (vB.y < 0.0) B = -C.y;
    gl_FragColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
  }`;

const CURL = HEAD + /* glsl */ `
  uniform sampler2D uVelocity;
  void main() {
    float L = texture2D(uVelocity, vL).y;
    float R = texture2D(uVelocity, vR).y;
    float T = texture2D(uVelocity, vT).x;
    float B = texture2D(uVelocity, vB).x;
    gl_FragColor = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
  }`;

const VORTICITY = HEAD + /* glsl */ `
  uniform sampler2D uVelocity; uniform sampler2D uCurl; uniform float curl; uniform float dt;
  void main() {
    float L = texture2D(uCurl, vL).x;
    float R = texture2D(uCurl, vR).x;
    float T = texture2D(uCurl, vT).x;
    float B = texture2D(uCurl, vB).x;
    float C = texture2D(uCurl, vUv).x;
    vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
    force /= length(force) + 0.0001;
    force *= curl * C;
    force.y *= -1.0;
    vec2 v = texture2D(uVelocity, vUv).xy + force * dt;
    gl_FragColor = vec4(clamp(v, -1000.0, 1000.0), 0.0, 1.0);
  }`;

const PRESSURE = HEAD + /* glsl */ `
  uniform sampler2D uPressure; uniform sampler2D uDivergence;
  void main() {
    float L = texture2D(uPressure, vL).x;
    float R = texture2D(uPressure, vR).x;
    float T = texture2D(uPressure, vT).x;
    float B = texture2D(uPressure, vB).x;
    float d = texture2D(uDivergence, vUv).x;
    gl_FragColor = vec4((L + R + B + T - d) * 0.25, 0.0, 0.0, 1.0);
  }`;

const GRADIENT = HEAD + /* glsl */ `
  uniform sampler2D uPressure; uniform sampler2D uVelocity;
  void main() {
    float L = texture2D(uPressure, vL).x;
    float R = texture2D(uPressure, vR).x;
    float T = texture2D(uPressure, vT).x;
    float B = texture2D(uPressure, vB).x;
    vec2 v = texture2D(uVelocity, vUv).xy - vec2(R - L, T - B);
    gl_FragColor = vec4(v, 0.0, 1.0);
  }`;

const SCALE = HEAD + /* glsl */ `
  uniform sampler2D uTexture; uniform float value;
  void main() { gl_FragColor = value * texture2D(uTexture, vUv); }`;

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

class Double {
  read: THREE.WebGLRenderTarget;
  write: THREE.WebGLRenderTarget;
  constructor(public size: number) {
    this.read = target(size);
    this.write = target(size);
  }
  swap() {
    const t = this.read;
    this.read = this.write;
    this.write = t;
  }
  dispose() {
    this.read.dispose();
    this.write.dispose();
  }
}

export interface FluidOptions {
  sim?: number;
  dye?: number;
  pressureIterations?: number;
  curl?: number;
  velocityDissipation?: number;
  dyeDissipation?: number;
}

export class Fluid {
  readonly velocity: Double;
  readonly dye: Double;
  private pressure: Double;
  private divergence: THREE.WebGLRenderTarget;
  private curlRT: THREE.WebGLRenderTarget;
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad: THREE.Mesh;
  private mats: Record<string, THREE.ShaderMaterial> = {};
  private simTexel: THREE.Vector2;
  private dyeTexel: THREE.Vector2;
  opts: Required<FluidOptions>;

  constructor(private gl: THREE.WebGLRenderer, o: FluidOptions = {}) {
    this.opts = {
      sim: o.sim ?? 128,
      dye: o.dye ?? 512,
      pressureIterations: o.pressureIterations ?? 20,
      curl: o.curl ?? 22,
      velocityDissipation: o.velocityDissipation ?? 0.35,
      dyeDissipation: o.dyeDissipation ?? 0.38,
    };
    this.velocity = new Double(this.opts.sim);
    this.pressure = new Double(this.opts.sim);
    this.dye = new Double(this.opts.dye);
    this.divergence = target(this.opts.sim);
    this.curlRT = target(this.opts.sim);
    this.simTexel = new THREE.Vector2(1 / this.opts.sim, 1 / this.opts.sim);
    this.dyeTexel = new THREE.Vector2(1 / this.opts.dye, 1 / this.opts.dye);
    const mk = (frag: string, uniforms: Record<string, THREE.IUniform>) =>
      new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: frag, uniforms: { texelSize: { value: this.simTexel }, ...uniforms }, depthTest: false, depthWrite: false });
    this.mats.splat = mk(SPLAT, { uTarget: { value: null }, color: { value: new THREE.Vector3() }, point: { value: new THREE.Vector2() }, radius: { value: 0.001 } });
    this.mats.advect = mk(ADVECT, { uVelocity: { value: null }, uSource: { value: null }, dt: { value: 0 }, dissipation: { value: 0 }, chroma: { value: 0 } });
    this.mats.divergence = mk(DIVERGENCE, { uVelocity: { value: null } });
    this.mats.curl = mk(CURL, { uVelocity: { value: null } });
    this.mats.vorticity = mk(VORTICITY, { uVelocity: { value: null }, uCurl: { value: null }, curl: { value: 0 }, dt: { value: 0 } });
    this.mats.pressure = mk(PRESSURE, { uPressure: { value: null }, uDivergence: { value: null } });
    this.mats.gradient = mk(GRADIENT, { uPressure: { value: null }, uVelocity: { value: null } });
    this.mats.scale = mk(SCALE, { uTexture: { value: null }, value: { value: 1 } });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mats.splat);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
    // start from a clean field
    for (const t of [this.velocity.read, this.velocity.write, this.dye.read, this.dye.write, this.pressure.read, this.pressure.write]) {
      this.gl.setRenderTarget(t);
      this.gl.clear(true, false, false);
    }
    this.gl.setRenderTarget(null);
  }

  private pass(mat: THREE.ShaderMaterial, out: THREE.WebGLRenderTarget) {
    this.quad.material = mat;
    this.gl.setRenderTarget(out);
    this.gl.render(this.scene, this.cam);
  }

  /** Add velocity (texels/s of the sim grid) and dye at uv point (0..1). radius in uv units. */
  splat(x: number, y: number, dx: number, dy: number, color: [number, number, number], radius = 0.012) {
    const m = this.mats.splat;
    m.uniforms.point.value.set(x, y);
    m.uniforms.radius.value = radius * radius;
    m.uniforms.uTarget.value = this.velocity.read.texture;
    m.uniforms.color.value.set(dx, dy, 0);
    m.uniforms.texelSize.value = this.simTexel;
    this.pass(m, this.velocity.write);
    this.velocity.swap();
    if (color[0] + color[1] + color[2] > 0) {
      m.uniforms.uTarget.value = this.dye.read.texture;
      m.uniforms.color.value.set(color[0], color[1], color[2]);
      m.uniforms.texelSize.value = this.dyeTexel;
      this.pass(m, this.dye.write);
      this.dye.swap();
    }
  }

  step(dtIn: number) {
    const dt = Math.min(dtIn, 1 / 30);
    const o = this.opts;
    const m = this.mats;
    m.curl.uniforms.uVelocity.value = this.velocity.read.texture;
    this.pass(m.curl, this.curlRT);

    m.vorticity.uniforms.uVelocity.value = this.velocity.read.texture;
    m.vorticity.uniforms.uCurl.value = this.curlRT.texture;
    m.vorticity.uniforms.curl.value = o.curl;
    m.vorticity.uniforms.dt.value = dt;
    this.pass(m.vorticity, this.velocity.write);
    this.velocity.swap();

    m.divergence.uniforms.uVelocity.value = this.velocity.read.texture;
    this.pass(m.divergence, this.divergence);

    m.scale.uniforms.uTexture.value = this.pressure.read.texture;
    m.scale.uniforms.value.value = 0.8;
    this.pass(m.scale, this.pressure.write);
    this.pressure.swap();

    m.pressure.uniforms.uDivergence.value = this.divergence.texture;
    for (let i = 0; i < o.pressureIterations; i++) {
      m.pressure.uniforms.uPressure.value = this.pressure.read.texture;
      this.pass(m.pressure, this.pressure.write);
      this.pressure.swap();
    }

    m.gradient.uniforms.uPressure.value = this.pressure.read.texture;
    m.gradient.uniforms.uVelocity.value = this.velocity.read.texture;
    this.pass(m.gradient, this.velocity.write);
    this.velocity.swap();

    m.advect.uniforms.texelSize.value = this.simTexel;
    m.advect.uniforms.dt.value = dt;
    m.advect.uniforms.uVelocity.value = this.velocity.read.texture;
    m.advect.uniforms.uSource.value = this.velocity.read.texture;
    m.advect.uniforms.dissipation.value = o.velocityDissipation;
    m.advect.uniforms.chroma.value = 0;
    this.pass(m.advect, this.velocity.write);
    this.velocity.swap();

    m.advect.uniforms.uVelocity.value = this.velocity.read.texture;
    m.advect.uniforms.uSource.value = this.dye.read.texture;
    m.advect.uniforms.dissipation.value = o.dyeDissipation;
    m.advect.uniforms.chroma.value = 0.55;
    this.pass(m.advect, this.dye.write);
    this.dye.swap();
  }

  dispose() {
    this.velocity.dispose();
    this.dye.dispose();
    this.pressure.dispose();
    this.divergence.dispose();
    this.curlRT.dispose();
    Object.values(this.mats).forEach((m) => m.dispose());
  }
}
