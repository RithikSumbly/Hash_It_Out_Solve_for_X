/**
 * Three verdicts, and wrong refusals priced by the payment.
 *   pay      score <= 350,000 (HOLD_SCORE)
 *   hold     350,000 < score <= 500,000: the payment waits HOLD_DELAY blocks; the owner or a guardian may veto it, then
 *            anyone may release it. Its amount is reserved and counts toward the round's outflow at once.
 *   refuse   score > 500,000, or a hard limit (bits 16/17)
 * Grading: a candidate that holds an attack payment saves half its value; one that refuses an honest payment pays
 * 2 x its amount + 0.5% of the round's start, a tenth of that if it holds it. The bench is priced the same way (ppm).
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import { mine } from "@nomicfoundation/hardhat-network-helpers";
import type { Log, TransactionReceipt } from "ethers";
import { deployV2World, deployWorld, doSpend, toEpochEnd, toReveal, reveal, packed, eventsOf, ATTACK, HONEST, POLICY_STAKE, ATTACK_STAKE, ZERO } from "./fixture";
import { encodeAttack, ATTACK_PRESETS, policyGenes, type Genes } from "../../sdk/src/genome";
import { V2_DEFAULTS, V2_GENESIS, V2_HONEST_BENCH } from "../../sdk/src/v2";

const E = (x: string) => ethers.parseEther(x);
const BIG = { gasLimit: 12_000_000 };
const PAID = 0;
const HELD = 1;
const REFUSED = 2;
const SPEND_CAP = 1n << 16n;
const ROUND_CAP = 1n << 17n;
const ATTACK_SPEND_CAP = 1n << 18n;
const ATTACK_HOLD = 1n << 20n;
const pk = (g: Genes): [bigint, bigint] => {
  const p = packed(g);
  return [p.lo, p.hi];
};
function eventsIn(rc: TransactionReceipt, c: { interface: { parseLog(l: Log): any } }, address: string) {
  return rc.logs.filter((l) => l.address.toLowerCase() === address.toLowerCase()).map((l) => c.interface.parseLog(l));
}

/** Holds every payment to a contract (w6 = 400: 400,000 points) and pays everything else. Used only as a live
 *  genesis (never screened: it would let the drain canaries through). */
const HOLD_CONTRACTS = policyGenes({ weights: { 6: 400 } });

describe("Three verdicts in the Vault: pay, hold, refuse", () => {
  it("each band: under genesis a wallet's 10% pays, 20% is held (with the policy's reason bits), 30% is refused, 60% breaks a hard limit; previewSpend says so first", async () => {
    const w = await deployV2World();
    // an attacker's hold is refused (bit 20), so the bands are shown with a registered wallet (genesis ignores f4)
    const x = w.signers[3];
    await w.vault.registerHonest(x.address);
    expect(await w.vault.HOLD_SCORE()).to.equal(350_000n);
    expect(await w.firewall.HOLD_THRESHOLD()).to.equal(350_000n);
    const bal = await w.vault.balance();
    const pct = (p: bigint) => (bal * p) / 100n;
    const pv = async (p: bigint) => w.vault.previewSpend(x.address, x.address, pct(p));
    expect([(await pv(10n)).verdict, (await pv(10n)).score]).to.deep.equal([BigInt(PAID), 200_000n]);
    const h = await pv(20n);
    expect([h.verdict, h.refused, h.score, h.reason]).to.deep.equal([BigInt(HELD), false, 400_000n, 0x81n]); // f0 and f7 terms
    expect([(await pv(30n)).verdict, (await pv(30n)).refused]).to.deep.equal([BigInt(REFUSED), true]);
    const big = await pv(60n);
    expect(big.verdict).to.equal(BigInt(REFUSED));
    expect(big.reason & SPEND_CAP).to.equal(SPEND_CAP);

    // the spend itself: a held payment moves nothing, returns false, and the Spend event says "held"
    // for a wallet with an attack staked the same 20% is refused, and any payment over 10% breaks its own cap
    const a = w.signers[5];
    await w.arena.connect(a).submitAttack(encodeAttack(ATTACK_PRESETS.drain.steps), { value: V2_DEFAULTS.attackStake, ...BIG });
    const ah = await w.vault.previewSpend(a.address, a.address, pct(20n));
    expect([ah.verdict, ah.score, ah.reason]).to.deep.equal([BigInt(REFUSED), 400_000n, 0x81n | ATTACK_SPEND_CAP | ATTACK_HOLD]);
    const a10 = await w.vault.previewSpend(a.address, a.address, pct(10n));
    expect([a10.verdict, a10.reason]).to.deep.equal([BigInt(PAID), 0n]); // 10% is the most, inclusive
    const before = await ethers.provider.getBalance(x.address);
    const tx = await w.vault.connect(x).spend(x.address, pct(20n), 0, ethers.ZeroHash, BIG);
    const rc = (await tx.wait())!;
    const ev = eventsIn(rc, w.vault, await w.vault.getAddress());
    const spend = ev.find((e) => e.name === "Spend")!.args;
    const held = ev.find((e) => e.name === "Held")!.args;
    const shadow = ev.find((e) => e.name === "ShadowScored")!.args;
    expect([spend.verdict, spend.refused, spend.reason]).to.deep.equal([BigInt(HELD), false, 0x81n]);
    expect([shadow.liveVerdict, shadow.liveRefused, shadow.holdMask, shadow.shadowMask]).to.deep.equal([BigInt(HELD), false, 1n, 0n]);
    expect(held.releaseBlock).to.equal(BigInt(rc.blockNumber) + (await w.vault.HOLD_DELAY()));
    expect(await ethers.provider.getBalance(x.address)).to.equal(before - rc.gasUsed * rc.gasPrice);
    expect(await w.vault.connect(x).spend.staticCall(x.address, pct(1n), 0, ethers.ZeroHash, BIG)).to.equal(true); // a paid one returns true
    const rec = await w.vault.getTx(1, spend.txId);
    expect([rec.liveVerdict, rec.liveRefused, rec.holdMask]).to.deep.equal([BigInt(HELD), false, 1n]);
    const hp = await w.vault.getHeld(held.id);
    expect([hp.from, hp.to, hp.amount, hp.settled, hp.epoch, hp.txId]).to.deep.equal([x.address, x.address, pct(20n), false, 1n, spend.txId]);
  });

  it("a held amount is reserved: it cannot be paid twice, every balance the vault uses leaves it out, and it counts toward the round's outflow", async () => {
    const w = await deployV2World({ genesis: HOLD_CONTRACTS });
    const h = w.signers[2];
    await w.vault.registerHonest(h.address);
    const sink = await (await ethers.deployContract("AgentProxy", [h.address])).getAddress(); // a contract: held
    const start = await w.vault.balance(); // 10 ETH
    const r = await doSpend(w, h, sink, E("3"), HONEST);
    expect(r.verdict).to.equal(HELD);
    expect(await w.vault.heldTotal()).to.equal(E("3"));
    expect(await w.vault.balance()).to.equal(start - E("3")); // what it can pay
    expect(await ethers.provider.getBalance(await w.vault.getAddress())).to.equal(start); // the money is still there
    // reserved: asking for more than what is left reverts, as for any balance
    await expect(w.vault.connect(h).spend(h.address, E("7.5"), 1, ethers.ZeroHash, BIG))
      .to.be.revertedWithCustomError(w.vault, "InsufficientBalance")
      .withArgs(E("7"), E("7.5"));
    // f0 is a share of the 7 ETH left: 3.5 ETH is half of it, so the single-payment limit lets it through...
    const f = await w.vault.features(h.address, h.address, h.address, E("3.5"));
    expect(f[0]).to.equal(500n);
    // ...but the round has already let 3 ETH (30% of its start) go, held: 3.5 more would make 65%
    const big = await doSpend(w, h, h.address, E("3.5"), HONEST, 1);
    expect([big.verdict, big.reason]).to.deep.equal([REFUSED, ROUND_CAP]);
    expect((await doSpend(w, h, h.address, E("2"), HONEST, 1)).verdict).to.equal(PAID); // exactly 50%
    expect((await w.vault.previewSpend(h.address, h.address, 1n)).reason).to.equal(ROUND_CAP);
    // a second request over a hard limit in the round reverts instead of being logged
    await expect(w.vault.connect(h).spend(h.address, 1n, 1, ethers.ZeroHash, BIG)).to.be.revertedWithCustomError(w.vault, "HardLimit").withArgs(ROUND_CAP);
    // a veto in the same round gives the held 3 ETH back to the round's allowance
    await w.vault.veto(r.heldId!);
    expect(await w.vault.heldTotal()).to.equal(0n);
    expect((await doSpend(w, h, h.address, E("2.9"), HONEST, 1)).verdict).to.equal(PAID);
  });

  it("release: refused before releaseBlock (TooEarly), then anyone may release; it pays, and settles once", async () => {
    const w = await deployV2World({ genesis: HOLD_CONTRACTS });
    const [, h, anyone] = w.signers;
    await w.vault.registerHonest(h.address);
    const sink = await ethers.deployContract("AgentProxy", [h.address]);
    const r = await doSpend(w, h, await sink.getAddress(), E("1"), HONEST);
    const hp = await w.vault.getHeld(r.heldId!);
    await expect(w.vault.connect(anyone).release(r.heldId!)).to.be.revertedWithCustomError(w.vault, "TooEarly").withArgs(hp.releaseBlock);
    await mine(Number(hp.releaseBlock) - (await ethers.provider.getBlockNumber()) - 2);
    // mined one block short of releaseBlock (an explicit gas limit sends it instead of failing the estimate)
    await expect(w.vault.connect(anyone).release(r.heldId!, { gasLimit: 300_000 })).to.be.revertedWithCustomError(w.vault, "TooEarly");
    const paidBefore = await w.vault.recipientPaid(await sink.getAddress());
    const tx = await w.vault.connect(anyone).release(r.heldId!);
    await expect(tx).to.emit(w.vault, "Released").withArgs(r.heldId!, anyone.address);
    await expect(tx).to.changeEtherBalances([await sink.getAddress(), await w.vault.getAddress()], [E("1"), -E("1")]);
    expect(await w.vault.heldTotal()).to.equal(0n);
    expect((await w.vault.getHeld(r.heldId!)).settled).to.equal(true);
    expect(await w.vault.recipientPaid(await sink.getAddress())).to.equal(paidBefore + 1n); // novelty moves at release
    await expect(w.vault.connect(anyone).release(r.heldId!)).to.be.revertedWithCustomError(w.vault, "AlreadySettled");
    await expect(w.vault.veto(r.heldId!)).to.be.revertedWithCustomError(w.vault, "AlreadySettled");
    await expect(w.vault.release(999)).to.be.revertedWithCustomError(w.vault, "UnknownHold");
  });

  it("veto: only the owner or a guardian; the money stays; a vetoed payment cannot be released or vetoed again", async () => {
    const w = await deployV2World({ genesis: HOLD_CONTRACTS });
    const [, h, stranger, guardian] = w.signers;
    await w.vault.registerHonest(h.address);
    const sink = await (await ethers.deployContract("AgentProxy", [h.address])).getAddress();
    const a = await doSpend(w, h, sink, E("1"), HONEST);
    const b = await doSpend(w, h, sink, E("1"), HONEST);
    await expect(w.vault.connect(stranger).veto(a.heldId!)).to.be.revertedWithCustomError(w.vault, "NotGuardian");
    await expect(w.vault.connect(stranger).setGuardian(stranger.address, true)).to.be.revertedWithCustomError(w.vault, "OwnableUnauthorizedAccount");
    await expect(w.vault.setGuardian(guardian.address, true)).to.emit(w.vault, "GuardianSet").withArgs(guardian.address, true);
    const vaultEth = await ethers.provider.getBalance(await w.vault.getAddress());
    await expect(w.vault.connect(guardian).veto(a.heldId!)).to.emit(w.vault, "Vetoed").withArgs(a.heldId!, guardian.address);
    await expect(w.vault.veto(b.heldId!)).to.emit(w.vault, "Vetoed").withArgs(b.heldId!, w.owner.address); // the owner may too
    expect(await ethers.provider.getBalance(await w.vault.getAddress())).to.equal(vaultEth);
    expect(await w.vault.heldTotal()).to.equal(0n);
    await mine(400);
    await expect(w.vault.release(a.heldId!)).to.be.revertedWithCustomError(w.vault, "AlreadySettled");
    await expect(w.vault.connect(guardian).veto(a.heldId!)).to.be.revertedWithCustomError(w.vault, "AlreadySettled");
    await w.vault.setGuardian(guardian.address, false);
    const c = await doSpend(w, h, sink, E("1"), HONEST);
    await expect(w.vault.connect(guardian).veto(c.heldId!)).to.be.revertedWithCustomError(w.vault, "NotGuardian");
  });

  it("a release in a later round pays out without counting toward that round's outflow; a delegation and the extraction land at release", async () => {
    const w = await deployV2World({ genesis: HOLD_CONTRACTS });
    const [, h, keeper] = w.signers;
    await w.vault.registerHonest(h.address);
    const agent = await (await ethers.deployContract("AgentProxy", [h.address])).getAddress();
    const r = await doSpend(w, h, agent, E("2"), HONEST, 2); // KIND_DELEGATE to a contract: held
    expect(r.verdict).to.equal(HELD);
    expect(await w.vault.delegateOf(agent)).to.equal(ethers.ZeroAddress); // not at hold
    const e0 = await w.arena.currentEpoch();
    const hp = await w.vault.getHeld(r.heldId!);
    await mine(Number(hp.releaseBlock) - (await ethers.provider.getBlockNumber()));
    await w.arena.connect(keeper).closeEpoch(BIG); // a later round
    expect(await w.arena.currentEpoch()).to.be.greaterThan(e0);
    await expect(w.vault.connect(keeper).release(r.heldId!)).to.emit(w.vault, "Delegated").withArgs(h.address, agent, E("2"));
    expect(await w.vault.delegateOf(agent)).to.equal(h.address);
    // the new round started with what the vault could pay (8 ETH: the 2 ETH were reserved), and the release is not
    // part of its outflow: half of 8 ETH may still go this round
    expect(await w.arena.epochStartBalance()).to.equal(E("8"));
    expect((await w.vault.features(h.address, h.address, h.address, E("4")))[7]).to.equal(500n);
    expect((await doSpend(w, h, h.address, E("4"), HONEST, 1)).verdict).to.equal(PAID);
  });

  it("a payment the policy would hold is refused when an attacker asks for it, directly or through its agent contract; nothing is held, so nothing pays out by default", async () => {
    const w = await deployV2World({ genesis: HOLD_CONTRACTS, epoch: 700n, reveal: 100n });
    const [, h, , , x] = w.signers;
    await w.vault.registerHonest(h.address);
    await w.arena.connect(x).submitAttack(encodeAttack(ATTACK_PRESETS.drain.steps), { value: V2_DEFAULTS.attackStake, ...BIG });
    const id = await w.arena.attackOf(1, x.address);
    const agent = await ethers.deployContract("AgentProxy", [x.address]);
    const sink = await (await ethers.deployContract("AgentProxy", [x.address])).getAddress();
    const r = await doSpend(w, x, sink, E("1"), ATTACK);
    expect([r.verdict, r.reason, r.score]).to.deep.equal([REFUSED, (1n << 6n) | ATTACK_HOLD, 400_000n]);
    expect(r.heldId).to.equal(undefined);
    expect(r.holdMask & 1).to.equal(1); // the shadow verdict is still the policy's own: a hold
    // through its own agent contract (tx.origin is the attacker): refused just the same
    const rc = (await (await agent.connect(x).act(await w.vault.getAddress(), sink, E("1"), 0, ethers.ZeroHash, BIG)).wait())!;
    const ev = eventsIn(rc, w.vault, await w.vault.getAddress()).find((e) => e.name === "Spend")!.args;
    expect([ev.verdict, ev.reason & ATTACK_HOLD]).to.deep.equal([BigInt(REFUSED), ATTACK_HOLD]);
    expect(await w.vault.heldTotal()).to.equal(0n);
    expect(await w.arena.attackExtracted(1, id)).to.equal(0n);
    // an honest wallet's payment of the same shape is still held
    expect((await doSpend(w, h, sink, E("1"), HONEST)).verdict).to.equal(HELD);
  });

  it("gas: a holding spend, a release and a veto", async () => {
    const w = await deployV2World({ genesis: HOLD_CONTRACTS });
    const [, h, guardian, anyone] = w.signers;
    await w.vault.registerHonest(h.address);
    await w.vault.setGuardian(guardian.address, true);
    const sink = await (await ethers.deployContract("AgentProxy", [h.address])).getAddress();
    await doSpend(w, h, h.address, E("0.1"), HONEST, 1); // warm the caller's counters
    const used = async (p: Promise<{ wait(): Promise<TransactionReceipt | null> }>) => (await (await p).wait())!.gasUsed;
    const holdGas = await used(w.vault.connect(h).spend(sink, E("1"), 0, ethers.ZeroHash, BIG));
    const payGas = await used(w.vault.connect(h).spend(h.address, E("0.1"), 1, ethers.ZeroHash, BIG));
    await used(w.vault.connect(h).spend(sink, E("1"), 0, ethers.ZeroHash, BIG));
    await mine(400);
    const releaseGas = await used(w.vault.connect(anyone).release(0));
    const vetoGas = await used(w.vault.connect(guardian).veto(1));
    console.log(`        a spend that is held: ${holdGas} gas (a paid one: ${payGas}); release: ${releaseGas}; veto: ${vetoGas}`);
    expect(holdGas).to.be.lessThan(700_000n);
    expect(releaseGas).to.be.lessThan(150_000n);
    expect(vetoGas).to.be.lessThan(80_000n);
  });
});

describe("Grading with holds, and wrong refusals priced by the payment", () => {
  /** An arena without a Crucible (so F = R - C exactly) with genesis paying everything, a REFUSER and a HOLDER. */
  async function threeWay() {
    const w = await deployWorld();
    const [p1, p2, x, hon] = w.signers;
    await w.arena.connect(p1).submitPolicy(policyGenes({ weights: { 0: 3000 } }), { value: POLICY_STAKE }); // id 2: a 20% payment scores 600,000
    await w.arena.connect(p2).submitPolicy(policyGenes({ weights: { 0: 1800 } }), { value: POLICY_STAKE }); // id 3: 360,000, held
    await w.arena.connect(x).submitAttack(ZERO, { value: ATTACK_STAKE });
    await w.vault.registerHonest(hon.address);
    return { w, x, hon };
  }

  it("an attack payment: the candidate that refuses it saves all of it, the one that holds it half", async () => {
    const { w, x } = await threeWay();
    const a = await doSpend(w, x, x.address, E("2"), ATTACK); // 20% of 10 ETH, unrevealed: counts as an attack
    expect([a.shadowMask, a.holdMask]).to.deep.equal([0b010, 0b100]);
    await toEpochEnd(w);
    const closed = (await eventsOf(await w.arena.closeEpoch(), w.arena.interface, "EpochClosed"))[0].args;
    const at = (id: bigint) => (closed.ids as bigint[]).indexOf(id);
    expect(closed.retained[at(2n)]).to.equal(E("2"));
    expect(closed.retained[at(3n)]).to.equal(E("1"));
    expect(closed.retained[at(1n)]).to.equal(0n);
    expect(closed.champion).to.equal(2n);
  });

  it("an honest payment: refusing it costs 2 x its amount + 0.5% of the round's start, holding it a tenth of that; priced by amount", async () => {
    const { w, hon } = await threeWay();
    const r1 = await doSpend(w, hon, w.signers[10].address, E("2"), HONEST); // 20%: refused by 2, held by 3
    const r2 = await doSpend(w, hon, w.signers[11].address, E("0.5"), HONEST); // 5% of what is left: nobody stops it
    expect([r1.shadowMask, r1.holdMask, r2.shadowMask, r2.holdMask]).to.deep.equal([0b010, 0b100, 0, 0]);
    await toReveal(w);
    await reveal(w, hon, [r1, r2]);
    const start = await w.arena.epochStartBalance();
    const [, cost] = await w.vault.tally(1, 3, start);
    const wrong = 2n * E("2") + (start * 50n) / 10000n; // 4.05 ETH
    expect(cost).to.deep.equal([0n, wrong, wrong / 10n]);
    await toEpochEnd(w);
    const closed = (await eventsOf(await w.arena.closeEpoch(), w.arena.interface, "EpochClosed"))[0].args;
    const at = (id: bigint) => (closed.ids as bigint[]).indexOf(id);
    expect(closed.fitness[at(2n)]).to.equal(-wrong);
    expect(closed.fitness[at(3n)]).to.equal(-wrong / 10n);
    expect(closed.honestCost[at(3n)]).to.equal(wrong / 10n);
    expect(closed.champion).to.equal(1n); // genesis refused and held nothing
  });

  it("a held honest payment is not a wrong refusal for compensation", async () => {
    const w = await deployV2World({ genesis: HOLD_CONTRACTS });
    const h = w.signers[2];
    await w.vault.registerHonest(h.address);
    const sink = await (await ethers.deployContract("AgentProxy", [h.address])).getAddress();
    const r = await doSpend(w, h, sink, E("1"), HONEST);
    expect(r.verdict).to.equal(HELD);
    await toReveal(w);
    await reveal(w, h, [r]);
    const t = await w.vault.tally(1, 1, await w.arena.epochStartBalance());
    expect([t.userCount, t.totalWrong]).to.deep.equal([0n, 0n]);
  });

  it("the bench: a policy that only holds a bench payment pays a tenth and is not REFUSED_HONEST; one that refuses it is; a held canary counts as let through", async () => {
    const w = await deployV2World();
    const c = w.crucible;
    const price = (i: number) => 2n * BigInt(V2_HONEST_BENCH[i].f[0]) * 1000n + 5000n;
    // genesis plus a weight on contract recipients: bench #5 (2% to its agent contract) and #9 (1% to a dapp) score
    // 375,000 and 355,000 with w6 = 330 (held), 545,000 and 525,000 with w6 = 500 (refused)
    const holds = policyGenes({ weights: { 0: 1500, 6: 330, 7: 500 } });
    const refuses = policyGenes({ weights: { 0: 1500, 6: 500, 7: 500 } });
    expect(await c.honestRefusals(...pk(holds))).to.equal(0n);
    expect((await c.benchCost(...pk(holds))).cost).to.equal(price(5) / 10n + price(9) / 10n);
    expect(await c.screenVerdict(...pk(holds))).to.not.equal(1n);
    expect(await c.honestRefusals(...pk(refuses))).to.equal(2n);
    // refusing an everyday payment keeps lambdaBench as its price when that is more (a held one pays a tenth of its own)
    const lb = await c.lambdaBench();
    const refusedPrice = (i: number) => (price(i) > lb ? price(i) : lb);
    expect((await c.benchCost(...pk(refuses))).cost).to.equal(refusedPrice(5) + refusedPrice(9));
    expect(await c.screenVerdict(...pk(refuses))).to.equal(1n);
    // a canary must be refused: the adaptive canary (a stranger's 26%, bit CANARIES) scores 260,000 here, so it
    // counts as let through, and so does a fixed one held rather than refused (row 2, 50%: 500,000)
    const soft = policyGenes({ weights: { 0: 500, 7: 500 } });
    const [n, mask] = await c.canaryPasses(...pk(soft));
    expect(mask & (1n << (await c.CANARIES()))).to.equal(1n << (await c.CANARIES()));
    expect(mask & (1n << 2n)).to.equal(1n << 2n);
    expect(n).to.be.greaterThan(0n);
    expect(await c.screenVerdict(...pk(soft))).to.equal(5n);
    expect((await c.screen(...pk(soft))).fitness).to.be.at.most(-BigInt(V2_DEFAULTS.lambdaBench) * n);
    void V2_GENESIS;
  });

  it("sparring: a held step counts half as taken, and its amount still raises the outflow the next steps see", async () => {
    const w = await deployV2World();
    const ref = await ethers.deployContract("SparReference", [V2_DEFAULTS.insiderRep]);
    const g = pk(V2_GENESIS);
    // one step of 20%: genesis scores 400,000 (held): half of 200,000 is taken
    const one = pk(encodeAttack([{ amountBps: 2000, recipient: "self" }]));
    expect(await w.crucible.extracted(...g, ...one)).to.equal(100_000n);
    // then 15% of what is left: 120,000, f0 150, and f7 counts the held 200,000: (200,000 + 120,000) -> 320, so it
    // scores 225,000 + 160,000 = 385,000 and is held too (without the held step in the outflow it would have paid)
    const two = pk(encodeAttack([{ amountBps: 2000, recipient: "self" }, { amountBps: 1500, recipient: "self", delayBlocks: 30 }]));
    expect(await w.crucible.extracted(...g, ...two)).to.equal(160_000n);
    expect(await ref.extracted(...g, ...two)).to.equal(160_000n);
  });
});
