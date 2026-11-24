"use client";
import type { ArenaEvent, ArenaSnapshot, RelayMode } from "@redqueen/sdk";
import { quantize } from "./tempo";

export type BusEvent =
  | { type: "chain"; event: ArenaEvent; replay: boolean }
  | { type: "snapshot"; snapshot: ArenaSnapshot }
  | { type: "mode"; mode: RelayMode }
  /** the visitor's own pending transaction (Try it / Attack lab) */
  | { type: "own-attack"; hash: string; amount: bigint; label: string }
  /** attack-lab preview: predicted scores per step, drawn on the shield rim */
  | { type: "lab-preview"; steps: { ratio: number; refused: boolean; held?: boolean }[] }
  | { type: "cinematic"; on: boolean }
  /** she refused something said to her (an injection, a request for code): her glass flashes as for a drain */
  | { type: "queen-refuses" };

type Listener = (e: BusEvent) => void;

const listeners = new Set<Listener>();

/**
 * One shared heartbeat. Chain events are released on the next tempo subdivision so that events landing in
 * the same block (or within ~150 ms) fire together as a chord instead of a smear.
 */
export const bus = {
  on(l: Listener) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
  emit(e: BusEvent) {
    if (e.type !== "chain") {
      for (const l of listeners) l(e);
      return;
    }
    const delay = quantize(performance.now()) - performance.now();
    setTimeout(() => {
      for (const l of listeners) l(e);
    }, Math.max(0, delay));
  },
};
