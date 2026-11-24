import * as THREE from "three";

/** Brand colours as linear-ish shader values. Red is reserved for refusals. */
export const palette = {
  ivory: new THREE.Color("#efe8da"),
  cold: new THREE.Color("#9fd4e0"),
  hot: new THREE.Color("#e8372c"),
  /** held, a payment waiting on its clock */
  held: new THREE.Color("#d6b67e"),
  ash: new THREE.Color("#4b4844"),
};
