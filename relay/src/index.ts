/**
 * Red Queen relay — one heartbeat for the whole room.
 *
 *  - Backfills every event of the four contracts since deployment, then polls for new logs.
 *  - Streams decoded events + periodic chain snapshots to every WebSocket client.
 *  - Keeps a ring buffer of the last REPLAY_MINUTES of events. In replay mode (manual via
 *    POST /admin/replay, or automatic when the chain stalls) it re-streams that window at
 *    REPLAY_SPEED x with `replay: true` while still forwarding fresh live events (a judge's own tx).
 *  - Public read API for other teams' agents: /api/status, /api/policies, /api/policy/:id,
 *    /api/attacks, /api/events, /api/lineage, /api/deployment.
 */
import * as http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { createPublicClient, http as viemHttp, type Log } from "viem";
import {
  RedQueen,
  decodeLog,
  eventAddresses,
  sortEvents,
  stringify,
  parse,
  type ArenaEvent,
  type ArenaSnapshot,
  type RelayMessage,
  type RelayMode,
  type RelayRequest,
} from "@redqueen/sdk";
import { config, loadDeployment } from "./config";

const deployment = loadDeployment(config.chainId);
const client = createPublicClient({ transport: viemHttp(config.rpcUrl, { batch: true, retryCount: 4 }) });
const rq = new RedQueen({ deployment, publicClient: client });
const addresses = eventAddresses(deployment); // + the Crucible when the deployment has one

const history: ArenaEvent[] = [];
const seen = new Set<string>();
let snapshot: ArenaSnapshot | null = null;
let cursor = BigInt(deployment.deployBlock);
let lastBlockSeenAt = Date.now();
let lastBlock = 0n;
let mode: RelayMode = { replay: false, speed: config.replaySpeed };
let replayTimer: ReturnType<typeof setTimeout> | null = null;
let replayManual = false;

const blockTimes = new Map<bigint, number>();
async function blockTime(n: bigint): Promise<number> {
  const c = blockTimes.get(n);
  if (c !== undefined) return c;
  const b = await client.getBlock({ blockNumber: n });
  const t = Number(b.timestamp);
  blockTimes.set(n, t);
  if (blockTimes.size > 5000) blockTimes.delete(blockTimes.keys().next().value as bigint);
  return t;
}

// ---------------------------------------------------------------- websocket fan-out
const server = http.createServer(handleHttp);
const wss = new WebSocketServer({ server });
const clients = new Set<WebSocket>();

function broadcast(m: RelayMessage) {
  const s = stringify(m);
  for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(s);
}

/** Events every screen needs in full (genealogy, installs, epoch tables); everything else is recent traffic. */
const STRUCTURAL = new Set(["Born", "PolicySubmitted", "ChildBorn", "PolicyDied", "PolicyInstalled", "EpochClosed", "EpochStarted", "Randomness", "BetPlaced", "BetSettled", "Deposit"]);
const RECENT_TRAFFIC = Number(process.env.RELAY_HELLO_TRAFFIC ?? 600);
const SKIP_IN_HELLO = new Set(["ShadowScored", "LabelRevealed", "Recorded", "GenomeInstalled", "StakeReturned", "Rewarded", "Compensated", "AttackSubmitted", "AttackBorn", "AttackDied", "AttackEpochResults", "StakeForfeited", "Slashed", "BetPaid", "Claimed", "HonestRegistered", "Delegated"]);

function helloHistory(): ArenaEvent[] {
  const structural: ArenaEvent[] = [];
  const traffic: ArenaEvent[] = [];
  for (const e of history) {
    if (STRUCTURAL.has(e.name)) structural.push(e);
    else if (!SKIP_IN_HELLO.has(e.name)) traffic.push(e);
  }
  return [...structural, ...traffic.slice(-RECENT_TRAFFIC)].sort(sortEvents);
}

wss.on("connection", (ws) => {
  clients.add(ws);
  const hello: RelayMessage = {
    t: "hello",
    deployment,
    snapshot,
    history: helloHistory(),
    mode,
    serverTime: Date.now(),
  };
  ws.send(stringify(hello));
  ws.on("message", (raw) => {
    try {
      const r = parse<RelayRequest>(raw.toString());
      if (r.t === "ping") ws.send(stringify({ t: "pong", at: r.at } satisfies RelayMessage));
    } catch {
      /* ignore */
    }
  });
  ws.on("close", () => clients.delete(ws));
});

// ---------------------------------------------------------------- chain ingestion
async function ingest(logs: Log[]) {
  const out: ArenaEvent[] = [];
  for (const l of logs) {
    const id = `${l.blockNumber}-${l.logIndex}`;
    if (seen.has(id)) continue;
    const ts = l.blockNumber != null ? await blockTime(l.blockNumber) : 0;
    const e = decodeLog(deployment, l, ts);
    if (!e) continue;
    seen.add(id);
    out.push(e);
  }
  out.sort(sortEvents);
  for (const e of out) {
    history.push(e);
    broadcast({ t: "event", e });
  }
  if (history.length > config.historyLimit * 2) history.splice(0, history.length - config.historyLimit);
  return out.length;
}

async function poll() {
  try {
    const head = await client.getBlockNumber();
    if (head > lastBlock) {
      lastBlock = head;
      lastBlockSeenAt = Date.now();
      if (mode.replay && !replayManual) setMode(false, "chain resumed");
    }
    while (cursor <= head) {
      const to = cursor + config.logChunk - 1n < head ? cursor + config.logChunk - 1n : head;
      const logs = await client.getLogs({ address: addresses, fromBlock: cursor, toBlock: to });
      await ingest(logs as Log[]);
      cursor = to + 1n;
    }
    if (!mode.replay && Date.now() - lastBlockSeenAt > config.stallSeconds * 1000) setMode(true, "chain stalled");
  } catch (e) {
    console.error("[relay] poll", (e as Error).message.split("\n")[0]);
  }
}

async function refreshSnapshot() {
  try {
    snapshot = await rq.snapshot();
    broadcast({ t: "snapshot", s: snapshot });
  } catch (e) {
    console.error("[relay] snapshot", (e as Error).message.split("\n")[0]);
  }
}

// ---------------------------------------------------------------- replay
function setMode(replay: boolean, reason: string, speed = config.replaySpeed) {
  mode = { replay, speed, since: replay ? Date.now() : undefined, reason };
  broadcast({ t: "mode", mode });
  console.log(`[relay] mode -> ${replay ? `REPLAY x${speed}` : "LIVE"} (${reason})`);
  if (replayTimer) clearTimeout(replayTimer);
  replayTimer = null;
  if (replay) runReplay(speed);
}

function runReplay(speed: number) {
  const windowStart = Math.floor(Date.now() / 1000) - config.replayMinutes * 60;
  let buffer = history.filter((e) => e.timestamp >= windowStart);
  if (buffer.length === 0) buffer = history.slice(-200); // stalled long ago: replay the tail
  if (buffer.length === 0) return;
  let i = 0;
  const step = () => {
    if (!mode.replay) return;
    const e = buffer[i];
    broadcast({ t: "event", e: { ...e, replay: true } });
    i++;
    if (i >= buffer.length) i = 0; // loop until live resumes
    const next = buffer[i];
    const gap = next && next.timestamp >= e.timestamp ? (next.timestamp - e.timestamp) * 1000 : 1000;
    replayTimer = setTimeout(step, Math.min(4000, Math.max(30, gap / speed)));
  };
  step();
}

// ---------------------------------------------------------------- HTTP: health, public read API, admin
function json(res: http.ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization" });
  res.end(stringify(body));
}

async function handleHttp(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  if (req.method === "OPTIONS") return json(res, 204, null);
  try {
    if (url.pathname === "/health") return json(res, 200, { ok: true, clients: clients.size, events: history.length, cursor, mode, lastBlock });
    if (url.pathname === "/api/deployment") return json(res, 200, deployment);
    if (url.pathname === "/api/status") return json(res, 200, snapshot ?? (await rq.snapshot()));
    if (url.pathname === "/api/policies") return json(res, 200, snapshot?.pool ?? (await rq.pool()));
    if (url.pathname === "/api/attacks") return json(res, 200, snapshot?.attackPool ?? (await rq.attackPool()));
    if (url.pathname.startsWith("/api/policy/")) {
      const id = BigInt(url.pathname.split("/").pop()!);
      const [p, anc] = await Promise.all([rq.policy(id), rq.ancestors(id).catch(() => [])]);
      return json(res, 200, { ...p, ancestors: anc });
    }
    if (url.pathname === "/api/events") {
      const name = url.searchParams.get("name");
      const limit = Math.min(5000, Number(url.searchParams.get("limit") ?? 200));
      const from = url.searchParams.get("fromBlock");
      let list = name ? history.filter((e) => e.name === name) : history;
      if (from) list = list.filter((e) => e.blockNumber >= BigInt(from));
      return json(res, 200, list.slice(-limit));
    }
    if (url.pathname === "/api/lineage") {
      const births = history.filter((e) => e.name === "Born").map((e) => e.args);
      const installs = history.filter((e) => e.name === "PolicyInstalled").map((e) => ({ ...e.args, block: e.blockNumber }));
      return json(res, 200, { births, installs });
    }
    if (url.pathname === "/admin/replay" && req.method === "POST") {
      if (!config.adminToken || req.headers.authorization !== `Bearer ${config.adminToken}`) return json(res, 401, { error: "unauthorized" });
      const body = await new Promise<string>((r) => {
        let b = "";
        req.on("data", (c) => (b += c));
        req.on("end", () => r(b));
      });
      const { on, speed } = JSON.parse(body || "{}");
      replayManual = Boolean(on);
      setMode(Boolean(on), "operator", Number(speed ?? config.replaySpeed));
      return json(res, 200, mode);
    }
    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 500, { error: (e as Error).message });
  }
}

async function main() {
  console.log(`[relay] chain ${deployment.chainId} rpc ${config.rpcUrl}`);
  console.log(`[relay] backfilling from block ${cursor} ...`);
  await poll();
  console.log(`[relay] ${history.length} events in history`);
  await refreshSnapshot();
  server.listen(config.port, () => console.log(`[relay] ws + http on :${config.port}`));
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    const before = lastBlock;
    await poll();
    if (lastBlock !== before || !snapshot) await refreshSnapshot();
    busy = false;
  }, config.pollMs);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
