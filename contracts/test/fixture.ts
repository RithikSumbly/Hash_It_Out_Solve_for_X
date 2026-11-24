import { ethers } from "hardhat";
import { mine } from "@nomicfoundation/hardhat-network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { ContractTransactionResponse, Log } from "ethers";
import type { Arena, Crucible, Firewall, Lineage, Vault } from "../typechain-types";
import { pack, policyGenes, zeroGenes, type Genes } from "../../sdk/src/genome";
import { V2_DEFAULTS, V2_GENESIS, v2HonestBenchPacked, v2SeedAttackGenomes } from "../../sdk/src/v2";

export const EPOCH = 20n;
export const REVEAL = 5n;
export const POLICY_STAKE = ethers.parseEther("0.02");
export const ATTACK_STAKE = ethers.parseEther("0.01");
export const MIN_BET = ethers.parseEther("0.005");
export const VAULT_FUNDS = ethers.parseEther("10");

export const HONEST = 1;
export const ATTACK = 2;

export interface World {
  lineage: Lineage;
  firewall: Firewall;
  arena: Arena;
  vault: Vault;
  owner: HardhatEthersSigner;
  signers: HardhatEthersSigner[];
}

/** Arena constructor config with the original constants (stakes 0.02 / 0.01, min bet 0.005, no tip,
 *  ±64 mutations, all-zero genesis). */
export function v1Config(firewall: string, lineage: string, epochLength: bigint | number, revealWindow: bigint | number) {
  return {
    firewall,
    lineage,
    epochLength,
    revealWindow,
    policyStake: POLICY_STAKE,
    attackStake: ATTACK_STAKE,
    minBet: MIN_BET,
    closeTip: 0n,
    mutationScale: 64n,
    genesisLo: 0n,
    genesisHi: 0n,
  };
}

/** An arena with the original constants, all-zero genesis and no Crucible. */
export async function deployWorld(opts: { epoch?: bigint; reveal?: bigint; funds?: bigint; start?: boolean } = {}): Promise<World> {
  const [owner, ...signers] = await ethers.getSigners();
  const lineage = await ethers.deployContract("Lineage");
  const firewall = await ethers.deployContract("Firewall");
  const arena = await ethers.deployContract("Arena", [
    v1Config(await firewall.getAddress(), await lineage.getAddress(), opts.epoch ?? EPOCH, opts.reveal ?? REVEAL),
    [],
  ]);
  const vault = await ethers.deployContract("Vault", [await firewall.getAddress(), await arena.getAddress(), 0]);
  await firewall.setArena(await arena.getAddress());
  await lineage.setWriter(await arena.getAddress());
  await arena.setVault(await vault.getAddress());
  await vault.deposit({ value: opts.funds ?? VAULT_FUNDS });
  if (opts.start !== false) await arena.start();
  return { lineage, firewall, arena, vault, owner, signers };
}

export interface V2World extends World {
  crucible: Crucible;
}

/** The arena exactly as contracts/scripts/deploy.ts deploys it (sdk/src/v2.ts), at test scale. */
export async function deployV2World(
  opts: {
    epoch?: bigint;
    reveal?: bigint;
    funds?: bigint;
    pool?: bigint;
    crucible?: boolean;
    insiderRep?: number;
    mutationScale?: number;
    closeTip?: bigint;
    genesis?: Genes;
    seedAttacks?: { lo: bigint; hi: bigint }[];
  } = {},
): Promise<V2World> {
  const [owner, ...signers] = await ethers.getSigners();
  const lineage = await ethers.deployContract("Lineage");
  const firewall = await ethers.deployContract("Firewall");
  const g = pack(opts.genesis ?? V2_GENESIS);
  const seeds = opts.seedAttacks ?? v2SeedAttackGenomes();
  const arena = await ethers.deployContract("Arena", [
    {
      firewall: await firewall.getAddress(),
      lineage: await lineage.getAddress(),
      epochLength: opts.epoch ?? EPOCH,
      revealWindow: opts.reveal ?? REVEAL,
      policyStake: V2_DEFAULTS.policyStake,
      attackStake: V2_DEFAULTS.attackStake,
      minBet: V2_DEFAULTS.minBet,
      closeTip: opts.closeTip ?? V2_DEFAULTS.closeTip,
      mutationScale: BigInt(opts.mutationScale ?? V2_DEFAULTS.mutationScale),
      genesisLo: g.lo,
      genesisHi: g.hi,
    },
    seeds.map((s) => [s.lo, s.hi]),
  ]);
  const vault = await ethers.deployContract("Vault", [await firewall.getAddress(), await arena.getAddress(), 0]);
  const crucible = await ethers.deployContract("Crucible", [
    await arena.getAddress(),
    await firewall.getAddress(),
    v2HonestBenchPacked(),
    V2_DEFAULTS.lambdaBench,
    opts.insiderRep ?? V2_DEFAULTS.insiderRep,
  ]);
  await firewall.setArena(await arena.getAddress());
  await lineage.setWriter(await arena.getAddress());
  await arena.setVault(await vault.getAddress());
  if (opts.crucible !== false) await arena.setCrucible(await crucible.getAddress());
  await vault.deposit({ value: opts.funds ?? VAULT_FUNDS });
  await arena.fundPool({ value: opts.pool ?? ethers.parseEther("0.5") });
  await arena.start();
  return { lineage, firewall, arena, vault, crucible, owner, signers };
}

export function genome(g: Genes): [number[]] {
  return [g];
}

/** Refuses everything: interaction k0 (f0,f1) with thresholds 0 always fires with weight 600*1000 > threshold. */
export const REFUSE_ALL = policyGenes({ interactions: { 0: 600 }, thresholds: { 0: 0, 1: 0 } });
/** Refuses spends above 25% of the vault (f0 > 250). */
export const AMOUNT_CAP = policyGenes({ weights: { 0: 2000 } });
/** Refuses spends above 50% of the vault. */
export const LOOSE_CAP = policyGenes({ weights: { 0: 1000 } });
export const ZERO = zeroGenes();

export function packed(g: Genes) {
  return pack(g);
}

export function salt(n: number | string): string {
  return ethers.zeroPadValue(ethers.toBeHex(BigInt(ethers.id(String(n)))), 32);
}

export function commitFor(label: number, s: string, who: string): string {
  return ethers.solidityPackedKeccak256(["uint8", "bytes32", "address"], [label, s, who]);
}

export interface SpendResult {
  txId: bigint;
  refused: boolean;
  reason: bigint;
  score: bigint;
  salt: string;
  label: number;
  features: bigint;
  shadowMask: number;
  /** 0 paid, 1 held, 2 refused */
  verdict: number;
  /** bit j = pool slot j would hold it */
  holdMask: number;
  /** The Held entry's id when it was held */
  heldId?: bigint;
}

let saltCounter = 0;

export async function doSpend(
  w: World,
  who: HardhatEthersSigner,
  to: string,
  amount: bigint,
  label = HONEST,
  kind = 0,
): Promise<SpendResult> {
  const s = salt(`s${saltCounter++}`);
  const tx = await w.vault.connect(who).spend(to, amount, kind, commitFor(label, s, who.address));
  const rc = await tx.wait();
  const parsed = rc!.logs.map((l: Log) => w.vault.interface.parseLog(l)).filter(Boolean);
  const ev = parsed.find((e) => e!.name === "Spend")!;
  const sh = parsed.find((e) => e!.name === "ShadowScored");
  const hd = parsed.find((e) => e!.name === "Held");
  return {
    txId: ev.args.txId,
    refused: ev.args.refused,
    reason: ev.args.reason,
    score: ev.args.score,
    salt: s,
    label,
    features: ev.args.features,
    shadowMask: sh ? Number(sh.args.shadowMask) : 0,
    verdict: Number(ev.args.verdict),
    holdMask: sh ? Number(sh.args.holdMask) : 0,
    heldId: hd ? hd.args.id : undefined,
  };
}

export async function toReveal(w: World) {
  const opens = await w.arena.revealOpensAt();
  const now = BigInt(await ethers.provider.getBlockNumber());
  if (now + 1n < opens) await mine(opens - now - 1n);
}

export async function toEpochEnd(w: World) {
  const end = await w.arena.epochEndBlock();
  const now = BigInt(await ethers.provider.getBlockNumber());
  if (now + 1n < end) await mine(end - now - 1n);
}

export async function reveal(w: World, who: HardhatEthersSigner, results: SpendResult[]) {
  return w.vault.connect(who).revealLabels(
    results.map((r) => r.txId),
    results.map((r) => r.label),
    results.map((r) => r.salt),
  );
}

export async function eventsOf(tx: ContractTransactionResponse, iface: { parseLog(l: Log): any }, name: string) {
  const rc = await tx.wait();
  return rc!.logs
    .map((l: Log) => {
      try {
        return iface.parseLog(l);
      } catch {
        return null;
      }
    })
    .filter((e: any) => e && e.name === name);
}

export function unpackFeatures(p: bigint): number[] {
  const f: number[] = [];
  for (let i = 0; i < 8; i++) f.push(Number((p >> BigInt(16 * i)) & 0xffffn));
  return f;
}

/**
 * One wallet may log at most Vault.MAX_TX_PER_CALLER requests a round, so filling a round's log
 * takes many wallets. Fills the current round's log up to `target` entries with 1-wei withdrawals from fresh wallets
 * registered as honest (funded by the owner), MAX_TX_PER_CALLER each.
 */
export async function fillLog(w: World, target: number, to?: (i: number) => string) {
  const per = Number(await w.vault.MAX_TX_PER_CALLER());
  const e = await w.arena.currentEpoch();
  let i = 0;
  while (Number(await w.vault.epochTxCount(e)) < target) {
    const wallet = ethers.Wallet.createRandom().connect(ethers.provider);
    await (await w.owner.sendTransaction({ to: wallet.address, value: ethers.parseEther("1") })).wait();
    await (await w.vault.registerHonest(wallet.address)).wait();
    for (let k = 0; k < per && Number(await w.vault.epochTxCount(e)) < target; k++, i++) {
      const dest = to ? to(i) : wallet.address;
      await (await w.vault.connect(wallet).spend(dest, 1n, dest === wallet.address ? 1 : 0, ethers.ZeroHash)).wait();
    }
  }
}
