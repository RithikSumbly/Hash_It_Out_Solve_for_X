import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { RedQueen, SpendOutcome } from "./client";
import { decodeAttack, type AttackStep, type Genes } from "./genome";
import type { Address } from "./types";
import { KIND } from "./types";

export interface ExecuteOptions {
  /** wait for N blocks (default: poll the chain). Override in tests / simulations. */
  waitBlocks?: (n: number) => Promise<void>;
  /** reuse an agent proxy across steps / epochs */
  agent?: Address;
  /** extra contract recipient for "contract" mode (defaults to the agent itself) */
  contractRecipient?: Address;
  onStep?: (i: number, step: AttackStep, out: SpendOutcome | null) => void;
  /** stop early (e.g. epoch about to close) */
  shouldStop?: () => boolean | Promise<boolean>;
  /** repeat the decoded template (judge "burst count") */
  repeat?: number;
}

/** Execute an 8-step attack genome against the vault, step by step, exactly as the genome encodes it. */
export async function executeAttack(rq: RedQueen, genes: Genes, o: ExecuteOptions = {}) {
  const steps = decodeAttack(genes).filter((s) => s.amountBps > 0);
  const me = rq.account;
  let agent = o.agent;
  let previous: Address = me;
  const results: (SpendOutcome | null)[] = [];
  const waitBlocks =
    o.waitBlocks ??
    (async (n: number) => {
      if (n <= 0) return;
      const start = await rq.pub.getBlockNumber();
      while ((await rq.pub.getBlockNumber()) < start + BigInt(n)) await new Promise((r) => setTimeout(r, 1500));
    });
  const ensureAgent = async () => (agent ??= await rq.deployAgent());
  const runs = Math.max(1, o.repeat ?? 1);
  let i = 0;
  for (let rep = 0; rep < runs; rep++) {
    for (const step of steps) {
      if (o.shouldStop && (await o.shouldStop())) return { results, agent };
      await waitBlocks(step.delayBlocks);
      // a share of what the vault can pay (held payments are reserved and cannot be asked for)
      const balance = await rq.vaultAvailable();
      const amount = (balance * BigInt(step.amountBps)) / 10_000n;
      if (amount === 0n) continue;
      let to: Address;
      if (step.recipient === "self") to = me;
      else if (step.recipient === "fresh") to = privateKeyToAccount(generatePrivateKey()).address;
      else if (step.recipient === "contract") to = o.contractRecipient ?? (await ensureAgent());
      else to = previous;
      previous = to;
      let out: SpendOutcome | null = null;
      try {
        if (step.route === "direct") {
          out = await rq.spend({ to, amount, label: "attack" });
        } else if (step.route === "agent") {
          const a = await ensureAgent();
          out = await rq.agentSpend(a, { to: to === a ? me : to, amount });
        } else {
          const a = await ensureAgent();
          const seed = amount / 20n || 1n;
          await rq.spend({ to: a, amount: seed, kind: KIND.DELEGATE, label: "attack" });
          out = await rq.agentSpend(a, { to: to === a ? me : to, amount });
        }
      } catch (e) {
        out = null;
      }
      results.push(out);
      o.onStep?.(i++, step, out);
    }
  }
  return { results, agent };
}
