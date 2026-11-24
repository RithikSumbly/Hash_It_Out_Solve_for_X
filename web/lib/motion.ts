/** The page's one material: one ease-out, one spring. */
export const EASE_OUT = [0.16, 1, 0.3, 1] as const;
export const EASE_OUT_CSS = "cubic-bezier(0.16, 1, 0.3, 1)";
export const SPRING = { type: "spring" as const, stiffness: 260, damping: 28, mass: 0.9 };

/** JS mirror of EASE_OUT for shaders / rAF tweens (expo-out is visually identical to the bezier). */
export function easeOut(t: number) {
  const x = Math.min(1, Math.max(0, t));
  return x === 1 ? 1 : 1 - Math.pow(2, -10 * x);
}

export function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

export function damp(current: number, target: number, lambda: number, dt: number) {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}
