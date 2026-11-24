"use client";
/**
 * Mutable scene state shared between the DOM (scroll, panels) and the render loops (WebGL and 2D).
 * Written by ScrollTrigger / overlays, read every frame — never triggers React renders.
 */
export type SceneSection =
  | "loader"
  | "hero"
  | "vault"
  | "attack"
  | "try"
  | "feed"
  | "generations"
  | "lineage"
  | "charts"
  | "bet"
  | "proof";

export const scene = {
  /** 0..1 over the whole page */
  progress: 0,
  section: "loader" as SceneSection,
  /** per-section camera keyframe blending is done in CameraRig from this value (0..10) */
  stage: 0,
  /** while the menu is open, the chapter the camera previews (the item under the cursor); null otherwise */
  previewStage: null as number | null,
  /** attack-field scrub: unix seconds being viewed, or null for live */
  scrubTime: null as number | null,
  /** time machine: genes override and a label */
  overrideGenes: null as number[] | null,
  cinema: false,
  reducedMotion: false,
  pointer: { x: 0, y: 0, nx: 0, ny: 0, overShield: false },
  /** loader animation 0..1 */
  intro: 0,
  /** the loading curtain has lifted (the intro plays from then; changes before it happen without animation) */
  revealed: false,
  /** the stage has drawn its first frames (shaders compiled): the curtain may lift */
  stageWarm: false,
  /** where the queen stands on screen (fractions of the viewport), written by the stage every frame */
  queenAt: { x: 0.6, y: 0.55 },
  /** shield horizontal offset in viewport fractions (Try it panel pushes it left) */
  shift: 0,
  /** dim the scene behind dense sections */
  dim: 0,
  /** policy inspector: highlight one feature band on the queen (-1 none) */
  band: -1,
  /** frame offset: shifts the queen left (-) or right (+) in the viewport, as a fraction of its width */
  frame: 0,
  /** smoothed scroll velocity in px/s (Lenis), drives ink stirring and camera roll */
  scrollV: 0,
  quality: 1,
  /** a verdict in the record under the cursor: its attack line is drawn on the board */
  hoverSpend: null as { caller: string; refused: boolean } | null,
  /** an audience with her: 0 none, 1 face to face (the camera comes to her), 2 stepped aside (she took you somewhere) */
  audience: 0,
  /** her voice's level while she speaks (0..1, smoothed): her crown's light follows it */
  voice: 0,
  /** the visitor's voice while she listens (0..1, smoothed): it reaches her across the water */
  mic: 0,
  /** her line in your voice is playing: she stands still and dark, and the voice comes from your side of the water */
  echo: 0,
};

export function stageFor(section: SceneSection): number {
  return ["loader", "hero", "vault", "attack", "try", "feed", "generations", "lineage", "charts", "bet", "proof"].indexOf(section);
}
