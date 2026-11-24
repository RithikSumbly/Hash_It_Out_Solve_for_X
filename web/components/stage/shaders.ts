/** GLSL for the Red Queen stage. Colours arrive as uniforms from the brand tokens. */

/**
 * A product photographer's studio for glass on black: tall strip softboxes with crisp sides (they draw the
 * long highlights down a turned piece), an overhead box for the collars, and a faint cyclorama with a horizon.
 * Shared by the glass, the far wall seen through it, and the quicksilver.
 */
export const ENV = /* glsl */ `
float angDiff(float a, float b) { return abs(mod(a - b + 3.14159265, 6.28318531) - 3.14159265); }
float softbox(float az, float y, float a0, float hw, float y0, float y1) {
  float d = angDiff(az, a0);
  float across = smoothstep(hw, hw * 0.68, d) * (0.78 + 0.22 * smoothstep(hw * 0.68, 0.0, d));
  float along = smoothstep(y0 - 0.05, y0 + 0.05, y) * smoothstep(y1 + 0.05, y1 - 0.05, y);
  return across * along;
}
vec3 studio(vec3 r) {
  float az = atan(r.x, r.z);
  float y = r.y;
  vec3 c = vec3(1.0, 0.955, 0.9) * softbox(az, y, -1.0, 0.11, -0.3, 0.82) * 6.0;   // key strip, front-left
  c += vec3(0.8, 0.9, 1.0) * softbox(az, y, 2.3, 0.065, -0.25, 0.88) * 7.0;          // rim strip, back-right
  c += vec3(0.95, 0.95, 0.96) * softbox(az, y, -2.35, 0.05, -0.15, 0.72) * 4.5;     // kicker, back-left
  c += vec3(0.9, 0.92, 0.95) * softbox(az, y, 0.95, 0.28, -0.2, 0.62) * 0.5;        // fill, front-right
  c += vec3(0.92, 0.93, 0.95) * smoothstep(0.8, 0.93, y) * 1.6;                     // overhead
  c += vec3(0.028, 0.029, 0.032) * smoothstep(-0.03, 0.1, y) * (1.0 - smoothstep(0.45, 0.85, y));
  c += vec3(0.006) * (1.0 - smoothstep(-0.6, -0.02, y));
  return c;
}
`;

/**
 * The looking-glass country, after Carroll: "the country was divided up into squares by a number of tiny
 * little brooks running straight across it". Shared by the sky, the fields and the distant pieces, so the
 * mist they fade into is the same colour everywhere. Values are display-referred (the post pass applies no
 * gamma), so they are set by eye against the page.
 */
export const WORLD = /* glsl */ `
uniform vec3 uMoon;
uniform float uMoonSize;
uniform vec3 uMoonTint;
uniform float uMoonGlow;
uniform vec3 uIvory;
uniform vec3 uCold;
vec3 moonColour() { return uMoonTint; }
// the mist low on the horizon: cold grey everywhere, warming toward the moon
vec3 mist(vec3 d) {
  vec2 h = normalize(d.xz + 1e-5);
  float m = max(dot(h, normalize(uMoon.xz)), 0.0);
  return mix(vec3(0.042, 0.049, 0.062), moonColour() * 0.13, pow(m, 6.0));
}
vec3 haze(vec3 d) { return mix(vec3(0.005, 0.006, 0.009), mist(d), exp(-max(d.y, 0.0) * 6.5)); }
vec3 skyAt(vec3 d) {
  vec3 c = haze(d);
  float a = acos(clamp(dot(d, uMoon), -1.0, 1.0));
  // a small moon with a faint face (soft maria), a glow round it and a wide halo in the mist
  vec3 mt = normalize(cross(uMoon, vec3(0.0, 1.0, 0.0)));
  vec3 mb = cross(mt, uMoon);
  vec2 mp = vec2(dot(d, mt), dot(d, mb)) / uMoonSize;
  float face = 0.82 + 0.18 * sin(mp.x * 3.1 + 1.3) * sin(mp.y * 2.6 - 0.4) - 0.12 * exp(-dot(mp - vec2(0.3, 0.2), mp - vec2(0.3, 0.2)) * 3.0);
  float disc = smoothstep(uMoonSize * 1.04, uMoonSize * 0.92, a);
  c += moonColour() * (disc * 0.5 * face + (exp(-a * 0.62 / uMoonSize) * 0.07 + exp(-a * 4.0) * 0.025) * uMoonGlow);
  // a few faint stars, high enough to stay clear of the mist
  vec3 q = d * 150.0;
  vec3 cell = floor(q);
  float h = fract(sin(dot(cell, vec3(127.1, 311.7, 74.7))) * 43758.5453);
  float star = step(0.9962, h) * smoothstep(0.3, 0.0, length(fract(q) - 0.5)) * smoothstep(0.1, 0.45, d.y);
  return c + vec3(0.86, 0.89, 0.96) * star * (0.25 + 0.3 * fract(h * 91.0));
}
`;

export const BOARD_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vW;
void main() {
  vUv = uv;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

export const BOARD_FRAG = /* glsl */ `
uniform sampler2D tDye;
uniform sampler2D tVel;
uniform sampler2D tReflect;
uniform vec2 uRes;
uniform float uTime;
uniform vec4 uShocks[4];
uniform float uDim;
uniform float uReflect;
uniform float uDyeTexel;
uniform vec3 uIvory;
uniform vec3 uHot;
uniform vec4 uMask;
uniform float uMaskAmt;
uniform vec3 uLamp;
uniform float uCore;
uniform vec3 uCold;
uniform sampler2D tRipple;
uniform float uRippleTexel;
uniform float uWater;
uniform vec3 uMoon;
varying vec2 vUv;
varying vec3 vW;

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

void main() {
  vec3 dye = texture2D(tDye, vUv).rgb;
  float h = luma(dye);
  float e = uDyeTexel * 1.5;
  float hx = luma(texture2D(tDye, vUv + vec2(e, 0.0)).rgb) - luma(texture2D(tDye, vUv - vec2(e, 0.0)).rgb);
  float hz = luma(texture2D(tDye, vUv + vec2(0.0, e)).rgb) - luma(texture2D(tDye, vUv - vec2(0.0, e)).rgb);

  // the film of water: its slope (world units) and curvature from the ripple height field
  float rt = uRippleTexel;
  float r0 = texture2D(tRipple, vUv).r;
  float rR = texture2D(tRipple, vUv + vec2(rt, 0.0)).r;
  float rL = texture2D(tRipple, vUv - vec2(rt, 0.0)).r;
  float rU = texture2D(tRipple, vUv + vec2(0.0, rt)).r;
  float rD = texture2D(tRipple, vUv - vec2(0.0, rt)).r;
  // +u is +x; +v is -z
  vec2 slope = vec2(rR - rL, -(rU - rD)) * uWater;
  float curv = (rR + rL + rU + rD - 4.0 * r0) * uWater;
  vec3 Nw = normalize(vec3(-slope.x * 7.0, 1.0, -slope.y * 7.0));
  vec3 N = normalize(vec3(-hx * 5.0 - slope.x * 7.0, 1.0, hz * 5.0 - slope.y * 7.0));
  vec3 V = normalize(cameraPosition - vW);

  // the looking-glass: the queen's reflection, rippled by the ink's relief, its flow and the water
  vec2 suv = gl_FragCoord.xy / uRes;
  vec2 flow = texture2D(tVel, vUv).xy;
  suv += vec2(N.x, -N.z) * 0.05 + flow * 0.00006 + vec2(Nw.x, -Nw.z) * 0.06;
  vec3 refl = texture2D(tReflect, suv).rgb;
  float fres = 0.22 + 0.78 * pow(1.0 - max(dot(N, V), 0.0), 4.0);

  // ebony and ivory squares at a whisper of contrast, seen through the water (bent by its slope)
  vec2 sq = (vW.xz + vec2(Nw.x, Nw.z) * 0.22) / 1.1 + 0.5;
  float checker = mod(floor(sq.x) + floor(sq.y), 2.0);
  vec2 f = abs(fract(sq) - 0.5);
  float line = smoothstep(0.492, 0.5, max(f.x, f.y));
  vec3 base = mix(vec3(0.010, 0.011, 0.013), vec3(0.026, 0.025, 0.024), checker) + uIvory * line * 0.016;

  // neutral ink (attack jets, drains) stays a soft grey however dense it gets; colour (red refusals,
  // cold deposits) keeps its full strength so a refusal always reads
  float inkN = min(dye.r, min(dye.g, dye.b));
  vec3 inkc = vec3(0.42 * (1.0 - exp(-inkN * 1.8))) + (1.0 - exp(-(dye - inkN) * 2.2));
  vec3 L = normalize(vec3(-0.35, 1.0, 0.5));
  float spec = pow(max(dot(reflect(-L, N), V), 0.0), 48.0) * smoothstep(0.0, 0.04, h);

  // legibility zone: ink and reflection recede behind the chapter's text
  vec2 sp = gl_FragCoord.xy / uRes;
  float inMask = smoothstep(uMask.x - 0.08, uMask.x + 0.04, sp.x) * (1.0 - smoothstep(uMask.z - 0.04, uMask.z + 0.08, sp.x))
               * smoothstep(uMask.y - 0.08, uMask.y + 0.04, sp.y) * (1.0 - smoothstep(uMask.w - 0.04, uMask.w + 0.08, sp.y));
  float keep = 1.0 - inMask * uMaskAmt * 0.78;
  // the cursor's lamp: a pool of light where you point; the squares surface and the ink glows in it
  float ld = length(vW.xz - uLamp.xy);
  float lamp = uLamp.z * exp(-ld * ld * 0.55);
  float lampSpec = pow(max(dot(reflect(-normalize(vec3(uLamp.x, 2.4, uLamp.y) - vW), N), V), 0.0), 36.0);
  // light through the water gathers where the ripples converge: caustics on the squares under the lamp
  float caust = clamp(-curv * 26.0, -0.6, 1.6);
  vec3 col = base * (1.0 + lamp * 5.0) * (1.0 + caust * (0.35 + lamp * 1.2)) + (refl * fres * uReflect + inkc * (1.0 + lamp * 1.6) + spec * uIvory * 0.5) * keep;
  col += (uIvory * 0.022 + uIvory * lampSpec * smoothstep(0.0, 0.05, h) * 0.5) * lamp;
  // glints: the lamp and the moon catch the ripple crests
  float rough = clamp(length(slope) * 40.0, 0.0, 1.0);
  float wLamp = pow(max(dot(reflect(-normalize(vec3(uLamp.x, 2.4, uLamp.y) - vW), Nw), V), 0.0), 90.0);
  float wMoon = pow(max(dot(reflect(-uMoon, Nw), V), 0.0), 140.0);
  col += uIvory * (wLamp * lamp * 0.9 + wMoon * 0.35) * rough * keep;
  // the light inside her spills through her foot onto the board: a cold pool that shrinks as the vault drains
  float fd = length(vW.xz);
  float pool = uCore * (exp(-fd * fd * 1.6) * 0.9 + exp(-fd * 2.2) * 0.25);
  col += (base * 4.0 + mix(uIvory, uCold, 0.55) * 0.05) * pool + inkc * pool * 0.6;

  // refusal shock rings travel out across the board from the point of impact
  float r = length(vW.xz);
  float az = atan(vW.x, vW.z);
  for (int k = 0; k < 4; k++) {
    vec4 s = uShocks[k];
    float age = uTime - s.x;
    if (s.y <= 0.0 || age < 0.0 || age > 1.8) continue;
    float front = 0.62 + age * 3.6;
    float band = exp(-pow((r - front) * 4.0, 2.0)) * (1.0 - age / 1.8) * s.y;
    float da = abs(mod(az - s.z + 3.14159265, 6.28318531) - 3.14159265);
    band *= 0.25 + 0.75 * exp(-da * 1.4);
    col += uHot * band * 0.5;
  }

  // she stands in a pool of light; contact shadow at her foot
  col *= 0.5 + 0.5 * smoothstep(0.4, 1.0, r);
  col += uIvory * 0.03 * exp(-r * r * 0.22);
  col *= smoothstep(12.5, 3.2, r);
  col *= 1.0 - uDim * 0.72;
  gl_FragColor = vec4(col, 1.0);
}`;

export const GLASS_VERT = /* glsl */ `
attribute float aT;
attribute float aA;
uniform float uTime;
uniform float uBreath;
uniform vec4 uRipples[8];
uniform vec3 uTouch;
uniform float uTouchAmt;
uniform float uPress;
varying vec3 vN;
varying vec3 vW;
varying vec3 vL;
varying vec3 vLN;
varying float vT;
varying float vA;
varying float vRip;
varying float vTouch;
void main() {
  float rip = 0.0;
  for (int k = 0; k < 8; k++) {
    vec4 q = uRipples[k];
    float age = uTime - q.y;
    if (q.z <= 0.0 || age < 0.0 || age > 2.4) continue;
    float da = abs(mod(aA - q.x + 3.14159265, 6.28318531) - 3.14159265);
    float d = sqrt(da * da * 0.18 + pow(aT - q.w, 2.0));
    rip += sin(d * 34.0 - age * 15.0) * exp(-age * 1.8) * exp(-pow(d - age * 0.35, 2.0) * 40.0) * q.z;
  }
  float breath = 1.0 + uBreath * sin(uTime * 6.28318531 / 4.0) * smoothstep(0.05, 0.4, aT);
  vec3 p = position;
  p.xz *= breath;
  p += normal * rip * 0.012;
  // gel: she swells softly toward the cursor, gives under a press and springs back (uPress overshoots)
  vec4 w0 = modelMatrix * vec4(p, 1.0);
  float d = distance(w0.xyz, uTouch);
  float touch = uTouchAmt * exp(-d * d / 0.045);
  p += normal * (touch * 0.03 - uPress * exp(-d * d / 0.07) * 0.055);
  vec4 w = modelMatrix * vec4(p, 1.0);
  vW = w.xyz;
  vL = p;
  vLN = normal;
  vN = normalize(mat3(modelMatrix) * normal);
  vT = aT;
  vA = aA;
  vRip = rip;
  vTouch = (uTouchAmt + max(uPress, 0.0)) * exp(-d * d / 0.09);
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

export const GLASS_FRAG = /* glsl */ `
${ENV}
${WORLD}
uniform mat4 modelMatrix;
uniform mat4 projectionMatrix;
uniform sampler2D tScene;
uniform vec2 uRes;
uniform float uTime;
uniform float uFlash;
uniform float uFlashA;
uniform float uIntro;
uniform float uBand;
uniform float uLive;
uniform float uDim;
uniform float uHit[8];
uniform float uHitP[8];
uniform float uDiff[8];
uniform float uDiffP[8];
uniform float uLab[8];
uniform vec3 uHot;
uniform vec3 uCursorL;
uniform float uCursorAmt;
uniform vec2 uCursorS;
uniform float uAspect;
uniform float uFrost;
uniform float uFill;
uniform float uCav0;
uniform float uCav1;
uniform float uStemR[12];
uniform float uCore;
varying vec3 vN;
varying vec3 vW;
varying vec3 vL;
varying vec3 vLN;
varying float vT;
varying float vA;
varying float vRip;
varying float vTouch;
uniform vec4 uStreak;
// strike her and a pulse of light runs out from the point you hit, through the glass
float streak(vec3 w) {
  float age = uTime - uStreak.w;
  if (age < 0.0 || age > 1.4) return 0.0;
  float r = age * 2.6;
  float d = distance(w, uStreak.xyz);
  float band = exp(-pow((d - r) / 0.055, 2.0));
  float wake = exp(-max(r - d, 0.0) / 0.35) * step(d, r) * 0.25;
  float f = 1.0 - age / 1.4;
  return (band + wake) * f * f;
}


const float BAND_T0 = 0.02;
const float BAND_H = 0.106875;
// the quicksilver column is a little over half the stem's width: thick clear walls round a liquid core
const float WALL = 0.38;

float stemR(float y) {
  float x = clamp((y - uCav0) / max(uCav1 - uCav0, 1e-3), 0.0, 1.0) * 11.0;
  int i = int(min(floor(x), 10.0));
  return mix(uStemR[i], uStemR[i + 1], x - float(i));
}

vec2 toScreen(vec3 local) {
  vec4 c = projectionMatrix * viewMatrix * modelMatrix * vec4(local, 1.0);
  return c.xy / c.w * 0.5 + 0.5;
}

// what the world looks like in a direction (for reflections): the night sky above, dark ground and mist below
vec3 envAt(vec3 R) {
  if (R.y >= 0.0) return skyAt(R);
  return mix(vec3(0.004, 0.0045, 0.006), mist(R), exp(R.y * 10.0));
}

/*
 * One wavelength through solid glass, in her local frame. In through the front (Snell), across the body to
 * the far wall (a cylinder of the radius at the entry height, or the sphere for the ball), out the back.
 * Returns the screen uv of what is seen, with x < -1 when the far wall reflects it back (total internal
 * reflection). A solid lens like this flips and magnifies what stands behind her: that is what reads as glass.
 */
vec2 traceUV(vec3 P, vec3 I, vec3 Nf, float ior, bool ball, out float len, out vec3 D) {
  D = refract(I, Nf, 1.0 / ior);
  vec3 Nx;
  float t;
  if (ball) {
    // P lies on the sphere, so the far root is simply -2(P.D)
    t = max(-2.0 * dot(P, D), 0.0);
    Nx = normalize(P + D * t);
  } else {
    float a = dot(D.xz, D.xz);
    t = a > 1e-5 ? max(-2.0 * dot(P.xz, D.xz) / a, 0.0) : 1e3;
    vec3 E = P + D * t;
    Nx = normalize(vec3(E.x, 0.0, E.z) + vec3(0.0, 1e-4, 0.0));
    // a ray heading down through the foot leaves by the flat base, not the side wall
    if (D.y < -1e-4) {
      float tf = (0.001 - P.y) / D.y;
      if (tf > 0.0 && tf < t) {
        t = tf;
        Nx = vec3(0.0, -1.0, 0.0);
      }
    }
    if (t > 50.0) t = 0.0;
  }
  len = t;
  vec3 E = P + D * t;
  vec3 O = refract(D, -Nx, ior);
  if (dot(O, O) < 1e-4) return vec2(-9.0);
  return toScreen(E + O * 5.0);
}

void main() {
  if (vT > uIntro) discard;
  bool ball = vT > 0.95;
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vW);
  if (!gl_FrontFacing) N = -N;
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  vec2 suv = gl_FragCoord.xy / uRes;

  // into her local frame
  mat3 Rm = mat3(modelMatrix);
  vec3 I = normalize(transpose(Rm) * -V);
  vec3 Nl = normalize(vLN);
  // cut crystal: a lattice of small four-sided pyramids (a strawberry-diamond cut) on the stem and the
  // crown cup, one diamond per facet around. Each pyramid face bends its own piece of the world and
  // catches its own glint, which is what makes cut glass sparkle as it turns.
  float cutZone = 0.0;
  float cutLine = 0.0;
  if (cutZone > 0.0) {
    float a = vA;
    float u = a / 6.28318531 * 16.0;
    float cell = 6.28318531 * max(length(vL.xz), 0.05) / 16.0;
    float v = vL.y / cell;
    float s1 = fract(u + v) - 0.5;
    float s2 = fract(u - v) - 0.5;
    vec3 Ta = vec3(cos(a), 0.0, -sin(a));
    vec3 g1 = normalize(Ta + vec3(0.0, 1.0, 0.0));
    vec3 g2 = normalize(Ta - vec3(0.0, 1.0, 0.0));
    float pick = smoothstep(-0.025, 0.025, abs(s1) - abs(s2));
    vec3 tilt = mix(g2 * sign(s2), g1 * sign(s1), pick);
    vec3 dN = tilt * 0.42 * cutZone;
    // the cut lines between diamonds carry light along them, as grooves in crystal do
    cutLine = (1.0 - smoothstep(0.0, 0.06, 0.5 - max(abs(s1), abs(s2)))) * cutZone;
    Nl = normalize(Nl + dN);
    N = normalize(N + Rm * dN * (gl_FrontFacing ? 1.0 : -1.0));
    ndv = clamp(dot(N, V), 0.0, 1.0);
  }
  if (dot(Nl, I) > 0.0) Nl = -Nl;
  float edge = 1.0 - ndv;
  float F = 0.04 + 0.96 * pow(edge, 5.0);
  vec3 nv = normalize((viewMatrix * vec4(N, 0.0)).xyz);
  vec3 P = vL;

  // three wavelengths, three slightly different lenses: the rim splits into colour
  float lenR, lenG, lenB;
  vec3 Dr, Dg, Db;
  vec2 uvR = traceUV(P, I, Nl, 1.48, ball, lenR, Dr);
  vec2 uvG = traceUV(P, I, Nl, 1.5, ball, lenG, Dg);
  vec2 uvB = traceUV(P, I, Nl, 1.52, ball, lenB, Db);
  float lod = uFrost;
  // Apple's lens: the middle passes what is behind her almost straight through; the bending (and the
  // flip of a solid body) gathers toward the rim, where the far wall also turns light back (dark band)
  // (the small finial ball is a gentler lens, or its flipped image reads as an eye)
  float bendW = ball ? smoothstep(0.4, 1.0, edge) * 0.55 : smoothstep(0.12, 0.82, edge);
  vec2 uv0 = toScreen(P + I * 5.0);
  if (uvR.x > -1.0) uvR = mix(uv0, uvR, bendW);
  if (uvG.x > -1.0) uvG = mix(uv0, uvG, bendW);
  if (uvB.x > -1.0) uvB = mix(uv0, uvB, bendW);
  if (uvG.x < -1.0 && bendW < 0.5) {
    uvR = uv0;
    uvG = uv0;
    uvB = uv0;
  }
  vec3 trans;
  vec3 tir = envAt(Rm * reflect(I, Nl)) * 0.35;
  if (uvG.x < -1.0 && ball) uvR = uvG = uvB = uv0;
  if (uvG.x < -1.0) {
    // total internal reflection: the far wall mirrors the world back, mostly dark: the thick-glass edge
    trans = tir;
  } else {
    // a channel that reflects internally while green gets through borrows green's path, so the edge of
    // a total-reflection band never splits into hard colour stripes
    trans.g = textureLod(tScene, uvG, lod).g;
    trans.r = textureLod(tScene, uvR.x < -1.0 ? uvG : uvR, lod).r;
    trans.b = textureLod(tScene, uvB.x < -1.0 ? uvG : uvB, lod).b;
  }

  // the quicksilver inside: the refracted ray meets its column (or its surface, from above)
  if (!ball && P.y > uCav0 - 0.05 && P.y < uFill + 0.6) {
    float rm = stemR(clamp(P.y, uCav0, uFill)) * WALL;
    vec3 D = Dg;
    float a = dot(D.xz, D.xz);
    float b = dot(P.xz, D.xz);
    float c = dot(P.xz, P.xz) - rm * rm;
    float disc = b * b - a * c;
    float tHit = -1.0;
    vec3 Nm = vec3(0.0);
    if (disc > 0.0 && a > 1e-5) {
      float t1 = (-b - sqrt(disc)) / a;
      vec3 M = P + D * t1;
      if (t1 > 0.0 && M.y > uCav0 && M.y < uFill) {
        tHit = t1;
        Nm = normalize(vec3(M.x, 0.0, M.z));
      }
    }
    if (tHit < 0.0 && D.y < -1e-3 && P.y > uFill) {
      float tp = (uFill - P.y) / D.y;
      vec3 M = P + D * tp;
      if (tp > 0.0 && length(M.xz) < rm) {
        tHit = tp;
        Nm = vec3(0.0, 1.0, 0.0);
      }
    }
    if (tHit > 0.0) {
      vec3 M = P + D * tHit;
      float cq = clamp(dot(-D, Nm), 0.0, 1.0);
      // the vault is a cold light inside her: a column of liquid light whose level is the balance. It is
      // brightest seen straight on and softer at its sides, with a slow drift rising through it.
      vec3 coreCol = mix(uIvory, uCold, 0.7);
      float pulse = 0.78 + 0.22 * sin(M.y * 5.0 - uTime * 1.6) * sin(M.y * 2.3 - uTime * 0.7 + 1.0);
      float depth = smoothstep(uCav0, uFill, M.y);
      // a volume of light, not a painted tube: bright along its axis, melting into the glass at its sides
      float core = pow(cq, 3.0);
      vec3 light = coreCol * (0.25 + 2.2 * core) * pulse * (0.7 + 0.4 * depth);
      trans = mix(trans, light, 0.35 + 0.6 * smoothstep(0.0, 0.6, cq));
      // its top: a soft glowing surface, not a hard cut
      float top = smoothstep(0.08, 0.0, uFill - M.y);
      trans += coreCol * top * 0.5 * (Nm.y < 0.5 ? cq : 1.0);
      lenG = tHit * 0.3;
    }
  }

  // clear glass: a faint cool absorption where the path through her is long (Beer), and what is seen
  // through her a little richer than what is around her, as Apple's material does
  trans *= exp(-lenG * vec3(0.22, 0.085, 0.03));
  float tl = dot(trans, vec3(0.2126, 0.7152, 0.0722));
  trans = max(mix(vec3(tl), trans, 1.25) * 1.05, 0.0);

  vec3 refl = envAt(reflect(-V, N));

  // the cursor is a soft light in front of her: its highlight glides as you move, and the rim on its side
  // catches it (Apple's moving specular edge)
  vec3 Lc = normalize(uCursorL - vW);
  float nh = max(dot(N, normalize(Lc + V)), 0.0);
  // liquid glass, not chrome: a soft, broad highlight rather than a pinpoint mirror flash
  float specC = (pow(nh, 110.0) * 0.75 + pow(nh, 22.0) * 0.12 + pow(nh, 6.0) * 0.025) * uCursorAmt;
  // the moon behind her lights her edges
  float back = pow(max(dot(-V, uMoon), 0.0), 3.0) * pow(edge, 2.0);
  // Apple's moving edge light: two lobes on opposite edges, the near one facing the cursor's light and a
  // weaker one opposite it (light that crossed the glass), coloured by what the glass shows, crisp at the rim
  vec2 toC = uCursorS - suv;
  toC.x *= uAspect;
  vec2 n2 = normalize(nv.xy + 1e-5);
  vec2 ldir = normalize(mix(vec2(-0.6, 0.8), normalize(toC + 1e-5), uCursorAmt));
  float g = dot(n2, ldir);
  float lobes = pow(max(g, 0.0), 2.5) + 0.6 * pow(max(-g, 0.0), 3.0);
  float rimMask = pow(edge, 4.5);
  vec3 rimCol = mix(mix(uIvory, uCold, 0.25), trans * 2.6 + 0.12, 0.35);
  // and a hairline round the whole silhouette, about two pixels at any size
  float px = fwidth(ndv);
  float hair = smoothstep(2.6 * px, 0.4 * px, ndv);

  vec3 col = trans * (1.0 - F * 0.55) + refl * F * 0.5 + rimCol * rimMask * (0.15 + 0.85 * lobes) * 0.5 + uIvory * hair * (0.08 + 0.2 * lobes)
    + vec3(1.0, 0.985, 0.96) * specC + moonColour() * back * 0.5;
  // lit from within: the vault's light fills the glass round it, strongest near its column, and pools
  // in the pedestal, which glows from its centre as cut-crystal bases do
  vec3 coreTint = mix(uIvory, uCold, 0.55);
  if (!ball) {
    float below = smoothstep(uFill + 0.35, uFill - 0.1, vL.y) * smoothstep(0.0, 0.15, vL.y);
    col += coreTint * uCore * below * (0.05 + 0.1 * (1.0 - edge));
    float ped = exp(-vL.y * 7.0) * (0.35 + 0.65 * (1.0 - edge));
    col += coreTint * uCore * ped * 0.22;
    col += coreTint * cutLine * (0.12 + 0.22 * uCore);
    col += coreTint * uCore * 0.03;
  }
  // glints: a high key light and the moon caught by single facets, a few pixels each (bloom makes stars)
  vec3 Lk = normalize(vec3(0.35, 0.9, 0.45));
  float gk = pow(max(dot(N, normalize(Lk + V)), 0.0), 300.0) * 0.9 + pow(max(dot(N, normalize(uMoon + V)), 0.0), 400.0) * 0.7;
  col += vec3(0.92, 0.97, 1.0) * gk * (0.4 + cutZone + (ball ? 1.0 : 0.0));
  // where you touch her, she lights from inside
  col += mix(uIvory, uCold, 0.3) * vTouch * 0.26;
  col += uCold * uLive * smoothstep(0.84, 0.92, vT) * pow(edge, 2.0) * 0.22;
  col += uIvory * clamp(vRip, 0.0, 1.0) * 0.22;

  // which feature band / crown point this fragment belongs to
  float bf = (vT - BAND_T0) / BAND_H;
  int band = int(clamp(floor(bf), 0.0, 7.0));
  bool inBody = false; // the features live in the ribbons now
  bool inCrown = false; // the crown is its own hollow piece (RIBBON_FRAG with CROWN)
  float ax = fract(vA / 6.28318531) * 8.0;
  int pt = int(mod(floor(ax + 0.5), 8.0));

  // a new policy: every changed gene glows cold for a moment
  if (inBody) col += uCold * uDiff[band] * 0.22;
  if (inCrown) col += uCold * uDiffP[pt] * 0.3 * smoothstep(0.83, 0.86, vT);

  // attack lab / your turn: step i's predicted verdict tints crown point i (1 pays, 2 refused, 3 held: brass)
  if (inCrown && uLab[pt] > 0.5) {
    vec3 tint = uLab[pt] > 2.5 ? vec3(0.84, 0.71, 0.49) : uLab[pt] > 1.5 ? uHot : uCold;
    col = mix(col, tint * (0.7 + F), 0.45 * smoothstep(0.83, 0.86, vT));
  }

  // inspector: light one band
  if (uBand >= 0.0 && inBody) {
    float on = float(band) == uBand ? 1.0 : 0.0;
    col = mix(col * 0.55, col + uCold * 0.1, on);
  }

  // REFUSED, and why: only the bands and crown points named by the reason bits, centred on the impact
  float da = abs(mod(vA - uFlashA + 3.14159265, 6.28318531) - 3.14159265);
  float near = exp(-da * da * 0.9);
  float why = 0.0;
  if (inBody) why = uHit[band];
  if (inCrown) why = max(why, uHitP[pt] * smoothstep(0.82, 0.86, vT));
  float hit = uFlash * why * (0.35 + 0.65 * near);
  col = mix(col, uHot * (0.85 + F), clamp(hit * 1.4, 0.0, 1.0));
  col += uHot * uFlash * F * 0.35 * near;

  col += uIvory * smoothstep(0.012, 0.0, abs(vT - uIntro)) * step(uIntro, 0.999) * 2.0;
  col *= 1.0 - uDim * 0.55;
  col += vec3(0.9, 0.97, 1.0) * streak(vW) * 1.0;
  gl_FragColor = vec4(col, 1.0);
}`;

export const RIBBON_VERT = /* glsl */ `
attribute float aT;
attribute float aK;
attribute float aU;
attribute float aA;
varying vec3 vN;
varying vec3 vW;
varying float vT;
varying float vK;
varying float vU;
varying float vA;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  vT = aT;
  vK = aK;
  vU = aU;
  vA = aA;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

/*
 * Her ribbons are thin glass: almost clear face-on, gathering light where we look along them (Fresnel),
 * carrying the night sky in their reflection, a crisp highlight that follows the cursor, and a little of the
 * vault's light. Drawn premultiplied over whatever is behind (her body, the board, the other ribbons), split
 * into a far half (refracted by her body) and a near half (laid over it). Each ribbon is one feature: a new
 * policy lights the ribbons it changed, and a refusal lights the ribbons its reason bits name.
 */
export const RIBBON_FRAG = /* glsl */ `
${ENV}
${WORLD}
uniform float uSide;
uniform vec3 uCenter;
uniform float uIntro;
uniform float uDim;
uniform float uFlash;
uniform float uHit[8];
uniform float uDiff[8];
uniform float uBand;
uniform vec3 uHot;
uniform vec3 uCursorL;
uniform float uCursorAmt;
uniform float uCore;
uniform float uTime;
uniform vec4 uStreak;
// strike her and a pulse of light runs out from the point you hit, through the glass
float streak(vec3 w) {
  float age = uTime - uStreak.w;
  if (age < 0.0 || age > 1.4) return 0.0;
  float r = age * 2.6;
  float d = distance(w, uStreak.xyz);
  float band = exp(-pow((d - r) / 0.055, 2.0));
  float wake = exp(-max(r - d, 0.0) / 0.35) * step(d, r) * 0.25;
  float f = 1.0 - age / 1.4;
  return (band + wake) * f * f;
}

#ifdef CROWN
uniform float uHitP[8];
uniform float uDiffP[8];
uniform float uLab[8];
#endif
varying vec3 vN;
varying vec3 vW;
varying float vT;
varying float vK;
varying float vU;
varying float vA;

vec3 envAt(vec3 R) {
  if (R.y >= 0.0) return skyAt(R);
  return mix(vec3(0.004, 0.0045, 0.006), mist(R), exp(R.y * 10.0));
}

void main() {
  if (vT > uIntro) discard;
  vec2 toCam = normalize(cameraPosition.xz - uCenter.xz + 1e-5);
  if (dot(vW.xz - uCenter.xz, toCam) * uSide < 0.0) discard;
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vW);
  if (dot(N, V) < 0.0) N = -N;
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  float edge = 1.0 - ndv;
  float F = 0.04 + 0.96 * pow(edge, 5.0);
  vec3 tint = mix(uIvory, uCold, 0.62);
  float rim = pow(edge, 2.2);
  vec3 refl = envAt(reflect(-V, N));
  vec3 Lc = normalize(uCursorL - vW);
  float nh = max(dot(N, normalize(Lc + V)), 0.0);
  float spec = (pow(nh, 90.0) * 0.6 + pow(nh, 20.0) * 0.08) * uCursorAmt;
  vec3 Lk = normalize(vec3(0.35, 0.9, 0.45));
  float gk = pow(max(dot(N, normalize(Lk + V)), 0.0), 90.0) * 0.35;
  float back = pow(max(dot(-V, uMoon), 0.0), 3.0) * rim;
  vec3 col = refl * F * 0.8 + tint * rim * 0.46 + vec3(1.0, 0.985, 0.96) * (spec + gk) + moonColour() * back * 0.6;
  // the vault's light inside her stem lights the ribbons from within, most where they gather near it
  col += tint * uCore * (0.05 + 0.08 * (1.0 - vU)) * (0.5 + 0.5 * ndv);
  float alpha = 0.08 + F * 0.5 + rim * 0.2;
#ifdef CROWN
  // the crown's walls overlap (inside and outside, near and far), so each layer is a little clearer
  alpha *= 0.62;
  col *= 0.78;
  // the crown: each of the 8 tall spikes is one pair rule
  int k = int(mod(floor(fract(vA / 6.28318531) * 8.0 + 0.5), 8.0));
  float spikes = smoothstep(0.83, 0.86, vT);
  col += uCold * uDiffP[k] * 0.3 * spikes;
  if (uLab[k] > 0.5) {
    col = mix(col, (uLab[k] > 2.5 ? vec3(0.84, 0.71, 0.49) : uLab[k] > 1.5 ? uHot : uCold) * (0.7 + F), 0.5 * spikes);
    alpha = max(alpha, 0.35 * spikes);
  }
  float why = uHitP[k] * uFlash * spikes;
#else
  int k = int(vK + 0.5);
  col += uCold * uDiff[k] * 0.28;
  if (uBand >= 0.0) {
    float on = float(k) == uBand ? 1.0 : 0.0;
    col = mix(col * 0.45, col + uCold * 0.18, on);
    alpha = mix(alpha * 0.6, alpha + 0.12, on);
  }
  float why = uHit[k] * uFlash;
#endif
  col = mix(col, uHot * (0.9 + F), clamp(why * 1.2, 0.0, 1.0));
  alpha = max(alpha, why * 0.8);
  col *= 1.0 - uDim * 0.55;
  col += vec3(0.9, 0.97, 1.0) * streak(vW) * 1.0;
  gl_FragColor = vec4(col, alpha);
}`;

export const TRACE_VERT = /* glsl */ `
uniform vec3 uA; uniform vec3 uB; uniform vec3 uC; uniform float uWidth;
attribute float aT; attribute float aSide;
varying float vT;
void main() {
  vec3 p; vec3 d;
  if (aT <= 0.8) { float u = aT / 0.8; p = mix(uA, uB, u); d = normalize(uB - uA); }
  else { float u = (aT - 0.8) / 0.2; p = mix(uB, uC, u); d = normalize(uC - uB + vec3(1e-4)); }
  vec3 side = normalize(cross(d, vec3(0.0, 1.0, 0.0)));
  p += side * aSide * uWidth;
  vT = aT;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;

export const TRACE_FRAG = /* glsl */ `
uniform float uHead; uniform float uFade; uniform float uRefused; uniform float uOwn; uniform float uEmber;
uniform vec3 uIvory; uniform vec3 uCold; uniform vec3 uHot;
varying float vT;
void main() {
  if (uHead < 0.0 || vT > uHead) discard;
  float k = clamp(1.0 - (uHead - vT) / 0.38, 0.0, 1.0);
  float head = smoothstep(0.988, 1.0, 1.0 - (uHead - vT));
  vec3 c = mix(uIvory, uCold, uOwn);
  c = mix(c, uHot, uRefused * smoothstep(0.72, 0.8, uHead) * head);
  float a = (k * k * 0.55 + head * 1.4) * (1.0 - clamp(uFade, 0.0, 1.0));
  // after the strike the line stays on the board as a faint scar for a minute; a refusal keeps a red tip
  vec3 ce = mix(mix(uIvory, uCold, uOwn), uHot, uRefused * smoothstep(0.55, 0.8, vT));
  float ae = uEmber * (0.25 + 0.75 * vT);
  gl_FragColor = vec4(c * a * a + ce * ae, 1.0);
}`;

export const FLECK_UPDATE = /* glsl */ `
precision highp float;
uniform sampler2D tPos;
uniform sampler2D tVel;
uniform float uDt;
uniform float uTime;
uniform float uSim;
varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec4 p = texture2D(tPos, vUv);
  vec2 v = texture2D(tVel, p.xy).xy / uSim;
  // a slow ambient drift so the surface never freezes
  float a = hash(floor(p.xy * 40.0)) * 6.2831 + uTime * 0.05;
  p.xy += (v + vec2(cos(a), sin(a)) * 0.0012) * uDt;
  p.z += uDt;
  vec2 c = p.xy - 0.5;
  if (p.z > p.w || length(c) > 0.42 || length(c) < 0.025) {
    float r1 = hash(vUv * 91.7 + uTime);
    float r2 = hash(vUv * 37.3 - uTime * 1.7);
    float r3 = hash(vUv * 13.1 + uTime * 0.37);
    float ang = r1 * 6.2831853;
    float rad = 0.03 + pow(r2, 0.7) * 0.36;
    p.xy = 0.5 + vec2(cos(ang), sin(ang)) * rad;
    p.z = 0.0;
    p.w = 5.0 + r3 * 9.0;
  }
  gl_FragColor = p;
}`;

export const FLECK_VERT = /* glsl */ `
uniform sampler2D tPos;
uniform sampler2D tDye;
uniform float uBoard;
uniform float uPx;
attribute vec2 aRef;
varying float vA;
varying vec3 vTint;
void main() {
  vec4 p = texture2D(tPos, aRef);
  vec3 dye = texture2D(tDye, p.xy).rgb;
  float glow = clamp(dot(dye, vec3(0.33)) * 3.0, 0.0, 1.0);
  vec3 w = vec3((p.x - 0.5) * uBoard, 0.008, (0.5 - p.y) * uBoard);
  float life = smoothstep(0.0, 0.8, p.z) * (1.0 - smoothstep(p.w - 1.0, p.w, p.z));
  vA = life * (0.3 + glow * 0.9);
  vTint = mix(vec3(0.92, 0.9, 0.86), normalize(dye + 0.001) * 1.2, glow * 0.6);
  vec4 mv = viewMatrix * vec4(w, 1.0);
  gl_PointSize = (2.1 + glow * 2.2) * uPx * (8.0 / -mv.z);
  gl_Position = projectionMatrix * mv;
}`;

export const FLECK_FRAG = /* glsl */ `
uniform float uDim;
varying float vA;
varying vec3 vTint;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.1, d) * vA * (1.0 - uDim * 0.6);
  gl_FragColor = vec4(vTint * a, a);
}`;

export const FULL_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

export const COPY_DEPTH_FRAG = /* glsl */ `
uniform sampler2D tColor;
uniform sampler2D tDepth;
varying vec2 vUv;
void main() {
  gl_FragColor = texture2D(tColor, vUv);
  gl_FragDepth = texture2D(tDepth, vUv).x;
}`;

export const BRIGHT_FRAG = /* glsl */ `
uniform sampler2D tColor;
uniform float uThreshold;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tColor, vUv).rgb;
  float l = max(c.r, max(c.g, c.b));
  float k = smoothstep(uThreshold, uThreshold + 0.45, l);
  gl_FragColor = vec4(c * k, 1.0);
}`;

export const BLUR_FRAG = /* glsl */ `
uniform sampler2D tColor;
uniform vec2 uDir;
varying vec2 vUv;
void main() {
  vec3 s = texture2D(tColor, vUv).rgb * 0.227027;
  s += texture2D(tColor, vUv + uDir * 1.3846).rgb * 0.316216;
  s += texture2D(tColor, vUv - uDir * 1.3846).rgb * 0.316216;
  s += texture2D(tColor, vUv + uDir * 3.2308).rgb * 0.070270;
  s += texture2D(tColor, vUv - uDir * 3.2308).rgb * 0.070270;
  gl_FragColor = vec4(s, 1.0);
}`;

export const POST_FRAG = /* glsl */ `
uniform sampler2D tColor;
uniform sampler2D tBloom;
uniform float uBloom;
uniform float uChroma;
uniform vec4 uShock;
uniform float uTime;
uniform float uAspect;
varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
void main() {
  vec2 uv = vUv;
  float age = uTime - uShock.z;
  if (age > 0.0 && age < 0.9) {
    vec2 d = uv - uShock.xy; d.x *= uAspect;
    float r = length(d);
    float w = exp(-pow((r - age * 1.05) * 16.0, 2.0)) * (1.0 - age / 0.9) * uShock.w;
    uv -= normalize(d + 1e-5) * w * 0.01 / vec2(uAspect, 1.0);
  }
  vec2 off = (uv - 0.5) * uChroma * 0.01;
  vec3 c = vec3(texture2D(tColor, uv + off).r, texture2D(tColor, uv).g, texture2D(tColor, uv - off).b);
  c += texture2D(tBloom, uv).rgb * uBloom;
  c = aces(c * 1.05);
  vec2 q = vUv - 0.5;
  c *= 1.0 - dot(q, q) * 0.75;
  c += (hash(vUv * 1000.0 + fract(uTime)) - 0.5) / 255.0; // dither, no banding
  gl_FragColor = vec4(c, 1.0);
}`;

/**
 * A soft light on the wall behind her. Glass on pure black has nothing to bend; this pool of light gives the
 * lens its subject (her body brightens and its edges darken where the rays turn away from it), and frames
 * her like a piece in a dark gallery. A camera-facing quad pinned behind her, so every chapter keeps it.
 */
export const BACKDROP_VERT = /* glsl */ `
uniform vec3 uCenter;
uniform float uPush;
uniform float uSize;
varying vec2 vUv;
void main() {
  vec4 c = viewMatrix * vec4(uCenter, 1.0);
  c.z -= uPush;
  c.xy += position.xy * uSize;
  vUv = uv;
  gl_Position = projectionMatrix * c;
}`;

export const BACKDROP_FRAG = /* glsl */ `
uniform vec3 uIvory;
uniform float uAmt;
uniform float uDim;
varying vec2 vUv;
void main() {
  vec2 p = (vUv - 0.5) * 2.0;
  vec2 q = p / vec2(0.24, 0.48);
  float g = exp(-dot(q, q)) + 0.18 * exp(-dot(p, p) * 9.0);
  vec3 col = mix(uIvory, vec3(0.86, 0.9, 0.95), 0.55) * uAmt * g;
  col *= 1.0 - uDim * 0.6;
  gl_FragColor = vec4(col, 1.0);
}`;



/** Sky and fields in one full-screen triangle: rays above the horizon see the sky, rays below hit the fields. */
export const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vec4 v = inverse(projectionMatrix) * vec4(position.xy, 1.0, 1.0);
  vDir = (inverse(viewMatrix) * vec4(v.xyz / v.w, 0.0)).xyz;
  gl_Position = vec4(position.xy, 0.9999, 1.0);
}`;

export const SKY_FRAG = /* glsl */ `
${WORLD}
uniform float uTime;
uniform float uDim;
uniform vec3 uLamp;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  vec3 ro = cameraPosition;
  vec3 c;
  if (ro.y < 0.0) {
    // the mirrored camera (the board's reflection): only what stands above the board
    c = d.y > 0.0 ? skyAt(d) : vec3(0.0);
  } else if (d.y >= 0.0) {
    c = skyAt(d);
  } else {
    float t = min(-ro.y / d.y, 600.0);
    vec3 p = ro + d * t;
    vec2 g = p.xz / 8.0;
    float checker = mod(floor(g.x) + floor(g.y), 2.0);
    vec3 field = mix(vec3(0.008, 0.0085, 0.010), vec3(0.019, 0.0195, 0.021), checker);
    // brooks between the fields: a cold thread of water that glints toward the moon; they fade out
    // before they are thinner than a pixel, so the far fields never shimmer
    vec2 fw = fwidth(g);
    vec2 e = abs(fract(g + 0.5) - 0.5);
    vec2 l = 1.0 - smoothstep(vec2(0.0), fw * 1.2 + 0.006, e);
    float brook = max(l.x, l.y) * clamp(1.0 - max(fw.x, fw.y) * 7.0, 0.0, 1.0);
    vec3 r = vec3(d.x, -d.y, d.z);
    float glint = pow(max(dot(r, uMoon), 0.0), 220.0) * (0.6 + 0.4 * sin(uTime * 1.7 + p.x * 0.9 + p.z * 1.3));
    float lampD = length(p.xz - uLamp.xy);
    float lamp = uLamp.z * exp(-lampD * lampD * 0.012);
    field += (uCold * (0.11 + lamp * 0.9) + moonColour() * glint * 1.4) * brook;
    field += uIvory * 0.02 * lamp;
    // the fields begin where the board ends, and sink into the mist
    field *= smoothstep(10.5, 20.0, length(p.xz));
    c = mix(field, mist(d), 1.0 - exp(-t * 0.016));
  }
  c *= 1.0 - uDim * 0.6;
  gl_FragColor = vec4(c, 1.0);
}`;

/** Giant pieces of an unfinished game, far out in the fields: obsidian, edged by the mist and the moon. */
export const PIECE_VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vW;
void main() {
  mat4 m = modelMatrix * instanceMatrix;
  vec4 w = m * vec4(position, 1.0);
  vW = w.xyz;
  vN = normalize(mat3(m) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

export const PIECE_FRAG = /* glsl */ `
${WORLD}
uniform float uDim;
varying vec3 vN;
varying vec3 vW;
void main() {
  vec3 N = normalize(vN);
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(cameraPosition - vW);
  vec3 d = -V;
  float ndv = max(dot(N, V), 0.0);
  vec3 R = reflect(-V, N);
  vec3 c = vec3(0.004, 0.0045, 0.006);
  c += mist(d) * 1.1 * pow(1.0 - ndv, 3.0);
  c += moonColour() * pow(max(dot(R, uMoon), 0.0), 40.0) * 0.18;
  c += uIvory * 0.015 * max(N.y, 0.0);
  float dist = length(vW - cameraPosition);
  c = mix(c, haze(d), 1.0 - exp(-dist * 0.015));
  c *= 1.0 - uDim * 0.6;
  gl_FragColor = vec4(c, 1.0);
}`;

/** Dust in the air round her: slow, faint, catching the light; it gives the space depth when the camera moves. */
export const DUST_VERT = /* glsl */ `
attribute vec4 aSeed;
uniform float uTime;
uniform float uPx;
uniform vec3 uRayO;
uniform vec3 uRayD;
varying float vA;
void main() {
  vec3 p = aSeed.xyz;
  float t = uTime * 0.06 + aSeed.w * 6.2831853;
  p += vec3(sin(t * 1.3 + aSeed.w * 9.0), sin(t * 0.7 + aSeed.w * 3.0) * 0.5, cos(t * 1.1 + aSeed.w * 5.0)) * 0.55;
  // they drift aside from the cursor's ray, and the ones near it catch the light
  vec3 rel = p - uRayO;
  vec3 perp = rel - uRayD * dot(rel, uRayD);
  float rd = length(perp);
  float near = exp(-rd * rd * 1.6);
  p += perp / max(rd, 1e-3) * near * 0.55;
  vec4 mv = viewMatrix * vec4(p, 1.0);
  float z = -mv.z;
  gl_PointSize = uPx * (1.1 + fract(aSeed.w * 13.0) * 1.5) * (6.0 / max(z, 0.5));
  vA = (0.3 + 0.7 * fract(aSeed.w * 7.0) + near * 2.2) * smoothstep(1.2, 4.0, z) * (1.0 - smoothstep(16.0, 26.0, z));
  gl_Position = projectionMatrix * mv;
}`;

export const DUST_FRAG = /* glsl */ `
uniform vec3 uIvory;
uniform float uDim;
varying float vA;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.05, d) * vA * 0.3 * (1.0 - uDim * 0.6);
  gl_FragColor = vec4(uIvory * a, 1.0);
}`;
