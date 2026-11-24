"use client";
/** The guided tour's state: which step, and whether it is playing on its own. */
import { useSyncExternalStore } from "react";

export interface TourState {
  active: boolean;
  /** the title card before the first chapter (where sound is chosen) */
  intro: boolean;
  step: number;
  playing: boolean;
  /** the letterbox is opening out; the theatre unmounts when this ends */
  closing: boolean;
}

let state: TourState = { active: false, intro: false, step: 0, playing: false, closing: false };
let closer: ReturnType<typeof setTimeout> | null = null;
const ls = new Set<() => void>();

export const tour = {
  get: () => state,
  set(p: Partial<TourState>) {
    state = { ...state, ...p };
    for (const l of ls) l();
  },
  start() {
    if (closer) clearTimeout(closer);
    closer = null;
    tour.set({ active: true, intro: true, step: 0, playing: false, closing: false });
  },
  begin() {
    tour.set({ intro: false, step: 0, playing: true });
  },
  stop() {
    if (!state.active || state.closing) return;
    tour.set({ closing: true, playing: false });
    closer = setTimeout(() => {
      closer = null;
      tour.set({ active: false, closing: false });
    }, 700);
  },
  subscribe(l: () => void) {
    ls.add(l);
    return () => ls.delete(l);
  },
};

export function useTour<T>(sel: (s: TourState) => T): T {
  return useSyncExternalStore(tour.subscribe, () => sel(state), () => sel(state));
}
