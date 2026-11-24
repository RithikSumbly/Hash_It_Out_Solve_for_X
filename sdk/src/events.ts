import { decodeEventLog, type Log } from "viem";
import { arenaAbi, crucibleAbi, firewallAbi, lineageAbi, vaultAbi } from "./abi";
import { verdictOf, type Verdict } from "./genome";
import type { Address, ArenaEvent, ContractName, Deployment, Hex, HoldStatus, HoldView } from "./types";

const ABIS = { vault: vaultAbi, arena: arenaAbi, firewall: firewallAbi, lineage: lineageAbi, crucible: crucibleAbi } as const;

/** Events the arena front end is driven by (plus the supporting ones). */
export const LIVE_EVENTS = [
  "Spend",
  "ShadowScored",
  "LabelRevealed",
  "Deposit",
  "HonestRegistered",
  "Delegated",
  "EpochStarted",
  "EpochClosed",
  "PolicySubmitted",
  "AttackSubmitted",
  "PolicyInstalled",
  "PolicyDied",
  "ChildBorn",
  "AttackBorn",
  "AttackDied",
  "AttackEpochResults",
  "Slashed",
  "Compensated",
  "Rewarded",
  "StakeReturned",
  "StakeForfeited",
  "BetPlaced",
  "BetSettled",
  "BetPaid",
  "Claimed",
  "PoolFunded",
  "Randomness",
  "GenomeInstalled",
  "Born",
  "Recorded",
  "CrucibleSet",
  "Sparred",
  "Proposed",
  "Held",
  "Released",
  "Vetoed",
  "GuardianSet",
  "Undelegated",
  "CrownKept",
  "Archived",
  "CanariesPassed",
] as const;

/** The contracts whose events drive the arena: the four core contracts, plus the Crucible when the deployment has one. */
export function eventAddresses(d: Deployment): `0x${string}`[] {
  const c = d.contracts;
  return [c.vault, c.arena, c.firewall, c.lineage, ...(c.crucible ? [c.crucible] : [])] as `0x${string}`[];
}

export function contractOf(d: Deployment, address: string): ContractName | null {
  const a = address.toLowerCase();
  for (const k of ["vault", "arena", "firewall", "lineage", "crucible"] as const) {
    const at = d.contracts[k];
    if (at && String(at).toLowerCase() === a) return k;
  }
  return null;
}

/** Decode a raw log from one of the arena's contracts into an ArenaEvent (null if unknown). */
export function decodeLog(d: Deployment, log: Log, timestamp = 0): ArenaEvent | null {
  const contract = contractOf(d, log.address);
  if (!contract || log.blockNumber == null || log.logIndex == null || !log.transactionHash) return null;
  try {
    const ev = decodeEventLog({ abi: ABIS[contract], data: log.data, topics: log.topics, strict: false }) as {
      eventName: string;
      args: Record<string, unknown> | readonly unknown[];
    };
    const args = Array.isArray(ev.args) ? Object.fromEntries(ev.args.map((v, i) => [String(i), v])) : { ...(ev.args as Record<string, unknown>) };
    return {
      id: `${log.blockNumber}-${log.logIndex}`,
      name: ev.eventName,
      contract,
      args,
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
      txHash: log.transactionHash as Hex,
      timestamp,
    };
  } catch {
    return null;
  }
}

export function sortEvents(a: ArenaEvent, b: ArenaEvent): number {
  if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
  return a.logIndex - b.logIndex;
}

// ---------------------------------------------------------------- verdicts and held payments

/** A Spend event's verdict (0 paid, 1 held, 2 refused); an older Spend has only `refused`. */
export function spendVerdict(e: Pick<ArenaEvent, "args">): Verdict {
  return verdictOf(e.args as { verdict?: unknown; refused?: unknown });
}

/** A ShadowScored event's fields: every candidate's verdict on one logged payment (including the hold mask). */
export function shadowScored(e: Pick<ArenaEvent, "args">) {
  const a = e.args as Record<string, unknown>;
  const liveRefused = Boolean(a.liveRefused);
  return {
    epoch: BigInt((a.epoch as bigint) ?? 0n),
    txId: BigInt((a.txId as bigint) ?? 0n),
    caller: String(a.caller ?? "") as Address,
    /** bit j = pool slot j would refuse it */
    shadowMask: Number(a.shadowMask ?? 0),
    /** bit j = pool slot j would hold it (0 on older deployments) */
    holdMask: Number(a.holdMask ?? 0),
    liveRefused,
    liveVerdict: verdictOf({ verdict: a.liveVerdict, refused: liveRefused }),
  };
}

/** Where a held payment stands at `block`: settled ones by their event, open ones by their release block. */
export function holdStatus(h: { status: HoldStatus; releaseBlock: bigint }, block: bigint): HoldStatus {
  if (h.status === "released" || h.status === "vetoed") return h.status;
  return block >= h.releaseBlock ? "releasable" : "waiting";
}

/**
 * Fold Held / Released / Vetoed events (in chain order) into the held payments, newest first. `block` (the chain's
 * current block) turns an open hold "releasable" once its release block has come.
 */
export function holdsFromEvents(events: Iterable<ArenaEvent>, block = 0n): HoldView[] {
  const byId = new Map<string, HoldView>();
  for (const e of events) {
    const a = e.args as Record<string, unknown>;
    if (e.name === "Held") {
      const id = BigInt(a.id as bigint);
      byId.set(id.toString(), {
        id,
        from: String(a.from) as Address,
        to: String(a.to) as Address,
        amount: BigInt(a.amount as bigint),
        releaseBlock: BigInt(a.releaseBlock as bigint),
        epoch: BigInt(a.epoch as bigint),
        txId: BigInt(a.txId as bigint),
        status: "waiting",
        heldTx: e.txHash,
        heldBlock: e.blockNumber,
      });
    } else if (e.name === "Released" || e.name === "Vetoed") {
      const h = byId.get(BigInt(a.id as bigint).toString());
      if (!h) continue;
      h.status = e.name === "Released" ? "released" : "vetoed";
      h.by = String(a.by) as Address;
      h.settledTx = e.txHash;
      h.settledBlock = e.blockNumber;
    }
  }
  return [...byId.values()].map((h) => ({ ...h, status: holdStatus(h, block) })).sort((x, y) => (x.id < y.id ? 1 : x.id > y.id ? -1 : 0));
}
