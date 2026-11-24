/**
 * Deploys Red Queen: Lineage, Firewall, Arena (stakes, minimum bet, closer's tip, mutation size and the genesis
 * policy set at deploy; the five scripted attacks seeded into the attack pool), Vault, Crucible (the sparring ring
 * and the proposal screen), PolicyGuard, and an ERC-8004 identity registry mock when none is configured. Wires them,
 * funds the vault and the protocol pool, and starts epoch 1. The configuration is sdk/src/v2.ts.
 *
 * Writes deployments/<chainId>.json (with `version`, `contracts.crucible`, `stakes` and `closeGas`)
 * and sdk/src/deployments.ts. An existing deployments/<chainId>.json is kept first as deployments/<chainId>.v<version>.json.
 *
 *   npx hardhat run scripts/deploy.ts --network baseSepolia
 *   npx hardhat run scripts/deploy.ts --network localhost
 *
 * Dry run (sends nothing, writes nothing): replays the whole deployment on a local fork of the target chain as the
 * deployer, then prices it with the chain's gas price and L1 data fee.
 *
 *   DRY_RUN=1 FORK_URL=https://sepolia.base.org DEPLOYER_ADDRESS=0x… npx hardhat run scripts/deploy.ts
 *
 * Env (all optional):
 *   EPOCH_LENGTH, REVEAL_WINDOW   blocks (default 20 / 5; locally 30 / 7; Base Sepolia 600 / 100, about two minutes
 *                                 at 0.2 s a block)
 *   VAULT_FUNDS                   ETH deposited in the vault (default 0.004 on public chains, 50 locally)
 *   POOL_FUNDS                    ETH in the protocol pool: closers' tips and false-refusal compensation (0.0005 / 5)
 *   POLICY_STAKE, ATTACK_STAKE, MIN_BET, CLOSE_TIP   ETH (default: sdk/src/v2.ts V2_DEFAULTS)
 *   MUTATION_SCALE, LAMBDA_BENCH, INSIDER_REP        (default: sdk/src/v2.ts V2_DEFAULTS)
 *   IDENTITY_REGISTRY             an ERC-8004 identity registry; default: the one in the existing deployment file,
 *                                 else a mock is deployed
 *   REGISTRARS                    comma-separated addresses allowed to registerHonest (e.g. the judge top-up wallet)
 *   GUARDIAN                      comma-separated addresses allowed to veto a held payment (Vault.setGuardian);
 *                                 the deployer, as the Vault's owner, may always veto
 *
 * There are no libraries to link. The previous deployments/<chainId>.json is kept as
 * deployments/<chainId>.v<version>.json before it is overwritten.
 */
import { ethers, network } from "hardhat";
import type { Signer, TransactionReceipt } from "ethers";
import * as fs from "fs";
import * as path from "path";
import { pack } from "../../sdk/src/genome";
import { V2_DEFAULTS, V2_GENESIS, v2HonestBenchPacked, v2SeedAttackGenomes } from "../../sdk/src/v2";

const EXPLORERS: Record<number, string> = {
  11155111: "https://sepolia.etherscan.io",
  17000: "https://holesky.etherscan.io",
  560048: "https://hoodi.etherscan.io",
  84532: "https://sepolia.basescan.org",
  11155420: "https://sepolia-optimism.etherscan.io",
  421614: "https://sepolia.arbiscan.io",
  80002: "https://amoy.polygonscan.com",
  31337: "",
};

const FAUCETS: Record<number, string> = {
  11155111: "https://cloud.google.com/application/web3/faucet/ethereum/sepolia",
  84532: "https://www.alchemy.com/faucets/base-sepolia",
  17000: "https://cloud.google.com/application/web3/faucet/ethereum/holesky",
};

/** OP-stack chains (Base included) charge an L1 data fee on top of L2 gas; this predeploy prices it. */
const GAS_PRICE_ORACLE = "0x420000000000000000000000000000000000000F";
const OP_STACK = new Set([84532, 8453, 11155420, 10]);

const eth = (name: string, fallback: bigint) => (process.env[name] ? ethers.parseEther(process.env[name]!) : fallback);
const num = (name: string, fallback: number) => (process.env[name] ? Number(process.env[name]) : fallback);

async function main() {
  const dry = !!process.env.DRY_RUN;
  let deployer: Signer;
  let chainId: number;
  let forkGasPrice = 0n;
  let realBalance = -1n;
  if (dry) {
    const url = process.env.FORK_URL;
    const who = process.env.DEPLOYER_ADDRESS;
    if (!url || !who) throw new Error("DRY_RUN needs FORK_URL and DEPLOYER_ADDRESS");
    const remote = new ethers.JsonRpcProvider(url);
    chainId = Number((await remote.getNetwork()).chainId);
    forkGasPrice = (await remote.getFeeData()).gasPrice ?? 0n;
    await network.provider.request({ method: "hardhat_reset", params: [{ forking: { jsonRpcUrl: url } }] });
    await network.provider.request({ method: "hardhat_impersonateAccount", params: [who] });
    // the fork's local fee market (about 1 gwei) is far above Base Sepolia's, so the upfront-cost check would fail
    // on the real balance: give the impersonated deployer room on the fork; the real cost is priced below
    realBalance = await remote.getBalance(who);
    await network.provider.request({ method: "hardhat_setBalance", params: [who, "0x8AC7230489E80000"] });
    deployer = await ethers.getSigner(who);
    console.log(`DRY RUN on a local fork of chain ${chainId}: nothing is sent to the chain, nothing is written`);
  } else {
    [deployer] = await ethers.getSigners();
    chainId = Number((await ethers.provider.getNetwork()).chainId);
  }
  const me = await deployer.getAddress();
  const local = chainId === 31337;
  const root = path.resolve(__dirname, "../..");
  const file = path.join(root, "deployments", `${chainId}.json`);
  const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;

  const base = chainId === 84532; // a block every 0.2 s: 20 blocks would be a four-second round
  const epochLength = BigInt(num("EPOCH_LENGTH", local ? 30 : base ? 600 : 20));
  const revealWindow = BigInt(num("REVEAL_WINDOW", base && !process.env.EPOCH_LENGTH ? 100 : Math.max(1, Math.floor(Number(epochLength) / 4))));
  const vaultFunds = eth("VAULT_FUNDS", ethers.parseEther(local ? "50" : "0.004"));
  const poolFunds = eth("POOL_FUNDS", ethers.parseEther(local ? "5" : "0.0005"));
  const policyStake = eth("POLICY_STAKE", V2_DEFAULTS.policyStake);
  const attackStake = eth("ATTACK_STAKE", V2_DEFAULTS.attackStake);
  const minBet = eth("MIN_BET", V2_DEFAULTS.minBet);
  const closeTip = eth("CLOSE_TIP", V2_DEFAULTS.closeTip);
  const mutationScale = num("MUTATION_SCALE", V2_DEFAULTS.mutationScale);
  const lambdaBench = num("LAMBDA_BENCH", V2_DEFAULTS.lambdaBench);
  const insiderRep = num("INSIDER_REP", V2_DEFAULTS.insiderRep);
  const genesis = pack(V2_GENESIS);

  console.log(`network ${network.name} (chain ${chainId}) deployer ${me}`);
  console.log(`balance ${ethers.formatEther(await ethers.provider.getBalance(me))} ETH`);
  console.log(`epoch ${epochLength} blocks, reveal window ${revealWindow}; vault ${ethers.formatEther(vaultFunds)} ETH, pool ${ethers.formatEther(poolFunds)} ETH`);
  console.log(
    `stakes: policy ${ethers.formatEther(policyStake)}, attack ${ethers.formatEther(attackStake)}, min bet ${ethers.formatEther(minBet)}, ` +
      `closer's tip ${ethers.formatEther(closeTip)} ETH; mutation ±${mutationScale}, insider reputation ${insiderRep}`,
  );

  const receipts: TransactionReceipt[] = [];
  const track = async <T extends { deploymentTransaction(): { wait(): Promise<TransactionReceipt | null> } | null }>(c: Promise<T>) => {
    const x = await c;
    receipts.push((await x.deploymentTransaction()!.wait())!);
    return x;
  };
  const send = async (tx: Promise<{ wait(): Promise<TransactionReceipt | null> }>) => receipts.push((await (await tx).wait())!);

  const lineage = await track(ethers.deployContract("Lineage", [], deployer));
  const firewall = await track(ethers.deployContract("Firewall", [], deployer));
  const arena = await track(
    ethers.deployContract(
      "Arena",
      [
        {
          firewall: await firewall.getAddress(),
          lineage: await lineage.getAddress(),
          epochLength,
          revealWindow,
          policyStake,
          attackStake,
          minBet,
          closeTip,
          mutationScale,
          genesisLo: genesis.lo,
          genesisHi: genesis.hi,
        },
        v2SeedAttackGenomes().map((a) => [a.lo, a.hi]),
      ],
      deployer,
    ),
  );
  const vault = await track(ethers.deployContract("Vault", [await firewall.getAddress(), await arena.getAddress(), 0], deployer));
  const crucible = await track(
    ethers.deployContract("Crucible", [await arena.getAddress(), await firewall.getAddress(), v2HonestBenchPacked(), lambdaBench, insiderRep], deployer),
  );
  const deployBlock = receipts[0].blockNumber;
  console.log("Lineage ", await lineage.getAddress());
  console.log("Firewall", await firewall.getAddress());
  console.log("Arena   ", await arena.getAddress());
  console.log("Vault   ", await vault.getAddress());
  console.log("Crucible", await crucible.getAddress());

  await send(firewall.setArena(await arena.getAddress()));
  await send(lineage.setWriter(await arena.getAddress()));
  await send(arena.setVault(await vault.getAddress()));
  await send(arena.setCrucible(await crucible.getAddress()));

  let identity = process.env.IDENTITY_REGISTRY || (previous?.chainId === chainId ? previous.contracts?.identityRegistry : "") || "";
  if (identity && (await ethers.provider.getCode(identity)) === "0x") identity = "";
  if (!identity) {
    const reg = await track(ethers.deployContract("MockIdentityRegistry", [], deployer));
    identity = await reg.getAddress();
    console.log("ERC-8004 identity registry (mock)", identity);
  } else console.log("ERC-8004 identity registry (reused)", identity);
  await send(vault.setIdentityRegistry(identity));

  const guard = await track(ethers.deployContract("PolicyGuard", [await firewall.getAddress()], deployer));
  console.log("PolicyGuard", await guard.getAddress());

  for (const r of (process.env.REGISTRARS || "").split(",").map((s) => s.trim()).filter(Boolean)) {
    await send(vault.setRegistrar(r, true));
    console.log("registrar", r);
  }
  for (const g of (process.env.GUARDIAN || "").split(",").map((s) => s.trim()).filter(Boolean)) {
    await send(vault.setGuardian(g, true));
    console.log("guardian (may veto held payments)", g);
  }

  if (vaultFunds > 0n) await send(vault.deposit({ value: vaultFunds }));
  if (poolFunds > 0n) await send(arena.fundPool({ value: poolFunds }));
  await send(arena.start());
  const startBlock = Number(await arena.epochStartBlock());

  const live = await firewall.exportGenome();
  if (live.lo !== genesis.lo || live.hi !== genesis.hi) throw new Error("the live genome is not the genesis policy");
  console.log(`started: epoch 1 at block ${startBlock}; live policy #${live.policyId} = genesis; attack pool ${(await arena.getAttackPool()).length}`);

  const gas = receipts.reduce((s, r) => s + r.gasUsed, 0n);
  console.log(`\n${receipts.length} transactions, ${gas} gas`);
  if (dry) {
    const price = forkGasPrice;
    let l1 = 0n;
    if (OP_STACK.has(chainId)) {
      const remote = new ethers.JsonRpcProvider(process.env.FORK_URL!);
      const oracle = new ethers.Contract(GAS_PRICE_ORACLE, ["function getL1Fee(bytes) view returns (uint256)"], remote);
      for (const r of receipts) {
        const tx = await ethers.provider.getTransaction(r.hash);
        // the signed transaction carries ~100 bytes more than its data; pad so the estimate errs high
        l1 += await oracle.getL1Fee(ethers.concat([tx!.data, ethers.toBeHex(0, 100)]));
      }
    }
    const fees = gas * price + l1;
    const total = fees + vaultFunds + poolFunds;
    console.log(`gas price ${ethers.formatUnits(price, "gwei")} gwei: L2 execution ${ethers.formatEther(gas * price)} ETH, L1 data ${ethers.formatEther(l1)} ETH`);
    console.log(`fees ${ethers.formatEther(fees)} ETH + vault ${ethers.formatEther(vaultFunds)} + pool ${ethers.formatEther(poolFunds)} = ${ethers.formatEther(total)} ETH needed`);
    if (realBalance >= 0n)
      console.log(`the deployer holds ${ethers.formatEther(realBalance)} ETH on the real chain: ${realBalance >= total ? "enough" : "NOT enough"}`);
    console.log("(DRY RUN: nothing was sent or written)");
    return;
  }

  const out = {
    chainId,
    network: network.name,
    explorer: EXPLORERS[chainId] ?? "",
    faucet: FAUCETS[chainId] ?? "",
    deployer: me,
    deployBlock,
    startBlock,
    epochLength: Number(epochLength),
    revealWindow: Number(revealWindow),
    contracts: {
      vault: await vault.getAddress(),
      firewall: await firewall.getAddress(),
      arena: await arena.getAddress(),
      lineage: await lineage.getAddress(),
      policyGuard: await guard.getAddress(),
      identityRegistry: identity,
      crucible: await crucible.getAddress(),
    },
    seedGenome: { genes: V2_GENESIS, lo: genesis.lo.toString(), hi: genesis.hi.toString() },
    version: 4,
    stakes: { policy: policyStake.toString(), attack: attackStake.toString(), minBet: minBet.toString(), closeTip: closeTip.toString() },
    closeGas: Number(await arena.CLOSE_GAS()),
    deployedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.join(root, "deployments"), { recursive: true });
  // keep the deployment this one replaces (a file without `version` counts as version 1)
  const prevVersion = previous ? Number(previous.version ?? 1) : 0;
  const kept = path.join(root, "deployments", `${chainId}.v${prevVersion}.json`);
  if (previous && prevVersion < 4 && !fs.existsSync(kept)) {
    fs.writeFileSync(kept, JSON.stringify(previous, null, 2));
    console.log(`kept the v${prevVersion} deployment as deployments/${chainId}.v${prevVersion}.json`);
  }
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  writeSdkDeployments(root);
  console.log(`wrote deployments/${chainId}.json and sdk/src/deployments.ts`);
}

/** Aggregate every deployments/<chainId>.json into sdk/src/deployments.ts so the arena bundles them. */
export function writeSdkDeployments(root: string) {
  const dir = path.join(root, "deployments");
  const all: Record<string, unknown> = {};
  for (const f of fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f))) {
    const d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    all[d.chainId] = d;
  }
  const ts =
    "// AUTO-GENERATED by contracts/scripts/deploy.ts — do not edit.\n" +
    "import type { Deployment } from \"./types\";\n\n" +
    `export const DEPLOYMENTS: Record<number, Deployment> = ${JSON.stringify(all, null, 2)};\n`;
  fs.writeFileSync(path.join(root, "sdk", "src", "deployments.ts"), ts);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
