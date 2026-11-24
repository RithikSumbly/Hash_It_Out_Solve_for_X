"use client";
/**
 * The frame, in order:
 *   1. ink: flush chain/cursor/scroll splats, step the fluid
 *   2. mirror: the queen (glass + quicksilver) and the world beyond (sky, moon, giants) through a reflected
 *      camera → the looking-glass texture
 *   3. opaque: sky and fields, giants, wall light, board, flecks, scars, dust, quicksilver → target A
 *   4. glass: copy A (colour + depth) → target B, draw the glass into B; each fragment traces its ray
 *      through her (in, across the body or onto the quicksilver, out the back) and samples A there; then her
 *      name, sculpted in red glass over the hero (title.ts), bending A in the same way
 *   5. bloom: bright pass + separable blur at quarter resolution
 *   6. post: refusal chromatic offset (one frame), screen shockwave, ACES, vignette, dither → screen
 */
import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { bus } from "@/lib/bus";
import { scene } from "@/lib/scene";
import { Fluid } from "./fluid";
import { Ripple } from "./ripple";
import { ink, wireInk, TRAVEL, BOARD } from "./ink";
import { gfx, LAYER_GLASS, LAYER_LIQUID, LAYER_OPAQUE, LAYER_RIBBON_BACK, LAYER_RIBBON_FRONT, LAYER_SCENERY } from "./gfx";
import { BLUR_FRAG, BRIGHT_FRAG, COPY_DEPTH_FRAG, FULL_VERT, POST_FRAG } from "./shaders";
import { queenFrame } from "./Queen";
import { SculptedTitle } from "./title";
import { HEIGHT, outerRadius } from "@/lib/queen";

function rt(w: number, h: number, depth = false, samples = 0) {
  const t = new THREE.WebGLRenderTarget(w, h, {
    samples,
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: depth,
    stencilBuffer: false,
  });
  if (depth) {
    t.depthTexture = new THREE.DepthTexture(w, h);
    t.depthTexture.type = THREE.UnsignedIntType;
  }
  return t;
}

export function Pipeline({ quality = 1 }: { quality?: number }) {
  const { gl, camera, scene: world, size } = useThree();

  // phones: a coarser fluid and fewer glass samples; the look is the same, the cost about a third
  const fluid = useMemo(() => new Fluid(gl, quality > 0 ? { sim: 128, dye: 384, pressureIterations: 10 } : { sim: 96, dye: 256, pressureIterations: 8 }), [gl, quality]);
  const ripple = useMemo(() => new Ripple(gl, quality > 0 ? 384 : 256), [gl, quality]);
  const targets = useMemo(() => {
    const opaque = rt(4, 4, true, 0);
    // a mip chain on the backdrop lets the liquid glass frost it cheaply (textureLod)
    opaque.texture.generateMipmaps = true;
    opaque.texture.minFilter = THREE.LinearMipmapLinearFilter;
    const o = {
      opaque,
      glass: rt(4, 4, true, 4),
      reflect: rt(4, 4, true),
      bright: rt(4, 4),
      blurA: rt(4, 4),
      blurB: rt(4, 4),
    };
    return o;
  }, []);

  const quads = useMemo(() => {
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const mk = (frag: string, uniforms: Record<string, THREE.IUniform>, extra: Partial<THREE.ShaderMaterialParameters> = {}) => {
      const m = new THREE.ShaderMaterial({ vertexShader: FULL_VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false, ...extra });
      const s = new THREE.Scene();
      const q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), m);
      q.frustumCulled = false;
      s.add(q);
      return { m, s };
    };
    return {
      cam,
      copy: mk(COPY_DEPTH_FRAG, { tColor: { value: null }, tDepth: { value: null } }, { depthTest: true, depthWrite: true, depthFunc: THREE.AlwaysDepth }),
      bright: mk(BRIGHT_FRAG, { tColor: { value: null }, uThreshold: { value: 0.72 } }),
      blur: mk(BLUR_FRAG, { tColor: { value: null }, uDir: { value: new THREE.Vector2() } }),
      post: mk(POST_FRAG, {
        tColor: { value: null },
        tBloom: { value: null },
        uBloom: { value: 0.55 },
        uChroma: { value: 0 },
        uShock: { value: new THREE.Vector4(0.5, 0.5, -10, 0) },
        uTime: { value: 0 },
        uAspect: { value: 1 },
      }),
    };
  }, []);

  const mirror = useMemo(() => {
    const c = new THREE.PerspectiveCamera();
    c.matrixAutoUpdate = false;
    c.matrixWorldAutoUpdate = false;
    return c;
  }, []);
  const reflectM = useMemo(() => new THREE.Matrix4().makeScale(1, -1, 1), []);
  const title = useMemo(() => new SculptedTitle(), []);
  useEffect(() => () => title.dispose(), [title]);
  const ray = useMemo(() => new THREE.Raycaster(), []);
  const plane = useMemo(() => new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), []);
  const hit = useMemo(() => new THREE.Vector3(), []);
  const fx = useRef({ chroma: 0, frames: 0, pointer: null as null | { x: number; y: number }, wasPressed: false });

  useEffect(() => {
    gfx.fluid = fluid;
    gfx.ripple = ripple;
    gfx.opaque = targets.opaque;
    gfx.reflect = targets.reflect;
    const off = wireInk();
    return () => {
      off();
      gfx.fluid = null;
      gfx.ripple = null;
      fluid.dispose();
      ripple.dispose();
    };
  }, [fluid, ripple, targets]);

  /**
   * Internal resolution is capped (render scale ≤ 1.25) and follows pixel-ratio changes from the adaptive
   * DPR, so a retina laptop never asks the GPU for more memory than it has (an over-budget allocation
   * silently blanks the canvas). The glass pass keeps MSAA for clean silhouettes; the board does not need it.
   */
  const resize = (dpr: number, wCss: number, hCss: number) => {
    const rs = Math.min(dpr, 1.25);
    const w = Math.max(4, Math.floor(wCss * rs));
    const h = Math.max(4, Math.floor(hCss * rs));
    if (targets.opaque.width === w && targets.opaque.height === h) return;
    gfx.width = w;
    gfx.height = h;
    gfx.dpr = rs;
    targets.opaque.setSize(w, h);
    targets.glass.setSize(w, h);
    // (2 samples; 4 cost a full-resolution half-float resolve every frame for edges bloom softens anyway)
    targets.glass.samples = quality === 0 || w * h > 2_400_000 ? 0 : 2;
    targets.reflect.setSize(Math.floor(w / 3), Math.floor(h / 3));
    targets.bright.setSize(Math.floor(w / 4), Math.floor(h / 4));
    targets.blurA.setSize(Math.floor(w / 4), Math.floor(h / 4));
    targets.blurB.setSize(Math.floor(w / 4), Math.floor(h / 4));
    quads.post.m.uniforms.uAspect.value = wCss / hCss;
  };
  useEffect(() => {
    resize(gl.getPixelRatio(), size.width, size.height);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, size, targets, quads]);

  // refusal: one frame of full chromatic offset and a screen-space shockwave from her foot
  useEffect(() => {
    return bus.on((e) => {
      if (e.type !== "chain" || e.event.name !== "Spend" || !e.event.args.refused || scene.reducedMotion) return;
      setTimeout(() => {
        fx.current.frames = 1;
        fx.current.chroma = 1;
        const p = new THREE.Vector3(0, 0.3, 0).project(camera);
        quads.post.m.uniforms.uShock.value.set(p.x * 0.5 + 0.5, p.y * 0.5 + 0.5, quads.post.m.uniforms.uTime.value, 0.8);
      }, TRAVEL * 1000);
    });
  }, [camera, quads]);

  // cursor over the board stirs the ink
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      fx.current.pointer = { x: (e.clientX / window.innerWidth) * 2 - 1, y: -(e.clientY / window.innerHeight) * 2 + 1 };
    };
    const onLeave = () => {
      fx.current.pointer = null;
      gfx.touch.pressed = false;
      ink.pointerOut();
    };
    const onDown = (e: PointerEvent) => {
      onMove(e);
      gfx.touch.pressed = true;
    };
    const onUp = () => {
      gfx.touch.pressed = false;
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerdown", onDown, { passive: true });
    window.addEventListener("pointerup", onUp, { passive: true });
    window.addEventListener("pointercancel", onUp, { passive: true });
    document.addEventListener("pointerleave", onLeave);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      document.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  useFrame((state, dt) => {
    const t = state.clock.elapsedTime;
    const cam = camera as THREE.PerspectiveCamera;
    resize(state.gl.getPixelRatio(), state.size.width, state.size.height);

    // 1. ink, and the cursor as the queen sees it
    const p = fx.current.pointer;
    const touch = gfx.touch;
    let touching = false;
    let lampOn = 0;
    if (p) {
      ray.setFromCamera(new THREE.Vector2(p.x, p.y), cam);
      touch.rayO.copy(ray.ray.origin);
      touch.rayD.copy(ray.ray.direction);
      const onGround = ray.ray.intersectPlane(plane, hit);
      if (onGround && Math.hypot(hit.x, hit.z) < 140) {
        // the lamp glides after the cursor rather than snapping to it
        const k = Math.min(1, dt * 9);
        touch.lamp.x += (hit.x - touch.lamp.x) * (touch.lamp.z < 0.02 ? 1 : k);
        touch.lamp.y += (hit.z - touch.lamp.y) * (touch.lamp.z < 0.02 ? 1 : k);
        lampOn = 1;
      }
      if (onGround && Math.abs(hit.x) < BOARD / 2 && Math.abs(hit.z) < BOARD / 2) {
        ink.pointer(hit.x / BOARD + 0.5, 0.5 - hit.z / BOARD, t);
      } else ink.pointerOut();
      // the water: a wake behind the cursor, a ring where it presses (not while it rests on her)
      const overWater = onGround && Math.abs(hit.x) < BOARD / 2 - 0.3 && Math.abs(hit.z) < BOARD / 2 - 0.3;
      if (overWater) {
        ripple.pointer(hit.x, hit.z, t);
        if (touch.pressed && !fx.current.wasPressed) ripple.press(hit.x, hit.z);
      } else ripple.pointerOut();
      // march the ray against her surface of revolution (exact for a lathe body)
      const sh = queenFrame.shape;
      if (sh) {
        const o = ray.ray.origin;
        const d = ray.ray.direction;
        const camDist = o.length();
        for (let k = 0, s = Math.max(0, camDist - 1.2); k < 90; k++, s += 0.03) {
          const x = o.x + d.x * s;
          const y = o.y + d.y * s;
          const z = o.z + d.z * s;
          if (y < 0 || y > HEIGHT * 0.95) continue;
          if (Math.hypot(x, z) <= outerRadius(sh, y / HEIGHT) * HEIGHT) {
            touch.point.set(x, y, z);
            touching = true;
            break;
          }
        }
        // a soft light hovering just in front of her, wherever the cursor points
        touch.light.copy(o).addScaledVector(d, Math.max(1, camDist - 1.6));
      }
      touch.screen.set(p.x * 0.5 + 0.5, p.y * 0.5 + 0.5);
    }
    touch.touching = touching;
    fx.current.wasPressed = touch.pressed;
    touch.lamp.z += ((scene.reducedMotion ? lampOn * 0.6 : lampOn) - touch.lamp.z) * Math.min(1, dt * 3);
    touch.amt += ((touching && !scene.reducedMotion ? 1 : 0) - touch.amt) * Math.min(1, dt * (touching ? 6 : 3));
    touch.lightAmt += ((p ? 1 : 0.35) - touch.lightAmt) * Math.min(1, dt * 3);
    ink.scrollVelocity = scene.scrollV;
    ink.flush(fluid, t, dt);
    if (!scene.reducedMotion || t < 0.5) fluid.step(dt);
    ripple.step(dt, t);

    // 2. mirror (queen + quicksilver seen in the looking-glass)
    cam.updateMatrixWorld();
    mirror.projectionMatrix.copy(cam.projectionMatrix);
    mirror.projectionMatrixInverse.copy(cam.projectionMatrixInverse);
    mirror.matrixWorld.multiplyMatrices(reflectM, cam.matrixWorld);
    mirror.matrixWorldInverse.copy(mirror.matrixWorld).invert();
    mirror.layers.disableAll();
    mirror.layers.enable(LAYER_GLASS);
    mirror.layers.enable(LAYER_LIQUID);
    mirror.layers.enable(LAYER_SCENERY);
    mirror.layers.enable(LAYER_RIBBON_BACK);
    mirror.layers.enable(LAYER_RIBBON_FRONT);
    gl.setRenderTarget(targets.reflect);
    gl.setClearColor(0x000000, 1);
    gl.clear(true, true, false);
    // the reflected camera flips the winding, so the glass culls its other side for this pass
    if (gfx.glass) gfx.glass.side = THREE.BackSide;
    gl.render(world, mirror);
    if (gfx.glass) gfx.glass.side = THREE.FrontSide;

    // 3. opaque
    cam.layers.disableAll();
    cam.layers.enable(LAYER_OPAQUE);
    cam.layers.enable(LAYER_LIQUID);
    cam.layers.enable(LAYER_SCENERY);
    cam.layers.enable(LAYER_RIBBON_BACK);
    gl.setRenderTarget(targets.opaque);
    gl.setClearColor(0x050608, 1);
    gl.clear(true, true, false);
    gl.render(world, cam);
    // the light behind her name (the glass bends it)
    title.backlight(gl, targets.opaque, state.size.width, state.size.height);

    // 4. glass over a copy of the opaque pass
    quads.copy.m.uniforms.tColor.value = targets.opaque.texture;
    quads.copy.m.uniforms.tDepth.value = targets.opaque.depthTexture;
    gl.setRenderTarget(targets.glass);
    gl.clear(true, true, false);
    gl.render(quads.copy.s, quads.cam);
    cam.layers.disableAll();
    cam.layers.enable(LAYER_GLASS);
    const autoClear = gl.autoClear;
    gl.autoClear = false;
    gl.render(world, cam);
    // the near halves of the ribbons, thin glass laid over her body
    cam.layers.disableAll();
    cam.layers.enable(LAYER_RIBBON_FRONT);
    gl.render(world, cam);
    gl.autoClear = autoClear;
    cam.layers.enableAll();
    // her name, in the same glass
    title.frame(gl, targets.glass, targets.opaque.texture, state.size.width, state.size.height);

    // 5. bloom
    quads.bright.m.uniforms.tColor.value = targets.glass.texture;
    gl.setRenderTarget(targets.bright);
    gl.render(quads.bright.s, quads.cam);
    let src = targets.bright;
    for (let i = 0; i < 2; i++) {
      quads.blur.m.uniforms.tColor.value = src.texture;
      quads.blur.m.uniforms.uDir.value.set(1 / targets.blurA.width, 0);
      gl.setRenderTarget(targets.blurA);
      gl.render(quads.blur.s, quads.cam);
      quads.blur.m.uniforms.tColor.value = targets.blurA.texture;
      quads.blur.m.uniforms.uDir.value.set(0, 1 / targets.blurA.height);
      gl.setRenderTarget(targets.blurB);
      gl.render(quads.blur.s, quads.cam);
      src = targets.blurB;
    }

    // 6. post
    const u = quads.post.m.uniforms;
    u.uTime.value = t;
    if (fx.current.frames > 0) {
      u.uChroma.value = 1;
      fx.current.frames--;
    } else {
      fx.current.chroma = Math.max(0, fx.current.chroma - dt * 8);
      u.uChroma.value = fx.current.chroma * 0.3;
    }
    u.tColor.value = targets.glass.texture;
    u.tBloom.value = targets.blurB.texture;
    gl.setRenderTarget(null);
    gl.render(quads.post.s, quads.cam);
  }, 1);

  return null;
}
