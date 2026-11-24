import { ATTACK_PRESETS, encodeAttack, pack, packFeatures, policyGenes, type Genes } from "./genome";

/**
 * Arena the deploy-time configuration. contracts/scripts/deploy.ts deploys exactly this, and the contract
 * tests check it, so the site and the queen can rely on the same numbers.
 */

/**
 * The genesis policy, live from the first block. Amount weight 1500 and outflow weight 500 (limit 500,000):
 *   a 40% drain scores 800,000 and a 50% payment 1,000,000: refused;
 *   anything above about a quarter of the vault in one payment is refused;
 *   a 0.4–1.2% payment scores 6,000–18,000 plus 500 per point of this epoch's outflow: it passes unless the
 *   vault has already lost almost everything this epoch.
 * Salami slices and new-recipient bursts get through: those are the gaps evolution has to close.
 */
export const V2_GENESIS: Genes = policyGenes({ weights: { 0: 1500, 7: 500 } });

/** Attack plans in the attack pool from deploy (the five scripted attacks), so the attackers exist from the first close. */
export const V2_SEED_ATTACKS = ["drain", "salami", "burst", "delegate", "hop"] as const;

export function v2SeedAttackGenomes(): { lo: bigint; hi: bigint }[] {
  return V2_SEED_ATTACKS.map((n) => pack(encodeAttack(ATTACK_PRESETS[n].steps)));
}

/**
 * The honest bench: everyday payments the arena must never refuse, as the eight features the Vault would compute
 * (f0 amount share, f1 recipient novelty, f2 velocity, f3 gap, f4 reputation, f5 call depth, f6 contract
 * recipient, f7 epoch outflow; each 0..1000). The Crucible plays every candidate policy against it at every
 * close; refusing one costs more than losing the whole vault. Reputation 500 is a wallet registered a moment
 * ago (a judge who just connected), 800 a long-registered one.
 */
export const V2_HONEST_BENCH: { label: string; f: number[] }[] = [
  { label: "new wallet, first payment, 1.2% to someone new", f: [12, 1000, 0, 1000, 500, 0, 0, 12] },
  { label: "new wallet, a second 0.4% payment soon after", f: [4, 1000, 200, 30, 500, 0, 0, 16] },
  { label: "new wallet pays the same friend again, 0.8%", f: [8, 500, 400, 20, 500, 0, 0, 24] },
  { label: "known wallet, routine 1% to a regular payee", f: [10, 250, 0, 1000, 800, 0, 0, 10] },
  { label: "known wallet, weekly 15% withdrawal", f: [150, 1000, 0, 1000, 800, 0, 0, 160] },
  { label: "known wallet funds its agent contract, 2%", f: [20, 1000, 0, 1000, 800, 0, 1000, 30] },
  { label: "the agent pays on its owner's behalf, 1%", f: [10, 500, 200, 50, 800, 1000, 0, 40] },
  { label: "new wallet, 1% while the vault is draining (30% gone)", f: [10, 1000, 0, 1000, 500, 0, 0, 310] },
  { label: "known wallet, two quick payments", f: [10, 333, 400, 10, 800, 0, 0, 50] },
  { label: "new wallet pays a contract (a dapp), 1%", f: [10, 1000, 0, 1000, 500, 0, 1000, 20] },
];

export function v2HonestBenchPacked(): bigint[] {
  return V2_HONEST_BENCH.map((b) => packFeatures(b.f));
}

export const V2_DEFAULTS = {
  /** wei */
  policyStake: 500_000_000_000_000n, // 0.0005 ETH
  attackStake: 200_000_000_000_000n, // 0.0002 ETH
  minBet: 100_000_000_000_000n, // 0.0001 ETH
  closeTip: 20_000_000_000_000n, // 0.00002 ETH, from the protocol pool to whoever closes an epoch
  /** each of a child's 2 mutations moves a gene by ±(1..mutationScale) */
  mutationScale: 1000,
  /** ppm of the vault per refused honest bench payment (1,000,000 = a full drain) */
  lambdaBench: 1_000_000,
  /** reputation the Crucible's simulated attackers carry (an honest-registered insider) */
  insiderRep: 500,
} as const;

/** Crucible.propose / Proposed.verdict */
export const PROPOSAL_VERDICTS = ["accepted", "refuses an honest payment", "weaker than the live champion", "already proposed this epoch", "the pool is full", "lets a drain canary through", "not monotone: a bigger or later payment could score lower"] as const;
