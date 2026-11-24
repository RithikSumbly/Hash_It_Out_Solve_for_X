/** 96 BPM; chain events are released on 1/4-beat subdivisions (156.25 ms) so they read as a chord. */
export const BPM = 96;
export const BEAT_MS = 60_000 / BPM;
export const SUBDIVISION_MS = BEAT_MS / 4;
export const BREATH_MS = 4000;

export function quantize(nowMs: number): number {
  return Math.ceil(nowMs / SUBDIVISION_MS) * SUBDIVISION_MS;
}
