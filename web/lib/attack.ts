"use client";
import { parseAbiItem, type Address, type Hex } from "viem";
import type { RedQueen, SpendOutcome } from "@redqueen/sdk";
import { arena } from "./store";

/**
 * A visitor's attack payment, with the vault's one-hearing rule handled.
 *
 * The vault refuses an over-the-limit request and records it; a second one from the same wallet in the same round
 * reverts (HardLimit) instead of being logged, so one wallet cannot fill the round's log. To the visitor that is
 * still a refusal, so it is shown as one: the refusal this wallet already has on the record this round.
 */
export type AttackOutcome = SpendOutcome & { repeat?: boolean };

const SPEND = parseAbiItem(
  "event Spend(address indexed caller, address indexed to, uint256 amount, bool refused, uint256 reason, uint256 score, uint256 indexed epoch, uint256 txId, uint8 kind, uint256 features, uint256 balanceAfter, uint8 verdict)",
);

/** each wallet's latest refusal sent from this page */
const lastRefusal = new Map<string, AttackOutcome>();

export async function attackSpend(rq: RedQueen, me: Address, o: { to: Address; amount: bigint }): Promise<AttackOutcome> {
  try {
    const out = await rq.spend({ ...o, label: "attack" });
    if (out.refused) lastRefusal.set(me.toLowerCase(), out);
    return out;
  } catch (e) {
    if (!/HardLimit|0x7675135a/i.test(String((e as { message?: string })?.message ?? e))) throw e;
    const earlier = await earlierRefusal(rq, me);
    if (!earlier) throw e;
    return earlier;
  }
}

/** This wallet's latest refusal on the record: from the page's history first, else from the vault's recent log. */
async function earlierRefusal(rq: RedQueen, me: Address): Promise<AttackOutcome | null> {
  const mine = me.toLowerCase();
  const sent = lastRefusal.get(mine);
  if (sent) return { ...sent, repeat: true };
  const row = [...arena.get().spends].reverse().find((s) => s.caller.toLowerCase() === mine && s.refused);
  if (row)
    return {
      hash: row.txHash as Hex,
      verdict: 2,
      refused: true,
      held: false,
      reason: row.reason,
      score: row.score,
      epoch: row.epoch,
      txId: row.txId,
      features: 0n,
      balanceAfter: row.balanceAfter,
      repeat: true,
    } as AttackOutcome;
  try {
    const head = await rq.pub.getBlockNumber();
    const logs = await rq.pub.getLogs({
      address: rq.vault,
      event: SPEND,
      args: { caller: me },
      fromBlock: head > 1999n ? head - 1999n : 0n,
      toBlock: head,
    });
    const l = [...logs].reverse().find((x) => x.args.refused);
    if (!l) return null;
    const a = l.args;
    return {
      hash: l.transactionHash as Hex,
      verdict: 2,
      refused: true,
      held: false,
      reason: a.reason ?? 0n,
      score: a.score ?? 0n,
      epoch: a.epoch ?? 0n,
      txId: a.txId ?? 0n,
      features: a.features ?? 0n,
      balanceAfter: a.balanceAfter ?? 0n,
      repeat: true,
    } as AttackOutcome;
  } catch {
    return null;
  }
}

export const REPEAT_LINE =
  "Refused before it was even logged: she already refused you once this round for asking over the cap, and a second one doesn't get a hearing. Your refusal is on the record. Try a different attack, or come back next round.";
