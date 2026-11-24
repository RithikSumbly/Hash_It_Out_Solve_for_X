import { expect } from "chai";
import { ethers } from "hardhat";
import { mine } from "@nomicfoundation/hardhat-network-helpers";
import type { Log, TransactionReceipt } from "ethers";
import { deployV2World, deployWorld, doSpend, toEpochEnd, EPOCH, HONEST, ATTACK, AMOUNT_CAP, REFUSE_ALL, ZERO, POLICY_STAKE as V1_POLICY_STAKE, packed, fillLog, type V2World } from "./fixture";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { encodeAttack, ATTACK_PRESETS, policyGenes, unpackFeatures, type Genes } from "../../sdk/src/genome";
import { V2_DEFAULTS, V2_GENESIS, V2_HONEST_BENCH, v2SeedAttackGenomes } from "../../sdk/src/v2";

const E = (x: string) => ethers.parseEther(x);
const pk = (g: Genes): [bigint, bigint] => {
  const p = packed(g);
  return [p.lo, p.hi];
};

/** Genesis plus a salami detector (k3: velocity x outflow) and a burst detector (k2: novelty x velocity). */
const STRONG = policyGenes({ weights: { 0: 1500, 7: 500 }, interactions: { 2: 600, 3: 600 }, thresholds: { 1: 900, 2: 400, 7: 100 } });

/** Decoded events a contract emitted in a receipt, in order. */
function eventsIn(rc: TransactionReceipt, c: { interface: { parseLog(l: Log): any } }, address: string) {
  return rc.logs.filter((l) => l.address.toLowerCase() === address.toLowerCase()).map((l) => c.interface.parseLog(l));
}

async function proposed(w: V2World, rc: TransactionReceipt) {
  return eventsIn(rc, w.crucible, await w.crucible.getAddress()).find((e) => e.name === "Proposed")!.args;
}

const presets = ["drain", "salami", "burst", "delegate", "hop"] as const;
async function lossVsPresets(w: V2World, lo: bigint, hi: bigint) {
  let t = 0n;
  for (const n of presets) {
    const a = packed(encodeAttack(ATTACK_PRESETS[n].steps));
    t += await w.crucible.extracted(lo, hi, a.lo, a.hi);
  }
  return t / BigInt(presets.length);
}

describe("Arena — the genesis policy and deploy-time economics", () => {
  it("genesis refuses a 40% drain and a 50% payment, and passes 0.4–1.2% payments from a newly registered wallet", async () => {
    const w = await deployV2World();
    const live = await w.firewall.exportGenome();
    expect([live.lo, live.hi]).to.deep.equal(pk(V2_GENESIS));
    const [x, judge] = [w.signers[3], w.signers[4]];
    await w.arena.connect(x).submitAttack(encodeAttack(ATTACK_PRESETS.drain.steps), { value: V2_DEFAULTS.attackStake });
    const bal0 = await w.vault.balance();
    const drain = await doSpend(w, x, x.address, (bal0 * 40n) / 100n, ATTACK);
    expect(drain.refused).to.equal(true);
    expect(drain.score).to.equal(800_000n);
    expect(drain.reason & 1n).to.equal(1n); // too large
    expect(drain.reason & (1n << 7n)).to.equal(1n << 7n); // the vault already draining
    // a second request over a hard limit in one round reverts, so the 50% payment is asked of previewSpend
    const half = await w.vault.previewSpend(x.address, x.address, bal0 / 2n);
    expect(half.refused).to.equal(true);
    expect(half.score).to.equal(1_000_000n); // genesis refuses it on its own, limits aside
    await expect(w.vault.connect(x).spend(x.address, bal0 / 2n, 0, ethers.ZeroHash)).to.be.revertedWithCustomError(w.vault, "HardLimit");
    expect(await w.vault.balance()).to.equal(bal0);

    await w.vault.registerHonest(judge.address);
    for (const bps of [40n, 80n, 120n]) {
      const r = await doSpend(w, judge, ethers.Wallet.createRandom().address, ((await w.vault.balance()) * bps) / 10_000n, HONEST);
      expect(r.refused, `${bps} bps`).to.equal(false);
      expect(unpackFeatures(r.features)[4]).to.equal(500); // reputation of a wallet registered a moment ago
    }
  });

  it("stakes, the minimum bet, the closer's tip and the mutation size are the deploy-time values", async () => {
    const w = await deployV2World();
    expect(await w.arena.POLICY_STAKE()).to.equal(V2_DEFAULTS.policyStake);
    expect(await w.arena.ATTACK_STAKE()).to.equal(V2_DEFAULTS.attackStake);
    expect(await w.arena.MIN_BET()).to.equal(V2_DEFAULTS.minBet);
    expect(await w.arena.closeTip()).to.equal(V2_DEFAULTS.closeTip);
    expect(await w.arena.mutationScale()).to.equal(BigInt(V2_DEFAULTS.mutationScale));
    expect(await w.arena.crucible()).to.equal(await w.crucible.getAddress());
    const [p, b] = w.signers;
    await expect(w.arena.connect(p).submitPolicy(AMOUNT_CAP, { value: V1_POLICY_STAKE }))
      .to.be.revertedWithCustomError(w.arena, "BadStake")
      .withArgs(V2_DEFAULTS.policyStake);
    await expect(w.arena.connect(p).submitPolicy(AMOUNT_CAP, { value: V2_DEFAULTS.policyStake })).to.emit(w.arena, "PolicySubmitted");
    await expect(w.arena.connect(b).placeBet(1, { value: V2_DEFAULTS.minBet - 1n })).to.be.revertedWithCustomError(w.arena, "BetTooSmall");
    await expect(w.arena.connect(b).placeBet(1, { value: V2_DEFAULTS.minBet })).to.emit(w.arena, "BetPlaced");
    await expect(w.arena.setCrucible(p.address)).to.be.revertedWithCustomError(w.arena, "CrucibleAlreadySet");
  });

  it("the attack pool holds the five scripted attacks from deploy, before anyone stakes", async () => {
    const w = await deployV2World();
    const ids = await w.arena.getAttackPool();
    const seeds = v2SeedAttackGenomes();
    expect(ids.length).to.equal(seeds.length);
    for (let i = 0; i < seeds.length; i++) {
      const a = await w.arena.getAttack(ids[i]);
      expect([a.lo, a.hi, a.alive]).to.deep.equal([seeds[i].lo, seeds[i].hi, true]);
    }
  });
});

describe("Arena — self-driving epochs", () => {
  it("an honest payment after the end block closes the epoch in its own transaction, is judged in the new one, and earns the tip", async () => {
    const w = await deployV2World();
    const h = w.signers[2];
    await w.vault.registerHonest(h.address);
    await toEpochEnd(w); // the next block is the end block: the epoch is due
    const rc = (await (await w.vault.connect(h).spend(h.address, (await w.vault.balance()) / 100n, 1, ethers.ZeroHash)).wait())!;
    const a = eventsIn(rc, w.arena, await w.arena.getAddress()).map((e) => e.name);
    expect(a).to.include.members(["EpochClosed", "PolicyInstalled", "ChildBorn", "BetSettled", "Rewarded", "EpochStarted"]);
    // the Crucible also files the round's top attack plan in its hall of fame
    expect(eventsIn(rc, w.crucible, await w.crucible.getAddress()).map((e) => e.name)).to.deep.equal(["Sparred", "Archived"]);
    const tip = eventsIn(rc, w.arena, await w.arena.getAddress()).find((e) => e.name === "Rewarded" && e.args.kind === 2n)!;
    expect([tip.args.to, tip.args.amount]).to.deep.equal([h.address, V2_DEFAULTS.closeTip]);
    expect(await w.arena.claimable(h.address)).to.equal(V2_DEFAULTS.closeTip);
    expect(await w.arena.currentEpoch()).to.equal(2n);
    const spend = eventsIn(rc, w.vault, await w.vault.getAddress()).find((e) => e.name === "Spend")!;
    expect(spend.args.epoch).to.equal(2n);
    expect(await w.vault.epochTxCount(2)).to.equal(1n);
  });

  it("a wallet staked in the current epoch never closes it: its spends land in the epoch it staked for", async () => {
    const w = await deployV2World();
    const [x, h] = [w.signers[3], w.signers[2]];
    await w.arena.connect(x).submitAttack(encodeAttack(ATTACK_PRESETS.salami.steps), { value: V2_DEFAULTS.attackStake });
    const id = await w.arena.attackOf(1, x.address);
    await toEpochEnd(w);
    await mine(3); // well past due
    const r = await doSpend(w, x, x.address, ((await w.vault.balance()) * 300n) / 10_000n, ATTACK);
    expect(r.refused).to.equal(false);
    expect(await w.arena.currentEpoch()).to.equal(1n);
    expect((await w.vault.getTx(1, r.txId)).caller).to.equal(x.address);
    // a staked wallet may close nothing, so it needs no gas reserve
    await expect(w.vault.connect(x).spend(x.address, 1n, 0, ethers.ZeroHash, { gasLimit: 1_000_000 })).to.emit(w.vault, "Spend");
    // the next transaction from anyone else closes it, and the extraction counts for epoch 1
    await w.vault.registerHonest(h.address);
    await expect(w.vault.connect(h).spend(h.address, 1n, 1, ethers.ZeroHash)).to.emit(w.arena, "EpochClosed");
    expect(await w.arena.attackExtracted(1, id)).to.be.greaterThan(0n);
    await expect(w.arena.connect(x).submitAttack(encodeAttack(ATTACK_PRESETS.drain.steps), { value: V2_DEFAULTS.attackStake })).to.emit(w.arena, "AttackSubmitted");
  });

  it("anyone who may close must bring CLOSE_GAS, due or not; only the gas used is charged", async () => {
    const w = await deployV2World();
    const h = w.signers[2];
    await w.vault.registerHonest(h.address);
    const reserve = await w.arena.CLOSE_GAS();
    await expect(w.vault.connect(h).spend(h.address, 1n, 1, ethers.ZeroHash, { gasLimit: 1_000_000 }))
      .to.be.revertedWithCustomError(w.arena, "NeedGas")
      .withArgs(reserve);
    expect(await w.vault.connect(h).spend.estimateGas(h.address, 1n, 1, ethers.ZeroHash)).to.be.greaterThan(reserve);
    const rc = (await (await w.vault.connect(h).spend(h.address, 1n, 1, ethers.ZeroHash)).wait())!;
    expect(rc.gasUsed).to.be.lessThan(1_000_000n);
  });

  it("a new attack plan, a challenger or a bet after the end block closes the epoch first and lands in the new one", async () => {
    const w = await deployV2World();
    const [y, p, b] = [w.signers[6], w.signers[7], w.signers[8]];
    await toEpochEnd(w);
    await expect(w.arena.connect(y).submitAttack(encodeAttack(ATTACK_PRESETS.burst.steps), { value: V2_DEFAULTS.attackStake })).to.emit(w.arena, "EpochClosed");
    expect(await w.arena.currentEpoch()).to.equal(2n);
    expect(await w.arena.attackOf(2, y.address)).to.not.equal(0n);
    expect(await w.arena.hasAttack(y.address)).to.equal(true);
    await toEpochEnd(w);
    // a challenger proposed through the Crucible (a staked one must also pass its screen against a champion bred from
    // the block hashes, which made this test flaky: whatever the screen says, the close comes first)
    const tx = w.crucible.connect(p).propose(...pk(AMOUNT_CAP));
    await expect(tx).to.emit(w.arena, "EpochClosed");
    await expect(tx).to.emit(w.crucible, "Proposed").withArgs(p.address, anyValue, 3n, anyValue, anyValue, anyValue, anyValue, anyValue, anyValue, anyValue);
    await toEpochEnd(w);
    await expect(w.arena.connect(b).placeBet(1, { value: V2_DEFAULTS.minBet })).to.emit(w.arena, "EpochClosed");
    expect((await w.arena.bets(4, b.address)).amount).to.equal(V2_DEFAULTS.minBet);
  });

  it("a payment estimated before the epoch fell due still closes it with that estimate as its gas limit", async function () {
    this.timeout(120000);
    const w = await deployV2World();
    const [h, p1, p2, x1, x2] = [w.signers[2], w.signers[3], w.signers[4], w.signers[5], w.signers[6]];
    await w.vault.registerHonest(h.address);
    await w.arena.connect(p1).submitPolicy(AMOUNT_CAP, { value: V2_DEFAULTS.policyStake });
    await w.arena.connect(p2).submitPolicy(STRONG, { value: V2_DEFAULTS.policyStake });
    await w.arena.connect(x1).submitAttack(encodeAttack(ATTACK_PRESETS.salami.steps), { value: V2_DEFAULTS.attackStake });
    await w.arena.connect(x2).submitAttack(encodeAttack(ATTACK_PRESETS.burst.steps), { value: V2_DEFAULTS.attackStake });
    for (let i = 0; i < 3; i++) await doSpend(w, x1, x1.address, ((await w.vault.balance()) * 300n) / 10_000n, ATTACK);
    const end = await w.arena.epochEndBlock();
    const now = BigInt(await ethers.provider.getBlockNumber());
    if (now + 3n < end) await mine(end - now - 3n);
    const amount = (await w.vault.balance()) / 100n;
    const est = await w.vault.connect(h).spend.estimateGas(h.address, amount, 1, ethers.ZeroHash); // not due yet
    await mine(4); // now it is
    const rc = (await (await w.vault.connect(h).spend(h.address, amount, 1, ethers.ZeroHash, { gasLimit: process.env.PROBE ? 16_700_000n : est })).wait())!;
    expect(rc.status).to.equal(1);
    expect(eventsIn(rc, w.arena, await w.arena.getAddress()).map((e) => e.name)).to.include("EpochClosed");
    console.log(`        estimated ${est} before due; the close + payment used ${rc.gasUsed}`);
  });
});

describe("Arena — the honest bench and the sparring ring", () => {
  it("an epoch with no revealed honest labels would install refuse-everything without the bench and cannot with it", async () => {
    async function play(w: Awaited<ReturnType<typeof deployWorld>>, wire?: () => Promise<unknown>) {
      const [p, h] = [w.signers[1], w.signers[2]];
      await w.vault.registerHonest(h.address);
      await w.arena.connect(p).submitPolicy(REFUSE_ALL, { value: await w.arena.POLICY_STAKE() });
      if (wire) await wire();
      // honest payments that nobody reveals: unrevealed labels count as attacks, so refusing them looks like a win
      for (let i = 0; i < 3; i++) await doSpend(w, h, ethers.Wallet.createRandom().address, (await w.vault.balance()) / 100n, HONEST);
      await toEpochEnd(w);
      await w.arena.closeEpoch();
      const live = await w.firewall.exportGenome();
      const after = await doSpend(w, h, ethers.Wallet.createRandom().address, (await w.vault.balance()) / 100n, HONEST);
      return { live, after };
    }
    const v1 = await play(await deployWorld());
    expect([v1.live.lo, v1.live.hi]).to.deep.equal(pk(REFUSE_ALL)); // without the bench, everyone is refused from now on
    expect(v1.after.refused).to.equal(true);
    // a staked refuse-everything does not even enter (the Crucible's screen, REFUSED_HONEST)...
    const v3 = await deployV2World();
    await expect(v3.arena.connect(v3.signers[1]).submitPolicy(REFUSE_ALL, { value: await v3.arena.POLICY_STAKE() }))
      .to.be.revertedWithCustomError(v3.arena, "Screened")
      .withArgs(1n);
    // ...so to show the close-time bench, it enters before the Crucible is wired (as an unscreened bred child might be)
    const v2w = await deployV2World({ crucible: false });
    const v2 = await play(v2w, () => v2w.arena.setCrucible(v2w.crucible.getAddress()));
    expect([v2.live.lo, v2.live.hi]).to.not.deep.equal(pk(REFUSE_ALL));
    expect(v2.after.refused).to.equal(false);
  });

  it("each close plays every candidate against the attack pool and the bench, and the score decides the ranking", async () => {
    const w = await deployV2World();
    const p = w.signers[1];
    await w.arena.connect(p).submitPolicy(STRONG, { value: V2_DEFAULTS.policyStake });
    await toEpochEnd(w);
    const rc = (await (await w.arena.closeEpoch()).wait())!;
    const sp = eventsIn(rc, w.crucible, await w.crucible.getAddress()).find((e) => e.name === "Sparred")!.args;
    expect(sp.policies).to.deep.equal([1n, 2n]); // pool order: genesis, STRONG
    expect(sp.honestRefused).to.deep.equal([0n, 0n]);
    expect(sp.fitness[1]).to.be.greaterThan(sp.fitness[0]); // STRONG lets the scripted attacks take less
    expect(sp.fitness[0]).to.equal(-(await lossVsPresets(w, ...pk(V2_GENESIS))));
    const closed = eventsIn(rc, w.arena, await w.arena.getAddress()).find((e) => e.name === "EpochClosed")!.args;
    expect(closed.champion).to.equal(2n);
    const start = await w.arena.epochStartBalance(); // unchanged: no traffic
    expect(closed.fitness[0]).to.equal((sp.fitness[1] * start) / 1_000_000n);
  });
});

/**
 * Fill the Crucible's hall of fame with SIM_ARCHIVE attack plans the pool does not hold, so the next close spars
 * every one of them on top of the pool's first eight (the worst case; in practice at most three can be new, because
 * the plan archived at the previous close is always one of its survivors). Storage: honest (slot 0), proposals (1),
 * proposalsRefused (2), archive[k][i] at 3 + 2k + i, archiveCount (11), archiveNext (12); read back to check.
 */
async function fillArchive(w: V2World) {
  const c = await w.crucible.getAddress();
  const n = Number(await w.crucible.SIM_ARCHIVE());
  const word = (x: bigint) => ethers.zeroPadValue(ethers.toBeHex(x), 32);
  const plans: { lo: bigint; hi: bigint }[] = [];
  for (let i = 0; i < n; i++) {
    const g = packed(encodeAttack(Array.from({ length: 8 }, (_, k) => ({ amountBps: 900 + 37 * i + 11 * k, recipient: (["self", "fresh", "contract"] as const)[(i + k) % 3], route: (["direct", "agent"] as const)[k % 2] }))));
    plans.push(g);
    await ethers.provider.send("hardhat_setStorageAt", [c, ethers.toQuantity(3 + 2 * i), word(g.lo)]);
    await ethers.provider.send("hardhat_setStorageAt", [c, ethers.toQuantity(4 + 2 * i), word(g.hi)]);
  }
  await ethers.provider.send("hardhat_setStorageAt", [c, ethers.toQuantity(11), word(BigInt(n))]);
  await ethers.provider.send("hardhat_setStorageAt", [c, ethers.toQuantity(12), word(0n)]);
  const [xl, xh] = await w.crucible.getArchive();
  expect([...xl]).to.deep.equal(plans.map((p) => p.lo));
  expect([...xh]).to.deep.equal(plans.map((p) => p.hi));
}

describe("Arena — a bounded close", () => {
  it("pays at most 32 wrongly refused honest users per close, so no epoch can need more than the gas cap to close", async function () {
    this.timeout(300000);
    const w = await deployV2World({ epoch: 400n, reveal: 120n });
    const max = Number(await w.vault.MAX_COMPENSATED());
    const users = Array.from({ length: max + 2 }, () => ethers.Wallet.createRandom().connect(ethers.provider));
    for (const u of users) {
      await w.owner.sendTransaction({ to: u.address, value: E("0.05") });
      await w.vault.registerHonest(u.address);
    }
    // each asks to withdraw 30% of the vault: genesis refuses it, and each reveals the payment as honest
    const results = [];
    for (const u of users) results.push(await doSpend(w, u as any, u.address, ((await w.vault.balance()) * 30n) / 100n, HONEST, 1));
    expect(results.every((r) => r.refused)).to.equal(true);
    const { toReveal, reveal } = await import("./fixture");
    await toReveal(w);
    for (const [i, u] of users.entries()) await reveal(w, u as any, [results[i]]);
    await toEpochEnd(w);
    const rc = (await (await w.arena.closeEpoch()).wait())!;
    const paid = eventsIn(rc, w.arena, await w.arena.getAddress()).filter((e) => e.name === "Compensated");
    expect(paid.length).to.equal(max);
    console.log(`        ${users.length} wrongly refused honest users, ${paid.length} compensated; the close used ${rc.gasUsed} gas`);
  });

  it("the worst close the contracts allow (64 attackers, 32 paid users, 16 candidates, 16 plans, 240 txs) stays under the 2^24 gas cap", async function () {
    this.timeout(900000);
    const w = await deployV2World({ epoch: 700n, reveal: 120n, funds: E("1000") });
    const s = w.signers;
    const fund = async (n: number) => {
      const out = Array.from({ length: n }, () => ethers.Wallet.createRandom().connect(ethers.provider));
      for (const u of out) await w.owner.sendTransaction({ to: u.address, value: E("0.05") });
      return out;
    };
    const attackers = await fund(Number(await w.arena.MAX_ATTACKERS_PER_EPOCH()));
    const honest = await fund(Number(await w.vault.MAX_COMPENSATED()));
    for (const u of honest) await w.vault.registerHonest(u.address);
    const filler = s[22];
    await w.vault.registerHonest(filler.address);

    for (let i = 0; i < 14; i++) await w.arena.connect(s[i]).submitPolicy(policyGenes({ weights: { 0: 1600 + i, 7: 400 + i } }), { value: V2_DEFAULTS.policyStake });
    await w.crucible.connect(s[14]).propose(...pk(STRONG));
    expect((await w.arena.getPool()).length).to.equal(16);
    for (const [i, x] of attackers.entries()) {
      if (i < 11) {
        const genes = encodeAttack(Array.from({ length: 8 }, (_, k) => ({ amountBps: 50 + 10 * i + k, recipient: k % 2 ? "fresh" : "self" })));
        await w.arena.connect(x).submitAttack(genes, { value: V2_DEFAULTS.attackStake });
      } else {
        await w.arena.connect(x).adoptAttack((await w.arena.getAttackPool())[i % 16], { value: V2_DEFAULTS.attackStake });
      }
    }
    expect((await w.arena.getAttackPool()).length).to.equal(16);
    for (const x of attackers) await w.vault.connect(x).spend(x.address, E("0.01"), 0, ethers.ZeroHash); // every stake comes back
    const refused = [];
    for (const u of honest) refused.push(await doSpend(w, u as any, u.address, ((await w.vault.balance()) * 30n) / 100n, HONEST, 1));
    const max = Number(await w.vault.MAX_TX_PER_EPOCH());
    // one wallet logs at most MAX_TX_PER_CALLER a round, so fresh honest wallets fill the log
    await fillLog(w, max, () => s[(Math.random() * 10) | 0].address);
    const { toReveal, reveal } = await import("./fixture");
    await toReveal(w);
    for (const [i, u] of honest.entries()) await reveal(w, u as any, [refused[i]]);
    await toEpochEnd(w);
    await mine(1);
    // the hall of fame adds up to Crucible.SIM_ARCHIVE plans to the sparring. Price the close (the gas limit it
    // needs: refunds come after) with an empty archive, then fill it with plans the pool lacks and close for real
    const est0 = await w.arena.closeEpoch.estimateGas({ gasLimit: 16_777_216 });
    await fillArchive(w);
    const est = await w.arena.closeEpoch.estimateGas({ gasLimit: 16_777_216 });
    const rc = (await (await w.arena.closeEpoch({ gasLimit: 16_777_216 })).wait())!;
    const ev = eventsIn(rc, w.arena, await w.arena.getAddress());
    // each stake came back at the payment that took at least the stake, not at the close
    expect(ev.filter((e) => (e.name === "StakeReturned" && e.args.attack) || e.name === "StakeForfeited").length).to.equal(0);
    expect(await w.arena.stakesReturned(1)).to.equal(BigInt(attackers.length));
    expect(ev.filter((e) => e.name === "Compensated").length).to.equal(honest.length);
    const reserve = await w.arena.CLOSE_GAS();
    const est3 = est0 + ((est - est0) * 3n) / 4n; // three new archived plans, the most a close can really meet
    console.log(
      `        the worst close: a gas limit of ${est0} needed with an empty archive; with ${await w.crucible.SIM_ARCHIVE()} archived plans ` +
        `not in the pool: ${est} needed, ${rc.gasUsed} used; with three: ~${est3} (CLOSE_GAS ${reserve}; cap 16,777,216)`,
    );
    // inside CLOSE_GAS with room to spare, even with all four archived plans new
    expect(est).to.be.lessThan((reserve * 95n) / 100n);
    expect(est3).to.be.lessThan((reserve * 9n) / 10n);
  });
});

describe("Arena — proposals screened on chain (the queen, or anyone)", () => {
  it("refuse-everything is refused (honest bench), an empty policy is refused (weaker than the champion), a stronger one enters the pool", async () => {
    const w = await deployV2World();
    const [queen] = [w.signers[10]];
    const c = w.crucible.connect(queen);
    let a = await proposed(w, (await (await c.propose(...pk(REFUSE_ALL))).wait())!);
    expect([a.verdict, a.honestRefused, a.id]).to.deep.equal([1n, BigInt(V2_HONEST_BENCH.length), 0n]);
    a = await proposed(w, (await (await c.propose(...pk(ZERO))).wait())!);
    expect(a.verdict).to.equal(5n); // it lets every drain canary through, checked before the champion comparison
    expect(a.fitness).to.be.lessThan(a.championFitness);
    const rc = (await (await c.propose(...pk(STRONG))).wait())!;
    a = await proposed(w, rc);
    expect(a.verdict).to.equal(0n);
    expect(a.fitness).to.be.greaterThan(a.championFitness);
    const sub = eventsIn(rc, w.arena, await w.arena.getAddress()).find((e) => e.name === "PolicySubmitted")!.args;
    expect([sub.id, sub.submitter, sub.lo]).to.deep.equal([a.id, queen.address, pk(STRONG)[0]]);
    expect(eventsIn(rc, w.lineage, await w.lineage.getAddress()).map((e) => e.name)).to.deep.equal(["Born"]);
    expect(await w.arena.getPool()).to.deep.equal([1n, a.id]);
    expect((await w.arena.getPolicy(a.id)).stake).to.equal(0n);
    // one accepted policy per wallet per epoch (refusals do not use it up)
    a = await proposed(w, (await (await c.propose(...pk(STRONG))).wait())!);
    expect(a.verdict).to.equal(3n);
    expect(await w.crucible.proposals()).to.equal(4n);
    expect(await w.crucible.proposalsRefused()).to.equal(3n);
  });

  it("an accepted proposal wins the next close on sparring, is installed, and then refuses a real salami attack", async () => {
    const w = await deployV2World();
    await w.crucible.connect(w.signers[10]).propose(...pk(STRONG));
    await toEpochEnd(w);
    await w.arena.closeEpoch();
    expect([...(await w.firewall.exportGenome()).slice(0, 2)]).to.deep.equal(pk(STRONG));
    const x = w.signers[5];
    await w.arena.connect(x).submitAttack(encodeAttack(ATTACK_PRESETS.salami.steps), { value: V2_DEFAULTS.attackStake });
    const out: boolean[] = [];
    for (let i = 0; i < 8; i++) out.push((await doSpend(w, x, x.address, ((await w.vault.balance()) * 300n) / 10_000n, ATTACK)).refused);
    expect(out).to.deep.equal([false, false, false, true, true, true, true, true]); // genesis let all 8 through
  });

  it("refused when the pool is full; after the end block a proposal closes the epoch first and tips the proposer", async () => {
    const w = await deployV2World();
    // staked policies pass the screen, so these keep genesis's outflow weight (an amount weight alone is weaker)
    for (let i = 0; i < 15; i++) await w.arena.connect(w.signers[i]).submitPolicy(policyGenes({ weights: { 0: 1600 + i, 7: 400 + i } }), { value: V2_DEFAULTS.policyStake });
    const q = w.signers[20];
    let a = await proposed(w, (await (await w.crucible.connect(q).propose(...pk(STRONG))).wait())!);
    expect(a.verdict).to.equal(4n);
    await toEpochEnd(w);
    const rc = (await (await w.crucible.connect(q).propose(...pk(STRONG))).wait())!;
    const ev = eventsIn(rc, w.arena, await w.arena.getAddress());
    expect(ev.map((e) => e.name)).to.include("EpochClosed");
    expect(ev.find((e) => e.name === "Rewarded" && e.args.kind === 2n)!.args.to).to.equal(q.address);
    a = await proposed(w, rc);
    expect(a.epoch).to.equal(2n);
    expect(a.verdict).to.not.equal(4n); // the close left 8 in the pool
  });
});

describe("Arena — evolution and gas", () => {
  it("evolves with no traffic: 40 closes, new champions that beat genesis against the attackers of the day", async function () {
    this.timeout(600000);
    const w = await deployV2World();
    const [gLo, gHi] = pk(V2_GENESIS);
    const lambdaBench = await w.crucible.lambdaBench();
    let prev = gLo;
    let changes = 0;
    let better = 0;
    let worse = 0;
    let sumChamp = 0n;
    let sumGen = 0n;
    let benchRefusing = 0;
    const takes: string[] = [];
    for (let i = 1; i <= 40; i++) {
      await mine(Number(EPOCH));
      const gen = await w.crucible.screen(gLo, gHi); // genesis against the attack pool about to be graded
      const rc = (await (await w.arena.closeEpoch()).wait())!;
      const sp = eventsIn(rc, w.crucible, await w.crucible.getAddress()).find((e) => e.name === "Sparred")!.args;
      const live = await w.firewall.exportGenome();
      // the champion's sparring score at this close (bench and canaries priced in), against the same attackers as
      // genesis's screen just before it. A refused bench payment costs 2 x its amount + 0.5% of the
      // vault, so a champion may refuse a small honest bench payment when that stops more
      // than it costs; it is still never let through the screen (REFUSED_HONEST)
      const champFit = sp.fitness[(sp.policies as bigint[]).indexOf(live.policyId)] as bigint;
      const [bench] = await w.crucible.benchCost(live.lo, live.hi);
      const [drains] = await w.crucible.canaryPasses(live.lo, live.hi);
      expect(drains, `close ${i}: the champion lets a drain canary through`).to.equal(0n);
      if ((await w.crucible.honestRefusals(live.lo, live.hi)) > 0n) benchRefusing++;
      const champLost = -champFit - bench - lambdaBench * drains;
      if (champFit > gen.fitness) better++;
      if (champFit < gen.fitness) worse++;
      sumChamp += champLost;
      sumGen += gen.lost;
      if (live.lo !== prev) {
        changes++;
        prev = live.lo;
      }
      if (i % 10 === 0) takes.push(`${Number(sp.take[0]) / 1e4}%`);
    }
    console.log(
      `        ${changes} new champions; against the attackers of each round the champion lets them take ${Number(sumChamp / 40n) / 1e4}% ` +
        `on average where genesis would let them take ${Number(sumGen / 40n) / 1e4}% (priced fitness better in ${better}/40 closes, worse in ${worse}); ` +
        `best attacker's take every 10 closes: ${takes.join(", ")}; the champion refused some bench payment in ${benchRefusing}/40 closes`,
    );
    expect(await w.firewall.installCount()).to.equal(41n);
    expect(changes).to.be.greaterThanOrEqual(3);
    expect(better).to.be.greaterThanOrEqual(20);
    expect(benchRefusing).to.equal(0); // a refused everyday payment still costs lambdaBench: no champion refuses one
  });

  it("gas: every call, and a heavy close (16 candidates, 16 attack plans, a full log) inside a payment estimated before it fell due", async function () {
    this.timeout(900000);
    const w = await deployV2World({ epoch: 400n, reveal: 20n, funds: E("1000") });
    const s = w.signers;
    const reserve = await w.arena.CLOSE_GAS();
    const g: [string, bigint][] = [];
    const used = async (p: Promise<{ wait(): Promise<TransactionReceipt | null> }>) => (await (await p).wait())!.gasUsed;
    const h = s[22];
    await w.vault.registerHonest(h.address);

    g.push(["submitPolicy (challenger, first of the epoch)", await used(w.arena.connect(s[0]).submitPolicy(AMOUNT_CAP, { value: V2_DEFAULTS.policyStake }))]);
    for (let i = 1; i < 14; i++) await w.arena.connect(s[i]).submitPolicy(policyGenes({ weights: { 0: 1600 + i, 7: 400 + i } }), { value: V2_DEFAULTS.policyStake });
    const accepted = (await (await w.crucible.connect(s[14]).propose(...pk(STRONG))).wait())!;
    g.push(["propose (accepted, 16th candidate)", accepted.gasUsed]);
    g.push(["propose (refused: pool full)", await used(w.crucible.connect(s[15]).propose(...pk(STRONG)))]);
    expect((await w.arena.getPool()).length).to.equal(16);

    const attackers = s.slice(11, 22);
    for (const [i, x] of attackers.entries()) {
      const genes = encodeAttack(Array.from({ length: 8 }, (_, k) => ({ amountBps: 50 + 10 * i + k, recipient: k % 2 ? "fresh" : "self" })));
      const gas = await used(w.arena.connect(x).submitAttack(genes, { value: V2_DEFAULTS.attackStake }));
      if (i === 0) g.push(["submitAttack", gas]);
    }
    expect((await w.arena.getAttackPool()).length).to.equal(16);
    let first = true;
    for (const x of attackers) {
      for (let k = 0; k < 5; k++) {
        const gas = await used(w.vault.connect(x).spend(x.address, E("0.5"), 0, ethers.ZeroHash));
        if (first) g.push(["spend by a staked attacker (16 shadow candidates)", gas]);
        first = false;
      }
    }
    g.push(["spend by an honest wallet, no close", await used(w.vault.connect(h).spend(h.address, E("0.1"), 1, ethers.ZeroHash))]);
    g.push(["placeBet", await used(w.arena.connect(s[3]).placeBet(1, { value: V2_DEFAULTS.minBet }))]);
    const max = Number(await w.vault.MAX_TX_PER_EPOCH());
    await fillLog(w, max - 1, () => s[(Math.random() * 10) | 0].address); // MAX_TX_PER_CALLER a wallet

    const end = await w.arena.epochEndBlock();
    const now = BigInt(await ethers.provider.getBlockNumber());
    if (now + 3n < end) await mine(end - now - 3n);
    const est = await w.vault.connect(h).spend.estimateGas(h.address, E("0.1"), 1, ethers.ZeroHash);
    await mine(4);
    const rc = (await (await w.vault.connect(h).spend(h.address, E("0.1"), 1, ethers.ZeroHash, { gasLimit: process.env.PROBE ? 16_700_000n : est })).wait())!;
    expect(eventsIn(rc, w.arena, await w.arena.getAddress()).map((e) => e.name)).to.include("EpochClosed");
    g.push([`honest spend that closed it (${max} txs, 16 x 8 bouts, 11 attackers), limit = its pre-due estimate ${est}`, rc.gasUsed]);
    await mine(400);
    g.push(["closeEpoch() on a quiet epoch (8 candidates, 8 attack plans)", await used(w.arena.connect(s[1]).closeEpoch())]);

    console.log("        gas used:");
    for (const [k, v] of g) console.log(`          ${v.toString().padStart(9)}  ${k}`);
    console.log(`        CLOSE_GAS reserve ${reserve}`);
    expect(rc.gasUsed).to.be.lessThan(reserve);
  });
});
