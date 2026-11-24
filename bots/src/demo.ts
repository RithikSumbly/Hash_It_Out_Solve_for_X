/**
 * The demo service: lets a visitor watch the vault refuse a real attack without a wallet of their own,
 * and keeps the vault funded so the arena's figures stay legible.
 *
 *   POST /attack   one real attack from the demo wallet: 40% of the vault, in one transaction, to itself.
 *                  Responds with the on-chain verdict (refused, reason, score, block, tx). If the policy
 *                  lets it through, the demo returns what it took to the vault straight away.
 *   GET  /health
 *
 * The demo wallet is an attacker like any other: each epoch it stakes an attack genome (the "drain"
 * preset) before it may spend, exactly as the scripted attackers do.
 *
 * Treasury: every TREASURY_MS (default 20 s) the vault is topped back up to VAULT_TARGET_ETH from the
 * treasury wallet (default 0 = off on public networks; the local stack sets 25). The top-ups are real
 * Deposit events: they show on the board as cold ink.
 *
 * Rate-limited: one attack in flight, at least 3 s apart, 30 per IP per hour.
 */
import * as http from "http";
import { formatEther, parseEther } from "viem";
import { ATTACK_PRESETS, encodeAttack } from "@redqueen/sdk";
import { botAccount, deployerAccount, env, isLocal, loadDeployment, log, publicClient, rqFor, walletFor } from "./env";

export function startDemo(port = Number(process.env.DEMO_PORT ?? 8789)) {
  const d = loadDeployment();
  const pub = publicClient();
  const attacker = botAccount(Number(process.env.DEMO_INDEX ?? 20));
  const rq = rqFor(attacker, d, "demo");
  const treasury = deployerAccount();
  const treasuryRq = rqFor(treasury, d, "treasury");
  const target = parseEther(process.env.VAULT_TARGET_ETH ?? (isLocal() ? "25" : "0"));
  const perIp = new Map<string, number[]>();
  let busy = false;
  let last = 0;

  const reply = (res: http.ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" });
    res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  };

  async function ensureGas() {
    const bal = await pub.getBalance({ address: attacker.address });
    // (gas only: on a testnet with small faucets keep this lean; DEMO_FUND_ETH overrides)
    const fund = parseEther(process.env.DEMO_FUND_ETH ?? (isLocal() ? "0.5" : "0.02"));
    if (bal >= fund / 10n) return;
    const w = walletFor(treasury);
    const hash = await w.sendTransaction({ to: attacker.address, value: fund, account: treasury, chain: w.chain });
    await pub.waitForTransactionReceipt({ hash });
    log("demo", `funded the demo wallet ${attacker.address}`);
  }

  async function attack() {
    await ensureGas();
    if (!(await rq.hasAttack(attacker.address))) await rq.submitAttack(encodeAttack(ATTACK_PRESETS.drain.steps));
    const vault = await rq.vaultAvailable(); // held payments are reserved, so size on what it can still pay
    if (vault === 0n) throw new Error("the vault is empty");
    const amount = (vault * 4000n) / 10_000n;
    const out = await rq.spend({ to: attacker.address, amount, label: "attack" });
    const rc = await pub.getTransactionReceipt({ hash: out.hash });
    let returned = false;
    if (out.held && out.holdId !== undefined && out.releaseBlock !== undefined) {
      // held, nothing moved yet. Once its wait is over, release it (as anyone may) and give it back
      const id = out.holdId;
      const at = out.releaseBlock;
      void (async () => {
        try {
          while ((await pub.getBlockNumber()) < at) await new Promise((r) => setTimeout(r, 3000));
          await rq.release(id);
          await rq.deposit(amount);
          log("demo", `hold ${id} released and returned`);
        } catch (e) {
          log("demo", `hold ${id}: release failed (${String(e).slice(0, 80)})`);
        }
      })();
    } else if (!out.refused) {
      // she let it through: give it back, so the demo never costs the vault anything
      await rq.deposit(amount);
      returned = true;
    }
    log("demo", `attack ${formatEther(amount)} ETH → ${out.refused ? "refused" : out.held ? "held (released and returned after its wait)" : "passed (returned)"}`);
    return { ...out, amount, block: rc.blockNumber, caller: attacker.address, returned };
  }

  const server = http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") return reply(res, 204, null);
    if (req.url === "/health") return reply(res, 200, { ok: true, attacker: attacker.address, target: formatEther(target) });
    if (req.url !== "/attack" || req.method !== "POST") return reply(res, 404, { error: "not found" });
    const ip = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "?").split(",")[0];
    const now = Date.now();
    const hits = (perIp.get(ip) ?? []).filter((t) => now - t < 3600_000);
    if (hits.length >= 30) return reply(res, 429, { error: "Too many demo attacks from here; try again later." });
    if (busy || now - last < 3000) return reply(res, 429, { error: "One attack at a time; try again in a moment." });
    perIp.set(ip, [...hits, now]);
    busy = true;
    last = now;
    try {
      reply(res, 200, { ok: true, ...(await attack()) });
    } catch (e) {
      reply(res, 500, { error: (e as Error).message.split("\n")[0] });
    } finally {
      busy = false;
    }
  });

  // the treasury keeps the vault funded so the numbers on the page stay readable
  let topping = false;
  const top = async () => {
    if (target === 0n || topping) return;
    topping = true;
    try {
      const bal = await treasuryRq.vaultAvailable();
      if (bal < (target * 9n) / 10n) {
        const add = target - bal;
        await treasuryRq.deposit(add);
        log("treasury", `topped the vault up by ${formatEther(add)} ETH`);
      }
    } catch (e) {
      log("treasury", `top-up failed: ${(e as Error).message.split("\n")[0]}`);
    } finally {
      topping = false;
    }
  };
  void top();
  const timer = setInterval(top, Number(process.env.TREASURY_MS ?? 20_000));
  server.on("close", () => clearInterval(timer));

  server.listen(port, () => log("demo", `listening on :${port} · attacker ${attacker.address} · vault target ${formatEther(target)} ETH · chain ${env.chainId}`));
  return server;
}

if (require.main === module) startDemo();
