import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { deployWorld, REFUSE_ALL, AMOUNT_CAP } from "./fixture";
import { explain, pack, unpack, decodeReason, policyGenes, crossover } from "../../sdk/src/genome";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe("GenomeLib + Firewall", () => {
  async function world() {
    return deployWorld();
  }

  it("packs and unpacks int16[32] identically in Solidity and the SDK", async () => {
    const { firewall } = await loadFixture(world);
    const r = rng(7);
    for (let n = 0; n < 10; n++) {
      const g = Array.from({ length: 32 }, () => Math.floor(r() * 65536) - 32768);
      const { lo, hi } = pack(g);
      const [slo, shi] = await firewall.packGenes(g);
      expect(slo).to.equal(lo);
      expect(shi).to.equal(hi);
      const back = (await firewall.unpackGenes(lo, hi)).map(Number);
      expect(back).to.deep.equal(g);
      expect(unpack(lo, hi)).to.deep.equal(g);
    }
  });

  it("scores bit-exactly like the SDK mirror over 60 random genomes x feature vectors", async () => {
    const { firewall } = await loadFixture(world);
    const r = rng(42);
    for (let n = 0; n < 60; n++) {
      const g = Array.from({ length: 32 }, (_, i) =>
        i < 8 ? Math.floor(r() * 4000) - 1500 : i < 16 ? Math.floor(r() * 1400) - 400 : i < 24 ? Math.floor(r() * 2000) - 1000 : 0,
      );
      const f = Array.from({ length: 8 }, () => Math.floor(r() * 1001));
      const { lo, hi } = pack(g);
      const res = await firewall.explainWith(lo, hi, f);
      const mine = explain(g, f);
      expect(res.refused).to.equal(mine.refused);
      // explainWith decodes reasons on a hold too, like GenomeLib.verdict (what the Vault uses)
      // and the SDK, so the predictor's on-chain view and the SDK agree on held payments
      expect(mine.reason).to.equal(res.reason);
      expect(res.s).to.equal(mine.score);
      expect(res.raw).to.equal(mine.raw);
      expect(res.terms.map((x: bigint) => x)).to.deep.equal(mine.terms);
    }
  });

  it("shadowMask() (the fast scorer) agrees with the full scorer for every candidate", async () => {
    const { firewall } = await loadFixture(world);
    const r = rng(99);
    for (let n = 0; n < 25; n++) {
      const gs = Array.from({ length: 16 }, () =>
        Array.from({ length: 32 }, (_, i) =>
          i < 8 ? Math.floor(r() * 3000) - 1000 : i < 16 ? Math.floor(r() * 1400) - 400 : i < 24 ? Math.floor(r() * 2000) - 1000 : Math.floor(r() * 65536) - 32768,
        ),
      );
      const f = Array.from({ length: 8 }, () => Math.floor(r() * 1200));
      const packedGs = gs.map(pack);
      const mask = await firewall.shadowMask(packedGs.map((p) => p.lo), packedGs.map((p) => p.hi), f);
      let expected = 0;
      gs.forEach((g, j) => {
        if (explain(g, f).refused) expected |= 1 << j;
      });
      expect(Number(mask)).to.equal(expected);
    }
  });

  it("refuses when score > GLOBAL_THRESHOLD with a decoded reason bitmask", async () => {
    const { firewall } = await loadFixture(world);
    const { lo, hi } = pack(AMOUNT_CAP);
    // f0 = 400 -> 2000 * 400 = 800k > 500k
    const big = await firewall.explainWith(lo, hi, [400, 0, 0, 0, 0, 0, 0, 0]);
    expect(big.refused).to.equal(true);
    expect(big.reason).to.equal(1n); // bit 0: LARGE_AMOUNT
    expect(decodeReason(big.reason)).to.deep.equal(["LARGE_AMOUNT"]);
    // exactly at threshold: 250 * 2000 = 500k -> not refused (strictly greater), but held, and explained
    const edge = await firewall.explainWith(lo, hi, [250, 0, 0, 0, 0, 0, 0, 0]);
    expect(edge.refused).to.equal(false);
    expect(edge.reason).to.equal(1n);
    const paid = await firewall.explainWith(lo, hi, [175, 0, 0, 0, 0, 0, 0, 0]); // 350k: paid, no reason
    expect([paid.refused, paid.reason]).to.deep.equal([false, 0n]);
    const ra = pack(REFUSE_ALL);
    const all = await firewall.explainWith(ra.lo, ra.hi, [0, 0, 0, 0, 0, 0, 0, 0]);
    expect(all.refused).to.equal(true);
    expect(all.reason).to.equal(1n << 8n); // interaction k0 fired
  });

  it("supports inverted step gates (negative thresholds)", async () => {
    const { firewall } = await loadFixture(world);
    // interaction k6 (f2 velocity, f3 gap): fires when f2 >= 400 and f3 < 100 (inverted)
    const g = policyGenes({ interactions: { 6: 700 }, thresholds: { 2: 400, 3: -100 } });
    const { lo, hi } = pack(g);
    expect((await firewall.explainWith(lo, hi, [0, 0, 600, 50, 0, 0, 0, 0])).refused).to.equal(true);
    expect((await firewall.explainWith(lo, hi, [0, 0, 600, 500, 0, 0, 0, 0])).refused).to.equal(false);
    expect((await firewall.explainWith(lo, hi, [0, 0, 300, 50, 0, 0, 0, 0])).refused).to.equal(false);
  });

  it("clamps features above 1000", async () => {
    const { firewall } = await loadFixture(world);
    const { lo, hi } = pack(policyGenes({ weights: { 0: 1 } }));
    expect((await firewall.explainWith(lo, hi, [5000, 0, 0, 0, 0, 0, 0, 0])).s).to.equal(1000n);
  });

  it("breed(): uniform crossover + exactly two bounded mutations in the active range", async () => {
    const { firewall } = await loadFixture(world);
    const r = rng(3);
    for (let n = 0; n < 12; n++) {
      const a = Array.from({ length: 32 }, () => Math.floor(r() * 2000) - 1000);
      const b = Array.from({ length: 32 }, () => Math.floor(r() * 2000) - 1000);
      const A = pack(a);
      const B = pack(b);
      const rand = BigInt(ethers.id(`r${n}`));
      const out = await firewall.breed(A.lo, A.hi, B.lo, B.hi, rand, 24);
      const child = unpack(out.lo, out.hi);
      const crossed = crossover(a, b, rand);
      const diffs = child.map((c, i) => c - crossed[i]).map((d, i) => ({ d, i })).filter((x) => x.d !== 0);
      // two mutations (they may land on the same gene)
      const mg = out.mutGenes.map(Number);
      const md = out.mutDeltas.map(Number);
      for (const g of mg) expect(g).to.be.lessThan(24);
      for (const d of md) expect(Math.abs(d)).to.be.within(1, 64);
      const expected = [...crossed];
      expected[mg[0]] += md[0];
      expected[mg[1]] += md[1];
      expect(child).to.deep.equal(expected);
      expect(diffs.length).to.be.at.most(2);
      for (let i = 24; i < 32; i++) expect(child[i]).to.equal(crossed[i]); // reserved genes never mutate
    }
  });

  it("install() is only callable by the Arena; setArena is one-shot", async () => {
    const { firewall, owner } = await loadFixture(world);
    await expect(firewall.install(99, 1, 2)).to.be.revertedWithCustomError(firewall, "NotArena");
    await expect(firewall.setArena(owner.address)).to.be.revertedWithCustomError(firewall, "ArenaAlreadySet");
  });

  it("starts on the genesis policy (all-zero genome, refuses nothing)", async () => {
    const { firewall } = await loadFixture(world);
    const [lo, hi, id, count] = await firewall.exportGenome();
    expect(lo).to.equal(0n);
    expect(hi).to.equal(0n);
    expect(id).to.equal(1n);
    expect(count).to.equal(1n);
    const [refused, reason] = await firewall.refuses([1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000]);
    expect(refused).to.equal(false);
    expect(reason).to.equal(0n);
    expect(await firewall.score([1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000])).to.equal(0n);
  });
});
