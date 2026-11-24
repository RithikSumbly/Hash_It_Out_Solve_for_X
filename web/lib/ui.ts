"use client";
import { useSyncExternalStore } from "react";
import type { SpendRow } from "./store";

export interface Toast {
  id: number;
  text: string;
  tone: "cold" | "hot" | "held" | "bone" | "ivory";
  href?: string;
}

export interface UIState {
  verify: boolean;
  cinema: boolean;
  sound: boolean;
  timeMachine: { on: boolean; index: number; playing: boolean };
  inspector: bigint | null;
  lab: boolean;
  scar: SpendRow | null;
  toasts: Toast[];
  phone: boolean;
  webgl: boolean;
  me: string | null;
  /** the full-screen menu is open */
  menu: boolean;
}

let state: UIState = {
  verify: false,
  cinema: false,
  sound: false,
  timeMachine: { on: false, index: 0, playing: false },
  inspector: null,
  lab: false,
  scar: null,
  toasts: [],
  phone: false,
  webgl: true,
  me: null,
  menu: false,
};
const ls = new Set<() => void>();
let toastId = 0;

export const ui = {
  get: () => state,
  set(p: Partial<UIState>) {
    state = { ...state, ...p };
    for (const l of ls) l();
  },
  subscribe(l: () => void) {
    ls.add(l);
    return () => ls.delete(l);
  },
  toast(text: string, tone: Toast["tone"] = "bone", href?: string) {
    const t = { id: ++toastId, text, tone, href };
    ui.set({ toasts: [...state.toasts.slice(-3), t] });
    setTimeout(() => ui.set({ toasts: state.toasts.filter((x) => x.id !== t.id) }), 6000);
  },
};

export function useUI<T>(sel: (s: UIState) => T): T {
  return useSyncExternalStore(ui.subscribe, () => sel(state), () => sel(state));
}
