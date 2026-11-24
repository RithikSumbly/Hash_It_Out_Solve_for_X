import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, mine } from "@nomicfoundation/hardhat-network-helpers";
import {
  deployWorld,
  doSpend,
  unpackFeatures,
  commitFor,
  salt,
  HONEST,
  ATTACK,
  ATTACK_STAKE,
  POLICY_STAKE,
  AMOUNT_CAP,
  toEpochEnd,
  ZERO,
  fillLog,
} from "./fixture";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { pack, policyGenes } from "../../sdk/src/genome";

describe("Vault", () => {
  async function world() {
    const w = await deployWorld();
    const [honest, attacker, judge, recipient, other] = w.signers;
    await w.vault.registerHonest(honest.address);
    return { ...w, honest, attacker, judge, recipient, other };
  }

  it("only participants can spend: honest, staked attackers, delegated agents", async () => {
    const w = await loadFixture(world);
    const amt = ethers.parseEther("0.1");
    await expect(
      w.vault.connect(w.attacker).spend(w.attacker.address, amt, 0, ethers.ZeroHash),
    ).to.be.revertedWithCustomError(w.vault, "NotParticipant");
    await w.arena.connect(w.attacker).submitAttack(ZERO, { value: ATTACK_STAKE });
    await expect(w.vault.connect(w.attacker).spend(w.attacker.address, amt, 0, ethers.ZeroHash)).to.emit(w.vault, "Spend");
    await expect(w.vault.connect(w.honest).spend(w.recipient.address, amt, 0, ethers.ZeroHash)).to.emit(w.vault, "Spend");
  });

  it("registerHonest is registrar-only; registrars are owner-managed", async () => {
    const w = await loadFixture(world);
    await expect(w.vault.connect(w.judge).registerHonest(w.judge.address)).to.be.revertedWithCustomError(w.vault, "NotRegistrar");
    await w.vault.setRegistrar(w.other.address, true);
    await expect(w.vault.connect(w.other).registerHonest(w.judge.address))
      .to.emit(w.vault, "HonestRegistered")
      .withArgs(w.judge.address, w.other.address);
    expect(await w.vault.isHonest(w.judge.address)).to.equal(true);
  });

  it("computes the 8 features on-chain", async () => {
    const w = await loadFixture(world);
    const bal = await w.vault.balance();
    // first spend: f0 = 10% of balance, f1 novelty 1000, f2 0, f3 1000 (never spent), f4 >= 500 honest,
    // f5 0 (EOA), f6 0 (EOA), f7 100 (10% of epoch start)
    const r1 = await doSpend(w, w.honest, w.recipient.address, bal / 10n);
    const f1 = unpackFeatures(r1.features);
    expect(f1[0]).to.equal(100);
    expect(f1[1]).to.equal(1000);
    expect(f1[2]).to.equal(0);
    expect(f1[3]).to.equal(1000);
    expect(f1[4]).to.be.within(500, 800);
    expect(f1[5]).to.equal(0);
    expect(f1[6]).to.equal(0);
    expect(f1[7]).to.equal(100);
    // second spend to same recipient, next block: novelty halves, velocity 200, gap 10 (1 block of 100), outflow cumulative
    const r2 = await doSpend(w, w.honest, w.recipient.address, bal / 10n);
    const f2 = unpackFeatures(r2.features);
    expect(f2[1]).to.equal(500);
    expect(f2[2]).to.equal(200);
    expect(f2[3]).to.equal(10);
    expect(f2[7]).to.equal(200);
    // contract recipient (f6) and call depth (f5) via an agent proxy
    const proxy = await ethers.deployContract("AgentProxy", [w.honest.address]);
    const r3 = await doSpend(w, w.honest, await proxy.getAddress(), 1000n);
    expect(unpackFeatures(r3.features)[6]).to.equal(1000);
  });

  it("previewSpend matches what spend() then sees", async () => {
    const w = await loadFixture(world);
    const amt = ethers.parseEther("1");
    const [refused, , score, f] = await w.vault.previewSpend(w.honest.address, w.recipient.address, amt);
    // preview is computed at the current block; spend mines the next block, only f3/f4 may move
    const r = await doSpend(w, w.honest, w.recipient.address, amt);
    const got = unpackFeatures(r.features);
    expect(got[0]).to.equal(Number(f[0]));
    expect(got[1]).to.equal(Number(f[1]));
    expect(got[7]).to.equal(Number(f[7]));
    expect(r.refused).to.equal(refused);
    expect(r.score).to.equal(score);
  });

  it("a refused spend does not revert, moves no funds, and emits the reason", async () => {
    const w = await loadFixture(world);
    // make AMOUNT_CAP live: submit it and win an epoch against an attack it refuses
    await w.arena.connect(w.other).submitPolicy(AMOUNT_CAP, { value: POLICY_STAKE });
    await w.arena.connect(w.attacker).submitAttack(ZERO, { value: ATTACK_STAKE });
    await doSpend(w, w.attacker, w.attacker.address, ethers.parseEther("4"), ATTACK);
    await toEpochEnd(w);
    await w.arena.closeEpoch();
    expect((await w.firewall.exportGenome())[2]).to.equal(2n); // policy id 2 = AMOUNT_CAP
    const before = await w.vault.balance();
    const amt = (before * 4n) / 10n; // 40% drain
    const tx = w.vault.connect(w.honest).spend(w.honest.address, amt, 1, commitFor(HONEST, salt(1), w.honest.address));
    await expect(tx).to.emit(w.vault, "Spend");
    const rc = await (await tx).wait();
    const ev = rc!.logs.map((l) => w.vault.interface.parseLog(l)).find((e) => e?.name === "Spend")!;
    expect(ev.args.refused).to.equal(true);
    expect(ev.args.reason).to.equal(1n);
    expect(ev.args.score).to.equal(2000n * 400n);
    expect(await w.vault.balance()).to.equal(before);
    // the attacker's 40% was refused too, by the attackers' 10% cap (the live genesis would have paid it)
    expect(await w.vault.totalRefused()).to.equal(2n);
  });

  it("withdraw must go to the caller; zero/oversized/bad-kind spends revert", async () => {
    const w = await loadFixture(world);
    await expect(w.vault.connect(w.honest).spend(w.recipient.address, 1n, 1, ethers.ZeroHash)).to.be.revertedWithCustomError(
      w.vault,
      "WithdrawMustBeSelf",
    );
    await expect(w.vault.connect(w.honest).spend(w.recipient.address, 0n, 0, ethers.ZeroHash)).to.be.revertedWithCustomError(w.vault, "ZeroAmount");
    await expect(
      w.vault.connect(w.honest).spend(w.recipient.address, ethers.parseEther("1000"), 0, ethers.ZeroHash),
    ).to.be.revertedWithCustomError(w.vault, "InsufficientBalance");
    await expect(w.vault.connect(w.honest).spend(w.recipient.address, 1n, 3, ethers.ZeroHash)).to.be.revertedWithCustomError(w.vault, "BadKind");
  });

  it("delegation: an agent funded with DELEGATE becomes a participant, inherits reputation, and shows call depth", async () => {
    const w = await loadFixture(world);
    const proxy = await ethers.deployContract("AgentProxy", [w.honest.address]);
    const pa = await proxy.getAddress();
    await expect(w.vault.connect(w.honest).spend(pa, 1000n, 2, ethers.ZeroHash))
      .to.emit(w.vault, "Delegated")
      .withArgs(w.honest.address, pa, 1000n);
    expect(await w.vault.delegateOf(pa)).to.equal(w.honest.address);
    const tx = await proxy.connect(w.honest).act(await w.vault.getAddress(), w.recipient.address, 5000n, 0, ethers.ZeroHash);
    const rc = await tx.wait();
    const ev = rc!.logs.map((l) => { try { return w.vault.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "Spend")!;
    const f = unpackFeatures(ev.args.features);
    expect(ev.args.caller).to.equal(pa);
    expect(f[5]).to.equal(1000); // tx.origin != msg.sender
    expect(f[4]).to.be.greaterThanOrEqual(500); // inherited reputation (the laundering the policy must learn)
  });

  it("ERC-8004 identity holders get a reputation bonus in f4", async () => {
    const w = await loadFixture(world);
    const reg = await ethers.deployContract("MockIdentityRegistry");
    const [, , , , , agent] = w.signers;
    await w.arena.connect(agent).submitAttack(ZERO, { value: ATTACK_STAKE });
    const before = unpackFeatures((await doSpend(w, agent, agent.address, 1000n, ATTACK)).features)[4];
    expect(before).to.equal(0);
    await w.vault.setIdentityRegistry(await reg.getAddress());
    await reg.connect(agent).register("ipfs://agent-card");
    const after = unpackFeatures((await doSpend(w, agent, agent.address, 1000n, ATTACK)).features)[4];
    expect(after).to.equal(200);
  });

  it("logs every spend with every shadow candidate's verdict", async () => {
    const w = await loadFixture(world);
    await w.arena.connect(w.other).submitPolicy(AMOUNT_CAP, { value: POLICY_STAKE });
    const r = await doSpend(w, w.honest, w.recipient.address, ethers.parseEther("3"));
    // pool = [genesis, AMOUNT_CAP]; 30% > 25% so slot 1 refuses
    expect(r.shadowMask).to.equal(0b10);
    const rec = await w.vault.getTx(1, r.txId);
    expect(rec.shadowMask).to.equal(2n);
    expect(rec.liveRefused).to.equal(false);
    expect(rec.caller).to.equal(w.honest.address);
    expect(await w.vault.epochTxCount(1)).to.equal(1n);
  });

  it("subscriber mode: a personal vault follows the champion firewall", async () => {
    const w = await loadFixture(world);
    const mine_ = await ethers.deployContract("Vault", [await w.firewall.getAddress(), ethers.ZeroAddress, 10]);
    await mine_.deposit({ value: ethers.parseEther("1") });
    await mine_.registerHonest(w.judge.address);
    // genesis live: passes
    await expect(mine_.connect(w.judge).spend(w.judge.address, ethers.parseEther("0.5"), 1, ethers.ZeroHash))
      .to.emit(mine_, "Spend")
      .withArgs(w.judge.address, w.judge.address, ethers.parseEther("0.5"), false, 0, 0, anyValue, ethers.MaxUint256, 1, anyValue, ethers.parseEther("0.5"), 0); // verdict 0 = paid
    expect(await mine_.balance()).to.equal(ethers.parseEther("0.5"));
    await expect(mine_.connect(w.other).spend(w.other.address, 1n, 1, ethers.ZeroHash)).to.be.revertedWithCustomError(mine_, "NotParticipant");
    await expect(mine_.revealLabels([], [], [])).to.be.revertedWithCustomError(mine_, "NoArena");
  });

  it("caps logged spends per epoch (MAX_TX_PER_EPOCH) so closeEpoch stays bounded", async function () {
    this.timeout(300000);
    const w = await deployWorld({ epoch: 400n, reveal: 10n, funds: ethers.parseEther("1000") });
    const [h] = w.signers;
    await w.vault.registerHonest(h.address);
    const max = await w.vault.MAX_TX_PER_EPOCH();
    await fillLog(w, Number(max)); // at most MAX_TX_PER_CALLER a wallet, so it takes 15 wallets
    await expect(w.vault.connect(h).spend(h.address, 1n, 1, ethers.ZeroHash)).to.be.revertedWithCustomError(w.vault, "EpochSaturated");
    await mine(400);
    const tx = await w.arena.closeEpoch();
    const rc = await tx.wait();
    expect(rc!.gasUsed).to.be.lessThan(15_000_000n);
  });

  it("is reentrancy-safe: a recipient cannot re-enter spend", async () => {
    const w = await loadFixture(world);
    const re = await ethers.deployContract("Reenterer");
    await re.setVault(await w.vault.getAddress());
    await w.vault.registerHonest(await re.getAddress());
    const bal = await w.vault.balance();
    await expect(re.start(1000n)).to.be.revertedWithCustomError(w.vault, "TransferFailed");
    expect(await w.vault.balance()).to.equal(bal);
  });

  it("packs features identically to the SDK", async () => {
    const w = await loadFixture(world);
    const f = [1, 2, 3, 4, 5, 6, 7, 1000];
    const p = await w.vault.packFeatures(f);
    expect(unpackFeatures(p)).to.deep.equal(f);
    const g = pack(policyGenes({ weights: { 0: 1 } }));
    expect(g.lo).to.equal(1n);
  });
});
