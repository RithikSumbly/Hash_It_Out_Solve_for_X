import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import type { Deployment } from "@redqueen/sdk";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });
dotenv.config();

export function loadDeployment(chainId?: number): Deployment {
  const dir = path.resolve(__dirname, "../../deployments");
  const id = chainId ?? Number(process.env.CHAIN_ID ?? 11155111);
  const file = process.env.DEPLOYMENT_FILE ?? path.join(dir, `${id}.json`);
  if (!fs.existsSync(file)) throw new Error(`deployment not found: ${file} (deploy first, or set DEPLOYMENT_FILE)`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export const config = {
  chainId: Number(process.env.CHAIN_ID ?? 11155111),
  rpcUrl: process.env.RPC_URL ?? process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com",
  port: Number(process.env.RELAY_PORT ?? 8787),
  pollMs: Number(process.env.RELAY_POLL_MS ?? 2000),
  logChunk: BigInt(process.env.RELAY_LOG_CHUNK ?? 2000),
  replayMinutes: Number(process.env.REPLAY_MINUTES ?? 10),
  replaySpeed: Number(process.env.REPLAY_SPEED ?? 4),
  /** auto-enter replay when no new block arrives for this long */
  stallSeconds: Number(process.env.STALL_SECONDS ?? 75),
  adminToken: process.env.RELAY_ADMIN_TOKEN ?? "",
  historyLimit: Number(process.env.RELAY_HISTORY_LIMIT ?? 20000),
};
