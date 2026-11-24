import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { createPublicClient, createWalletClient, defineChain, http, type Chain, type PublicClient } from "viem";
import { mnemonicToAccount, privateKeyToAccount, type HDAccount, type PrivateKeyAccount } from "viem/accounts";
import { RedQueen, type Deployment, type LabelEntry, type LabelStore, type Address } from "@redqueen/sdk";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });
dotenv.config();

export const HARDHAT_MNEMONIC = "test test test test test test test test test test test junk";

export const env = {
  chainId: Number(process.env.CHAIN_ID ?? 11155111),
  rpcUrl: process.env.RPC_URL ?? process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com",
  mnemonic: process.env.BOT_MNEMONIC ?? "",
  deployerKey: process.env.DEPLOYER_PRIVATE_KEY ?? "",
  topupKey: process.env.TOPUP_PRIVATE_KEY ?? "",
  tickMs: Number(process.env.BOT_TICK_MS ?? 3000),
  recycle: (process.env.BOT_RECYCLE ?? "1") === "1",
  stateDir: path.resolve(__dirname, "../.state"),
};

export function loadDeployment(chainId = env.chainId): Deployment {
  const file = process.env.DEPLOYMENT_FILE ?? path.resolve(__dirname, `../../deployments/${chainId}.json`);
  if (!fs.existsSync(file)) throw new Error(`deployment not found: ${file}`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function chainFor(id: number, rpc: string): Chain {
  return defineChain({
    id,
    name: id === 31337 ? "Hardhat" : id === 11155111 ? "Sepolia" : id === 84532 ? "Base Sepolia" : `Chain ${id}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
}

export const isLocal = () => env.chainId === 31337;

/**
 * Bot wallet layout (HD indices). Locally the hardhat mnemonic is used and index 0 is the deployer.
 *   honest 1..6 · attackers 7..11 · evolved runner 12 · challengers 13..16 · spectators 17..18 · closer 19
 */
export const ROLES = {
  honest: [1, 2, 3, 4, 5, 6],
  attackers: [7, 8, 9, 10, 11],
  evolved: [12],
  challengers: [13, 14, 15, 16],
  spectators: [17, 18],
  closer: [19],
} as const;

export function botAccount(index: number): HDAccount {
  const m = env.mnemonic || (isLocal() ? HARDHAT_MNEMONIC : "");
  if (!m) throw new Error("BOT_MNEMONIC is required on public networks");
  return mnemonicToAccount(m, { addressIndex: index });
}

export function deployerAccount(): PrivateKeyAccount | HDAccount {
  if (env.deployerKey) return privateKeyToAccount((env.deployerKey.startsWith("0x") ? env.deployerKey : `0x${env.deployerKey}`) as `0x${string}`);
  if (isLocal()) return mnemonicToAccount(HARDHAT_MNEMONIC, { addressIndex: 0 });
  throw new Error("DEPLOYER_PRIVATE_KEY is required on public networks");
}

export function topupAccount(): PrivateKeyAccount | HDAccount {
  if (env.topupKey) return privateKeyToAccount((env.topupKey.startsWith("0x") ? env.topupKey : `0x${env.topupKey}`) as `0x${string}`);
  return deployerAccount();
}

let _pub: PublicClient | null = null;
export function publicClient(): PublicClient {
  return (_pub ??= createPublicClient({ chain: chainFor(env.chainId, env.rpcUrl), transport: http(env.rpcUrl, { retryCount: 3 }), pollingInterval: 1000 }) as PublicClient);
}

export function walletFor(account: HDAccount | PrivateKeyAccount) {
  return createWalletClient({ account, chain: chainFor(env.chainId, env.rpcUrl), transport: http(env.rpcUrl, { retryCount: 3 }) });
}

/** Persist label salts so a bot restart can still reveal. */
export class FileLabelStore implements LabelStore {
  private file: string;
  private entries: LabelEntry[] = [];
  constructor(name: string) {
    fs.mkdirSync(env.stateDir, { recursive: true });
    this.file = path.join(env.stateDir, `labels-${env.chainId}-${name}.json`);
    if (fs.existsSync(this.file)) {
      this.entries = JSON.parse(fs.readFileSync(this.file, "utf8"), (_k, v) => (typeof v === "string" && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v));
    }
  }
  private save() {
    const keep = this.entries.filter((e) => !e.revealed).slice(-500);
    fs.writeFileSync(this.file, JSON.stringify(keep, (_k, v) => (typeof v === "bigint" ? `${v}n` : v)));
  }
  add(e: LabelEntry) {
    this.entries.push(e);
    this.save();
  }
  pending(caller: Address, epoch: bigint) {
    return this.entries.filter((e) => !e.revealed && e.epoch === epoch && e.caller.toLowerCase() === caller.toLowerCase());
  }
  markRevealed(caller: Address, epoch: bigint, txIds: bigint[]) {
    for (const e of this.entries) if (e.epoch === epoch && e.caller.toLowerCase() === caller.toLowerCase() && txIds.includes(e.txId)) e.revealed = true;
    this.save();
  }
}

export function rqFor(account: HDAccount | PrivateKeyAccount, d: Deployment, name: string) {
  return new RedQueen({ deployment: d, publicClient: publicClient(), walletClient: walletFor(account), labels: new FileLabelStore(name) });
}

export function log(who: string, msg: string) {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`${t} ${who.padEnd(14)} ${msg}`);
}
