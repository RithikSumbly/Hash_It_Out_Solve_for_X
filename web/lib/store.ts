"use client";
/**
 * The arena's single source of truth on the client: everything on the page is derived from contract
 * events streamed by the relay (or, if the relay is unreachable, read straight from the chain).
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { holdStatus, spendVerdict, unpack, unpackFeatures, type ArenaEvent, type ArenaSnapshot, type Deployment, type HoldStatus, type RelayMode, type Verdict } from "@redqueen/sdk";
import { bus } from "./bus";
import { CHAIN_ID } from "./config";

export interface SpendRow {
  id: string;
  caller: string;
  to: string;
  amount: bigint;
  /** 0 paid, 1 held, 2 refused */
  verdict: Verdict;
  /** verdict === 2 (false on a hold) */
  refused: boolean;
  /** the hold this payment became, when it was held */
  holdId?: bigint;
  reason: bigint;
  score: bigint;
  epoch: bigint;
  txId: bigint;
  kind: number;
  features: number[];
  balanceAfter: bigint;
  txHash: string;
  block: bigint;
  t: number;
  replay?: boolean;
}

/** A held payment, from its Held event, settled by a Released or Vetoed one. */
export interface HoldRow {
  id: bigint;
  from: string;
  to: string;
  amount: bigint;
  releaseBlock: bigint;
  epoch: bigint;
  txId: bigint;
  txHash: string;
  block: bigint;
  t: number;
  settled?: "released" | "vetoed";
  by?: string;
  settledTx?: string;
  settledT?: number;
}

export interface InstallRow {
  id: bigint;
  generation: number;
  parentA: bigint;
  parentB: bigint;
  fitness: bigint;
  epoch: bigint;
  genes: number[];
  root: bigint;
  txHash: string;
  block: bigint;
  t: number;
  index: number; // install sequence (era generation)
}

/** A policy proposed through the Crucible and the chain's verdict on it (0 accepted; see PROPOSAL_VERDICTS). */
export interface ProposalRow {
  proposer: string;
  id: bigint;
  epoch: bigint;
  verdict: number;
  honestRefused: bigint;
  /** ppm of the vault the current attackers would take from it on average */
  lost: bigint;
  fitness: bigint;
  championFitness: bigint;
  txHash: string;
  block: bigint;
  t: number;
}

export interface Node {
  id: bigint;
  parentA: bigint;
  parentB: bigint;
  root: bigint;
  generation: number;
  epoch: number;
  genes: number[];
  alive: boolean;
  bornT: number;
  diedT?: number;
  submitter?: string;
  txHash?: string;
  block?: bigint;
  mutGenes?: number[];
}

export interface EpochRow {
  epoch: bigint;
  champion: bigint;
  ids: bigint[];
  fitness: bigint[];
  retained: bigint[];
  /** wei each candidate's mistakes on honest payments cost (Arena.EpochClosed.honestCost) */
  honestCost: bigint[];
  txCount: bigint;
  seed: bigint;
  liveDuring?: bigint;
  liveRetained: bigint;
  liveHonestCost: bigint;
  txHash: string;
  block: bigint;
  t: number;
}

export interface BalancePoint {
  t: number;
  block: bigint;
  balance: bigint;
  txHash: string;
}

export interface ArenaState {
  status: "connecting" | "open" | "closed";
  deployment: Deployment | null;
  snapshot: ArenaSnapshot | null;
  mode: RelayMode;
  events: ArenaEvent[];
  spends: SpendRow[];
  installs: InstallRow[];
  nodes: Map<string, Node>;
  epochs: EpochRow[];
  balance: BalancePoint[];
  bets: { epoch: bigint; bettor: string; lineage: bigint; amount: bigint; txHash: string }[];
  proposals: ProposalRow[];
  /** every held payment by id */
  holds: Map<string, HoldRow>;
  lastRandom: { epoch: bigint; seed: bigint; source: number; txHash: string } | null;
  /** when the last snapshot arrived, to count blocks between snapshots */
  clock: ChainClock | null;
  version: number;
  loaded: boolean;
}

/** The chain's block, as last seen, and the pace of its blocks (for countdowns between snapshots). */
export interface ChainClock {
  block: bigint;
  at: number;
  msPerBlock: number;
}

const initial: ArenaState = {
  status: "connecting",
  deployment: null,
  snapshot: null,
  mode: { replay: false, speed: 4 },
  events: [],
  spends: [],
  installs: [],
  nodes: new Map(),
  epochs: [],
  balance: [],
  bets: [],
  proposals: [],
  holds: new Map(),
  lastRandom: null,
  clock: null,
  version: 0,
  loaded: false,
};

/** Base makes a block every 0.2 s; elsewhere the pace is measured from the snapshots as they arrive. */
const FIXED_MS = CHAIN_ID === 84532 ? 200 : CHAIN_ID === 11155111 ? 12_000 : 0;
let firstSeen: { block: bigint; at: number } | null = null;
let seen = 0;
function tickClock(block: bigint): ChainClock {
  const at = Date.now();
  // the first snapshot can be old when it arrives (the relay's hello): the pace is measured from the second on
  if (++seen === 2 || !firstSeen || block < firstSeen.block) firstSeen = { block, at };
  const db = Number(block - firstSeen.block);
  const measured = db >= 5 ? (at - firstSeen.at) / db : 0;
  return { block, at, msPerBlock: FIXED_MS || measured || state.clock?.msPerBlock || 2000 };
}

let state: ArenaState = initial;
const listeners = new Set<() => void>();

function commit(next: Partial<ArenaState>) {
  state = { ...state, ...next, version: state.version + 1 };
  for (const l of listeners) l();
}

export const arena = {
  get: () => state,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  setStatus(s: ArenaState["status"]) {
    commit({ status: s });
  },
  setDeployment(d: Deployment) {
    commit({ deployment: d });
  },
  setSnapshot(s: ArenaSnapshot) {
    commit({ snapshot: s, clock: tickClock(s.blockNumber) });
    bus.emit({ type: "snapshot", snapshot: s });
  },
  setMode(m: RelayMode) {
    commit({ mode: m });
    bus.emit({ type: "mode", mode: m });
  },
  /** Bulk-load history (no animations). */
  load(history: ArenaEvent[]) {
    const s = fresh();
    for (const e of history) apply(s, e, false);
    commit({ ...s, events: history.slice(), loaded: true });
  },
  /** A live (or replayed) event: update state and fire the choreography. */
  push(e: ArenaEvent) {
    if (e.replay) {
      bus.emit(toBusEvent(e, true));
      return;
    }
    if (state.events.length && state.events[state.events.length - 1].id === e.id) return;
    const s: Mutable = {
      spends: state.spends,
      installs: state.installs,
      nodes: state.nodes,
      epochs: state.epochs,
      balance: state.balance,
      bets: state.bets,
      proposals: state.proposals,
      holds: state.holds,
      lastRandom: state.lastRandom,
    };
    // copy-on-write for the slices this event touches
    apply(s, e, true);
    const events = state.events.length > 30000 ? state.events.slice(-20000) : state.events.slice();
    events.push(e);
    commit({ ...s, events });
    bus.emit(toBusEvent(e, false));
  },
};

type Mutable = Pick<ArenaState, "spends" | "installs" | "nodes" | "epochs" | "balance" | "bets" | "proposals" | "holds" | "lastRandom">;

function fresh(): Mutable {
  return { spends: [], installs: [], nodes: new Map(), epochs: [], balance: [], bets: [], proposals: [], holds: new Map(), lastRandom: null };
}

const a = <T,>(e: ArenaEvent, k: string) => e.args[k] as T;

function apply(s: Mutable, e: ArenaEvent, cow: boolean) {
  switch (e.name) {
    case "Spend": {
      const verdict = spendVerdict(e);
      // a held payment's Held event comes first in the same transaction
      let holdId: bigint | undefined;
      if (verdict === 1) for (const h of s.holds.values()) if (h.txHash === e.txHash) holdId = h.id;
      const row: SpendRow = {
        id: e.id,
        caller: a<string>(e, "caller"),
        to: a<string>(e, "to"),
        amount: a<bigint>(e, "amount"),
        verdict,
        refused: verdict === 2,
        holdId,
        reason: a<bigint>(e, "reason"),
        score: a<bigint>(e, "score"),
        epoch: a<bigint>(e, "epoch"),
        txId: a<bigint>(e, "txId"),
        kind: Number(a<number>(e, "kind")),
        features: unpackFeatures(a<bigint>(e, "features")),
        balanceAfter: a<bigint>(e, "balanceAfter"),
        txHash: e.txHash,
        block: e.blockNumber,
        t: e.timestamp,
      };
      s.spends = cow ? [...s.spends.slice(-4000), row] : (s.spends.push(row), s.spends);
      const bp = { t: e.timestamp, block: e.blockNumber, balance: row.balanceAfter, txHash: e.txHash };
      s.balance = cow ? [...s.balance.slice(-8000), bp] : (s.balance.push(bp), s.balance);
      break;
    }
    case "Held": {
      const id = a<bigint>(e, "id");
      const row: HoldRow = {
        id,
        from: a<string>(e, "from"),
        to: a<string>(e, "to"),
        amount: a<bigint>(e, "amount"),
        releaseBlock: a<bigint>(e, "releaseBlock"),
        epoch: a<bigint>(e, "epoch"),
        txId: a<bigint>(e, "txId"),
        txHash: e.txHash,
        block: e.blockNumber,
        t: e.timestamp,
      };
      if (cow) s.holds = new Map(s.holds);
      s.holds.set(id.toString(), row);
      break;
    }
    case "Released":
    case "Vetoed": {
      const key = a<bigint>(e, "id").toString();
      const h = s.holds.get(key);
      if (!h) break;
      if (cow) s.holds = new Map(s.holds);
      s.holds.set(key, { ...h, settled: e.name === "Released" ? "released" : "vetoed", by: a<string>(e, "by"), settledTx: e.txHash, settledT: e.timestamp });
      break;
    }
    case "Deposit": {
      const bp = { t: e.timestamp, block: e.blockNumber, balance: a<bigint>(e, "balance"), txHash: e.txHash };
      s.balance = cow ? [...s.balance.slice(-8000), bp] : (s.balance.push(bp), s.balance);
      break;
    }
    case "PolicyInstalled": {
      const lo = a<bigint>(e, "lo");
      const hi = a<bigint>(e, "hi");
      const row: InstallRow = {
        id: a<bigint>(e, "id"),
        generation: Number(a<number>(e, "generation")),
        parentA: a<bigint>(e, "parentA"),
        parentB: a<bigint>(e, "parentB"),
        fitness: a<bigint>(e, "fitness"),
        epoch: a<bigint>(e, "epoch"),
        genes: unpack(lo, hi),
        root: a<bigint>(e, "root"),
        txHash: e.txHash,
        block: e.blockNumber,
        t: e.timestamp,
        index: s.installs.length + 1,
      };
      s.installs = cow ? [...s.installs, row] : (s.installs.push(row), s.installs);
      // genesis has no Born-with-genes event in the arena; make sure the node exists
      ensureNode(s, cow, row.id, { genes: row.genes, root: row.root, generation: row.generation, epoch: Number(row.epoch), t: e.timestamp });
      break;
    }
    case "Born": {
      ensureNode(s, cow, a<bigint>(e, "id"), {
        parentA: a<bigint>(e, "parentA"),
        parentB: a<bigint>(e, "parentB"),
        root: a<bigint>(e, "root"),
        generation: Number(a<number>(e, "generation")),
        epoch: Number(a<number>(e, "epoch")),
        t: e.timestamp,
        txHash: e.txHash,
        block: e.blockNumber,
      });
      break;
    }
    case "PolicySubmitted": {
      ensureNode(s, cow, a<bigint>(e, "id"), {
        genes: unpack(a<bigint>(e, "lo"), a<bigint>(e, "hi")),
        submitter: a<string>(e, "submitter"),
        t: e.timestamp,
      });
      break;
    }
    case "ChildBorn": {
      const mg = a<readonly number[]>(e, "mutGenes");
      ensureNode(s, cow, a<bigint>(e, "id"), {
        genes: unpack(a<bigint>(e, "lo"), a<bigint>(e, "hi")),
        parentA: a<bigint>(e, "parentA"),
        parentB: a<bigint>(e, "parentB"),
        t: e.timestamp,
        mutGenes: mg ? Array.from(mg, Number) : undefined,
      });
      break;
    }
    case "PolicyDied": {
      const id = a<bigint>(e, "id");
      const n = s.nodes.get(id.toString());
      if (n) {
        if (cow) s.nodes = new Map(s.nodes);
        s.nodes.set(id.toString(), { ...n, alive: false, diedT: e.timestamp });
      }
      break;
    }
    case "EpochClosed": {
      const ids = (a<readonly bigint[]>(e, "ids") ?? []).slice();
      const retained = (a<readonly bigint[]>(e, "retained") ?? []).slice();
      // the field is honestCost (wei); logs from the first deployment call it falseRefusals (a count)
      const honestCost = (a<readonly bigint[]>(e, "honestCost") ?? a<readonly bigint[]>(e, "falseRefusals") ?? []).slice();
      // the policy that was live DURING this epoch was installed at an earlier close (PolicyInstalled for this
      // epoch is emitted earlier in the same transaction and is the NEW champion)
      const closing = a<bigint>(e, "epoch");
      const liveDuring = [...s.installs].reverse().find((i) => i.epoch < closing)?.id;
      const k = liveDuring !== undefined ? ids.findIndex((x) => x === liveDuring) : -1;
      const row: EpochRow = {
        epoch: a<bigint>(e, "epoch"),
        champion: a<bigint>(e, "champion"),
        ids,
        fitness: (a<readonly bigint[]>(e, "fitness") ?? []).slice(),
        retained,
        honestCost,
        txCount: a<bigint>(e, "txCount"),
        seed: a<bigint>(e, "seed"),
        liveDuring,
        liveRetained: k >= 0 ? retained[k] : 0n,
        liveHonestCost: k >= 0 ? honestCost[k] : 0n,
        txHash: e.txHash,
        block: e.blockNumber,
        t: e.timestamp,
      };
      s.epochs = cow ? [...s.epochs, row] : (s.epochs.push(row), s.epochs);
      break;
    }
    case "BetPlaced": {
      const b = { epoch: a<bigint>(e, "epoch"), bettor: a<string>(e, "bettor"), lineage: a<bigint>(e, "lineage"), amount: a<bigint>(e, "amount"), txHash: e.txHash };
      s.bets = cow ? [...s.bets.slice(-2000), b] : (s.bets.push(b), s.bets);
      break;
    }
    case "Proposed": {
      const row: ProposalRow = {
        proposer: a<string>(e, "proposer"),
        id: a<bigint>(e, "id"),
        epoch: a<bigint>(e, "epoch"),
        verdict: Number(a<number>(e, "verdict")),
        honestRefused: a<bigint>(e, "honestRefused"),
        lost: a<bigint>(e, "lost"),
        fitness: a<bigint>(e, "fitness"),
        championFitness: a<bigint>(e, "championFitness"),
        txHash: e.txHash,
        block: e.blockNumber,
        t: e.timestamp,
      };
      s.proposals = cow ? [...s.proposals.slice(-200), row] : (s.proposals.push(row), s.proposals);
      break;
    }
    case "Randomness": {
      s.lastRandom = { epoch: a<bigint>(e, "epoch"), seed: a<bigint>(e, "seed"), source: Number(a<number>(e, "source")), txHash: e.txHash };
      break;
    }
  }
}

function ensureNode(
  s: Mutable,
  cow: boolean,
  id: bigint,
  patch: Partial<Omit<Node, "id" | "bornT">> & { t: number },
) {
  const key = id.toString();
  const prev = s.nodes.get(key);
  const { t, ...rest } = patch;
  const base: Node = prev ?? {
    id,
    parentA: 0n,
    parentB: 0n,
    root: id,
    generation: 0,
    epoch: 0,
    genes: new Array(32).fill(0),
    alive: true,
    bornT: t,
  };
  const next: Node = { ...base };
  for (const [k, v] of Object.entries(rest)) if (v !== undefined) (next as unknown as Record<string, unknown>)[k] = v;
  if (cow) s.nodes = new Map(s.nodes);
  s.nodes.set(key, next);
}

function toBusEvent(e: ArenaEvent, replay: boolean): import("./bus").BusEvent {
  return { type: "chain", event: e, replay };
}

// ---------------------------------------------------------------- hooks

export function useArena<T>(select: (s: ArenaState) => T): T {
  return useSyncExternalStore(
    arena.subscribe,
    () => select(state),
    () => select(initial),
  );
}

const ZERO_GENES: number[] = new Array(32).fill(0);

/** Stable reference (safe as a useSyncExternalStore selector). */
export function liveGenes(s: ArenaState): number[] {
  if (s.snapshot) return s.snapshot.live.genes;
  if (s.installs.length) return s.installs[s.installs.length - 1].genes;
  return ZERO_GENES;
}

// ---------------------------------------------------------------- held payments, live

/** The chain's block now, counted on from the last snapshot at the chain's pace. */
export function blockNow(c: ChainClock | null, now = Date.now()): bigint {
  if (!c) return 0n;
  return c.block + BigInt(Math.max(0, Math.floor((now - c.at) / c.msPerBlock)));
}

/** A held payment's standing now: waiting (with blocks and seconds left), releasable, released or vetoed. */
export interface HoldLive {
  status: HoldStatus;
  blocksLeft: number;
  secondsLeft: number;
}

export function holdLive(h: HoldRow, c: ChainClock | null, now = Date.now()): HoldLive {
  const block = blockNow(c, now);
  const status = h.settled ?? holdStatus({ status: "waiting", releaseBlock: h.releaseBlock }, c ? block : 0n);
  const blocksLeft = status === "waiting" ? Math.max(0, Number(h.releaseBlock - block)) : 0;
  return { status, blocksLeft, secondsLeft: Math.ceil((blocksLeft * (c?.msPerBlock ?? 200)) / 1000) };
}

/** Re-render on a timer while something counts down (a held payment's wait). */
export function useTicker(ms = 1000, on = true): number {
  const [t, setT] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => setT(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms, on]);
  return t;
}
