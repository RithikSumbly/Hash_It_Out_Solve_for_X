"use client";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { CROWN_RIM_R, CROWN_RIM_T, HEIGHT, bandCentre, outerRadius } from "@/lib/queen";
import { queenFrame } from "./Queen";
import { scene } from "@/lib/scene";

/** Screen positions of the queen's 8 bands and her crown rim, written every frame for DOM annotations. */
export const anchors = {
  ready: false,
  bands: Array.from({ length: 8 }, () => ({ x: 0, y: 0 })),
  crown: { x: 0, y: 0 },
  centreX: 0,
  rightX: 0,
  w: 1,
  h: 1,
};

const v = new THREE.Vector3();
const right = new THREE.Vector3();

export function AnchorTracker() {
  const { camera, size } = useThree();
  useFrame(() => {
    const s = queenFrame.shape;
    if (!s) return;
    camera.updateMatrixWorld();
    // the right-hand silhouette as the camera sees it
    right.set(1, 0, 0).applyQuaternion(camera.quaternion).setY(0).normalize();
    const project = (x: number, y: number, z: number) => {
      v.set(x, y, z).project(camera);
      return { x: (v.x * 0.5 + 0.5) * size.width, y: (-v.y * 0.5 + 0.5) * size.height };
    };
    for (let k = 0; k < 8; k++) {
      const t = bandCentre(k);
      const r = outerRadius(s, t) * HEIGHT * 1.02;
      const p = project(right.x * r, t * HEIGHT, right.z * r);
      anchors.bands[k].x = p.x;
      anchors.bands[k].y = p.y;
    }
    const rim = CROWN_RIM_R * HEIGHT;
    const c = project(right.x * rim, (CROWN_RIM_T + 0.03) * HEIGHT, right.z * rim);
    anchors.crown.x = c.x;
    anchors.crown.y = c.y;
    anchors.centreX = project(0, HEIGHT * 0.5, 0).x;
    anchors.rightX = Math.max(...anchors.bands.map((b) => b.x));
    anchors.w = size.width;
    anchors.h = size.height;
    anchors.ready = true;
    // where she stands on screen, as fractions: the loading curtain turns its squares over from here
    const mid = project(0, HEIGHT * 0.5, 0);
    scene.queenAt.x = mid.x / Math.max(1, size.width);
    scene.queenAt.y = mid.y / Math.max(1, size.height);
  });
  return null;
}
