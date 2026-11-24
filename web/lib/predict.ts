import { explain, type AttackStep, type Explanation } from "@redqueen/sdk";

export interface StepPrediction extends Explanation {
  features: number[];
  amount: bigint;
  ratio: number; // score / threshold
}

export interface PredictContext {
  /** features the vault reports right now for step 1 (to = first recipient, amount = first amount) */
  base: number[];
  /** what the vault can pay now (its balance minus held payments) */
  balance: bigint;
  startBalance: bigint;
  genes: number[];
  /** the sender has an attack staked this round, so the attackers' limits apply (10% a payment, 20% a round for
   *  all attackers together) and a hold is refused (Vault.isAttacker) */
  attacker?: boolean;
  /** what attackers have taken this round so far (Vault.attackOutflow) */
  attackOutflow?: bigint;
}

/**
 * Predict the verdict of each step of an attack before signing. Step 1 uses the chain's own feature view;
 * later steps evolve velocity, gap, novelty, call depth, contract recipient and cumulative outflow the way
 * Vault.features() will, assuming earlier steps play out as predicted. There are three verdicts and the vault's hard limits;
 * a held step reserves its amount and counts toward the round's outflow at once, as a paid one does, but pays no one.
 * An attacker's step also meets the attackers' limits, and one the policy would hold is refused.
 */
export function predictSequence(ctx: PredictContext, steps: AttackStep[]): StepPrediction[] {
  const out: StepPrediction[] = [];
  let balance = ctx.balance;
  const start = ctx.startBalance > 0n ? ctx.startBalance : ctx.balance;
  const firstAmount = (ctx.balance * BigInt(steps[0]?.amountBps ?? 0)) / 10_000n;
  let outflow = (BigInt(ctx.base[7]) * start) / 1000n - firstAmount;
  if (outflow < 0n) outflow = 0n;
  let attackOutflow = ctx.attackOutflow ?? 0n;
  const priorVelocity = Math.round(ctx.base[2] / 200);
  const paid = new Map<string, number>();
  steps.forEach((s, k) => {
    const amount = (balance * BigInt(s.amountBps)) / 10_000n;
    const key = s.recipient === "fresh" ? `fresh-${k}` : s.recipient === "previous" ? (k > 0 ? lastKey(steps, k) : "self") : s.recipient;
    const timesPaid = paid.get(key) ?? 0;
    const f = [
      balance === 0n ? 1000 : Math.min(1000, Number((amount * 1000n) / balance)),
      k === 0 ? ctx.base[1] : s.recipient === "fresh" ? 1000 : Math.floor((key === "self" ? ctx.base[1] : 1000) / (1 + timesPaid)),
      Math.min(1000, (priorVelocity + k) * 200),
      k === 0 ? ctx.base[3] : s.delayBlocks > 0 ? Math.min(1000, s.delayBlocks * 10) : 10,
      ctx.base[4],
      s.route === "direct" ? 0 : 1000,
      s.recipient === "contract" ? 1000 : k === 0 ? ctx.base[6] : 0,
      start === 0n ? 1000 : Math.min(1000, Number(((outflow + amount) * 1000n) / start)),
    ];
    const ex = explain(ctx.genes, f, { amount, available: balance, startBalance: start, outflow, attacker: ctx.attacker, attackOutflow });
    out.push({ ...ex, features: f, amount, ratio: Number(ex.score) / 500_000 });
    if (!ex.refused) {
      balance -= amount;
      outflow += amount;
      if (!ex.held) paid.set(key, timesPaid + 1);
      if (ctx.attacker && !ex.held) attackOutflow += amount;
    }
  });
  return out;
}

function lastKey(steps: AttackStep[], k: number): string {
  for (let j = k - 1; j >= 0; j--) if (steps[j].recipient !== "previous") return steps[j].recipient === "fresh" ? `fresh-${j}` : steps[j].recipient;
  return "self";
}
