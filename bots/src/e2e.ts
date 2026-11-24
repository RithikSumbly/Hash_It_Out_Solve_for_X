/**
 * End-to-end local run of the whole backend:
 *   hardhat node (1 s blocks) → deploy → relay (WebSocket + read API) → judge top-up → all bots for N epochs
 *   → a simulated judge connects, gets topped up + registered, stakes, drains, and watches the relay deliver
 *   their own Spend → the relay's replay mode is exercised → on-chain + relay assertions → e2e-report.json
 *
 *   npm run e2e                 (E2E_EPOCHS=6 by default)
 */
import { spawn, spawnSync, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../..");
const RPC = process.env.E2E_RPC ?? "http://127.0.0.1:8545";
const RELAY_PORT = 8799;
const TOPUP_PORT = 8798;
const EPOCHS = Number(process.env.E2E_EPOCHS ?? 6);

process.env.CHAIN_ID = "31337";
process.env.RPC_URL = RPC;
process.env.BOT_TICK_MS = process.env.BOT_TICK_MS ?? "1000";
process.env.RELAY_ADMIN_TOKEN = "e2e";
delete process.env.DEPLOYMENT_FILE;
// A local chain: use Hardhat's own accounts, never the real keys in .env (blank values stop dotenv loading them).
process.env.DEPLOYER_PRIVATE_KEY = "";
process.env.TOPUP_PRIVATE_KEY = "";
process.env.BOT_MNEMONIC = "";

const children: ChildProcess[] = [];
function cleanup() {
  for (const c of children) c.kill("SIGTERM");
}
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(1));

async function rpc(method: string, params: unknown[] = []) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await r.json()) as { result?: unknown; error?: unknown };
}

async function waitFor(fn: () => Promise<boolean>, ms: number, what: string) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await fn()) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timeout waiting for ${what}`);
}

const checks: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

async function main() {
  const t0 = Date.now();
  console.log("== Red Queen end-to-end ==");
  // 1. chain
  if (!process.env.E2E_EXTERNAL_NODE) {
    const node = spawn("npx", ["hardhat", "node", "--port", "8545"], { cwd: path.join(ROOT, "contracts"), stdio: "ignore" });
    children.push(node);
  }
  await waitFor(async () => !!(await rpc("eth_chainId")).result, 60_000, "hardhat node");
  await rpc("evm_setIntervalMining", [1000]);
  console.log("chain up (1 s blocks)");

  // 2. deploy
  const dep = spawnSync("npx", ["hardhat", "run", "scripts/deploy.ts", "--network", "localhost"], {
    cwd: path.join(ROOT, "contracts"),
    env: { ...process.env, EPOCH_LENGTH: process.env.E2E_EPOCH_LENGTH ?? "30", REVEAL_WINDOW: "8", VAULT_FUNDS: "100", POOL_FUNDS: "5" },
    encoding: "utf8",
  });
  if (dep.status !== 0) throw new Error(`deploy failed:\n${dep.stdout}\n${dep.stderr}`);
  // from here on behave like a real chain: transactions are batched into 1-second blocks
  await rpc("evm_setAutomine", [false]);
  console.log(dep.stdout.split("\n").filter((l) => /Vault|Arena|Firewall|Lineage/.test(l)).join("\n"));
  for (const f of fs.existsSync(path.join(ROOT, "bots/.state")) ? fs.readdirSync(path.join(ROOT, "bots/.state")) : []) {
    if (f.includes("31337")) fs.rmSync(path.join(ROOT, "bots/.state", f));
  }

  // Modules that read the deployment are imported only after it exists.
  const { loadDeployment, publicClient, rqFor, walletFor, chainFor } = await import("./env");
  const { runArena, stats } = await import("./arena");
  const { startTopup } = await import("./topup");
  const sdk = await import("@redqueen/sdk");
  const viem = await import("viem");
  const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
  const d = loadDeployment(31337);

  // 3. relay + top-up
  const relay = spawn("npx", ["tsx", "src/index.ts"], {
    cwd: path.join(ROOT, "relay"),
    env: { ...process.env, RELAY_PORT: String(RELAY_PORT), STALL_SECONDS: "600", RELAY_POLL_MS: "1000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(relay);
  relay.stderr?.on("data", (b) => process.stderr.write(`[relay] ${b}`));
  await waitFor(async () => (await fetch(`http://127.0.0.1:${RELAY_PORT}/health`)).ok, 60_000, "relay");
  const topupServer = startTopup(TOPUP_PORT);
  console.log("relay + top-up up");

  // 4. a WebSocket client like every screen in the room
  const seen: Record<string, number> = {};
  const live: import("@redqueen/sdk").ArenaEvent[] = [];
  let hello = false;
  let replayEvents = 0;
  let modeSeen: import("@redqueen/sdk").RelayMode | null = null;
  const ws = sdk.connectRelay(`ws://127.0.0.1:${RELAY_PORT}`, {
    onHello: () => (hello = true),
    onEvent: (e) => {
      if (e.replay) replayEvents++;
      else {
        seen[e.name] = (seen[e.name] ?? 0) + 1;
        live.push(e);
      }
    },
    onMode: (m) => (modeSeen = m),
  });

  // 5. bots for N epochs, with a judge arriving at epoch 2
  let judgeDone: Promise<void> | null = null;
  const judgeResult: Record<string, unknown> = {};
  const run = await runArena({
    deployment: d,
    epochs: EPOCHS,
    onTick: (ctx) => {
      if (!judgeDone && ctx.epoch >= 2n && ctx.block + 6n < ctx.revealBlock) judgeDone = judge();
    },
  });

  async function judge() {
    const acct = privateKeyToAccount(generatePrivateKey());
    const r = await fetch(`http://127.0.0.1:${TOPUP_PORT}/topup`, { method: "POST", body: JSON.stringify({ address: acct.address }) });
    const body = (await r.json()) as { ok: boolean; registered: boolean; sent: string };
    judgeResult.topup = body;
    const rq = new sdk.RedQueen({ deployment: d, publicClient: publicClient(), walletClient: walletFor(acct) });
    judgeResult.balance = viem.formatEther(await publicClient().getBalance({ address: acct.address }));
    judgeResult.registered = await rq.isHonest(acct.address);
    await rq.submitAttack(sdk.encodeAttack(sdk.ATTACK_PRESETS.drain.steps));
    const amount = ((await rq.vaultAvailable()) * 40n) / 100n;
    const p = await rq.predict(acct.address, acct.address, amount);
    const out = await rq.spend({ to: acct.address, amount, label: "attack" });
    judgeResult.predicted = { refused: p.refused, score: p.score.toString(), note: "computed before signing; other txs can land first" };
    judgeResult.actual = { refused: out.refused, score: out.score.toString(), reason: sdk.decodeReason(out.reason) };
    // the SDK's scorer must reproduce the chain's verdict from the features the chain actually used
    const liveG = await rq.liveGenome();
    const mirror = sdk.explain(liveG.genes, sdk.unpackFeatures(out.features));
    judgeResult.mirror = { refused: mirror.refused, score: mirror.score.toString(), reason: sdk.decodeReason(mirror.reason) };
    judgeResult.mirrorExact = mirror.refused === out.refused && mirror.score === out.score && mirror.reason === out.reason;
    await waitFor(async () => live.some((e) => e.name === "Spend" && String(e.args.caller).toLowerCase() === acct.address.toLowerCase()), 15_000, "judge Spend over relay");
    judgeResult.relayDelivered = true;
    judgeResult.address = acct.address;
    void chainFor;
  }

  await run.done;
  if (judgeDone) await judgeDone;
  // the relay polls every second: let it deliver the final close before checking what screens saw
  await waitFor(async () => (seen.EpochClosed ?? 0) >= EPOCHS && (seen.BetSettled ?? 0) >= EPOCHS, 30_000, "relay to deliver the final epoch close").catch(() => {});

  // 6. replay fallback
  const on = await fetch(`http://127.0.0.1:${RELAY_PORT}/admin/replay`, { method: "POST", headers: { authorization: "Bearer e2e" }, body: JSON.stringify({ on: true, speed: 4 }) });
  await new Promise((r) => setTimeout(r, 3000));
  const replayMode = modeSeen as import("@redqueen/sdk").RelayMode | null;
  await fetch(`http://127.0.0.1:${RELAY_PORT}/admin/replay`, { method: "POST", headers: { authorization: "Bearer e2e" }, body: JSON.stringify({ on: false }) });
  const unauthorized = await fetch(`http://127.0.0.1:${RELAY_PORT}/admin/replay`, { method: "POST", body: "{}" });

  // 7. read API
  const status = sdk.parse<import("@redqueen/sdk").ArenaSnapshot>(await (await fetch(`http://127.0.0.1:${RELAY_PORT}/api/status`)).text());
  const spends = sdk.parse<import("@redqueen/sdk").ArenaEvent[]>(await (await fetch(`http://127.0.0.1:${RELAY_PORT}/api/events?name=Spend&limit=5000`)).text());
  const lineage = sdk.parse<{ births: unknown[]; installs: unknown[] }>(await (await fetch(`http://127.0.0.1:${RELAY_PORT}/api/lineage`)).text());

  // 8. on-chain truth
  const reader = rqFor(privateKeyToAccount(generatePrivateKey()), d, "reader");
  const installCount = (await reader.liveGenome()).installCount;
  const byEpoch = stats.byEpoch;
  const epochs = Object.keys(byEpoch).map(Number).sort((a, b) => a - b);
  const late = epochs.filter((e) => e >= 3);
  const lateDrainsRefused = late.reduce((s, e) => s + byEpoch[e].drainsRefused, 0);
  const lateDrainsPassed = late.reduce((s, e) => s + byEpoch[e].drainsPassed, 0);
  const honestTotal = epochs.reduce((s, e) => s + byEpoch[e].honest, 0);
  const honestRefused = epochs.reduce((s, e) => s + byEpoch[e].honestRefused, 0);

  console.log("\n== checks ==");
  check("relay hello received", hello);
  check(`${EPOCHS} epochs closed`, (seen.EpochClosed ?? 0) >= EPOCHS, `EpochClosed x${seen.EpochClosed ?? 0}`);
  check("firewall reinstalled every epoch", installCount >= BigInt(EPOCHS + 1), `installCount ${installCount}`);
  check("children bred every epoch (4 per close)", (seen.ChildBorn ?? 0) >= 4 * EPOCHS, `ChildBorn x${seen.ChildBorn ?? 0}`);
  check("attack genomes co-evolve", (seen.AttackBorn ?? 0) >= 4, `AttackBorn x${seen.AttackBorn ?? 0}`);
  // the sparring ring grades every close (its events reach the relay), and whoever closes a round is tipped
  check("the Crucible spars at every close", (seen.Sparred ?? 0) >= EPOCHS, `Sparred x${seen.Sparred ?? 0}`);
  const tips = live.filter((e) => e.name === "Rewarded" && Number(e.args.kind) === 2).length;
  check("closers are tipped from the pool", tips > 0, `${tips} tips`);
  check("weak policies died and were slashed", (seen.PolicyDied ?? 0) > 0 && (seen.Slashed ?? 0) >= EPOCHS, `PolicyDied x${seen.PolicyDied ?? 0}`);
  check("refusals happen on-chain", spends.some((e) => e.args.refused === true), `${spends.filter((e) => e.args.refused).length} refused / ${spends.length} spends`);
  check("passes happen on-chain", spends.some((e) => e.args.refused === false));
  // the genesis policy refuses a drain from the first block (an all-zero genesis would let epoch 1 be drained)
  check(
    "the genesis policy refuses the drain from epoch 1",
    (byEpoch[1]?.drainsRefused ?? 0) > 0 && (byEpoch[1]?.drainsPassed ?? 0) === 0,
    JSON.stringify(byEpoch[1] ?? {}),
  );
  check("later generations refuse the drain", lateDrainsRefused > 0 && lateDrainsRefused >= lateDrainsPassed, `epochs>=3: ${lateDrainsRefused} refused, ${lateDrainsPassed} passed`);
  check("honest users mostly pass", honestTotal > 0 && honestRefused / honestTotal < 0.35, `${honestRefused}/${honestTotal} honest refused`);
  check("labels revealed via commit-reveal", (seen.LabelRevealed ?? 0) > 0, `LabelRevealed x${seen.LabelRevealed ?? 0}`);
  check("bets placed and settled", (seen.BetPlaced ?? 0) > 0 && (seen.BetSettled ?? 0) >= EPOCHS, `BetPlaced x${seen.BetPlaced ?? 0}, BetPaid x${seen.BetPaid ?? 0}`);
  check("judge topped up + registered", Boolean((judgeResult.topup as { registered?: boolean })?.registered) && judgeResult.registered === true, JSON.stringify(judgeResult.topup));
  check("judge's own tx streamed over the relay", judgeResult.relayDelivered === true, JSON.stringify(judgeResult.actual));
  check("SDK scorer reproduces the chain verdict bit-for-bit", judgeResult.mirrorExact === true, JSON.stringify(judgeResult.mirror));
  check("replay mode streams flagged events", on.ok && replayMode?.replay === true && replayEvents > 0, `${replayEvents} replayed`);
  check("admin endpoint is protected", unauthorized.status === 401);
  check("read API serves status + lineage", status.epoch > 0n && lineage.births.length > 0 && lineage.installs.length > 0, `epoch ${status.epoch}, ${lineage.births.length} births`);

  const report = {
    at: new Date().toISOString(),
    seconds: Math.round((Date.now() - t0) / 1000),
    epochs: EPOCHS,
    deployment: d.contracts,
    checks,
    stats: JSON.parse(JSON.stringify(stats, (_k, v) => (typeof v === "bigint" ? v.toString() : v))),
    eventsSeen: seen,
    judge: judgeResult,
    finalLive: { id: status.live.id.toString(), installCount: status.live.installCount.toString(), genes: status.live.genes },
  };
  fs.writeFileSync(path.join(ROOT, "e2e-report.json"), JSON.stringify(report, null, 2));
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} checks passed in ${report.seconds}s — report at e2e-report.json`);
  ws.close();
  topupServer.close();
  cleanup();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  cleanup();
  process.exit(1);
});
