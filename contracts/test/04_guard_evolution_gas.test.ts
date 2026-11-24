import { expect } from "chai";
import hre, { ethers } from "hardhat";
import { mine } from "@nomicfoundation/hardhat-network-helpers";
import {
  deployWorld,
  doSpend,
  reveal,
  toReveal,
  toEpochEnd,
  HONEST,
  ATTACK,
  ATTACK_STAKE,
  POLICY_STAKE,
  AMOUNT_CAP,
  LOOSE_CAP,
  ZERO,
  SpendResult,
  fillLog,
} from "./fixture";
import { policyGenes, explain, unpackFeatures } from "../../sdk/src/genome";

const E = (x: string) => ethers.parseEther(x);

describe("PolicyGuard — exporting the live genome to any wallet / ERC-4337 account", () => {
  it("imports the champion genome and enforces it on the account's own transfers", async () => {
    const w = await deployWorld();
    const [owner, p, x, friend] = w.signers;
    await w.arena.connect(p).submitPolicy(AMOUNT_CAP, { value: POLICY_STAKE });
    await w.arena.connect(x).submitAttack(ZERO, { value: ATTACK_STAKE });
    await doSpend(w, x, x.address, E("4"), ATTACK);
    await toEpochEnd(w);
    await w.arena.closeEpoch();

    const guard = await ethers.deployContract("PolicyGuard", [await w.firewall.getAddress()]);
    const acct = await ethers.deployContract("GuardedAccount", [owner.address, await guard.getAddress()]);
    await owner.sendTransaction({ to: await acct.getAddress(), value: E("1") });
    await expect(acct.connect(owner).importPolicy()).to.emit(guard, "Imported");
    // 40% of the account in one go: refused with LARGE_AMOUNT
    await expect(acct.connect(owner).execute(friend.address, E("0.4"), "0x"))
      .to.be.revertedWithCustomError(guard, "PolicyRefused")
      .withArgs(1n, 800000n);
    // 10% passes
    await expect(acct.connect(owner).execute(friend.address, E("0.1"), "0x")).to.emit(guard, "Checked");
    expect(await ethers.provider.getBalance(await acct.getAddress())).to.equal(E("0.9"));
    // pinned genome survives later installs; unpin follows live again
    const [lo, hi] = await guard.genomeOf(await acct.getAddress());
    const live = await w.firewall.exportGenome();
    expect(lo).to.equal(live[0]);
    expect(hi).to.equal(live[1]);
  });
});

describe("Evolution — the arena learns to refuse the scripted attacks", () => {
  it("over several epochs the live policy refuses drains and salami while passing honest traffic", async function () {
    this.timeout(300000);
    // Breeding randomness comes from block hashes, which include timestamps. Pin every block 12 s apart
    // (Sepolia cadence) so this simulation is reproducible run to run.
    const provider = hre.network.provider as unknown as { request(a: { method: string; params?: unknown[] }): Promise<unknown> };
    const original = provider.request.bind(provider);
    await original({ method: "hardhat_reset", params: [] });
    let clock = Number(process.env.EVOLUTION_CLOCK ?? 1_900_000_000);
    provider.request = async (a) => {
      if (a.method === "hardhat_mine") {
        const n = Number(BigInt((a.params?.[0] as string) ?? "0x1"));
        for (let i = 0; i < n; i++) {
          clock += 12;
          await original({ method: "hardhat_setPrevRandao", params: [ethers.keccak256(ethers.toBeHex(clock, 32))] });
          await original({ method: "evm_mine", params: [clock] });
        }
        return null;
      }
      return original(a);
    };
    // transactions go through ethers' provider.send: pin timestamp + prevrandao for the block each one mines.
    // Hardhat randomises prevrandao per process, and the Arena prefers native randomness.
    const ep = ethers.provider as unknown as { send(m: string, p: unknown[]): Promise<unknown> };
    const originalSend = ep.send.bind(ep);
    ep.send = async (m, p) => {
      if (m === "eth_sendTransaction" || m === "eth_sendRawTransaction") {
        clock += 12;
        await original({ method: "evm_setNextBlockTimestamp", params: [clock] });
        await original({ method: "hardhat_setPrevRandao", params: [ethers.keccak256(ethers.toBeHex(clock, 32))] });
      }
      return originalSend(m, p);
    };
    try {
    const w = await deployWorld({ epoch: 40n, reveal: 10n, funds: E("20") });
    const s = w.signers;
    const honest = s.slice(0, 3);
    const attackers = s.slice(3, 5);
    const submitters = s.slice(5, 10);
    for (const h of honest) await w.vault.registerHonest(h.address);
    // weak, varied seed policies (what the deploy script seeds)
    const seeds = [
      LOOSE_CAP,
      policyGenes({ weights: { 1: 300, 2: 300 } }),
      policyGenes({ weights: { 0: 900, 7: 400 } }),
      policyGenes({ interactions: { 3: 520 }, thresholds: { 2: 600, 7: 300 } }),
      // reputation-aware amount cap: registered, aged wallets get headroom; strangers do not
      policyGenes({ weights: { 0: 1500, 4: -600 }, interactions: { 3: 520 }, thresholds: { 2: 600, 7: 250 } }),
    ];
    for (let i = 0; i < seeds.length; i++) await w.arena.connect(submitters[i]).submitPolicy(seeds[i], { value: POLICY_STAKE });

    const history: { epoch: number; live: bigint; drainRefused: boolean; honestRefused: number; drainFeatures: bigint }[] = [];
    for (let epoch = 1; epoch <= 6; epoch++) {
      for (const a of attackers) await w.arena.connect(a).submitAttack(ZERO, { value: ATTACK_STAKE });
      const mine_: Record<string, SpendResult[]> = {};
      let honestRefused = 0;
      // honest: small payments (2%) to known recipients. Wrong refusals are priced by payment: six
      // wrongly refused 1% payments cost a candidate less than the six 3% salami slices it stops, so refusing both could
      // win a close, and whether it did turned on the breeding seed (the test failed or passed with the test order);
      // at 2% letting honest traffic through is what pays
      for (const [i, h] of honest.entries()) {
        const r = await doSpend(w, h, s[20 + i].address, (await w.vault.balance()) / 50n, HONEST);
        if (r.refused) honestRefused++;
        (mine_[h.address] ??= []).push(r);
      }
      // attacks: one 40% drain, then 6 salami slices of 3%
      const d = await doSpend(w, attackers[0], attackers[0].address, ((await w.vault.balance()) * 40n) / 100n, ATTACK);
      // the attackers' 10% cap refuses the drain live whatever the policy says; what evolves is the policy's own
      // verdict on it (Firewall.judge, the live genome before this round's close)
      const drainRefused = (await w.firewall.judge(unpackFeatures(d.features)))[0] === 2n;
      for (let k = 0; k < 6; k++) await doSpend(w, attackers[1], attackers[1].address, ((await w.vault.balance()) * 3n) / 100n, ATTACK);
      for (const [i, h] of honest.entries()) {
        const r = await doSpend(w, h, s[20 + i].address, (await w.vault.balance()) / 50n, HONEST);
        if (r.refused) honestRefused++;
        mine_[h.address].push(r);
      }
      await toReveal(w);
      for (const h of honest) await reveal(w, h, mine_[h.address]);
      // top the vault back up so the arena keeps running (before the close, so the next round's start balance, which
      // the round's limits measure against, includes it)
      if ((await w.vault.balance()) < E("10")) await w.vault.deposit({ value: E("10") });
      await toEpochEnd(w);
      const ctx_ = await w.arena.closeEpoch();
      if (process.env.DEBUG_SEED) {
        const rc_ = await ctx_.wait();
        const b_ = await ethers.provider.getBlock(rc_!.blockNumber);
        const ev_ = rc_!.logs.map((l) => { try { return w.arena.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "Randomness");
        console.log("seed", epoch, b_!.timestamp, b_!.parentHash.slice(0, 10), ev_!.args.source, ev_!.args.seed.toString().slice(0, 12));
      }
      history.push({ epoch, live: (await w.firewall.exportGenome())[2], drainRefused, honestRefused, drainFeatures: d.features });
    }
    console.log("      evolution history:", history.map((h) => `e${h.epoch}:live#${h.live}${h.drainRefused ? " refused-drain" : " DRAINED"}${h.honestRefused ? ` honest-refused:${h.honestRefused}` : ""}`).join("  "));
    // generation 1 gets drained (genesis is live)
    expect(history[0].drainRefused).to.equal(false);
    // later generations refuse the drain without blocking honest users
    const late = history.slice(2);
    expect(late.every((h) => h.drainRefused)).to.equal(true);
    // ...and without locking out honest users. Breeding can install an over-blocking mutant, but the
    // lambda penalty removes it at the very next close: over-blocking never lasts two epochs in a row.
    for (let i = 1; i < late.length; i++) {
      expect(late[i - 1].honestRefused > 0 && late[i].honestRefused > 0).to.equal(false);
    }
    const lateHonestRefused = late.reduce((s, h) => s + h.honestRefused, 0);
    expect(lateHonestRefused).to.be.at.most(6);
    // the newly installed champion refuses the last epoch's drain exactly as it was seen on-chain
    const [lo, hi] = await w.firewall.exportGenome();
    expect(lo !== 0n || hi !== 0n).to.equal(true);
    const lastDrain = unpackFeatures(history[history.length - 1].drainFeatures);
    const [refusedOnChain] = await w.firewall.refuses(lastDrain);
    expect(refusedOnChain).to.equal(true);
    expect(explain((await w.firewall.liveGenes()).map(Number), lastDrain).refused).to.equal(true);
    } finally {
      provider.request = original;
      ep.send = originalSend;
    }
  });
});

describe("Gas — bounded worst cases", () => {
  it("spend() with a full 16-candidate shadow pool and closeEpoch() at saturation fit comfortably in a block", async function () {
    this.timeout(600000);
    const w = await deployWorld({ epoch: 600n, reveal: 50n, funds: E("1000") });
    const s = w.signers;
    for (let i = 0; i < 15; i++) {
      await w.arena.connect(s[i]).submitPolicy(policyGenes({ weights: { 0: 1000 + 50 * i, 1: 10 * i }, interactions: { 2: 100 + i }, thresholds: { 1: 500, 2: 200 } }), {
        value: POLICY_STAKE,
      });
    }
    const h = s[16];
    await w.vault.registerHonest(h.address);
    const tx = await w.vault.connect(h).spend(s[17].address, E("1"), 0, ethers.ZeroHash);
    const spendGas = (await tx.wait())!.gasUsed;
    const max = Number(await w.vault.MAX_TX_PER_EPOCH());
    const results: SpendResult[] = [];
    // at most MAX_TX_PER_CALLER requests a wallet a round: h logs its share, fresh honest wallets fill the rest
    const per = Number(await w.vault.MAX_TX_PER_CALLER());
    for (let i = 1; i < per; i++) results.push(await doSpend(w, h, s[18 + (i % 4)].address, E("0.01"), i % 2 ? HONEST : ATTACK));
    await fillLog(w, max, (i) => s[18 + (i % 4)].address);
    await mine(600);
    const ctx = await w.arena.closeEpoch();
    const closeGas = (await ctx.wait())!.gasUsed;
    console.log(`      spend() with 16 shadow candidates: ${spendGas} gas; closeEpoch() over ${max} txs x 16 candidates: ${closeGas} gas`);
    expect(spendGas).to.be.lessThan(700_000n);
    expect(closeGas).to.be.lessThan(16_000_000n);
    // features decode sanity on a stored tx
    expect(unpackFeatures(results[0].features).length).to.equal(8);
  });
});
