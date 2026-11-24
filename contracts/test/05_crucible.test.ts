import { expect } from "chai";
import { ethers } from "hardhat";
import { deployV2World, doSpend, ATTACK, AMOUNT_CAP, REFUSE_ALL, ZERO, packed } from "./fixture";
import { encodeAttack, ATTACK_PRESETS, policyGenes, unpackFeatures, type AttackStep, type Genes } from "../../sdk/src/genome";
import { V2_GENESIS, V2_HONEST_BENCH, V2_DEFAULTS } from "../../sdk/src/v2";

const SIM = 1_000_000n;
const pk = (g: Genes): [bigint, bigint] => {
  const p = packed(g);
  return [p.lo, p.hi];
};
const preset = (name: keyof typeof ATTACK_PRESETS) => pk(encodeAttack(ATTACK_PRESETS[name].steps));

/** Salami detector: velocity (>= 2 prior spends) together with outflow over 15% fires interaction k3. */
export const SALAMI_GUARD = policyGenes({ interactions: { 3: 600 }, thresholds: { 2: 400, 7: 150 } });
/** Burst detector: a new recipient (novelty >= 900) together with velocity (>= 2 prior spends) fires k2. */
export const BURST_GUARD = policyGenes({ interactions: { 2: 600 }, thresholds: { 1: 900, 2: 400 } });

/**
 * Run `steps` for real against a vault whose live policy is `guard` (as genesis) and return, per step,
 * whether the vault refused it. Recipients follow the genome: self, a brand-new address, or the agent contract.
 */
async function realRun(guard: Genes, steps: Partial<AttackStep>[]) {
  const w = await deployV2World({ genesis: guard, insiderRep: 0, epoch: 200n, reveal: 10n });
  const x = w.signers[5];
  await w.arena.connect(x).submitAttack(encodeAttack(steps), { value: await w.arena.ATTACK_STAKE() });
  const out: boolean[] = [];
  for (const st of steps) {
    const bal = await w.vault.balance();
    const to = st.recipient === "fresh" ? ethers.Wallet.createRandom().address : x.address;
    out.push((await doSpend(w, x, to, (bal * BigInt(st.amountBps ?? 0)) / 10_000n, ATTACK)).refused);
  }
  return { w, out };
}

/** The same steps in the Crucible: extracted after k steps tells which steps passed. */
async function simRun(crucible: Awaited<ReturnType<typeof deployV2World>>["crucible"], guard: Genes, steps: Partial<AttackStep>[]) {
  const [gLo, gHi] = pk(guard);
  const out: boolean[] = [];
  let prev = 0n;
  for (let k = 1; k <= steps.length; k++) {
    const [aLo, aHi] = pk(encodeAttack(steps.slice(0, k)));
    const got = await crucible.extracted(gLo, gHi, aLo, aHi);
    out.push(got === prev);
    prev = got;
  }
  return out;
}

describe("Crucible — the sparring ring", () => {
  it("simulates attacks: a 40% drain beats an empty policy and is stopped by the genesis policy", async () => {
    const { crucible: c } = await deployV2World();
    const [drainLo, drainHi] = preset("drain");
    const [zLo, zHi] = pk(ZERO);
    const [gLo, gHi] = pk(V2_GENESIS);
    expect(await c.extracted(zLo, zHi, drainLo, drainHi)).to.equal((SIM * 40n) / 100n);
    expect(await c.extracted(gLo, gHi, drainLo, drainHi)).to.equal(0n);
    // salami: 8 x 3% of what is left, all under the genesis limits (the gap evolution has to close)
    const [sLo, sHi] = preset("salami");
    const salami = await c.extracted(gLo, gHi, sLo, sHi);
    expect(salami).to.be.greaterThan(200_000n).and.lessThan(220_000n);
  });

  it("agrees step by step with the real Vault: salami against a salami guard, burst against a burst guard", async () => {
    const salami = Array.from({ length: 8 }, () => ({ amountBps: 300, recipient: "self" as const }));
    const burst = Array.from({ length: 5 }, () => ({ amountBps: 500, recipient: "fresh" as const }));
    const s = await realRun(SALAMI_GUARD, salami);
    const b = await realRun(BURST_GUARD, burst);
    expect(s.out).to.deep.equal([false, false, false, false, false, true, true, true]);
    expect(b.out).to.deep.equal([false, false, true, true, true]);
    expect(await simRun(s.w.crucible, SALAMI_GUARD, salami)).to.deep.equal(s.out);
    expect(await simRun(b.w.crucible, BURST_GUARD, burst)).to.deep.equal(b.out);
  });

  it("the honest bench is what the Vault really computes: a judge's first 1.2% payment", async () => {
    const w = await deployV2World();
    const judge = w.signers[7];
    const stranger = ethers.Wallet.createRandom().address;
    await w.vault.registerHonest(judge.address);
    const amount = ((await w.vault.balance()) * 120n) / 10_000n;
    const f = (await w.vault.features(judge.address, judge.address, stranger, amount)).map(Number);
    expect(f).to.deep.equal(V2_HONEST_BENCH[0].f);
    // and the payment goes through the genesis policy, with reputation 500 on the event
    const r = await doSpend(w, judge, stranger, amount, 1);
    expect(r.refused).to.equal(false);
    expect(unpackFeatures(r.features)[4]).to.equal(500);
  });

  it("screens the bench: genesis and a 25% cap pass all of it, refuse-everything fails all of it", async () => {
    const { crucible: c } = await deployV2World();
    expect(await c.honestRefusals(...pk(V2_GENESIS))).to.equal(0n);
    expect(await c.honestRefusals(...pk(AMOUNT_CAP))).to.equal(0n);
    expect(await c.honestRefusals(...pk(REFUSE_ALL))).to.equal(BigInt(V2_HONEST_BENCH.length));
    const s = await c.screen(...pk(REFUSE_ALL));
    expect(s.lost).to.equal(0n); // it does stop every attack...
    // ...at a price: each refused bench payment costs 2 x its amount (ppm) + 5,000 ppm, or lambdaBench if that is more
    const lb = await c.lambdaBench();
    const each = (b: { f: number[] }) => { const p = 2n * BigInt(b.f[0]) * 1000n + 5000n; return p > lb ? p : lb; };
    const price = V2_HONEST_BENCH.reduce((t, b) => t + each(b), 0n);
    expect(s.fitness).to.equal(-price);
    expect((await c.benchCost(...pk(REFUSE_ALL))).cost).to.equal(price);
    void V2_DEFAULTS;
    expect(s.championFitness).to.be.greaterThan(s.fitness);
  });

  it("the optimised simulation and scorer equal the reference ones on 400 random genomes (and 400 feature vectors)", async function () {
    this.timeout(300000);
    let seed = 0x5eed1234;
    const rnd = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 4294967296;
    };
    const int = (lo: number, hi: number) => Math.floor(lo + rnd() * (hi - lo + 1));
    const gene = (scale: number) => (rnd() < 0.15 ? int(-32768, 32767) : rnd() < 0.4 ? 0 : int(-scale, scale));
    let checked = 0;
    let differentOutcomes = new Set<bigint>();
    for (const rep of [0, 500]) {
      const { crucible: c } = await deployV2World({ insiderRep: rep });
      const ref = await ethers.deployContract("SparReference", [rep]);
      for (let i = 0; i < 200; i++) {
        const policy = [
          ...Array.from({ length: 8 }, () => gene(3000)),
          ...Array.from({ length: 8 }, () => gene(900)),
          ...Array.from({ length: 8 }, () => gene(1100)),
          ...Array.from({ length: 8 }, () => int(-32768, 32767)),
        ];
        const attack = Array.from({ length: 32 }, (_, k) => (k % 4 === 0 ? (rnd() < 0.2 ? 0 : int(-6000, 6000)) : int(-32768, 32767)));
        const [pLo, pHi] = pk(policy);
        const [aLo, aHi] = pk(attack);
        const got = await c.extracted(pLo, pHi, aLo, aHi);
        expect(got, `pair ${i} (insider ${rep})`).to.equal(await ref.extracted(pLo, pHi, aLo, aHi));
        differentOutcomes.add(got);
        const f = Array.from({ length: 8 }, () => int(0, 1200));
        expect(await c.refuses(pLo, pHi, f), `features ${i}`).to.equal(await ref.refusesFast(pLo, pHi, f));
        checked++;
      }
    }
    expect(checked).to.equal(400);
    expect(differentOutcomes.size).to.be.greaterThan(50); // the sample is not degenerate (all-pass or all-refuse)
  });

  it("grade() is the Arena's alone", async () => {
    const { crucible: c } = await deployV2World();
    await expect(c.grade(1, 1, [], [], [], [], [], [])).to.be.revertedWithCustomError(c, "NotArena");
  });
});
