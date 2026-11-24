/**
 * The whole arena on your machine, forever: hardhat node (12 s-style cadence compressed to 2 s blocks)
 * → deploy → relay → judge top-up → all bots. Then run the arena with `npm run web:local`.
 *   npm run local
 */
import { spawn, spawnSync, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../..");
const RPC = "http://127.0.0.1:8545";
process.env.CHAIN_ID = "31337";
process.env.RPC_URL = RPC;
process.env.BOT_TICK_MS = process.env.BOT_TICK_MS ?? "1500";
const kids: ChildProcess[] = [];
const bye = () => kids.forEach((k) => k.kill("SIGTERM"));
process.on("exit", bye);
process.on("SIGINT", () => process.exit(0));

async function rpc(method: string, params: unknown[] = []) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await r.json()) as { result?: unknown };
}

async function main() {
  const node = spawn("npx", ["hardhat", "node", "--port", "8545"], { cwd: path.join(ROOT, "contracts"), stdio: "ignore" });
  kids.push(node);
  for (let i = 0; i < 120; i++) {
    try {
      if ((await rpc("eth_chainId")).result) break;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const blockMs = Number(process.env.LOCAL_BLOCK_MS ?? 2000);
  const dep = spawnSync("npx", ["hardhat", "run", "scripts/deploy.ts", "--network", "localhost"], {
    cwd: path.join(ROOT, "contracts"),
    env: { ...process.env, EPOCH_LENGTH: process.env.EPOCH_LENGTH ?? "45", REVEAL_WINDOW: process.env.REVEAL_WINDOW ?? "10", VAULT_FUNDS: "100", POOL_FUNDS: "5" },
    encoding: "utf8",
  });
  if (dep.status !== 0) throw new Error(dep.stdout + dep.stderr);
  console.log(dep.stdout.split("\n").filter((l) => /^(Vault|Arena|Firewall|Lineage)/.test(l)).join("\n"));
  await rpc("evm_setAutomine", [false]);
  await rpc("evm_setIntervalMining", [blockMs]);
  for (const f of fs.existsSync(path.join(ROOT, "bots/.state")) ? fs.readdirSync(path.join(ROOT, "bots/.state")) : []) {
    if (f.includes("31337")) fs.rmSync(path.join(ROOT, "bots/.state", f));
  }
  const relay = spawn("npx", ["tsx", "src/index.ts"], { cwd: path.join(ROOT, "relay"), env: { ...process.env, RELAY_PORT: "8787", RELAY_ADMIN_TOKEN: process.env.RELAY_ADMIN_TOKEN ?? "local" }, stdio: "inherit" });
  kids.push(relay);
  const { startTopup } = await import("./topup");
  startTopup(8788);
  const { startDemo } = await import("./demo");
  startDemo(8789);
  const { loadDeployment } = await import("./env");
  const { runArena } = await import("./arena");
  console.log(`\nlocal arena running · relay ws://127.0.0.1:8787 · top-up http://127.0.0.1:8788 · demo http://127.0.0.1:8789 · rpc ${RPC}`);
  console.log("start the site with:  npm run web:local   (MetaMask: add network 31337 at http://127.0.0.1:8545)\n");
  const run = await runArena({ deployment: loadDeployment(31337) });
  await run.done;
}

main().catch((e) => {
  console.error(e);
  bye();
  process.exit(1);
});
