/** Shared GLSL chunks (three.js ShaderMaterial, WebGL2 / GLSL ES 3.0 via three's prefixes). */

export const NOISE = /* glsl */ `
vec3 hash3(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
  return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
}
float gnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(dot(hash3(i + vec3(0,0,0)), f - vec3(0,0,0)), dot(hash3(i + vec3(1,0,0)), f - vec3(1,0,0)), u.x),
                 mix(dot(hash3(i + vec3(0,1,0)), f - vec3(0,1,0)), dot(hash3(i + vec3(1,1,0)), f - vec3(1,1,0)), u.x), u.y),
             mix(mix(dot(hash3(i + vec3(0,0,1)), f - vec3(0,0,1)), dot(hash3(i + vec3(1,0,1)), f - vec3(1,0,1)), u.x),
                 mix(dot(hash3(i + vec3(0,1,1)), f - vec3(0,1,1)), dot(hash3(i + vec3(1,1,1)), f - vec3(1,1,1)), u.x), u.y), u.z);
}
float fbm(vec3 p) {
  float a = 0.5;
  float s = 0.0;
  for (int i = 0; i < 4; i++) {
    s += a * gnoise(p);
    p = p * 2.03 + vec3(1.7, 9.2, 3.1);
    a *= 0.5;
  }
  return s;
}
`;

/** Gene radii, morphing A -> B, sampled by periodic Catmull-Rom (mirror of lib/shape.ts). */
export const RADIUS = /* glsl */ `
uniform float uRadA[32];
uniform float uRadB[32];
uniform float uMorph;
float rAt(int i) { return mix(uRadA[i], uRadB[i], uMorph); }
float radiusAt(float phi) {
  float x = fract(phi / 6.28318530718) * 32.0;
  int i = int(floor(x));
  float t = x - float(i);
  float p0 = rAt((i + 31) % 32);
  float p1 = rAt(i % 32);
  float p2 = rAt((i + 1) % 32);
  float p3 = rAt((i + 2) % 32);
  float t2 = t * t;
  float t3 = t2 * t;
  return 0.5 * (2.0 * p1 + (-p0 + p2) * t + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2 + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t3);
}
`;

export const SHIELD_VERT = /* glsl */ `
${NOISE}
${RADIUS}
uniform float uTime;
uniform float uBreath;
uniform float uScale;
uniform vec4 uRipples[12];
uniform float uAgit[32];
attribute vec2 aPolar;
varying vec2 vPolar;
varying vec3 vPos;
varying float vRipple;
varying float vAgit;
varying float vR;

void main() {
  float r = aPolar.x;
  float phi = aPolar.y;
  float R = radiusAt(phi);
  float breath = 1.0 + uBreath * sin(uTime * 6.28318530718 / 4.0);
  vec2 dir = vec2(sin(phi), cos(phi));
  vec2 p2 = dir * r;

  float rip = 0.0;
  for (int k = 0; k < 12; k++) {
    vec4 q = uRipples[k];
    float age = uTime - q.y;
    if (q.z <= 0.0 || age < 0.0 || age > 3.0) continue;
    vec2 src = vec2(sin(q.x), cos(q.x)) * q.w;
    float d = distance(p2, src);
    float front = age * 0.95;
    float wave = sin(d * 22.0 - age * 16.0) * exp(-age * 1.4) * exp(-pow(d - front, 2.0) * 9.0);
    rip += wave * q.z;
  }

  float agit = uAgit[int(floor(fract(phi / 6.28318530718) * 32.0)) % 32];
  float n = fbm(vec3(p2 * 2.4, uTime * 0.06)) * (0.035 + agit * 0.11) * smoothstep(1.0, 0.6, r);
  float dome = sqrt(max(0.0, 1.0 - r * r)) * 0.32;
  vec3 pos = vec3(p2 * R * breath, dome + n + rip * 0.07) * uScale;

  vPolar = aPolar;
  vRipple = rip;
  vAgit = agit;
  vR = R;
  vec4 wp = modelMatrix * vec4(pos, 1.0);
  vPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const SHIELD_FRAG = /* glsl */ `
${NOISE}
uniform float uTime;
uniform float uFlash;
uniform float uFlashAngle;
uniform float uLive;
uniform vec3 uBone;
uniform vec3 uCold;
uniform vec3 uHot;
uniform float uDim;
varying vec2 vPolar;
varying vec3 vPos;
varying float vRipple;
varying float vAgit;
varying float vR;

void main() {
  float r = vPolar.x;
  float phi = vPolar.y;
  vec3 dx = dFdx(vPos);
  vec3 dy = dFdy(vPos);
  vec3 N = normalize(cross(dx, dy));
  vec3 V = normalize(cameraPosition - vPos);
  if (dot(N, V) < 0.0) N = -N;
  vec3 L = normalize(vec3(-0.45, 0.75, 0.55));

  // wrap diffuse + fresnel + back-scatter: a membrane lit from inside, not a glossy plate
  float wrap = 0.5;
  float diff = clamp((dot(N, L) + wrap) / (1.0 + wrap), 0.0, 1.0);
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  float fres = pow(1.0 - ndv, 3.0);
  float thin = smoothstep(0.55, 1.0, r);
  float sss = pow(clamp(dot(V, -L) * 0.5 + 0.5, 0.0, 1.0), 2.0) * thin;

  // cytoplasm: cellular veins whose density follows the genome's agitation
  vec2 p = vec2(sin(phi), cos(phi)) * r;
  float cell = fbm(vec3(p * (3.2 + vAgit * 2.5), uTime * 0.035));
  float veins = smoothstep(0.035, 0.0, abs(cell)) * (0.35 + vAgit);
  float nucleus = smoothstep(0.32, 0.0, r) * 0.08;

  vec3 col = uBone * (0.018 + 0.07 * diff * (1.0 - thin));
  col += uBone * veins * 0.075 * (1.0 - thin * 0.6);
  col += uBone * nucleus;
  col += uBone * fres * 0.5;
  col += uCold * sss * 0.22;
  col += uBone * pow(r, 14.0) * 0.85;

  // 32 gene sectors, faint radial hairlines
  float sector = fract(phi / 6.28318530718 * 32.0);
  float hair = 1.0 - smoothstep(0.0, 0.02, min(sector, 1.0 - sector));
  col += uBone * hair * 0.05 * smoothstep(0.35, 1.0, r);

  // ripples: every scored tx disturbs the membrane
  col += uCold * clamp(vRipple, 0.0, 1.0) * 0.4;
  col += uBone * clamp(-vRipple, 0.0, 1.0) * 0.08;

  // live: a cold heartbeat at the rim
  col += uCold * uLive * pow(r, 18.0) * 0.35;

  // REFUSED: the only place the hot accent appears
  float da = abs(mod(phi - uFlashAngle + 3.14159265, 6.28318530718) - 3.14159265);
  float hit = uFlash * (0.22 + 0.78 * exp(-da * 2.2)) * (0.35 + 0.65 * r);
  col = mix(col, uHot * (0.65 + 0.6 * fres), clamp(hit, 0.0, 1.0));

  col *= 1.0 - uDim * 0.65;
  gl_FragColor = vec4(col, 1.0);
}
`;

/** Annulus around the rim: halo, refusal shockwave, attack-lab predictions. */
export const HALO_VERT = /* glsl */ `
${RADIUS}
uniform float uTime;
uniform float uBreath;
uniform float uScale;
attribute vec2 aPolar;
varying vec2 vPolar;
void main() {
  float phi = aPolar.y;
  float R = radiusAt(phi) * (1.0 + uBreath * sin(uTime * 6.28318530718 / 4.0));
  float rr = R * (1.0 + aPolar.x * 0.9);
  vPolar = aPolar;
  vec3 pos = vec3(vec2(sin(phi), cos(phi)) * rr, 0.0) * uScale;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}
`;

export const HALO_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uBone;
uniform vec3 uCold;
uniform vec3 uHot;
uniform vec4 uShocks[4];
uniform float uLab[8];
uniform float uLabRefused[8];
uniform float uLabCount;
uniform float uDim;
uniform float uIntro;
varying vec2 vPolar;
void main() {
  float x = vPolar.x;          // 0 at rim -> 1 outward
  float phi = vPolar.y;
  float a = 0.0;
  vec3 col = vec3(0.0);

  // soft halo
  float halo = exp(-x * 9.0) * 0.22;
  col += uBone * halo;
  a += halo;

  // refusal shockwaves
  for (int k = 0; k < 4; k++) {
    vec4 s = uShocks[k];
    float age = uTime - s.x;
    if (s.y <= 0.0 || age < 0.0 || age > 1.4) continue;
    float front = age / 1.4;
    float band = exp(-pow((x - front) * 14.0, 2.0)) * (1.0 - front) * s.y;
    float da = abs(mod(phi - s.z + 3.14159265, 6.28318530718) - 3.14159265);
    band *= 0.45 + 0.55 * exp(-da * 1.2);
    col += uHot * band * 1.4;
    a += band;
  }

  // attack-lab predictions: step k owns a 1/8 arc; its length = predicted score / threshold
  if (uLabCount > 0.0) {
    float arc = fract(phi / 6.28318530718) * 8.0;
    int k = int(floor(arc));
    float local = fract(arc);
    if (float(k) < uLabCount && local > 0.08 && local < 0.92) {
      float reach = clamp(uLab[k], 0.0, 2.0) * 0.32;
      float on = step(0.05, x) * step(x, 0.05 + reach) * (1.0 - smoothstep(0.7, 1.0, abs(local - 0.5) * 2.0));
      vec3 c = uLabRefused[k] > 0.5 ? uHot : uCold;
      col += c * on * 0.9;
      a += on * 0.9;
      // threshold tick
      float tick = smoothstep(0.006, 0.0, abs(x - (0.05 + 0.32))) * 0.6;
      col += uBone * tick;
      a += tick;
    }
  }

  col *= (1.0 - uDim * 0.6) * uIntro;
  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0) * uIntro);
}
`;
