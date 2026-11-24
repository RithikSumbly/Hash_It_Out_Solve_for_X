import * as THREE from "three";
import type { Fluid } from "./fluid";
import type { Ripple } from "./ripple";

/** Layers: the pipeline renders them in separate passes. */
export const LAYER_OPAQUE = 0; // board, flecks, traces
export const LAYER_GLASS = 1; // the queen's glass body (refracts the opaque pass)
export const LAYER_LIQUID = 2; // quicksilver: inside the glass, part of what the glass refracts
export const LAYER_BACK = 3; // the glass's far wall, laid over the opaque pass before the front refracts it
export const LAYER_SCENERY = 4; // the world beyond the board (sky, fields, giants): drawn and mirrored
export const LAYER_RIBBON_FRONT = 5; // the near halves of her glass ribbons, laid over her refracted body
export const LAYER_RIBBON_BACK = 6; // the far halves, drawn into the opaque pass so her body refracts them

/** Render state shared between the pipeline (owner) and the materials that read its targets. */
export const gfx = {
  fluid: null as Fluid | null,
  /** the thin film of water on the board (height field) */
  ripple: null as Ripple | null,
  opaque: null as THREE.WebGLRenderTarget | null,
  reflect: null as THREE.WebGLRenderTarget | null,
  width: 1,
  height: 1,
  dpr: 1,
  /** the light inside her (the vault's level, 0..1), shared with the board's light pool under her foot */
  core: { value: 0.9 },
  /** the front glass material (its culled side flips for the mirrored camera) */
  glass: null as THREE.ShaderMaterial | null,
  /**
   * The cursor as the queen sees it: the touch point on her glass, a light hovering in front of her along
   * the cursor's ray, the cursor in screen uv (her rim lights on that side), and whether it is pressed.
   */
  touch: {
    point: new THREE.Vector3(0, 1.2, 0),
    amt: 0,
    light: new THREE.Vector3(-2, 2.5, 4),
    lightAmt: 0.35,
    screen: new THREE.Vector2(0.3, 0.8),
    pressed: false,
    touching: false,
    /** where the cursor's ray meets the ground (x, z) and how strongly its lamp is lit (0..1) */
    lamp: new THREE.Vector3(0, 0, 0),
    /** the cursor's ray, for the dust */
    rayO: new THREE.Vector3(0, 0, 100),
    rayD: new THREE.Vector3(0, 0, -1),
  },
};
