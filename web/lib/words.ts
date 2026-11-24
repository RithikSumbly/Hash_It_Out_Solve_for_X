import { REASON_WORDS, type HoldStatus } from "@redqueen/sdk";

/** Reason bits in plain words, for people rather than engineers. */
const HUMAN: Record<string, string> = {
  LARGE_AMOUNT: "too large",
  NEW_RECIPIENT: "unknown recipient",
  HIGH_VELOCITY: "too fast",
  TIMING: "odd timing",
  REPUTATION: "reputation",
  CALL_DEPTH: "sent through a contract",
  CONTRACT_RECIPIENT: "paid to a contract",
  EPOCH_OUTFLOW: "vault already draining",
  "AMOUNT×NOVELTY": "large, to a stranger",
  "AMOUNT×OUTFLOW": "large while draining",
  "NOVELTY×VELOCITY": "burst to strangers",
  SALAMI: "salami slicing",
  CONTRACT_HOP: "contract hop",
  DELEGATED_DRAIN: "delegated drain",
  RAPID_REPEAT: "rapid repeats",
  CONTRACT_SINK: "contract sink",
};

export function reasons(mask: bigint | number): string[] {
  const m = BigInt(mask);
  const out: string[] = [];
  for (let i = 0; i < 16; i++) if ((m >> BigInt(i)) & 1n) out.push(HUMAN[REASON_WORDS[i]] ?? String(REASON_WORDS[i]).toLowerCase());
  // the vault's own hard limits, which no evolved rule can lift
  if ((m >> 16n) & 1n) out.push("over the hard cap of half the vault in one payment");
  if ((m >> 17n) & 1n) out.push("over the hard cap of half the round's balance out");
  // the tighter limits for a wallet with an attack staked this round
  if ((m >> 18n) & 1n) out.push("over an attacker's cap of a tenth of the vault in one payment");
  if ((m >> 19n) & 1n) out.push("over the attackers' cap of a fifth of the round's balance out");
  if ((m >> 20n) & 1n) out.push("an attacker's payment is refused where others would be held");
  return out;
}

export function reasonLine(mask: bigint | number): string {
  const r = reasons(mask);
  if (r.length === 0) return "";
  if (r.length === 1) return r[0];
  return `${r.slice(0, -1).join(", ")} and ${r[r.length - 1]}`;
}

/** 1,234.56 with sensible precision for an ETH amount */
export function ethWords(wei: bigint | undefined | null, max = 2): string {
  if (wei === undefined || wei === null) return "…";
  const v = Number(wei) / 1e18;
  if (v === 0) return "0";
  // two significant figures, never in exponent form (7.9e-7 reads as 0.00000079)
  if (v < 0.01) return v.toLocaleString("en-US", { maximumSignificantDigits: 2, maximumFractionDigits: 18 });
  // never round a real amount down to nothing: below 1 ETH keep two decimals at least
  return v.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: v < 1 ? Math.max(2, max) : max });
}

export function count(n: number | bigint): string {
  return Number(n).toLocaleString("en-US");
}

export function secondsAgo(t: number, now = Date.now() / 1000): string {
  const s = Math.max(0, Math.round(now - t));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

// ---------------------------------------------------------------- the third verdict

/** What a hold means, in one line (the contract's rule: HOLD_DELAY blocks, a veto, then anyone may release). */
export const HELD_LINE = "Held: it waits about a minute; the owner or a guardian may cancel it; then anyone can pay it out.";

/** 47 s, 1 min 5 s */
export function seconds(n: number): string {
  const s = Math.max(0, Math.round(n));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`;
}

/** A held payment's standing, in a few words: its wait, or how it ended. */
export function holdWords(h: { status: HoldStatus; secondsLeft: number }): string {
  if (h.status === "waiting") return `waits ${seconds(h.secondsLeft)} more`;
  if (h.status === "releasable") return "anyone can pay it out now";
  if (h.status === "released") return "paid out after its wait";
  return "vetoed; the money stayed";
}

/** The class for a verdict's colour: refused is hot, held is brass, paid is plain ivory. */
export function verdictTone(v: number, paid = "text-ivory"): string {
  return v === 2 ? "text-hot" : v === 1 ? "text-held" : paid;
}
