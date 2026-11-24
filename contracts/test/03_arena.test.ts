import { expect } from "chai";
import { ethers, network } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import {
  deployWorld,
  v1Config,
  doSpend,
  reveal,
  toReveal,
  toEpochEnd,
  eventsOf,
  HONEST,
  ATTACK,
  ATTACK_STAKE,
  POLICY_STAKE,
  MIN_BET,
  AMOUNT_CAP,
  REFUSE_ALL,
  LOOSE_CAP,
  ZERO,
  World,
} from "./fixture";
import { crossover, unpack, encodeAttack, policyGenes } from "../../sdk/src/genome";

const E = (x: string) => ethers.parseEther(x);

async function closeAndParse(w: World) {
  await toEpochEnd(w);
  const tx = await w.arena.closeEpoch();
  const closed = (await eventsOf(tx, w.arena.interface, "EpochClosed"))[0];
  return { tx, closed };
}

/** Independent fitness recomputation from the on-chain outcome log (priced by payment, holds at a fraction:
 *  an attack payment refused saves its amount, held half of it; an honest payment refused costs 2 x its amount plus
 *  0.5% of the round's start balance, held a tenth of that). */
async function recompute(w: World, epoch: bigint, n: number, startBalance: bigint) {
  const count = await w.vault.epochTxCount(epoch);
  const R = new Array(n).fill(0n);
  const C = new Array(n).fill(0n);
  const floor = (startBalance * 50n) / 10000n;
  for (let i = 0n; i < count; i++) {
    const t = await w.vault.getTx(epoch, i);
    for (let j = 0; j < n; j++) {
      const refuses = (Number(t.shadowMask) >> j) & 1;
      const holds = (Number(t.holdMask) >> j) & 1;
      if (Number(t.label) === HONEST) {
        const c = 2n * t.amount + floor;
        if (refuses) C[j] += c;
        else if (holds) C[j] += c / 10n;
      } else if (refuses) R[j] += t.amount;
      else if (holds) R[j] += t.amount / 2n;
    }
  }
  return R.map((r, j) => r - C[j]);
}

describe("Arena — epoch lifecycle", () => {
  async function world() {
    const w = await deployWorld();
    const [H, X, P1, P2, P3, P4, P5, R, B1, B2, X2, X3] = w.signers;
    await w.vault.registerHonest(H.address);
    return { ...w, H, X, P1, P2, P3, P4, P5, R, B1, B2, X2, X3 };
  }

  it("start(): requires full wiring, installs genesis and opens epoch 1 exactly once", async () => {
    const w = await deployWorld({ start: false });
    // unwired arena
    const lineage = await ethers.deployContract("Lineage");
    const firewall = await ethers.deployContract("Firewall");
    const lonely = await ethers.deployContract("Arena", [v1Config(await firewall.getAddress(), await lineage.getAddress(), 10, 2), []]);
    await expect(lonely.start()).to.be.revertedWithCustomError(lonely, "NotWired");
    await expect(w.arena.connect(w.signers[0]).start()).to.be.revertedWithCustomError(w.arena, "OwnableUnauthorizedAccount");
    await expect(w.arena.submitPolicy(AMOUNT_CAP, { value: POLICY_STAKE })).to.be.revertedWithCustomError(w.arena, "NotStarted");
    await expect(w.arena.closeEpoch()).to.be.revertedWithCustomError(w.arena, "NotStarted");
    await expect(w.arena.start()).to.emit(w.arena, "EpochStarted");
    await expect(w.arena.start()).to.be.revertedWithCustomError(w.arena, "AlreadyStarted");
    expect(await w.arena.currentEpoch()).to.equal(1n);
    expect(await w.arena.getPool()).to.deep.equal([1n]);
    expect(await w.lineage.installCount()).to.equal(1n);
    await expect(ethers.deployContract("Arena", [v1Config(await firewall.getAddress(), await lineage.getAddress(), 10, 10), []])).to.be.reverted;
  });

  it("closeEpoch() reverts before EPOCH_LENGTH blocks and cannot run twice for the same epoch", async () => {
    const w = await loadFixture(world);
    const end = await w.arena.epochEndBlock();
    await expect(w.arena.closeEpoch()).to.be.revertedWithCustomError(w.arena, "EpochNotOver").withArgs(end);
    await toEpochEnd(w);
    // two closes racing into the same block: only one can succeed
    await network.provider.send("evm_setAutomine", [false]);
    const a = await w.arena.closeEpoch({ gasLimit: 5_000_000 });
    const b = await w.arena.closeEpoch({ gasLimit: 5_000_000 });
    await network.provider.send("evm_mine");
    await network.provider.send("evm_setAutomine", [true]);
    const ra = await ethers.provider.getTransactionReceipt(a.hash);
    const rb = await ethers.provider.getTransactionReceipt(b.hash);
    expect(ra!.status).to.equal(1);
    expect(rb!.status).to.equal(0);
    expect(await w.arena.epochClosed(1)).to.equal(true);
    expect(await w.arena.currentEpoch()).to.equal(2n);
    // and immediately after, epoch 2 is not over
    await expect(w.arena.closeEpoch()).to.be.revertedWithCustomError(w.arena, "EpochNotOver");
  });

  it("computes F = R - C exactly (C priced by payment), ranks, installs the champion and emits the fitness table", async () => {
    const w = await loadFixture(world);
    await w.arena.connect(w.P1).submitPolicy(REFUSE_ALL, { value: POLICY_STAKE }); // id 2
    await w.arena.connect(w.P2).submitPolicy(AMOUNT_CAP, { value: POLICY_STAKE }); // id 3
    await w.arena.connect(w.X).submitAttack(ZERO, { value: ATTACK_STAKE });
    const h = await doSpend(w, w.H, w.R.address, E("0.1"), HONEST);
    expect(h.shadowMask).to.equal(0b010);
    const x = await doSpend(w, w.X, w.X.address, E("4"), ATTACK);
    expect(x.shadowMask).to.equal(0b110);
    // genesis would let the drain through; the attackers' 10% cap refuses it live (bit 18). The candidates are graded
    // on their own verdicts (the shadow mask), so the table below is unchanged
    expect([x.refused, x.reason & (1n << 18n)]).to.deep.equal([true, 1n << 18n]);
    await toReveal(w);
    await reveal(w, w.H, [h]);

    // refusing the honest 0.1 ETH costs 2 x 0.1 + 0.5% of the 10 ETH start = 0.25 ETH
    const wrong = 2n * E("0.1") + (E("10") * 50n) / 10000n;
    const expected = await recompute(w, 1n, 3, E("10"));
    const { tx, closed } = await closeAndParse(w);
    expect(closed.args.ids).to.deep.equal([3n, 2n, 1n]);
    expect(closed.args.fitness).to.deep.equal([E("4"), E("4") - wrong, 0n]);
    expect([expected[2], expected[1], expected[0]]).to.deep.equal(closed.args.fitness);
    expect(closed.args.retained).to.deep.equal([E("4"), E("4"), 0n]);
    expect(closed.args.honestCost).to.deep.equal([0n, wrong, 0n]);
    expect(closed.args.champion).to.equal(3n);
    expect(closed.args.txCount).to.equal(2n);
    await expect(tx).to.emit(w.arena, "PolicyInstalled");
    const p3 = await w.arena.getPolicy(3);
    await expect(tx).to.emit(w.firewall, "GenomeInstalled").withArgs(3n, p3.lo, p3.hi, 2n);
    const [, , live] = await w.firewall.exportGenome();
    expect(live).to.equal(3n);
    expect((await w.arena.getPolicy(3)).lastFitness).to.equal(E("4"));
    const rnd = (await eventsOf(tx, w.arena.interface, "Randomness"))[0];
    // 3 = the hash of the round's last block (4 = a later fixed block, when the close is over 256 blocks late);
    // a seed taken at the close itself would let the closer preview and time it
    expect([3n, 4n]).to.include(BigInt(rnd.args.source));
  });

  it("selection keeps the top 4; breeding pairs (0,1) (0,2) (1,3) (2,3) by uniform crossover + 2 mutations", async () => {
    const w = await loadFixture(world);
    const subs = [w.P1, w.P2, w.P3, w.P4];
    const gens = [
      AMOUNT_CAP,
      LOOSE_CAP,
      policyGenes({ weights: { 0: 1500, 1: 100 } }),
      policyGenes({ weights: { 0: 1200, 7: 300 }, thresholds: { 2: 200 } }),
    ];
    for (let i = 0; i < 4; i++) await w.arena.connect(subs[i]).submitPolicy(gens[i], { value: POLICY_STAKE });
    await w.arena.connect(w.X).submitAttack(ZERO, { value: ATTACK_STAKE });
    await doSpend(w, w.X, w.X.address, E("4.5"), ATTACK); // 45%: 2,4,5 refuse; 3 (50% cap) passes (refused live, over 10%)
    // a second request over a hard limit from the same wallet in a round reverts, so a second attacker sends it
    await w.arena.connect(w.X2).submitAttack(ZERO, { value: ATTACK_STAKE });
    await doSpend(w, w.X2, w.X2.address, E("1.9"), ATTACK); // 19% (refused live too)
    const { tx, closed } = await closeAndParse(w);
    const ranked: bigint[] = closed.args.ids.map((x: bigint) => x);
    expect(ranked.length).to.equal(5);
    const survivors = ranked.slice(0, 4);
    const dead = ranked[4];
    expect((await w.arena.getPolicy(dead)).alive).to.equal(false);
    const pool = await w.arena.getPool();
    expect(pool.slice(0, 4)).to.deep.equal(survivors);
    expect(pool.length).to.equal(8);

    const born = await eventsOf(tx, w.arena.interface, "ChildBorn");
    expect(born.length).to.equal(4);
    const pairs = [
      [0, 1],
      [0, 2],
      [1, 3],
      [2, 3],
    ];
    for (let c = 0; c < 4; c++) {
      const ev = born[c];
      expect(ev.args.parentA).to.equal(survivors[pairs[c][0]]);
      expect(ev.args.parentB).to.equal(survivors[pairs[c][1]]);
      const A = await w.arena.getPolicy(ev.args.parentA);
      const B = await w.arena.getPolicy(ev.args.parentB);
      const ga = unpack(A.lo, A.hi);
      const gb = unpack(B.lo, B.hi);
      const child = unpack(ev.args.lo, ev.args.hi);
      // every gene comes from A or B except the (at most two) mutated ones
      const mg = ev.args.mutGenes.map(Number);
      const md = ev.args.mutDeltas.map(Number);
      for (let i = 0; i < 32; i++) {
        if (mg.includes(i)) continue;
        expect([ga[i], gb[i]]).to.include(child[i]);
      }
      for (const d of md) expect(Math.abs(d)).to.be.within(1, 64);
      for (const g of mg) expect(g).to.be.lessThan(24);
      const rec = await w.arena.getPolicy(ev.args.id);
      expect(rec.generation).to.equal((A.generation > B.generation ? A.generation : B.generation) + 1n);
      expect(rec.root).to.equal(A.root);
      expect(rec.stake).to.equal(0n);
      expect(pool[4 + c]).to.equal(ev.args.id);
      // lineage records the birth
      const birth = await w.lineage.getBirth(ev.args.id);
      expect(birth.parentA).to.equal(ev.args.parentA);
      expect(birth.parentB).to.equal(ev.args.parentB);
    }
    // a crossover with the chain's own seed is reproducible from the event data
    const ev0 = born[0];
    const A0 = await w.arena.getPolicy(ev0.args.parentA);
    const B0 = await w.arena.getPolicy(ev0.args.parentB);
    const seed = (await eventsOf(tx, w.arena.interface, "Randomness"))[0].args.seed;
    const r = BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "string", "uint256"], [seed, "policy", 0])));
    const crossed = crossover(unpack(A0.lo, A0.hi), unpack(B0.lo, B0.hi), r);
    const mutated = [...crossed];
    mutated[Number(ev0.args.mutGenes[0])] += Number(ev0.args.mutDeltas[0]);
    mutated[Number(ev0.args.mutGenes[1])] += Number(ev0.args.mutDeltas[1]);
    expect(unpack(ev0.args.lo, ev0.args.hi)).to.deep.equal(mutated);
  });

  it("with fewer than 4 survivors, pairs wrap (a lone champion breeds mutated clones)", async () => {
    const w = await loadFixture(world);
    const { tx } = await closeAndParse(w);
    const born = await eventsOf(tx, w.arena.interface, "ChildBorn");
    expect(born.length).to.equal(4);
    for (const b of born) {
      expect(b.args.parentA).to.equal(1n);
      expect(b.args.parentB).to.equal(1n);
    }
    expect((await w.arena.getPool()).length).to.equal(5);
  });

  it("quiet epochs keep the champion (stable ties) and still append to the lineage", async () => {
    const w = await loadFixture(world);
    await closeAndParse(w);
    await closeAndParse(w);
    expect((await w.firewall.exportGenome())[2]).to.equal(1n);
    expect(await w.firewall.installCount()).to.equal(3n);
    expect(await w.lineage.installCount()).to.equal(3n);
  });

  it("slashes dead stakes 60/30/10, returns survivor stakes, compensates wrongly refused honest users", async () => {
    const w = await loadFixture(world);
    // epoch 1: REFUSE_ALL wins against an unrevealed drain
    await w.arena.connect(w.P1).submitPolicy(REFUSE_ALL, { value: POLICY_STAKE }); // id 2
    await w.arena.connect(w.X).submitAttack(ZERO, { value: ATTACK_STAKE });
    await doSpend(w, w.X, w.X.address, E("1"), ATTACK); // 10%, the most an attacker may take in one payment
    await closeAndParse(w);
    expect((await w.firewall.exportGenome())[2]).to.equal(2n);
    expect(await w.arena.claimable(w.P1.address)).to.equal(POLICY_STAKE); // survivor stake returned
    expect(await w.arena.claimable(w.X.address)).to.equal(ATTACK_STAKE); // extracted -> stake back

    // epoch 2: live REFUSE_ALL wrongly refuses an honest payment; 4 more refuse-all clones are submitted
    const clones = [w.P2, w.P3, w.P4, w.P5];
    for (let i = 0; i < 4; i++) {
      await w.arena.connect(clones[i]).submitPolicy(policyGenes({ interactions: { 0: 601 + i }, thresholds: { 0: 0, 1: 0 } }), {
        value: POLICY_STAKE,
      });
    }
    await w.arena.fundPool({ value: E("1") });
    const h = await doSpend(w, w.H, w.R.address, E("0.1"), HONEST);
    expect(h.refused).to.equal(true);
    await toReveal(w);
    await reveal(w, w.H, [h]);
    const poolBefore = await w.arena.protocolPool();
    const p1Before = await w.arena.claimable(w.P1.address);
    const startBal = await w.arena.epochStartBalance();
    const lambda = (startBal * 200n) / 10000n;
    const { tx, closed } = await closeAndParse(w);
    const ranked: bigint[] = closed.args.ids;
    const survivors = ranked.slice(0, 4);
    // the clones are ranked after every older candidate with equal fitness -> they all die
    const died = await eventsOf(tx, w.arena.interface, "PolicyDied");
    const slashedIds = died.filter((d: any) => d.args.slashedStake > 0n).map((d: any) => d.args.id);
    expect(slashedIds).to.deep.equal([7n, 8n, 9n, 10n]);
    const slashed = POLICY_STAKE * 4n;
    const toSurv = (slashed * 60n) / 100n;
    const toHon = (slashed * 30n) / 100n;
    const toPool = slashed - toSurv - toHon;
    await expect(tx).to.emit(w.arena, "Slashed").withArgs(2n, slashed, toSurv, toHon, toPool);
    // 60% split across surviving policies' submitters (bred children inherit their parent A's submitter)
    let payees = 0n;
    let p1Slots = 0n;
    for (const id of survivors) {
      const s = (await w.arena.getPolicy(id)).submitter;
      if (s !== ethers.ZeroAddress) payees++;
      if (s === w.P1.address) p1Slots++;
    }
    const each = payees > 0n ? toSurv / payees : 0n;
    expect((await w.arena.claimable(w.P1.address)) - p1Before).to.equal(each * p1Slots);
    // 30% + lambda compensation to the wrongly refused honest user
    expect(await w.arena.claimable(w.H.address)).to.equal(toHon + lambda);
    await expect(tx).to.emit(w.arena, "Compensated").withArgs(2n, w.H.address, lambda, 1n);
    const dust = toSurv - each * payees;
    expect(await w.arena.protocolPool()).to.equal(poolBefore + toPool + dust - lambda + (payees === 0n ? toSurv : 0n));
    // claim pays out
    const bal = await ethers.provider.getBalance(w.H.address);
    const ctx = await w.arena.connect(w.H).claim();
    const crc = await ctx.wait();
    expect(await ethers.provider.getBalance(w.H.address)).to.equal(bal + toHon + lambda - crc!.gasUsed * crc!.gasPrice);
    await expect(w.arena.connect(w.H).claim()).to.be.revertedWithCustomError(w.arena, "NothingToClaim");
  });

  it("compensation is pro-rata when the protocol pool is short", async () => {
    const w = await loadFixture(world);
    await w.arena.connect(w.P1).submitPolicy(REFUSE_ALL, { value: POLICY_STAKE });
    await w.arena.connect(w.X).submitAttack(ZERO, { value: ATTACK_STAKE });
    await doSpend(w, w.X, w.X.address, E("1"), ATTACK); // 10%, paid, so the stake comes back
    await closeAndParse(w);
    const h1 = await doSpend(w, w.H, w.R.address, E("0.1"), HONEST);
    const h2 = await doSpend(w, w.H, w.R.address, E("0.1"), HONEST);
    await toReveal(w);
    await reveal(w, w.H, [h1, h2]);
    expect(await w.arena.protocolPool()).to.equal(0n);
    const { tx } = await closeAndParse(w);
    // nothing slashed and an empty pool -> compensation of 0, still reported
    await expect(tx).to.emit(w.arena, "Compensated").withArgs(2n, w.H.address, 0n, 2n);
  });
});

describe("Arena — commit-reveal labels", () => {
  async function world() {
    const w = await deployWorld();
    const [H, X, P1, R, Q] = w.signers;
    await w.vault.registerHonest(H.address);
    await w.arena.connect(P1).submitPolicy(REFUSE_ALL, { value: POLICY_STAKE });
    return { ...w, H, X, P1, R, Q };
  }

  it("reveal only opens in the last revealWindow blocks", async () => {
    const w = await loadFixture(world);
    const h = await doSpend(w, w.H, w.R.address, E("0.1"));
    const opens = await w.arena.revealOpensAt();
    await expect(reveal(w, w.H, [h])).to.be.revertedWithCustomError(w.vault, "RevealNotOpen").withArgs(opens);
    await toReveal(w);
    await expect(reveal(w, w.H, [h])).to.emit(w.vault, "LabelRevealed").withArgs(1n, h.txId, w.H.address, HONEST);
  });

  it("rejects wrong salts, other people's txs, double reveals and length mismatches", async () => {
    const w = await loadFixture(world);
    const h = await doSpend(w, w.H, w.R.address, E("0.1"));
    await toReveal(w);
    await expect(w.vault.connect(w.H).revealLabels([h.txId], [HONEST], [ethers.ZeroHash])).to.be.revertedWithCustomError(w.vault, "BadReveal");
    await expect(w.vault.connect(w.H).revealLabels([h.txId], [ATTACK], [h.salt])).to.be.revertedWithCustomError(w.vault, "BadReveal");
    await expect(w.vault.connect(w.Q).revealLabels([h.txId], [HONEST], [h.salt])).to.be.revertedWithCustomError(w.vault, "NotYourTx");
    await expect(w.vault.connect(w.H).revealLabels([h.txId], [], [])).to.be.revertedWithCustomError(w.vault, "LengthMismatch");
    await reveal(w, w.H, [h]);
    await expect(reveal(w, w.H, [h])).to.be.revertedWithCustomError(w.vault, "AlreadyRevealed");
  });

  it("an unrevealed label counts as an attack", async () => {
    const w = await loadFixture(world);
    await doSpend(w, w.H, w.R.address, E("0.1"), HONEST); // never revealed
    const { closed } = await closeAndParse(w);
    // REFUSE_ALL (id 2) refused it; unrevealed -> attack -> retained, not a false refusal
    expect(closed.args.ids[0]).to.equal(2n);
    expect(closed.args.retained[0]).to.equal(E("0.1"));
    expect(closed.args.honestCost[0]).to.equal(0n);
  });

  it("an honest label only counts from a registered wallet with no attack stake this epoch", async () => {
    const w = await loadFixture(world);
    // registered honest but also staked an attack -> honest label downgraded
    await w.arena.connect(w.H).submitAttack(ZERO, { value: ATTACK_STAKE });
    const h = await doSpend(w, w.H, w.R.address, E("0.1"), HONEST);
    // staked attacker (unregistered) claiming honest
    await w.arena.connect(w.X).submitAttack(ZERO, { value: ATTACK_STAKE });
    const x = await doSpend(w, w.X, w.X.address, E("0.1"), HONEST);
    await toReveal(w);
    await expect(reveal(w, w.H, [h])).to.emit(w.vault, "LabelRevealed").withArgs(1n, h.txId, w.H.address, ATTACK);
    await expect(reveal(w, w.X, [x])).to.emit(w.vault, "LabelRevealed").withArgs(1n, x.txId, w.X.address, ATTACK);
  });
});

describe("Arena — refusal rules on submissions", () => {
  async function world() {
    const w = await deployWorld();
    return w;
  }

  it("a policy needs exactly POLICY_STAKE; an attack exactly ATTACK_STAKE", async () => {
    const w = await loadFixture(world);
    const [a] = w.signers;
    await expect(w.arena.connect(a).submitPolicy(AMOUNT_CAP)).to.be.revertedWithCustomError(w.arena, "BadStake").withArgs(POLICY_STAKE);
    await expect(w.arena.connect(a).submitPolicy(AMOUNT_CAP, { value: POLICY_STAKE + 1n })).to.be.revertedWithCustomError(w.arena, "BadStake");
    await expect(w.arena.connect(a).submitAttack(ZERO, { value: 1n })).to.be.revertedWithCustomError(w.arena, "BadStake").withArgs(ATTACK_STAKE);
  });

  it("one policy submission per wallet per epoch (again allowed next epoch)", async () => {
    const w = await loadFixture(world);
    const [a] = w.signers;
    await w.arena.connect(a).submitPolicy(AMOUNT_CAP, { value: POLICY_STAKE });
    await expect(w.arena.connect(a).submitPolicy(LOOSE_CAP, { value: POLICY_STAKE })).to.be.revertedWithCustomError(w.arena, "AlreadySubmitted");
    await expect(w.arena.connect(a).submitPolicyPacked(1, 2, { value: POLICY_STAKE })).to.be.revertedWithCustomError(w.arena, "AlreadySubmitted");
    await closeAndParse(w);
    await expect(w.arena.connect(a).submitPolicy(LOOSE_CAP, { value: POLICY_STAKE })).to.emit(w.arena, "PolicySubmitted");
  });

  it("one attack submission (or adoption) per wallet per epoch", async () => {
    const w = await loadFixture(world);
    const [a] = w.signers;
    await w.arena.connect(a).submitAttack(encodeAttack([{ amountBps: 4000 }]), { value: ATTACK_STAKE });
    await expect(w.arena.connect(a).submitAttack(ZERO, { value: ATTACK_STAKE })).to.be.revertedWithCustomError(w.arena, "AlreadySubmitted");
    await expect(w.arena.connect(a).adoptAttack(1, { value: ATTACK_STAKE })).to.be.revertedWithCustomError(w.arena, "AlreadySubmitted");
    await expect(w.arena.connect(w.signers[1]).adoptAttack(99, { value: ATTACK_STAKE })).to.be.revertedWithCustomError(w.arena, "UnknownAttack");
  });

  it("the shadow pool is capped at 16 candidates", async () => {
    const w = await loadFixture(world);
    for (let i = 0; i < 15; i++) await w.arena.connect(w.signers[i]).submitPolicy(AMOUNT_CAP, { value: POLICY_STAKE });
    expect((await w.arena.getPool()).length).to.equal(16);
    await expect(w.arena.connect(w.signers[15]).submitPolicy(AMOUNT_CAP, { value: POLICY_STAKE })).to.be.revertedWithCustomError(w.arena, "PoolFull");
  });

  it("only the Vault can report extractions; only the Lineage writer can append", async () => {
    const w = await loadFixture(world);
    const [a] = w.signers;
    await expect(w.arena.recordExtraction(a.address, a.address, 1)).to.be.revertedWithCustomError(w.arena, "NotVault");
    await expect(w.lineage.recordBirth(77, 0, 0, 77, 1, 1, 0, 0, a.address)).to.be.revertedWithCustomError(w.lineage, "NotWriter");
    await expect(w.lineage.record(1, 0, 0, 0, 0, 0)).to.be.revertedWithCustomError(w.lineage, "NotWriter");
    await expect(w.arena.setVault(a.address)).to.be.revertedWithCustomError(w.arena, "VaultAlreadySet");
  });

  it("only policies from staked submissions or breeding ever become live", async () => {
    const w = await loadFixture(world);
    const [p, x] = w.signers;
    await w.arena.connect(p).submitPolicy(AMOUNT_CAP, { value: POLICY_STAKE });
    await w.vault.registerHonest(p.address);
    await w.arena.connect(x).submitAttack(ZERO, { value: ATTACK_STAKE });
    for (let epoch = 0; epoch < 4; epoch++) {
      await doSpend(w, x, x.address, (await w.vault.balance()) / 3n, ATTACK);
      await closeAndParse(w);
      if (epoch < 3) await w.arena.connect(x).submitAttack(ZERO, { value: ATTACK_STAKE });
    }
    // every install must be genesis, a PolicySubmitted id or a ChildBorn id
    const submitted = new Set((await w.arena.queryFilter(w.arena.filters.PolicySubmitted())).map((e) => e.args.id));
    const bred = new Set((await w.arena.queryFilter(w.arena.filters.ChildBorn())).map((e) => e.args.id));
    const n = await w.lineage.installCount();
    for (let i = 0n; i < n; i++) {
      const ins = await w.lineage.installAt(i);
      expect(ins.id === 1n || submitted.has(ins.id) || bred.has(ins.id)).to.equal(true);
    }
    expect(n).to.equal(5n);
  });
});

describe("Arena — attack genomes co-evolve", () => {
  it("returns stakes that extracted, forfeits the rest, keeps the top 4 by extraction and breeds 4 children", async () => {
    const w = await deployWorld();
    const [X1, X2, X3, P, X4] = w.signers;
    await w.arena.connect(P).submitPolicy(AMOUNT_CAP, { value: POLICY_STAKE }); // shadow only this epoch
    await w.arena.connect(X1).submitAttack(encodeAttack([{ amountBps: 3000 }]), { value: ATTACK_STAKE }); // attack 1
    await w.arena.connect(X2).submitAttack(encodeAttack([{ amountBps: 500 }]), { value: ATTACK_STAKE }); // attack 2
    await w.arena.connect(X3).submitAttack(encodeAttack([{ amountBps: 100, recipient: "fresh" }]), { value: ATTACK_STAKE }); // 3: never runs
    // an attacker may take at most 10% in one payment and the attackers 20% in a round
    await doSpend(w, X1, X1.address, E("1"), ATTACK);
    await doSpend(w, X2, X2.address, E("0.5"), ATTACK);
    expect(await w.arena.attackExtracted(1, 1)).to.equal(E("1"));
    expect(await w.arena.walletExtracted(1, X2.address)).to.equal(E("0.5"));
    const poolBefore = await w.arena.protocolPool();
    const { tx } = await closeAndParse(w);
    const res = (await eventsOf(tx, w.arena.interface, "AttackEpochResults"))[0];
    expect(res.args.ids).to.deep.equal([1n, 2n, 3n]);
    expect(res.args.extracted).to.deep.equal([E("1"), E("0.5"), 0n]);
    expect(await w.arena.claimable(X1.address)).to.equal(ATTACK_STAKE);
    expect(await w.arena.claimable(X2.address)).to.equal(ATTACK_STAKE);
    expect(await w.arena.claimable(X3.address)).to.equal(0n);
    await expect(tx).to.emit(w.arena, "StakeForfeited").withArgs(X3.address, ATTACK_STAKE, 1n);
    expect(await w.arena.protocolPool()).to.equal(poolBefore + ATTACK_STAKE);
    const born = await eventsOf(tx, w.arena.interface, "AttackBorn");
    expect(born.length).to.equal(4);
    expect((await w.arena.getAttackPool()).length).to.equal(7);
    // survivors ranked by extraction: [1, 2, 3]; pairs (0,1) (0,2) (1,0) (2,0)
    expect(born.map((b: any) => [b.args.parentA, b.args.parentB])).to.deep.equal([
      [1n, 2n],
      [1n, 3n],
      [2n, 1n],
      [3n, 1n],
    ]);
    // epoch 2: a runner adopts a bred child; its extraction is attributed to that genome
    const child = born[0].args.id;
    await w.arena.connect(X4).adoptAttack(child, { value: ATTACK_STAKE });
    expect(await w.arena.attackOf(2, X4.address)).to.equal(child);
    await doSpend(w, X4, X4.address, E("0.2"), ATTACK); // 0.2/8.5 < 25%: passes AMOUNT_CAP (now live)
    expect(await w.arena.attackExtracted(2, child)).to.equal(E("0.2"));
    // attack 3 extracted 0 but survived (top 4 of 3); adding a 5th genome next epoch would push it out
    expect((await w.arena.getAttack(3)).alive).to.equal(true);
  });

  it("extraction through an agent proxy is attributed to the originating staked attacker", async () => {
    const w = await deployWorld();
    const [X] = w.signers;
    await w.arena.connect(X).submitAttack(ZERO, { value: ATTACK_STAKE });
    const proxy = await ethers.deployContract("AgentProxy", [X.address]);
    await proxy.connect(X).act(await w.vault.getAddress(), X.address, E("1"), 0, ethers.ZeroHash);
    expect(await w.arena.walletExtracted(1, X.address)).to.equal(E("1"));
  });
});

describe("Arena — spectator bets (pari-mutuel)", () => {
  async function world() {
    const w = await deployWorld();
    const [P1, P2, X, B1, B2, B3] = w.signers;
    await w.arena.connect(P1).submitPolicy(LOOSE_CAP, { value: POLICY_STAKE }); // root 2: lets a 40% drain through
    await w.arena.connect(P2).submitPolicy(AMOUNT_CAP, { value: POLICY_STAKE }); // root 3: refuses it
    await w.arena.connect(X).submitAttack(ZERO, { value: ATTACK_STAKE });
    return { ...w, P1, P2, X, B1, B2, B3 };
  }

  it("validates bets: minimum, one per wallet per epoch, live lineage only", async () => {
    const w = await loadFixture(world);
    await expect(w.arena.connect(w.B1).placeBet(3, { value: MIN_BET - 1n })).to.be.revertedWithCustomError(w.arena, "BetTooSmall");
    await expect(w.arena.connect(w.B1).placeBet(999, { value: MIN_BET })).to.be.revertedWithCustomError(w.arena, "UnknownLineage");
    await expect(w.arena.connect(w.B1).placeBet(3, { value: MIN_BET })).to.emit(w.arena, "BetPlaced").withArgs(1n, w.B1.address, 3n, MIN_BET);
    await expect(w.arena.connect(w.B1).placeBet(2, { value: MIN_BET })).to.be.revertedWithCustomError(w.arena, "AlreadyBet");
    await expect(w.arena.connect(w.B1).settleBet(1)).to.be.revertedWithCustomError(w.arena, "EpochOpen");
  });

  it("winners split the whole pot in proportion to stake", async () => {
    const w = await loadFixture(world);
    await w.arena.connect(w.B1).placeBet(3, { value: E("0.01") });
    await w.arena.connect(w.B2).placeBet(3, { value: E("0.03") });
    await w.arena.connect(w.B3).placeBet(2, { value: E("0.06") });
    await doSpend(w, w.X, w.X.address, E("4"), ATTACK);
    const { tx } = await closeAndParse(w);
    await expect(tx).to.emit(w.arena, "BetSettled").withArgs(1n, 3n, E("0.1"), E("0.04"));
    await expect(w.arena.connect(w.B1).settleBet(1)).to.emit(w.arena, "BetPaid").withArgs(1n, w.B1.address, E("0.025"));
    await expect(w.arena.connect(w.B2).settleBet(1)).to.emit(w.arena, "BetPaid").withArgs(1n, w.B2.address, E("0.075"));
    await expect(w.arena.connect(w.B3).settleBet(1)).to.emit(w.arena, "BetPaid").withArgs(1n, w.B3.address, 0n);
    await expect(w.arena.connect(w.B1).settleBet(1)).to.be.revertedWithCustomError(w.arena, "NoBet");
    expect(await w.arena.claimable(w.B1.address)).to.equal(E("0.025"));
  });

  it("refunds every bet when nobody backed the winning lineage", async () => {
    const w = await loadFixture(world);
    await w.arena.connect(w.B1).placeBet(2, { value: E("0.01") });
    await doSpend(w, w.X, w.X.address, E("4"), ATTACK); // AMOUNT_CAP (3) wins
    await closeAndParse(w);
    expect(await w.arena.winningLineage(1)).to.equal(3n);
    await expect(w.arena.connect(w.B1).settleBet(1)).to.emit(w.arena, "BetPaid").withArgs(1n, w.B1.address, E("0.01"));
  });

  it("bred children carry their lineage root so bets follow the bloodline", async () => {
    const w = await loadFixture(world);
    await doSpend(w, w.X, w.X.address, E("4"), ATTACK);
    await closeAndParse(w);
    for (const id of await w.arena.getPool()) {
      const p = await w.arena.getPolicy(id);
      expect([1n, 2n, 3n]).to.include(p.root);
    }
    await expect(w.arena.connect(w.B1).placeBet(3, { value: MIN_BET })).to.emit(w.arena, "BetPlaced");
  });
});

describe("Lineage", () => {
  it("is append-only and walks ancestors through never-installed policies", async () => {
    const w = await deployWorld();
    const [P1, P2, P3, P4, X] = w.signers;
    for (const [i, p] of [P1, P2, P3, P4].entries())
      await w.arena.connect(p).submitPolicy(policyGenes({ weights: { 0: 1000 + 300 * i } }), { value: POLICY_STAKE });
    await w.arena.connect(X).submitAttack(ZERO, { value: ATTACK_STAKE });
    await doSpend(w, X, X.address, E("4"), ATTACK);
    await closeAndParse(w);
    await closeAndParse(w); // grandchildren
    const births = await w.lineage.birthCount();
    expect(births).to.equal(1n + 4n + 4n + 4n);
    const last = await w.lineage.birthAt(births - 1n);
    const anc = await w.lineage.ancestors(last);
    const b = await w.lineage.getBirth(last);
    expect(anc).to.include(b.parentA);
    expect(anc).to.include(b.parentB);
    // grandparents reached through parents
    const pa = await w.lineage.getBirth(b.parentA);
    if (pa.parentA !== 0n) expect(anc).to.include(pa.parentA);
    expect(await w.lineage.ancestorsCapped(last, 1)).to.have.length(1);
    await expect(w.lineage.ancestors(4242)).to.be.revertedWithCustomError(w.lineage, "Unknown");
    const installs = await w.lineage.installRange(0, 100);
    expect(installs.length).to.equal(3);
    expect(installs[0].id).to.equal(1n);
  });
});
