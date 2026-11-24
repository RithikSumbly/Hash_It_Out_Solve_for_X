/**
 * Verify all deployed contracts on the chain's explorer:  npx hardhat run scripts/verify.ts --network baseSepolia
 * Constructor arguments are read back from the contracts themselves (their immutables, the honest bench and the
 * seeded attack genomes), so they match what was deployed exactly.
 */
import { run, ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { V2_SEED_ATTACKS } from "../../sdk/src/v2";

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const d = JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../deployments/${chainId}.json`), "utf8"));
  const c = d.contracts;
  const jobs: [string, unknown[]][] = [
    [c.lineage, []],
    [c.firewall, []],
    [c.vault, [c.firewall, c.arena, 0]],
    [c.policyGuard, [c.firewall]],
  ];
  if (c.identityRegistry) jobs.push([c.identityRegistry, []]); // the ERC-8004 identity mock (no constructor arguments)
  if (d.version >= 2) {
    const arena = await ethers.getContractAt("Arena", c.arena);
    const crucible = await ethers.getContractAt("Crucible", c.crucible);
    const config = {
      firewall: c.firewall,
      lineage: c.lineage,
      epochLength: await arena.epochLength(),
      revealWindow: await arena.revealWindow(),
      policyStake: await arena.POLICY_STAKE(),
      attackStake: await arena.ATTACK_STAKE(),
      minBet: await arena.MIN_BET(),
      closeTip: await arena.closeTip(),
      mutationScale: await arena.mutationScale(),
      genesisLo: await arena.genesisLo(),
      genesisHi: await arena.genesisHi(),
    };
    const seeds: [bigint, bigint][] = [];
    for (let id = 1; id <= V2_SEED_ATTACKS.length; id++) {
      const a = await arena.getAttack(id);
      seeds.push([a.lo, a.hi]);
    }
    jobs.push([c.arena, [config, seeds]]);
    jobs.push([c.crucible, [c.arena, c.firewall, [...(await crucible.honestBench())], await crucible.lambdaBench(), await crucible.insiderRep()]]);
  } else {
    jobs.push([c.arena, [c.firewall, c.lineage, d.epochLength, d.revealWindow]]);
  }
  for (const [address, args] of jobs) {
    try {
      await run("verify:verify", { address, constructorArguments: args });
    } catch (e) {
      console.log(`verify ${address}: ${(e as Error).message.split("\n")[0]}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
