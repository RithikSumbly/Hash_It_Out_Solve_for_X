"use client";
import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { bus } from "@/lib/bus";
import { scene } from "@/lib/scene";
import { damp } from "@/lib/motion";

/**
 * "It takes all the running you can do, to keep in the same place."
 * The page is one orbit around the queen: azimuth climbs 0° → 360° across the chapters, so the last view
 * is the first. Per chapter: [azimuth°, distance, height, look-at height, frame offset (−left … +right)].
 */
const KEYS: [number, number, number, number, number][] = [
  [-8, 6.6, 1.3, 1.2, 0.0], // 0 loader
  [0, 7.3, 1.35, 1.22, 0.4], // 1 arrival: she stands right of the title, annotated
  [38, 5.8, 1.1, 1.15, -0.46], // 2 the vault: close on the quicksilver, crown to foot, copy on the right
  [78, 3.6, 13.5, 0.0, 0.32], // 3 the siege: from above, the board around her
  [122, 8.4, 0.95, 1.42, 0.0], // 4 your turn: from the attacker's edge, between the copy and the panel
  [158, 8.4, 3.8, 0.85, -0.48], // 5 the record
  [198, 10.5, 1.6, 0.12, 0.53], // 6 generations: whole, upper right, morphing above the cards
  [245, 1.6, 15.5, 0.0, 0.64], // 7 the family tree: overhead, beside the tree
  [286, 10.5, 1.0, 2.6, -0.42], // 8 is she learning: small, lower left, under the copy
  [322, 9.6, 1.6, 2.5, 0.04], // 9 back a bloodline: small, between the columns
  [360, 7.3, 1.35, 1.22, 0.4], // 10 check everything: home again
];

export function Orbit() {
  const { camera, size } = useThree();
  const cur = useRef({ az: KEYS[0][0], dist: KEYS[0][1], h: KEYS[0][2], look: KEYS[0][3], frame: 0, cine: 0, spin: 0, roll: 0 });

  useEffect(() => {
    return bus.on((e) => {
      if (e.type === "chain" && e.event.name === "EpochClosed" && scene.cinema && !e.replay) cur.current.cine = 6;
    });
  }, []);

  useFrame((state, dt) => {
    const cam = camera as THREE.PerspectiveCamera;
    // the menu previews a chapter: the camera flies there behind the glass, and back when it closes
    const s = Math.max(0, Math.min(KEYS.length - 1, scene.previewStage ?? scene.stage));
    const i = Math.floor(s);
    const f = s - i;
    const k = f * f * (3 - 2 * f);
    const a = KEYS[i];
    const b = KEYS[Math.min(KEYS.length - 1, i + 1)];
    const lerp = (x: number, y: number) => x + (y - x) * k;
    let az = lerp(a[0], b[0]);
    let dist = lerp(a[1], b[1]);
    let h = lerp(a[2], b[2]);
    let look = lerp(a[3], b[3]);
    let frame = lerp(a[4], b[4]);
    // previewed from the menu: she stands on the right, where the glass is clear
    if (scene.previewStage !== null) frame = 0.42;
    if (scene.audience === 1) {
      az = -10;
      dist = 6.3;
      h = 1.05;
      look = 1.3;
      frame = 0.34;
    }
    const c = cur.current;
    if (scene.cinema) {
      c.spin += dt * (c.cine > 0 ? 60 : 6);
      c.cine = Math.max(0, c.cine - dt);
      az = c.spin;
      dist = 5.0;
      h = 1.35;
      look = 1.2;
      frame = -0.18;
    }
    // narrow screens: no lateral framing; she stands a little further back, high in the frame, above the copy
    const narrow = size.width < 760;
    if (narrow) {
      frame = 0;
      if (!scene.cinema) dist *= 1.3;
    }
    // pointer parallax
    if (!scene.reducedMotion) {
      az += scene.pointer.nx * 2.2;
      h += scene.pointer.ny * 0.12;
    }
    const lam = scene.reducedMotion ? 30 : 2.8;
    // keep azimuth continuous when cinema spins past 360
    c.az = damp(c.az, az, lam, dt);
    c.dist = damp(c.dist, dist, lam, dt);
    c.h = damp(c.h, h, lam, dt);
    c.look = damp(c.look, look, lam, dt);
    c.frame = damp(c.frame, frame, lam, dt);
    c.roll = damp(c.roll, scene.reducedMotion ? 0 : Math.max(-1, Math.min(1, scene.scrollV / 3000)) * 0.03, 4, dt);
    const r = (c.az * Math.PI) / 180;
    cam.position.set(Math.sin(r) * c.dist, c.h, Math.cos(r) * c.dist);
    cam.up.set(Math.sin(c.roll), Math.cos(c.roll), 0);
    cam.lookAt(0, c.look, 0);
    // frame offset: slide the image sideways without changing perspective
    const w = size.width;
    const hh = size.height;
    cam.setViewOffset(w, hh, -c.frame * w * 0.5, narrow && !scene.cinema ? hh * 0.17 : 0, w, hh);
    scene.frame = c.frame;
    cam.updateProjectionMatrix();
  });
  return null;
}
