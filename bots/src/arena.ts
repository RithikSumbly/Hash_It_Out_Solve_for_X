/**
 * The bot population that keeps the arena alive: honest users, scripted attackers, the evolved-attacker
 * runner, challengers, spectators and the epoch closer. Every bot is block-scheduled against the live
 * epoch so a 3–5 minute testnet epoch and a 20-second local epoch behave the same way.
 */
import { parseEther, formatEther } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import {
  agentProxyAbi,
  ATTACK_PRESETS,
  KIND,
  RedQueen,
  decodeReason,
  encodeAttack,
  executeAttack,
  policyGenes,
  clampInt16,
  type Address,
  type Deployment,
  type Genes,
} from "@redqueen/sdk";
import { ROLES, botAccount, deployerAccount, env, log, publicClient, rqFor, HARDHAT_MNEMONIC, isLocal } from "./env";

export interface Ctx {
  block: bigint;
  epoch: bigint;
  startBlock: bigint;
  endBlock: bigint;
  revealBlock: bigint;
  vault: bigint;
}

export interface Stats {
  spends: number;
  refused: number;
  honestRefused: number;
  attacksRefused: number;
  attacksPassed: number;
  extracted: bigint;
  closes: number;
  reveals: number;
  bets: number;
  errors: number;
  byEpoch: Record<string, { drainsRefused: number; drainsPassed: number; honestRefused: number; honest: number }>;
}

export const stats: Stats = {
  spends: 0,
  refused: 0,
  honestRefused: 0,
  attacksRefused: 0,
  attacksPassed: 0,
  extracted: 0n,
  closes: 0,
  reveals: 0,
  bets: 0,
  errors: 0,
  byEpoch: {},
};

function ep(e: bigint) {
  return (stats.byEpoch[e.toString()] ??= { drainsRefused: 0, drainsPassed: 0, honestRefused: 0, honest: 0 });
}

export function describeError(e: unknown): string {
  const x = e as { shortMessage?: string; details?: string; message?: string; metaMessages?: string[]; cause?: { reason?: string; data?: { errorName?: string } } };
  const name = x.cause?.data?.errorName ?? x.cause?.reason;
  return [x.shortMessage ?? x.message?.split("\n")[0], name, x.details].filter(Boolean).join(" | ").slice(0, 240);
}

const rand = (a: number, b: number) => a + Math.floor(Math.random() * (b - a + 1));

function derived(i: number): Address {
  const m = env.mnemonic || HARDHAT_MNEMONIC;
  return mnemonicToAccount(m, { addressIndex: i }).address;
}

abstract class Bot {
  busy = false;
  epochSeen = -1n;
  plan: { at: bigint; run: () => Promise<void> }[] = [];
  revealed = false;
  constructor(public name: string, public rq: RedQueen) {}
  get me() {
    return this.rq.account;
  }
  async tick(ctx: Ctx) {
    if (this.busy) return;
    this.busy = true;
    try {
      if (ctx.epoch !== this.epochSeen) {
        this.epochSeen = ctx.epoch;
        this.plan = [];
        this.revealed = false;
        await this.onEpoch(ctx);
      }
      while (this.plan.length && this.plan[0].at <= ctx.block && ctx.block + 1n < ctx.endBlock) {
        const a = this.plan.shift()!;
        await a.run();
      }
      await this.step(ctx);
    } catch (e) {
      stats.errors++;
      log(this.name, `error: ${describeError(e)}`);
    } finally {
      this.busy = false;
    }
  }
  schedule(at: bigint, run: () => Promise<void>) {
    this.plan.push({ at, run });
    this.plan.sort((a, b) => (a.at < b.at ? -1 : 1));
  }
  /** a random block inside the traffic phase (before the reveal window) */
  slot(ctx: Ctx, from = 0.05, to = 0.85) {
    const len = Number(ctx.revealBlock - ctx.startBlock);
    return ctx.startBlock + BigInt(Math.max(1, Math.floor(len * (from + Math.random() * (to - from)))));
  }
  abstract onEpoch(ctx: Ctx): Promise<void>;
  async step(_ctx: Ctx): Promise<void> {}
}

// ---------------------------------------------------------------- honest users

class HonestBot extends Bot {
  recipients: Address[];
  agent: Address;
  constructor(name: string, rq: RedQueen, public idx: number) {
    super(name, rq);
    this.recipients = [0, 1, 2].map((k) => derived(200 + idx * 3 + k));
    this.agent = derived(300 + idx);
  }
  async pay(ctx: Ctx, bps: number, kind: number, to: Address) {
    const bal = await this.rq.vaultAvailable();
    const amount = (bal * BigInt(bps)) / 10_000n;
    if (amount === 0n) return;
    const out = await this.rq.spend({ to, amount, kind, label: "honest" });
    stats.spends++;
    ep(out.epoch).honest++;
    if (out.refused) {
      stats.refused++;
      stats.honestRefused++;
      ep(out.epoch).honestRefused++;
      log(this.name, `honest ${kind === 1 ? "withdraw" : kind === 2 ? "delegate" : "pay"} ${formatEther(amount)} REFUSED [${decodeReason(out.reason).join(",")}]`);
    }
  }
  async onEpoch(ctx: Ctx) {
    const e = Number(ctx.epoch);
    // small frequent payments to people it always pays
    const n = rand(2, 3);
    for (let i = 0; i < n; i++) {
      const to = this.recipients[(e + i + this.idx) % this.recipients.length];
      this.schedule(this.slot(ctx), () => this.pay(ctx, rand(40, 120), KIND.PAY, to));
    }
    // one larger "weekly" withdrawal every 4th epoch (staggered per bot)
    if ((e + this.idx) % 4 === 0) this.schedule(this.slot(ctx, 0.3, 0.8), () => this.pay(ctx, rand(250, 400), KIND.WITHDRAW, this.me));
    // agent delegation every 5th epoch
    if ((e + this.idx) % 5 === 0) this.schedule(this.slot(ctx, 0.2, 0.7), () => this.pay(ctx, rand(50, 90), KIND.DELEGATE, this.agent));
  }
  async step(ctx: Ctx) {
    if (!this.revealed && ctx.block + 1n >= ctx.revealBlock && ctx.block + 1n < ctx.endBlock) {
      this.revealed = true;
      const h = await this.rq.reveal();
      if (h) stats.reveals++;
    }
  }
}

// ---------------------------------------------------------------- scripted attackers

type Preset = "drain" | "salami" | "burst" | "delegate" | "hop";

class ScriptedAttacker extends Bot {
  agent?: Address;
  startBalance?: bigint;
  constructor(name: string, rq: RedQueen, public preset: Preset) {
    super(name, rq);
  }
  record(e: bigint, out: { refused: boolean; reason: bigint; balanceAfter: bigint } | null, amount = 0n) {
    if (!out) return;
    stats.spends++;
    if (out.refused) {
      stats.refused++;
      stats.attacksRefused++;
      if (this.preset === "drain") ep(e).drainsRefused++;
    } else {
      stats.attacksPassed++;
      stats.extracted += amount;
      if (this.preset === "drain") ep(e).drainsPassed++;
    }
  }
  async onEpoch(ctx: Ctx) {
    this.startBalance ??= await this.rq.pub.getBalance({ address: this.me });
    const genes = encodeAttack(ATTACK_PRESETS[this.preset].steps);
    if (!(await this.rq.hasAttack(this.me))) await this.rq.submitAttack(genes);
    this.schedule(this.slot(ctx, 0.1, 0.5), () => this.run(ctx, genes));
    if (env.recycle) this.schedule(this.slot(ctx, 0.85, 0.9), () => this.recycle());
  }
  async run(ctx: Ctx, genes: Genes) {
    const e = ctx.epoch;
    if (this.preset === "salami") {
      // 12 slices of 3%, each in its own block
      for (let i = 0; i < 12; i++) {
        const bal = await this.rq.vaultAvailable();
        const amount = (bal * 300n) / 10_000n;
        const out = await this.rq.spend({ to: this.me, amount, label: "attack" }).catch(() => null);
        this.record(e, out, amount);
        if ((await this.rq.pub.getBlockNumber()) + 2n >= ctx.revealBlock) break;
      }
      log(this.name, `salami x12 done`);
      return;
    }
    const res = await executeAttack(this.rq, genes, {
      agent: this.agent,
      shouldStop: async () => (await this.rq.pub.getBlockNumber()) + 2n >= ctx.endBlock,
      onStep: (_i, step, out) => this.record(e, out, out && !out.refused ? (out.balanceAfter * BigInt(step.amountBps)) / BigInt(10_000 - step.amountBps) : 0n),
    });
    this.agent = res.agent;
    const r = res.results.filter(Boolean);
    log(this.name, `${this.preset}: ${r.filter((x) => x!.refused).length} refused / ${r.filter((x) => !x!.refused).length} passed`);
  }
  /** keep test ETH circulating: send extractions back into the vault */
  async recycle() {
    const bal = await this.rq.pub.getBalance({ address: this.me });
    // return only what was extracted: never more than the bot's balance above where it started
    this.startBalance ??= bal;
    const floor = isLocal() ? this.startBalance : this.startBalance < parseEther("0.15") ? this.startBalance : parseEther("0.15");
    if (bal > floor + parseEther("0.01")) await this.rq.deposit(bal - floor);
    if (this.agent) {
      const ab = await this.rq.pub.getBalance({ address: this.agent });
      if (ab > 0n) await this.rq.wallet!.writeContract({ address: this.agent, abi: agentProxyAbi, functionName: "sweep", args: [this.me], account: this.rq.wallet!.account!, chain: this.rq.wallet!.chain });
    }
  }
}

// ---------------------------------------------------------------- evolved attackers (the second population)

class EvolvedRunner extends Bot {
  agent?: Address;
  async onEpoch(ctx: Ctx) {
    if (await this.rq.hasAttack(this.me)) return;
    const pool = await this.rq.attackPool();
    const bred = pool.filter((a) => a.alive && a.submitter === "0x0000000000000000000000000000000000000000").sort((a, b) => b.generation - a.generation || Number(b.id - a.id));
    let genes: Genes;
    if (bred.length) {
      const pick = bred[Math.floor(Math.random() * Math.min(2, bred.length))];
      await this.rq.adoptAttack(pick.id);
      genes = pick.genes;
      log(this.name, `adopted bred attack #${pick.id} (gen ${pick.generation})`);
    } else {
      // no children yet: enter a mutant of a random preset so the population has material to breed
      const keys = Object.keys(ATTACK_PRESETS) as Preset[];
      genes = encodeAttack(ATTACK_PRESETS[keys[rand(0, keys.length - 1)]].steps).map((g, i) => (i % 4 === 0 && g > 0 ? clampInt16(g + rand(-200, 200)) : g));
      await this.rq.submitAttack(genes);
      log(this.name, `submitted a mutant attack template`);
    }
    this.schedule(this.slot(ctx, 0.15, 0.55), async () => {
      const res = await executeAttack(this.rq, genes, {
        agent: this.agent,
        shouldStop: async () => (await this.rq.pub.getBlockNumber()) + 2n >= ctx.endBlock,
        onStep: (_i, _s, out) => {
          if (!out) return;
          stats.spends++;
          if (out.refused) {
            stats.refused++;
            stats.attacksRefused++;
          } else stats.attacksPassed++;
        },
      });
      this.agent = res.agent;
    });
  }
}

// ---------------------------------------------------------------- challengers (policy submitters)

const SEEDS: Genes[] = [
  policyGenes({ weights: { 1: 300, 2: 300 } }), // novelty + velocity
  policyGenes({ weights: { 0: 900, 7: 400 } }), // amount + epoch outflow
  policyGenes({ interactions: { 3: 520 }, thresholds: { 2: 600, 7: 300 } }), // salami detector (3+ rapid spends while the vault drains)
  policyGenes({ weights: { 5: 300, 6: 300 } }), // agent / contract hop
  policyGenes({ weights: { 0: 1500, 4: -600 }, interactions: { 3: 520 }, thresholds: { 2: 600, 7: 250 } }), // reputation-aware cap
];

class Challenger extends Bot {
  seeded = false;
  constructor(name: string, rq: RedQueen, public idx: number) {
    super(name, rq);
  }
  async onEpoch(ctx: Ctx) {
    const pool = await this.rq.pool();
    if (pool.length >= 13) return;
    if ((!this.seeded && Number(ctx.epoch) <= 2) || (this.idx === 3 && Number(ctx.epoch) === 2)) {
      this.seeded = true;
      // challenger k seeds SEEDS[k]; the last challenger also seeds the reputation-aware cap one epoch later
      await this.rq.submitPolicy(SEEDS[Number(ctx.epoch) === 2 && this.idx === 3 ? 4 : this.idx % 4]);
      log(this.name, `seeded policy ${this.idx}`);
      return;
    }
    // one rotating challenger per epoch submits a mutant of the champion
    if (Number(ctx.epoch) % 4 !== this.idx) return;
    const live = await this.rq.liveGenome();
    const g = [...live.genes];
    for (let k = 0; k < 3; k++) {
      const i = rand(0, 23);
      g[i] = clampInt16(g[i] + (i >= 16 ? rand(-120, 120) : rand(-150, 150)));
    }
    this.schedule(this.slot(ctx, 0.05, 0.3), async () => {
      await this.rq.submitPolicy(g);
      log(this.name, `submitted a mutant of champion #${live.id}`);
    });
  }
}

// ---------------------------------------------------------------- spectators

class Spectator extends Bot {
  betEpochs: bigint[] = [];
  constructor(name: string, rq: RedQueen, public strategy: "champion" | "underdog") {
    super(name, rq);
  }
  async onEpoch(ctx: Ctx) {
    for (const e of this.betEpochs.filter((x) => x < ctx.epoch)) {
      await this.rq.settleBet(e).catch(() => {});
    }
    this.betEpochs = this.betEpochs.filter((x) => x >= ctx.epoch);
    if ((await this.rq.claimable(this.me)) > parseEther("0.01")) await this.rq.claim();
    const pool = await this.rq.pool();
    const live = await this.rq.liveGenome();
    const roots = [...new Set(pool.map((p) => p.root))];
    const champRoot = pool.find((p) => p.id === live.id)?.root ?? roots[0];
    const pick = this.strategy === "champion" ? champRoot : roots[rand(0, roots.length - 1)];
    this.schedule(this.slot(ctx, 0.1, 0.6), async () => {
      await this.rq.placeBet(pick, parseEther("0.005"));
      this.betEpochs.push(ctx.epoch);
      stats.bets++;
    });
  }
}

// ---------------------------------------------------------------- closer

class Closer extends Bot {
  async onEpoch() {}
  async step(ctx: Ctx) {
    if (ctx.block >= ctx.endBlock) {
      try {
        await this.rq.closeEpoch();
        stats.closes++;
        const live = await this.rq.liveGenome();
        log(this.name, `closed epoch ${ctx.epoch} -> live policy #${live.id} (generation ${live.installCount})`);
      } catch (e) {
        const msg = (e as Error).message;
        if (!/EpochNotOver|EpochAlreadyClosed|reverted/.test(msg)) throw e;
      }
    }
  }
}

// ---------------------------------------------------------------- orchestrator

export type Role = "honest" | "attackers" | "evolved" | "challengers" | "spectators" | "closer";

export interface RunOptions {
  deployment: Deployment;
  roles?: Role[];
  epochs?: number; // stop after this many closes observed
  onTick?: (ctx: Ctx) => void;
}

export async function registerHonestBots(d: Deployment) {
  const registrar = rqFor(deployerAccount(), d, "registrar");
  for (const i of ROLES.honest) {
    const a = botAccount(i).address;
    if (!(await registrar.isHonest(a))) {
      await registrar.registerHonest(a);
      log("registrar", `registered honest bot ${a}`);
    }
  }
}

export async function runArena(o: RunOptions) {
  const d = o.deployment;
  const roles = new Set<Role>(o.roles ?? ["honest", "attackers", "evolved", "challengers", "spectators", "closer"]);
  const bots: Bot[] = [];
  if (roles.has("honest")) {
    await registerHonestBots(d);
    ROLES.honest.forEach((ix, k) => bots.push(new HonestBot(`honest-${k + 1}`, rqFor(botAccount(ix), d, `honest-${k + 1}`), k)));
  }
  if (roles.has("attackers")) {
    const presets: Preset[] = ["drain", "salami", "burst", "delegate", "hop"];
    ROLES.attackers.forEach((ix, k) => bots.push(new ScriptedAttacker(`atk-${presets[k]}`, rqFor(botAccount(ix), d, `atk-${k}`), presets[k])));
  }
  if (roles.has("evolved")) bots.push(new EvolvedRunner("evolved", rqFor(botAccount(ROLES.evolved[0]), d, "evolved")));
  if (roles.has("challengers")) ROLES.challengers.forEach((ix, k) => bots.push(new Challenger(`challenger-${k + 1}`, rqFor(botAccount(ix), d, `ch-${k}`), k)));
  if (roles.has("spectators")) {
    bots.push(new Spectator("spectator-1", rqFor(botAccount(ROLES.spectators[0]), d, "sp-0"), "champion"));
    bots.push(new Spectator("spectator-2", rqFor(botAccount(ROLES.spectators[1]), d, "sp-1"), "underdog"));
  }
  if (roles.has("closer")) bots.push(new Closer("closer", rqFor(botAccount(ROLES.closer[0]), d, "closer")));

  const reader = new RedQueen({ deployment: d, publicClient: publicClient() });
  log("arena", `${bots.length} bots on chain ${d.chainId}: ${[...roles].join(", ")}`);
  const startEpoch = await reader.epoch();
  let stop = false;
  const done = new Promise<void>((resolve) => {
    const loop = async () => {
      if (stop) return resolve();
      try {
        const [st, block, vault] = await Promise.all([reader.status(), publicClient().getBlockNumber(), reader.vaultBalance()]);
        const ctx: Ctx = { block, epoch: st.epoch, startBlock: st.startBlock, endBlock: st.endBlock, revealBlock: st.revealBlock, vault };
        o.onTick?.(ctx);
        if (o.epochs && st.epoch - startEpoch >= BigInt(o.epochs)) {
          stop = true;
          // let in-flight bot actions settle
          while (bots.some((b) => b.busy)) await new Promise((r) => setTimeout(r, 200));
          return resolve();
        }
        for (const b of bots) void b.tick(ctx);
      } catch (e) {
        log("arena", `tick error ${(e as Error).message.split("\n")[0]}`);
      }
      setTimeout(loop, env.tickMs);
    };
    loop();
  });
  return {
    done,
    stop: () => {
      stop = true;
    },
  };
}
