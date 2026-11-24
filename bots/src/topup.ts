/**
 * Judge top-up service. The arena calls POST /topup {address} when a wallet connects:
 *   - registers the wallet as an honest user (this hot wallet must be a Vault registrar)
 *   - sends TOPUP_ETH (default 0.05) if the wallet holds less than TOPUP_MIN_ETH (default 0.02), once per address
 * Rate-limited per IP and per address; state persisted in bots/.state.
 */
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { formatEther, isAddress, parseEther, getAddress } from "viem";
import { env, loadDeployment, log, publicClient, rqFor, topupAccount, walletFor } from "./env";

export function startTopup(port = Number(process.env.TOPUP_PORT ?? 8788)) {
  const d = loadDeployment();
  const hot = topupAccount();
  const wallet = walletFor(hot);
  const rq = rqFor(hot, d, "topup");
  const pub = publicClient();
  const amount = parseEther(process.env.TOPUP_ETH ?? "0.05");
  const min = parseEther(process.env.TOPUP_MIN_ETH ?? "0.02");
  const file = path.join(env.stateDir, `topup-${env.chainId}.json`);
  fs.mkdirSync(env.stateDir, { recursive: true });
  const funded: Record<string, string> = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const perIp = new Map<string, number[]>();
  let queue: Promise<unknown> = Promise.resolve();

  const reply = (res: http.ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") return reply(res, 204, null);
    if (req.url === "/health") return reply(res, 200, { ok: true, hot: hot.address, funded: Object.keys(funded).length });
    if (req.url !== "/topup" || req.method !== "POST") return reply(res, 404, { error: "not found" });
    const ip = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "?").split(",")[0];
    const now = Date.now();
    const hits = (perIp.get(ip) ?? []).filter((t) => now - t < 3600_000);
    if (hits.length >= 6) return reply(res, 429, { error: "slow down" });
    perIp.set(ip, [...hits, now]);
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      queue = queue.then(async () => {
        try {
          const { address } = JSON.parse(body || "{}");
          if (!address || !isAddress(address)) return reply(res, 400, { error: "bad address" });
          const who = getAddress(address);
          let registered = await rq.isHonest(who);
          if (!registered) {
            await rq.registerHonest(who);
            registered = true;
            log("topup", `registered ${who}`);
          }
          let sent = "0";
          const bal = await pub.getBalance({ address: who });
          if (!funded[who] && bal < min) {
            const hash = await wallet.sendTransaction({ to: who, value: amount, account: hot, chain: wallet.chain });
            await pub.waitForTransactionReceipt({ hash });
            funded[who] = hash;
            fs.writeFileSync(file, JSON.stringify(funded, null, 2));
            sent = formatEther(amount);
            log("topup", `sent ${sent} to ${who}`);
          }
          reply(res, 200, { ok: true, registered, sent, tx: funded[who] ?? null });
        } catch (e) {
          reply(res, 500, { error: (e as Error).message.split("\n")[0] });
        }
      });
    });
  });
  server.listen(port, () => log("topup", `listening on :${port} as ${hot.address}`));
  return server;
}

if (require.main === module) startTopup();
