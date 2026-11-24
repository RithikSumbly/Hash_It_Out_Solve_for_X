/**
 * Genome math — a bit-exact TypeScript mirror of contracts/lib/GenomeLib.sol.
 * Used by the arena (predicted score before signing), the bots, the tests and external agents.
 * Pure, dependency-free, works in Node and the browser.
 */

export const GENES = 32;
export const FEATURES = 8;
export const FEATURE_MAX = 1000;
export const GLOBAL_THRESHOLD = 500_000n;
/** a score above this (and not above GLOBAL_THRESHOLD) holds the payment instead of paying it. Fixed, not evolved. */
export const HOLD_THRESHOLD = 350_000n;
export const INTERACTION_SCALE = 1000n;

/** the three verdicts (Spend.verdict, previewSpend, getTx, ShadowScored.liveVerdict). */
export const VERDICT = { PAID: 0, HELD: 1, REFUSED: 2 } as const;
export type Verdict = (typeof VERDICT)[keyof typeof VERDICT];
export const VERDICT_WORDS = ["paid", "held", "refused"] as const;

/** The hard limits under every policy (Vault.MAX_SPEND_BPS / MAX_ROUND_OUTFLOW_BPS), with their reason bits. */
export const MAX_SPEND_BPS = 5000n;
export const MAX_ROUND_OUTFLOW_BPS = 5000n;
/** one payment over half of what the vault can pay */
export const REASON_SPEND_CAP = 1n << 16n;
/** the round's payments past half of the round's start balance */
export const REASON_ROUND_CAP = 1n << 17n;
/** tighter limits for attackers (a wallet with an attack staked this round, a contract it calls through, or its
 *  agent): one payment at most 10% of what the vault can pay, all attackers' payments in a round at most 20% of the
 *  round's start balance (Vault.ATTACK_SPEND_BPS / ATTACK_ROUND_BPS). */
export const ATTACK_SPEND_BPS = 1000n;
export const ATTACK_ROUND_BPS = 2000n;
/** an attacker's payment over a tenth of what the vault can pay */
export const REASON_ATTACK_SPEND_CAP = 1n << 18n;
/** the round's attacker payouts past a fifth of the round's start balance */
export const REASON_ATTACK_ROUND_CAP = 1n << 19n;
/** a payment the policy would hold, asked for by an attacker: refused instead */
export const REASON_ATTACK_HOLD = 1n << 20n;

export type Genes = number[]; // length 32, each int16
export type Features = number[]; // length 8, each 0..1000

export const FEATURE_KEYS = ["f0", "f1", "f2", "f3", "f4", "f5", "f6", "f7"] as const;

export const FEATURE_NAMES = [
  "Amount share",
  "Recipient novelty",
  "Velocity",
  "Time since last",
  "Reputation",
  "Call depth",
  "Contract recipient",
  "Epoch outflow",
] as const;

export const FEATURE_DESCRIPTIONS = [
  "Amount as a share of the vault balance",
  "1000 if the recipient was never paid, decays with every payment",
  "Spends by this caller in the last 20 blocks",
  "Blocks since the caller's last spend, capped at 100",
  "Honest registration, age and ERC-8004 identity",
  "Called through a contract (tx.origin != msg.sender)",
  "Recipient has code",
  "Cumulative outflow this epoch as a share of the epoch-start balance",
] as const;

/** Interaction pair k = (a, b) — must match GenomeLib.PAIRS. */
export const PAIRS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [0, 7],
  [1, 2],
  [2, 7],
  [5, 6],
  [0, 5],
  [2, 3],
  [6, 7],
];

export const PAIR_NAMES = [
  "Big payment to a stranger",
  "Big payment while draining",
  "New-recipient burst",
  "Salami slicing",
  "Contract hop",
  "Delegated drain",
  "Rapid repeat",
  "Contract sink under outflow",
] as const;

/** Reason bit -> words. Bits 0..7 linear features, 8..15 interactions, 16..17 the hard limits, 18..20 the
 *  attackers' limits. */
export const REASON_WORDS = [
  "LARGE_AMOUNT",
  "NEW_RECIPIENT",
  "HIGH_VELOCITY",
  "TIMING",
  "REPUTATION",
  "CALL_DEPTH",
  "CONTRACT_RECIPIENT",
  "EPOCH_OUTFLOW",
  "AMOUNT×NOVELTY",
  "AMOUNT×OUTFLOW",
  "NOVELTY×VELOCITY",
  "SALAMI",
  "CONTRACT_HOP",
  "DELEGATED_DRAIN",
  "RAPID_REPEAT",
  "CONTRACT_SINK",
  "SPEND_CAP",
  "ROUND_CAP",
  "ATTACK_SPEND_CAP",
  "ATTACK_ROUND_CAP",
  "ATTACK_HOLD",
] as const;

export function decodeReason(mask: bigint | number): string[] {
  const m = BigInt(mask);
  const out: string[] = [];
  for (let i = 0; i < REASON_WORDS.length; i++) if ((m >> BigInt(i)) & 1n) out.push(REASON_WORDS[i]);
  return out;
}

/** A Spend event's (or any record's) verdict: a record with a verdict field carries it; an older log has only `refused` (0 paid, 2 refused). */
export function verdictOf(x: { verdict?: unknown; refused?: unknown }): Verdict {
  if (x.verdict !== undefined && x.verdict !== null) {
    const v = Number(x.verdict);
    if (v === 0 || v === 1 || v === 2) return v;
  }
  return x.refused ? VERDICT.REFUSED : VERDICT.PAID;
}

const MASK16 = 0xffffn;

function toInt16(x: bigint): number {
  const v = Number(x & MASK16);
  return v >= 0x8000 ? v - 0x10000 : v;
}

export function clampInt16(v: number): number {
  return Math.max(-32768, Math.min(32767, Math.trunc(v)));
}

export function pack(genes: Genes): { lo: bigint; hi: bigint } {
  if (genes.length !== GENES) throw new Error(`genome must have ${GENES} genes`);
  let lo = 0n;
  let hi = 0n;
  for (let i = 0; i < 16; i++) {
    lo |= (BigInt(clampInt16(genes[i])) & MASK16) << BigInt(i * 16);
    hi |= (BigInt(clampInt16(genes[i + 16])) & MASK16) << BigInt(i * 16);
  }
  return { lo, hi };
}

export function unpack(lo: bigint, hi: bigint): Genes {
  const g: number[] = new Array(GENES);
  for (let i = 0; i < 16; i++) {
    g[i] = toInt16(lo >> BigInt(i * 16));
    g[i + 16] = toInt16(hi >> BigInt(i * 16));
  }
  return g;
}

export function packFeatures(f: Features): bigint {
  let p = 0n;
  for (let i = 0; i < 8; i++) p |= (BigInt(f[i]) & MASK16) << BigInt(16 * i);
  return p;
}

export function unpackFeatures(p: bigint): Features {
  const f: number[] = [];
  for (let i = 0; i < 8; i++) f.push(Number((p >> BigInt(16 * i)) & MASK16));
  return f;
}

export interface Explanation {
  /** 0 paid, 1 held, 2 refused (hard limits included when a limit context was given) */
  verdict: Verdict;
  /** verdict === REFUSED */
  refused: boolean;
  /** verdict === HELD */
  held: boolean;
  /** the policy's bits on a hold or a refusal (as Firewall.judge), plus bits 16-19 for a hard limit and bit 20 for an
   *  attacker's hold refused */
  reason: bigint;
  score: bigint;
  raw: bigint;
  terms: bigint[]; // 16
  fired: boolean[]; // 8 step gates
  /** the hard-limit bits alone (0n when none, or when no limit context was given) */
  limits: bigint;
}

/**
 * What the hard limits need, exactly as Vault._limits sees it: the payment, what the vault can pay now (its
 * balance minus held payments, `Vault.balance()`), the round's start balance and its outflow so far (holds included).
 */
export interface LimitContext {
  amount: bigint;
  available: bigint;
  startBalance: bigint;
  outflow: bigint;
  /** the payment is an attacker's (Vault.isAttacker: the caller, the tx origin or the caller's principal has an
   *  attack staked this round). Attackers meet the tighter limits and their holds are refused. */
  attacker?: boolean;
  /** what attackers have taken this round so far (Vault.attackOutflow()); 0n if not given */
  attackOutflow?: bigint;
}

/** Mirror of Vault._limits: the reason bits of the hard limits a payment breaks (0n if none). */
export function hardLimits(c: LimitContext): bigint {
  const start = c.startBalance > 0n ? c.startBalance : c.available;
  let r = 0n;
  if (c.amount * 10_000n > c.available * MAX_SPEND_BPS) r |= REASON_SPEND_CAP;
  if ((c.outflow + c.amount) * 10_000n > start * MAX_ROUND_OUTFLOW_BPS) r |= REASON_ROUND_CAP;
  if (c.attacker) {
    if (c.amount * 10_000n > c.available * ATTACK_SPEND_BPS) r |= REASON_ATTACK_SPEND_CAP;
    if (((c.attackOutflow ?? 0n) + c.amount) * 10_000n > start * ATTACK_ROUND_BPS) r |= REASON_ATTACK_ROUND_CAP;
  }
  return r;
}

/**
 * The hard limits read from the features alone: f0 is the payment's share of what the vault can pay and f7 the
 * round's outflow including it, both in thousandths, so a value above 500 breaks the limit. Exact except a payment
 * less than a thousandth above half, which reads as within (use `hardLimits` with the amounts for that).
 */
export function hardLimitsFromFeatures(f: Features, attacker = false): bigint {
  let r = 0n;
  if (Math.trunc(f[0]) > 500) r |= REASON_SPEND_CAP;
  if (Math.trunc(f[7]) > 500) r |= REASON_ROUND_CAP;
  // the attackers' per-payment cap reads the same way (their round cap needs the attackers' outflow: hardLimits)
  if (attacker && Math.trunc(f[0]) > 100) r |= REASON_ATTACK_SPEND_CAP;
  return r;
}

/**
 * Mirror of GenomeLib.explain / GenomeLib.verdict (Firewall.judge): identical integer math, three verdicts.
 * score > 500,000 refuses; 350,000 < score <= 500,000 holds; else it pays. Reason bits are worked out on a hold as on
 * a refusal.
 *
 * `limits` adds the vault's hard limits as Vault.previewSpend does (they override the policy's verdict only; the
 * shadow candidates never see them): a LimitContext for the exact check, or `true` to read them from the features.
 * with `attacker: true` in the context, the attackers' limits apply too and a hold is refused (bit 20).
 * Without it this is the policy alone, as a shadow candidate judges.
 */
export function explain(genes: Genes, f: Features, limits?: LimitContext | boolean): Explanation {
  const terms: bigint[] = new Array(16).fill(0n);
  const fired: boolean[] = new Array(8).fill(false);
  let raw = 0n;
  for (let i = 0; i < 8; i++) {
    const fi = BigInt(Math.min(Math.max(Math.trunc(f[i]), 0), FEATURE_MAX));
    terms[i] = BigInt(genes[i]) * fi;
    raw += terms[i];
    const t = BigInt(genes[16 + i]);
    fired[i] = t >= 0n ? fi >= t : fi < -t;
  }
  for (let k = 0; k < 8; k++) {
    const [a, b] = PAIRS[k];
    if (fired[a] && fired[b]) {
      terms[8 + k] = BigInt(genes[8 + k]) * INTERACTION_SCALE;
      raw += terms[8 + k];
    }
  }
  const score = raw > 0n ? raw : 0n;
  let verdict: Verdict = raw > GLOBAL_THRESHOLD ? VERDICT.REFUSED : raw > HOLD_THRESHOLD ? VERDICT.HELD : VERDICT.PAID;
  let reason = 0n;
  if (verdict !== VERDICT.PAID) {
    // Solidity int division truncates toward zero; raw > 0 here so plain division matches.
    const cut = raw / 8n;
    for (let j = 0; j < 16; j++) if (terms[j] > 0n && terms[j] >= cut) reason |= 1n << BigInt(j);
  }
  const lim = limits === undefined || limits === false ? 0n : limits === true ? hardLimitsFromFeatures(f) : hardLimits(limits);
  // (Vault._override) an attacker's payment the policy would hold is refused instead
  if (typeof limits === "object" && limits.attacker && verdict === VERDICT.HELD) {
    verdict = VERDICT.REFUSED;
    reason |= REASON_ATTACK_HOLD;
  }
  if (lim !== 0n) {
    verdict = VERDICT.REFUSED;
    reason |= lim;
  }
  return { verdict, refused: verdict === VERDICT.REFUSED, held: verdict === VERDICT.HELD, reason, score, raw, terms, fired, limits: lim };
}

/** Score as a 0..1 fraction of the refusal threshold (for gauges). >1 means refused; above HOLD_RATIO it is held. */
export function scoreRatio(score: bigint): number {
  return Number(score) / Number(GLOBAL_THRESHOLD);
}

/** Where the hold band starts on a scoreRatio gauge (0.7 of the refusal threshold). */
export const HOLD_RATIO = Number(HOLD_THRESHOLD) / Number(GLOBAL_THRESHOLD);

export function zeroGenes(): Genes {
  return new Array(GENES).fill(0);
}

/** Build a policy genome from named parts. */
export function policyGenes(parts: {
  weights?: Partial<Record<number, number>>;
  interactions?: Partial<Record<number, number>>;
  thresholds?: Partial<Record<number, number>>;
}): Genes {
  const g = zeroGenes();
  for (const [k, v] of Object.entries(parts.weights ?? {})) g[Number(k)] = v as number;
  for (const [k, v] of Object.entries(parts.interactions ?? {})) g[8 + Number(k)] = v as number;
  for (const [k, v] of Object.entries(parts.thresholds ?? {})) g[16 + Number(k)] = v as number;
  return g;
}

// ---------------------------------------------------------------- breeding mirror (for simulations / previews)

/** Uniform crossover: gene i from B when bit i of rand is set. */
export function crossover(a: Genes, b: Genes, rand: bigint): Genes {
  return a.map((ga, i) => (((rand >> BigInt(i)) & 1n) === 1n ? b[i] : ga));
}

// ---------------------------------------------------------------- attack genomes

/**
 * Attack genome: 8 steps x 4 genes.
 *   g0 amountBps    |g| clamped to 0..10000 — share of what the vault can pay, in basis points (0 = skip step;
 *                   the whole range 0..10000 is allowed)
 *   g1 recipient    |g| % 4 — 0 self, 1 fresh address, 2 contract (agent proxy), 3 previous recipient
 *   g2 delayBlocks  |g| % 101 — blocks to wait before this step (0..100, so sparring sees every gap f3 can
 *                   take)
 *   g3 route        |g| % 3 — 0 direct from the EOA, 1 through an agent contract (call depth), 2 delegate-then-drain
 */
export type RecipientMode = "self" | "fresh" | "contract" | "previous";
export type Route = "direct" | "agent" | "delegate";

export interface AttackStep {
  amountBps: number;
  recipient: RecipientMode;
  delayBlocks: number;
  route: Route;
}

/** an attack step may ask for up to the whole vault (Crucible / SparReference clamp at 10,000 bps). */
export const MAX_ATTACK_BPS = 10_000;
/** a step's delay is |g2| % 101 blocks (Crucible._decode / SparReference), 0..100. */
export const MAX_DELAY_MOD = 101;

const RECIPIENTS: RecipientMode[] = ["self", "fresh", "contract", "previous"];
const ROUTES: Route[] = ["direct", "agent", "delegate"];

export function decodeAttack(genes: Genes): AttackStep[] {
  const steps: AttackStep[] = [];
  for (let s = 0; s < 8; s++) {
    const g = genes.slice(4 * s, 4 * s + 4).map((x) => Math.abs(x));
    steps.push({
      amountBps: Math.min(g[0], MAX_ATTACK_BPS),
      recipient: RECIPIENTS[g[1] % 4],
      delayBlocks: g[2] % MAX_DELAY_MOD,
      route: ROUTES[g[3] % 3],
    });
  }
  return steps;
}

export function encodeAttack(steps: Partial<AttackStep>[]): Genes {
  const g = zeroGenes();
  steps.slice(0, 8).forEach((st, s) => {
    g[4 * s] = Math.min(Math.max(Math.round(st.amountBps ?? 0), 0), MAX_ATTACK_BPS);
    g[4 * s + 1] = RECIPIENTS.indexOf(st.recipient ?? "self");
    g[4 * s + 2] = Math.min(Math.max(Math.round(st.delayBlocks ?? 0), 0), MAX_DELAY_MOD - 1);
    g[4 * s + 3] = ROUTES.indexOf(st.route ?? "direct");
  });
  return g;
}

/** The five scripted attacks, plus helpers to express the judge presets. */
export const ATTACK_PRESETS: Record<string, { label: string; blurb: string; steps: Partial<AttackStep>[] }> = {
  drain: {
    label: "Drain 40%",
    blurb: "One transaction, 40% of the vault, straight to you.",
    steps: [{ amountBps: 4000, recipient: "self" }],
  },
  salami: {
    label: "Salami 8 × 3%",
    blurb: "Slice under the radar: eight 3% withdrawals in a row.",
    steps: Array.from({ length: 8 }, () => ({ amountBps: 300, recipient: "self" as RecipientMode })),
  },
  burst: {
    label: "New-recipient burst",
    blurb: "Five 5% payments, each to an address the vault has never seen.",
    steps: Array.from({ length: 5 }, () => ({ amountBps: 500, recipient: "fresh" as RecipientMode })),
  },
  delegate: {
    label: "Delegate, then drain",
    blurb: "Fund an agent with a small delegation, then drain through it.",
    steps: [
      { amountBps: 50, recipient: "contract", route: "direct" },
      { amountBps: 3000, recipient: "self", route: "agent", delayBlocks: 1 },
    ],
  },
  hop: {
    label: "Contract hop",
    blurb: "30% out through an agent contract into another contract.",
    steps: [{ amountBps: 3000, recipient: "contract", route: "agent" }],
  },
};
