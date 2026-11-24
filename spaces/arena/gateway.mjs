/**
 * The arena service on one Hugging Face Space (one public port, 7860).
 *
 * It runs four processes and routes to them by path:
 *   /topup/...   the judge top-up (test ETH and an honest-user registration for a visitor's wallet)   → :8788
 *   /demo/...    the demo service (one real attack, sent so a visitor can watch her refuse it)        → :8789
 *   /status      this gateway's own page: what is running
 *   everything else, WebSockets included, is the relay (events, snapshots, the REST API)            → :8787
 * and the bots (honest users, attackers, challengers, the epoch closer) with no port.
 *
 * A process that exits is restarted with a growing delay. No dependencies: Node's http and net only.
 */
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";

const PORT = Number(process.env.PORT || 7860);
const SERVICES = {
  relay: { cmd: ["npx", "tsx", "relay/src/index.ts"], env: { RELAY_PORT: "8787" }, port: 8787 },
  topup: { cmd: ["npx", "tsx", "bots/src/topup.ts"], env: { TOPUP_PORT: "8788" }, port: 8788 },
  demo: { cmd: ["npx", "tsx", "bots/src/demo.ts"], env: { DEMO_PORT: "8789" }, port: 8789 },
  bots: { cmd: ["npx", "tsx", "bots/src/index.ts"], env: {} },
};
// Leave a service out with OFF=bots,topup (for example while the wallets are being funded)
const OFF = new Set((process.env.OFF || "").split(",").map((s) => s.trim()).filter(Boolean));
// without their secrets, the services that need wallets wait (instead of crash-looping)
if (!process.env.BOT_MNEMONIC) OFF.add("bots"), OFF.add("demo");
if (!process.env.DEPLOYER_PRIVATE_KEY && !process.env.TOPUP_PRIVATE_KEY) OFF.add("topup"), OFF.add("demo");

const state = {};
function run(name) {
  const s = SERVICES[name];
  const st = (state[name] ??= { restarts: 0, up: false, since: 0, last: "" });
  const child = spawn(s.cmd[0], s.cmd.slice(1), { env: { ...process.env, ...s.env }, stdio: ["ignore", "pipe", "pipe"] });
  st.up = true;
  st.since = Date.now();
  const tag = (line) => {
    const t = String(line).trimEnd();
    if (!t) return;
    st.last = t.slice(-300);
    console.log(`[${name}] ${t}`);
  };
  child.stdout.on("data", tag);
  child.stderr.on("data", tag);
  child.on("exit", (code) => {
    st.up = false;
    st.restarts++;
    const wait = Math.min(60_000, 2_000 * 2 ** Math.min(st.restarts, 5));
    console.log(`[gateway] ${name} exited (${code}); restarting in ${wait / 1000}s`);
    setTimeout(() => run(name), wait);
  });
}
for (const name of Object.keys(SERVICES)) if (!OFF.has(name)) run(name);

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization", "access-control-allow-methods": "GET, POST, OPTIONS" };

function target(url) {
  if (url.startsWith("/topup")) return { port: SERVICES.topup.port, path: url.slice("/topup".length) || "/" };
  if (url.startsWith("/demo")) return { port: SERVICES.demo.port, path: url.slice("/demo".length) || "/" };
  return { port: SERVICES.relay.port, path: url };
}

const server = http.createServer((req, res) => {
  const url = req.url || "/";
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }
  if (url === "/" || url === "/status") {
    const rows = Object.keys(SERVICES)
      .map((n) => {
        const st = state[n];
        const s = OFF.has(n) ? "off" : !st ? "starting" : st.up ? `running ${Math.round((Date.now() - st.since) / 1000)}s` : "restarting";
        return `<tr><td>${n}</td><td>${s}</td><td>${st?.restarts ?? 0}</td></tr>`;
      })
      .join("");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...CORS });
    return res.end(`<!doctype html><meta charset="utf-8"><title>Red Queen arena service</title><body style="font:16px system-ui;background:#050608;color:#efe8da;padding:40px"><h1 style="font-weight:600">Red Queen · arena service</h1><p>The relay, the demo attack, the judges' top-up and the bots for <a style="color:#ff8a94" href="https://red-queen-seven.vercel.app">red-queen-seven.vercel.app</a>, on Base Sepolia.</p><table cellpadding="6"><tr><th align=left>service</th><th align=left>state</th><th align=left>restarts</th></tr>${rows}</table></body>`);
  }
  const t = target(url);
  const up = http.request({ host: "127.0.0.1", port: t.port, method: req.method, path: t.path, headers: { ...req.headers, host: `127.0.0.1:${t.port}` } }, (r) => {
    res.writeHead(r.statusCode || 502, { ...r.headers, ...CORS });
    r.pipe(res);
  });
  up.on("error", () => {
    if (!res.headersSent) res.writeHead(503, { "content-type": "application/json", ...CORS });
    res.end(JSON.stringify({ ok: false, error: "service starting, try again in a few seconds" }));
  });
  req.pipe(up);
});

// WebSockets (the relay): hand the raw connection through
server.on("upgrade", (req, socket, head) => {
  const t = target(req.url || "/");
  const up = net.connect(t.port, "127.0.0.1", () => {
    const lines = [`${req.method} ${t.path} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    up.write(lines.join("\r\n") + "\r\n\r\n");
    if (head && head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  const close = () => {
    socket.destroy();
    up.destroy();
  };
  up.on("error", close);
  socket.on("error", close);
});

server.listen(PORT, () => console.log(`[gateway] listening on :${PORT}${OFF.size ? ` (off: ${[...OFF].join(", ")})` : ""}`));
