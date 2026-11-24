"use client";
/**
 * One real attack, on request, for visitors without a wallet (the tour and the siege's "send one" button).
 * The demo service (bots/src/demo.ts) sends it from its own attacker wallet; the verdict arrives here and,
 * like every other transaction, through the relay as a Spend event (the ink, the red splash, the glass).
 */
import { useSyncExternalStore } from "react";
import { unpackFeatures } from "@redqueen/sdk";
import { DEMO_URL } from "./config";

export interface DemoResult {
  hash: string;
  /** 0 paid, 1 held, 2 refused, when the demo service sends it (else read the Spend event on the record) */
  verdict?: number;
  refused: boolean;
  reason: bigint;
  score: bigint;
  amount: bigint;
  block: bigint;
  caller: string;
  returned: boolean;
  /** the eight measurements the contract took (0..1000 each), from the Spend event */
  features: number[];
  balanceAfter: bigint;
}

export interface DemoState {
  status: "idle" | "sending" | "done" | "error";
  result: DemoResult | null;
  error: string | null;
  at: number;
}

let state: DemoState = { status: "idle", result: null, error: null, at: 0 };
const ls = new Set<() => void>();
const set = (p: Partial<DemoState>) => {
  state = { ...state, ...p };
  for (const l of ls) l();
};

export const demo = {
  get: () => state,
  subscribe(l: () => void) {
    ls.add(l);
    return () => ls.delete(l);
  },
  async fire(): Promise<DemoResult | null> {
    if (state.status === "sending") return null;
    set({ status: "sending", error: null, at: Date.now() });
    try {
      if (!DEMO_URL) throw new Error("the live demo attack is not connected on this site");
      const r = await fetch(`${DEMO_URL}/attack`, { method: "POST" });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error ?? `the demo service answered ${r.status}`);
      const result: DemoResult = {
        hash: j.hash,
        verdict: j.verdict !== undefined && j.verdict !== null ? Number(j.verdict) : j.held ? 1 : undefined,
        refused: Boolean(j.refused),
        reason: BigInt(j.reason),
        score: BigInt(j.score),
        amount: BigInt(j.amount),
        block: BigInt(j.block),
        caller: j.caller,
        returned: Boolean(j.returned),
        features: j.features !== undefined ? unpackFeatures(BigInt(j.features)) : [],
        balanceAfter: BigInt(j.balanceAfter ?? 0),
      };
      set({ status: "done", result, at: Date.now() });
      return result;
    } catch (e) {
      set({ status: "error", error: (e as Error).message, at: Date.now() });
      return null;
    }
  },
};

export function useDemo<T>(sel: (s: DemoState) => T): T {
  return useSyncExternalStore(demo.subscribe, () => sel(state), () => sel(state));
}
