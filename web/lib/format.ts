import { formatEther } from "viem";

export function eth(wei: bigint | undefined | null, digits = 4): string {
  if (wei === undefined || wei === null) return "—";
  const v = Number(formatEther(wei));
  if (v !== 0 && Math.abs(v) < 10 ** -digits) return `<${(10 ** -digits).toFixed(digits)}`;
  return v.toLocaleString("en-US", { minimumFractionDigits: Math.min(2, digits), maximumFractionDigits: digits });
}

/** An ETH figure as a number that never rounds a real amount to 0: two significant figures below 0.01. */
export function ethNum(v: number): string {
  if (v === 0 || !Number.isFinite(v)) return "0";
  const a = Math.abs(v);
  return v.toLocaleString("en-US", a < 0.01 ? { maximumSignificantDigits: 2, maximumFractionDigits: 18 } : { maximumFractionDigits: a < 1 ? 3 : 2 });
}

export function short(a: string | undefined | null, n = 4): string {
  if (!a) return "—";
  return `${a.slice(0, 2 + n)}…${a.slice(-n)}`;
}

export function pct(x: number, d = 1) {
  return `${(x * 100).toFixed(d)}%`;
}

export function ago(t: number, now = Date.now() / 1000): string {
  const s = Math.max(0, Math.round(now - t));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

export function clock(t: number): string {
  const d = new Date(t * 1000);
  return d.toTimeString().slice(0, 8);
}

/** deterministic 0..1 from an address/hash, used for attack angles and colours */
export function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}
