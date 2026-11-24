import { DEPLOYMENTS, type Deployment } from "@redqueen/sdk";

// the live arena (Base Sepolia) unless a build says otherwise, so `npm run web` shows the real thing out of the box
export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID || 84532);
export const RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL ?? (CHAIN_ID === 31337 ? "http://127.0.0.1:8545" : CHAIN_ID === 84532 ? "https://sepolia.base.org" : "https://ethereum-sepolia-rpc.publicnode.com");
/**
 * Where to read the chain from, best first. The public Base Sepolia endpoint rate-limits by address (a room of judges
 * on one network shares one), so reads fall through to other public endpoints on a 429 instead of waiting it out.
 */
export const READ_URLS: string[] =
  !process.env.NEXT_PUBLIC_RPC_URL && CHAIN_ID === 84532
    ? [RPC_URL, "https://base-sepolia-rpc.publicnode.com", "https://base-sepolia.gateway.tenderly.co"]
    : [RPC_URL];

/**
 * Where to read event history from, best first, with the largest block range each accepts in one getLogs. The public
 * Base Sepolia endpoint allows only 200 blocks a query, and Base makes a block every 0.2 s (over 400,000 a day), so
 * history comes from gateways that take wide ranges (checked 21 Nov 2026: Tenderly 300,000+, PublicNode 50,000).
 */
export const LOG_SOURCES: { url: string; span: bigint }[] = process.env.NEXT_PUBLIC_LOGS_RPC_URL
  ? [{ url: process.env.NEXT_PUBLIC_LOGS_RPC_URL, span: 49_000n }, { url: RPC_URL, span: 199n }]
  : CHAIN_ID === 84532
    ? [
        { url: "https://base-sepolia.gateway.tenderly.co", span: 250_000n },
        { url: "https://base-sepolia-rpc.publicnode.com", span: 49_000n },
        { url: RPC_URL, span: 199n },
      ]
    : [{ url: RPC_URL, span: 1_999n }];
// The relay, the judge top-up and the demo service default to this machine only on the local chain. A hosted
// build without them set reads the chain directly and never reaches for localhost (which made Chrome ask every
// visitor for permission to "access other apps and services on this device").
const LOCAL = CHAIN_ID === 31337;
export const RELAY_URL = process.env.NEXT_PUBLIC_RELAY_URL || (LOCAL ? "ws://127.0.0.1:8787" : "");
const TOPUP_SERVICE = process.env.NEXT_PUBLIC_TOPUP_URL || (LOCAL ? "http://127.0.0.1:8788" : "");


/** The deployment bundled at build time (sdk/src/deployments.ts); the relay's hello can override it. */
export const BUNDLED_DEPLOYMENT: Deployment | null = (DEPLOYMENTS as Record<number, Deployment>)[CHAIN_ID] ?? null;

export function explorerTx(d: Deployment | null, hash: string) {
  return d?.explorer ? `${d.explorer}/tx/${hash}` : null;
}
export function explorerAddress(d: Deployment | null, a: string) {
  return d?.explorer ? `${d.explorer}/address/${a}` : null;
}
export function explorerBlock(d: Deployment | null, n: bigint | number) {
  return d?.explorer ? `${d.explorer}/block/${n}` : null;
}

/**
 * The deployed stakes, in test ETH as text ("0.0002"): read from the deployment file, so the copy can never drift
 * from the contracts.
 */
function ethText(wei: string | undefined, v1: string): string {
  if (!wei) return v1;
  const s = (Number(BigInt(wei)) / 1e18).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return s;
}
export const STAKES = {
  policy: ethText(BUNDLED_DEPLOYMENT?.stakes?.policy, "0.02"),
  attack: ethText(BUNDLED_DEPLOYMENT?.stakes?.attack, "0.01"),
  minBet: ethText(BUNDLED_DEPLOYMENT?.stakes?.minBet, "0.005"),
};

/** The queen's own server (a Hugging Face Space): she hears, answers in her voice and acts. */
export const QUEEN_URL = (process.env.NEXT_PUBLIC_QUEEN_URL || "https://celestiallord-red-queen.hf.space").replace(/\/$/, "");

/**
 * The film's live attack: one real 40% drain sent so a visitor can watch her refuse it. Locally that is the demo
 * service (bots/src/demo.ts); on Base Sepolia it is her own server (POST /attack, the same reply), so a hosted
 * build needs no extra service or variable.
 */
export const DEMO_URL =
  process.env.NEXT_PUBLIC_DEMO_URL || (TOPUP_SERVICE ? TOPUP_SERVICE.replace(/:8788\b/, ":8789") : CHAIN_ID === 84532 ? QUEEN_URL : "");

/**
 * Test ETH for a judge who connects an empty wallet: the top-up service (bots/src/topup.ts) when one is set, and on
 * Base Sepolia her own server (POST /topup, the same reply), so a judge with no faucet can still try to drain her.
 */
export const TOPUP_URL = TOPUP_SERVICE || (CHAIN_ID === 84532 ? QUEEN_URL : "");
