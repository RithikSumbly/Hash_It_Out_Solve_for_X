import {
  encodePacked,
  keccak256,
  parseEventLogs,
  toHex,
  type Account,
  type Chain,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { agentProxyAbi, agentProxyBytecode, arenaAbi, crucibleAbi, firewallAbi, lineageAbi, vaultAbi } from "./abi";
import { decodeAttack, explain, pack, unpack, verdictOf, VERDICT, type AttackStep, type Explanation, type Genes, type Verdict } from "./genome";
import { decodeLog, holdsFromEvents } from "./events";
import type { Address, ArenaEvent, ArenaSnapshot, AttackView, Deployment, HeldPayment, Hex, HoldView, PolicyView, TxRecord } from "./types";
import { KIND, LABEL } from "./types";
import { PROPOSAL_VERDICTS } from "./v2";

// ---------------------------------------------------------------- commit-reveal bookkeeping

export interface LabelEntry {
  epoch: bigint;
  txId: bigint;
  label: number;
  salt: Hex;
  caller: Address;
  revealed: boolean;
}

/** Where an agent keeps its label salts between `spend()` and `reveal()`. */
export interface LabelStore {
  add(e: LabelEntry): void | Promise<void>;
  pending(caller: Address, epoch: bigint): LabelEntry[] | Promise<LabelEntry[]>;
  markRevealed(caller: Address, epoch: bigint, txIds: bigint[]): void | Promise<void>;
}

export class MemoryLabelStore implements LabelStore {
  entries: LabelEntry[] = [];
  add(e: LabelEntry) {
    this.entries.push(e);
  }
  pending(caller: Address, epoch: bigint) {
    return this.entries.filter((e) => !e.revealed && e.epoch === epoch && e.caller.toLowerCase() === caller.toLowerCase());
  }
  markRevealed(caller: Address, epoch: bigint, txIds: bigint[]) {
    for (const e of this.entries) {
      if (e.epoch === epoch && e.caller.toLowerCase() === caller.toLowerCase() && txIds.includes(e.txId)) e.revealed = true;
    }
  }
}

export function randomSalt(): Hex {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return toHex(b);
}

export function labelCommit(label: number, salt: Hex, caller: Address): Hex {
  return keccak256(encodePacked(["uint8", "bytes32", "address"], [label, salt, caller]));
}

/**
 * Gas limit with headroom. A Vault spend's cost grows with the shadow pool (every candidate scores it),
 * and the pool can grow between estimation and inclusion, so spends get a fixed pool-growth margin.
 */
export function gasWithHeadroom(estimate: bigint, functionName: string): bigint {
  const poolSensitive = functionName === "spend" || functionName === "act";
  const padded = estimate + estimate / 4n + (poolSensitive ? 350_000n : 60_000n);
  // never above the per-transaction gas cap (EIP-7825, 2^24): a node rejects the transaction outright
  return padded > MAX_TX_GAS ? (estimate > MAX_TX_GAS ? estimate : MAX_TX_GAS) : padded;
}

/** The per-transaction gas cap of the osaka hardfork (EIP-7825). */
export const MAX_TX_GAS = 16_777_216n;

export interface ProposalOutcome {
  hash: Hex;
  /** Crucible verdict: 0 accepted, 1 refuses an honest payment, 2 weaker than the live champion, 3 already, 4 pool full, 5 lets a drain canary through, 6 not monotone */
  verdict: number;
  verdictText: (typeof PROPOSAL_VERDICTS)[number];
  /** the policy's id in the Arena when accepted, else 0 */
  id: bigint;
  epoch: bigint;
  honestRefused: bigint;
  /** ppm of the vault the current attackers take from it on average */
  lost: bigint;
  /** sparring scores (ppm of the vault, <= 0): this policy's and the live champion's */
  fitness: bigint;
  championFitness: bigint;
}

// ---------------------------------------------------------------- results

export interface SpendOutcome {
  hash: Hex;
  /** 0 paid (the money moved), 1 held (it waits for its release block), 2 refused */
  verdict: Verdict;
  /** verdict === REFUSED (false on a hold) */
  refused: boolean;
  /** verdict === HELD */
  held: boolean;
  /** the policy's reason bits on a hold or a refusal, plus bits 16/17 for a hard limit */
  reason: bigint;
  score: bigint;
  epoch: bigint;
  txId: bigint;
  features: bigint;
  /** what the vault can still pay after it (held payments excluded) */
  balanceAfter: bigint;
  /** On a hold: its id (for `release` / `veto`) and the first block it may be released in */
  holdId?: bigint;
  releaseBlock?: bigint;
}

export interface Prediction extends Explanation {
  features: number[];
}

/** `Vault.previewSpend`, the live verdict for a payment before signing, hard limits included. */
export interface SpendPreview {
  verdict: Verdict;
  refused: boolean;
  held: boolean;
  reason: bigint;
  score: bigint;
  features: number[];
}

type AnyWallet = WalletClient<Transport, Chain | undefined, Account | undefined>;

export interface RedQueenOptions {
  deployment: Deployment;
  publicClient: PublicClient;
  walletClient?: AnyWallet;
  labels?: LabelStore;
}

/**
 * The Red Queen agent SDK. Everything an external AI agent needs to take part in the arena:
 * register (via a registrar), attack, defend (submit policies), bet, claim, and read state.
 *
 * ```ts
 * const rq = new RedQueen({ deployment, publicClient, walletClient });
 * await rq.submitAttack(encodeAttack(ATTACK_PRESETS.drain.steps));
 * const out = await rq.spend({ to: me, amount: parseEther("0.1"), label: "attack" });
 * console.log(out.refused ? decodeReason(out.reason) : "extracted");
 * ```
 */
export class RedQueen {
  readonly d: Deployment;
  readonly pub: PublicClient;
  readonly wallet?: AnyWallet;
  readonly labels: LabelStore;
  readonly vault: Address;
  readonly arena: Address;
  readonly firewall: Address;
  readonly lineage: Address;
  /** Present only on a deployment with a Crucible */
  readonly crucible?: Address;
  private stakeCache?: Promise<{ policy: bigint; attack: bigint; minBet: bigint }>;

  constructor(o: RedQueenOptions) {
    this.d = o.deployment;
    this.pub = o.publicClient;
    this.wallet = o.walletClient;
    this.labels = o.labels ?? new MemoryLabelStore();
    this.vault = o.deployment.contracts.vault as Address;
    this.arena = o.deployment.contracts.arena as Address;
    this.firewall = o.deployment.contracts.firewall as Address;
    this.lineage = o.deployment.contracts.lineage as Address;
    this.crucible = o.deployment.contracts.crucible as Address | undefined;
  }

  /** The stakes and the minimum bet: from the deployment file, else read once from the Arena. */
  stakes(): Promise<{ policy: bigint; attack: bigint; minBet: bigint }> {
    const s = this.d.stakes;
    if (s) return Promise.resolve({ policy: BigInt(s.policy), attack: BigInt(s.attack), minBet: BigInt(s.minBet) });
    return (this.stakeCache ??= Promise.all([
      this.read<bigint>(this.arena, arenaAbi, "POLICY_STAKE"),
      this.read<bigint>(this.arena, arenaAbi, "ATTACK_STAKE"),
      this.read<bigint>(this.arena, arenaAbi, "MIN_BET"),
    ]).then(([policy, attack, minBet]) => ({ policy, attack, minBet })));
  }

  get account(): Address {
    const a = this.wallet?.account?.address;
    if (!a) throw new Error("RedQueen: a walletClient with an account is required for writes");
    return a;
  }

  /**
   * Explicit EIP-1559 fees: twice the latest base fee plus the node's tip. Without them a browser wallet picks its
   * own, and it reserves gas limit × max fee up front: a wallet's first move in a round brings a 10M-gas limit (the
   * Arena's CLOSE_GAS), so a generous default fee can refuse a small test wallet outright. Unused fee is never
   * charged. Empty (the wallet decides) if the chain has no base fee or the read fails.
   */
  private async fees(): Promise<{ maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }> {
    try {
      const block = await this.pub.getBlock();
      if (block.baseFeePerGas == null) return {};
      const tip = await this.pub.estimateMaxPriorityFeePerGas().catch(() => 1_000_000n);
      return { maxFeePerGas: block.baseFeePerGas * 2n + tip, maxPriorityFeePerGas: tip };
    } catch {
      return {};
    }
  }

  private async write(address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[] = [], value?: bigint): Promise<Hex> {
    if (!this.wallet?.account) throw new Error("RedQueen: walletClient with account required");
    const walletChain = await this.wallet.getChainId().catch(() => this.d.chainId);
    if (walletChain !== this.d.chainId) throw new Error(`ChainMismatch: the wallet is on chain ${walletChain}, the arena on ${this.d.chainId}`);
    const est = await this.pub.estimateContractGas({
      address,
      abi: abi as never,
      functionName: functionName as never,
      args: args as never,
      value: value as never,
      account: this.wallet.account,
    } as never);
    const hash = await this.wallet.writeContract({
      address,
      abi: abi as never,
      functionName: functionName as never,
      args: args as never,
      value: value as never,
      gas: gasWithHeadroom(est, functionName),
      ...(await this.fees()),
      account: this.wallet.account,
      chain: this.wallet.chain ?? null,
    } as never);
    const rc = await this.pub.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") {
      // Re-run the call against the block it landed in to recover the custom error name.
      let why = "";
      try {
        await this.pub.simulateContract({
          address,
          abi: abi as never,
          functionName: functionName as never,
          args: args as never,
          value: value as never,
          account: this.wallet.account,
          blockNumber: rc.blockNumber,
        } as never);
      } catch (e) {
        const x = e as { cause?: { data?: { errorName?: string; args?: unknown[] } }; shortMessage?: string };
        why = x.cause?.data?.errorName ? `${x.cause.data.errorName}(${(x.cause.data.args ?? []).join(",")})` : (x.shortMessage ?? "");
      }
      if (!why) {
        const tx = await this.pub.getTransaction({ hash });
        if (rc.gasUsed >= (tx.gas * 98n) / 100n) why = `out of gas (limit ${tx.gas})`;
      }
      throw new Error(`${functionName} reverted${why ? `: ${why}` : ""} (${hash})`);
    }
    return hash;
  }

  private read<T>(address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[] = []): Promise<T> {
    return this.pub.readContract({ address, abi: abi as never, functionName: functionName as never, args: args as never } as never) as Promise<T>;
  }

  // ------------------------------------------------------------ reads

  epoch(): Promise<bigint> {
    return this.read<bigint>(this.arena, arenaAbi, "currentEpoch");
  }

  async status() {
    const r = await this.read<readonly bigint[]>(this.arena, arenaAbi, "status");
    const [epoch, startBlock, endBlock, revealBlock, txCount, poolSize, attackPoolSize, pot, bets] = r;
    return { epoch, startBlock, endBlock, revealBlock, txCount, poolSize, attackPoolSize, pot, bets };
  }

  /** The vault contract's ETH balance. held payments are still in it; `vaultAvailable()` is what it can pay. */
  vaultBalance(): Promise<bigint> {
    return this.pub.getBalance({ address: this.vault });
  }

  /** What the vault can pay right now (`Vault.balance()`; its balance minus held payments). Size payments on this. */
  vaultAvailable(): Promise<bigint> {
    return this.read<bigint>(this.vault, vaultAbi, "balance");
  }

  async liveGenome() {
    const [lo, hi, id, installCount] = await this.read<readonly [bigint, bigint, bigint, bigint]>(this.firewall, firewallAbi, "exportGenome");
    return { id, lo, hi, installCount, genes: unpack(lo, hi) };
  }

  async policy(id: bigint): Promise<PolicyView> {
    const p = await this.read<{
      lo: bigint;
      hi: bigint;
      parentA: bigint;
      parentB: bigint;
      root: bigint;
      generation: number;
      bornEpoch: number;
      submitter: Address;
      stake: bigint;
      alive: boolean;
      lastFitness: bigint;
    }>(this.arena, arenaAbi, "getPolicy", [id]);
    return { id, ...p, genes: unpack(p.lo, p.hi), generation: Number(p.generation), bornEpoch: Number(p.bornEpoch) };
  }

  async attack(id: bigint): Promise<AttackView> {
    const a = await this.read<{
      lo: bigint;
      hi: bigint;
      parentA: bigint;
      parentB: bigint;
      generation: number;
      bornEpoch: number;
      submitter: Address;
      alive: boolean;
      lastExtracted: bigint;
    }>(this.arena, arenaAbi, "getAttack", [id]);
    return { id, ...a, genes: unpack(a.lo, a.hi), generation: Number(a.generation), bornEpoch: Number(a.bornEpoch) };
  }

  async pool(): Promise<PolicyView[]> {
    const ids = await this.read<readonly bigint[]>(this.arena, arenaAbi, "getPool");
    return Promise.all(ids.map((id) => this.policy(id)));
  }

  async attackPool(): Promise<AttackView[]> {
    const ids = await this.read<readonly bigint[]>(this.arena, arenaAbi, "getAttackPool");
    return Promise.all(ids.map((id) => this.attack(id)));
  }

  isHonest(who: Address): Promise<boolean> {
    return this.read<boolean>(this.vault, vaultAbi, "isHonest", [who]);
  }

  hasAttack(who: Address): Promise<boolean> {
    return this.read<boolean>(this.arena, arenaAbi, "hasAttack", [who]);
  }

  claimable(who: Address): Promise<bigint> {
    return this.read<bigint>(this.arena, arenaAbi, "claimable", [who]);
  }

  ancestors(id: bigint): Promise<readonly bigint[]> {
    return this.read<readonly bigint[]>(this.lineage, lineageAbi, "ancestors", [id]);
  }

  /** The 8 features the vault would compute right now for this spend. */
  async features(caller: Address, to: Address, amount: bigint, origin: Address = caller): Promise<number[]> {
    const f = await this.read<readonly bigint[]>(this.vault, vaultAbi, "features", [caller, origin, to, amount]);
    return f.map(Number);
  }

  /**
   * Predict the live verdict for a spend before signing (same integer math as the chain), with the hard limits
   * read from the features. `previewSpend` asks the vault itself.
   */
  async predict(caller: Address, to: Address, amount: bigint, genes?: Genes, origin: Address = caller): Promise<Prediction> {
    const [f, g] = await Promise.all([this.features(caller, to, amount, origin), genes ? Promise.resolve(genes) : this.liveGenome().then((l) => l.genes)]);
    return { ...explain(g, f, true), features: f };
  }

  /** the vault's own preview of the live verdict (0 pay, 1 hold, 2 refuse), the hard limits included. */
  async previewSpend(caller: Address, to: Address, amount: bigint): Promise<SpendPreview> {
    const r = await this.read<readonly [boolean, bigint, bigint, readonly bigint[], number?]>(this.vault, vaultAbi, "previewSpend", [caller, to, amount]);
    const verdict = verdictOf({ verdict: r[4], refused: r[0] });
    return { verdict, refused: verdict === VERDICT.REFUSED, held: verdict === VERDICT.HELD, reason: r[1], score: r[2], features: r[3].map(Number) };
  }

  /** One logged payment of a round, with every candidate's verdict on it (the hold mask and the live verdict). */
  async getTx(epoch: bigint, i: bigint): Promise<TxRecord> {
    const t = await this.read<{
      caller: Address;
      amount: bigint;
      commit: Hex;
      shadowMask: number;
      liveRefused: boolean;
      label: number;
      holdMask?: number;
      liveVerdict?: number;
    }>(this.vault, vaultAbi, "getTx", [epoch, i]);
    return {
      caller: t.caller,
      amount: t.amount,
      commit: t.commit,
      shadowMask: Number(t.shadowMask),
      liveRefused: t.liveRefused,
      label: Number(t.label),
      holdMask: Number(t.holdMask ?? 0),
      liveVerdict: verdictOf({ verdict: t.liveVerdict, refused: t.liveRefused }),
    };
  }

  // ------------------------------------------------------------ held payments

  /** A held payment by id. */
  async getHeld(id: bigint): Promise<HeldPayment> {
    const h = await this.read<{
      from: Address;
      amount: bigint;
      to: Address;
      releaseBlock: bigint;
      kind: number;
      settled: boolean;
      origin: Address;
      epoch: bigint;
      txId: number | bigint;
    }>(this.vault, vaultAbi, "getHeld", [id]);
    return { ...h, kind: Number(h.kind), releaseBlock: BigInt(h.releaseBlock), epoch: BigInt(h.epoch), txId: BigInt(h.txId) };
  }

  /** How many payments have ever been held (ids run 0 .. heldCount - 1). */
  heldCount(): Promise<bigint> {
    return this.read<bigint>(this.vault, vaultAbi, "heldCount");
  }

  /** The sum of open held payments (reserved: the vault cannot pay it twice). */
  heldTotal(): Promise<bigint> {
    return this.read<bigint>(this.vault, vaultAbi, "heldTotal");
  }

  /** Whether the vault's owner appointed this wallet a guardian (allowed to veto held payments). */
  isGuardian(who: Address): Promise<boolean> {
    return this.read<boolean>(this.vault, vaultAbi, "isGuardian", [who]);
  }

  vaultOwner(): Promise<Address> {
    return this.read<Address>(this.vault, vaultAbi, "owner");
  }

  /** Whether a veto from this wallet would be accepted: the vault's owner or a guardian. */
  async canVeto(who: Address): Promise<boolean> {
    const [owner, guardian] = await Promise.all([this.vaultOwner(), this.isGuardian(who)]);
    return guardian || owner.toLowerCase() === who.toLowerCase();
  }

  /**
   * Every held payment, from the vault's Held / Released / Vetoed logs, newest first, each with its status at the
   * current block. `span` is the widest block range one getLogs call may cover on your RPC.
   */
  async holds(o: { fromBlock?: bigint; toBlock?: bigint; span?: bigint } = {}): Promise<HoldView[]> {
    const head = o.toBlock ?? (await this.pub.getBlockNumber());
    const span = o.span ?? 50_000n;
    const events: ArenaEvent[] = [];
    for (let from = o.fromBlock ?? BigInt(this.d.deployBlock); from <= head; from += span) {
      const to = from + span - 1n < head ? from + span - 1n : head;
      const logs = await this.pub.getLogs({ address: this.vault, fromBlock: from, toBlock: to });
      for (const l of logs) {
        const e = decodeLog(this.d, l);
        if (e && (e.name === "Held" || e.name === "Released" || e.name === "Vetoed")) events.push(e);
      }
    }
    return holdsFromEvents(events, head);
  }

  /** The hall of fame: past round-top attack plans the Crucible keeps sparring against. */
  async archive(): Promise<{ lo: bigint; hi: bigint; genes: Genes; steps: AttackStep[] }[]> {
    const [lo, hi] = await this.read<readonly [readonly bigint[], readonly bigint[]]>(this.requireCrucible(), crucibleAbi, "getArchive");
    return lo.map((l, i) => {
      const genes = unpack(l, hi[i]);
      return { lo: l, hi: hi[i], genes, steps: decodeAttack(genes) };
    });
  }

  archiveCount(): Promise<bigint> {
    return this.read<bigint>(this.requireCrucible(), crucibleAbi, "archiveCount");
  }

  /** Everything the arena header and panels need, in one call. */
  async snapshot(): Promise<ArenaSnapshot> {
    const [block, st, live, pool, attackPool, vaultBalance, totals, epochStartBalance, held, attackOutflow] = await Promise.all([
      this.pub.getBlock(),
      this.status(),
      this.liveGenome(),
      this.pool(),
      this.attackPool(),
      this.vaultBalance(),
      Promise.all([
        this.read<bigint>(this.vault, vaultAbi, "totalSpends"),
        this.read<bigint>(this.vault, vaultAbi, "totalRefused"),
        this.read<bigint>(this.vault, vaultAbi, "totalOutflow"),
      ]),
      this.read<bigint>(this.arena, arenaAbi, "epochStartBalance"),
      // what it can pay and what is held (a vault without holds fails these reads, which count as none)
      Promise.all([this.vaultAvailable(), this.heldTotal(), this.heldCount()]).catch(() => null),
      // the attackers' outflow this round (a vault without attacker limits has no such read)
      this.read<bigint>(this.vault, vaultAbi, "attackOutflow").catch(() => undefined),
    ]);
    const roots = [...new Set(pool.map((p) => p.root))];
    const stakes = await Promise.all(roots.map((r) => this.read<bigint>(this.arena, arenaAbi, "lineageStake", [st.epoch, r])));
    return {
      chainId: this.d.chainId,
      blockNumber: block.number!,
      timestamp: Number(block.timestamp),
      epoch: st.epoch,
      startBlock: st.startBlock,
      endBlock: st.endBlock,
      revealBlock: st.revealBlock,
      epochLength: this.d.epochLength,
      txCount: st.txCount,
      protocolPool: st.pot,
      betPool: st.bets,
      vaultBalance,
      vaultAvailable: held ? held[0] : vaultBalance,
      heldTotal: held ? held[1] : 0n,
      heldCount: held ? held[2] : 0n,
      attackOutflow,
      epochStartBalance,
      totalSpends: totals[0],
      totalRefused: totals[1],
      totalOutflow: totals[2],
      live,
      pool,
      attackPool,
      lineageStakes: roots.map((root, i) => ({ root, stake: stakes[i] })),
    };
  }

  // ------------------------------------------------------------ writes: traffic

  /**
   * Ask the vault to pay. The label ("honest" | "attack") is committed now and revealed later with `reveal()`.
   * Returns the on-chain verdict decoded from the Spend event: paid, held (with its hold id and release block), or
   * refused. Size `amount` on `vaultAvailable()`: a held payment's amount is reserved.
   */
  async spend(o: { to: Address; amount: bigint; kind?: number; label?: "honest" | "attack" }): Promise<SpendOutcome> {
    const label = o.label === "honest" ? LABEL.HONEST : LABEL.ATTACK;
    const salt = randomSalt();
    const commit = labelCommit(label, salt, this.account);
    const hash = await this.write(this.vault, vaultAbi, "spend", [o.to, o.amount, o.kind ?? KIND.PAY, commit]);
    const out = await this.outcome(hash);
    if (out.txId !== (1n << 256n) - 1n) await this.labels.add({ epoch: out.epoch, txId: out.txId, label, salt, caller: this.account, revealed: false });
    return out;
  }

  async outcome(hash: Hex): Promise<SpendOutcome> {
    const rc = await this.pub.getTransactionReceipt({ hash });
    const vaultLogs = rc.logs.filter((l) => l.address.toLowerCase() === this.vault.toLowerCase());
    const ev = parseEventLogs({ abi: vaultAbi, logs: vaultLogs, eventName: "Spend" })[0];
    if (!ev) throw new Error("no Spend event in receipt");
    const a = ev.args as unknown as {
      refused: boolean;
      reason: bigint;
      score: bigint;
      epoch: bigint;
      txId: bigint;
      features: bigint;
      balanceAfter: bigint;
      verdict?: number;
    };
    const verdict = verdictOf(a);
    const out: SpendOutcome = {
      hash,
      verdict,
      refused: verdict === VERDICT.REFUSED,
      held: verdict === VERDICT.HELD,
      reason: a.reason,
      score: a.score,
      epoch: a.epoch,
      txId: a.txId,
      features: a.features,
      balanceAfter: a.balanceAfter,
    };
    if (verdict === VERDICT.HELD) {
      const h = parseEventLogs({ abi: vaultAbi, logs: vaultLogs, eventName: "Held" })[0];
      if (h) {
        const ha = h.args as unknown as { id: bigint; releaseBlock: bigint };
        out.holdId = ha.id;
        out.releaseBlock = ha.releaseBlock;
      }
    }
    return out;
  }

  /** Reveal every pending label of this account for the current epoch (reveal window must be open). */
  async reveal(): Promise<Hex | null> {
    const epoch = await this.epoch();
    const pending = await this.labels.pending(this.account, epoch);
    if (pending.length === 0) return null;
    const hash = await this.write(this.vault, vaultAbi, "revealLabels", [
      pending.map((p) => p.txId),
      pending.map((p) => p.label),
      pending.map((p) => p.salt),
    ]);
    await this.labels.markRevealed(this.account, epoch, pending.map((p) => p.txId));
    return hash;
  }

  async revealOpen(): Promise<boolean> {
    const [opens, now] = await Promise.all([this.read<bigint>(this.arena, arenaAbi, "revealOpensAt"), this.pub.getBlockNumber()]);
    return now + 1n >= opens;
  }

  // ------------------------------------------------------------ writes: arena

  registerHonest(who: Address) {
    return this.write(this.vault, vaultAbi, "registerHonest", [who]);
  }

  async submitPolicy(genes: Genes) {
    const { lo, hi } = pack(genes);
    return this.write(this.arena, arenaAbi, "submitPolicyPacked", [lo, hi], (await this.stakes()).policy);
  }

  /**
   * Stake and file an attack plan. The attack pool holds at most 16 plans; if this round's pool is full the
   * Arena reverts `PoolFull`, and the wallet adopts the pool's first plan instead (same stake, same right to spend),
   * so a crowded round never locks a visitor out.
   */
  async submitAttack(genes: Genes) {
    const { lo, hi } = pack(genes);
    try {
      return await this.write(this.arena, arenaAbi, "submitAttackPacked", [lo, hi], (await this.stakes()).attack);
    } catch (e) {
      const x = e as { message?: string; cause?: { data?: { errorName?: string } } };
      if (x.cause?.data?.errorName !== "PoolFull" && !String(x.message ?? "").includes("PoolFull")) throw e;
      const [first] = await this.read<readonly bigint[]>(this.arena, arenaAbi, "getAttackPool");
      if (first === undefined) throw e;
      return this.adoptAttack(first);
    }
  }

  async adoptAttack(id: bigint) {
    return this.write(this.arena, arenaAbi, "adoptAttack", [id], (await this.stakes()).attack);
  }

  // ------------------------------------------------------------ proposals screened by the Crucible

  private requireCrucible(): Address {
    if (!this.crucible) throw new Error("RedQueen: this deployment has no Crucible (v1)");
    return this.crucible;
  }

  /**
   * Propose a policy (free apart from gas). The Crucible plays it against the current attack genomes and the honest
   * bench and records a verdict on chain; accepted policies enter the shadow pool without a stake and compete at the
   * next close. Closes an overdue epoch first (you are tipped).
   */
  async propose(genes: Genes): Promise<ProposalOutcome> {
    const { lo, hi } = pack(genes);
    const hash = await this.write(this.requireCrucible(), crucibleAbi, "propose", [lo, hi]);
    const rc = await this.pub.getTransactionReceipt({ hash });
    const ev = parseEventLogs({ abi: crucibleAbi, logs: rc.logs, eventName: "Proposed" })[0];
    if (!ev) throw new Error("no Proposed event in receipt");
    const a = ev.args as unknown as {
      id: bigint;
      epoch: bigint;
      verdict: number;
      honestRefused: bigint;
      lost: bigint;
      fitness: bigint;
      championFitness: bigint;
    };
    const verdict = Number(a.verdict);
    return { hash, verdict, verdictText: PROPOSAL_VERDICTS[verdict] ?? PROPOSAL_VERDICTS[0], id: a.id, epoch: a.epoch, honestRefused: a.honestRefused, lost: a.lost, fitness: a.fitness, championFitness: a.championFitness };
  }

  /**
   * Free preview of `propose`: the same numbers, nothing written. `verdict` is the Crucible's own answer
   * (`screenVerdict`: 0 would accept, else PROPOSAL_VERDICTS[verdict]); on a Crucible without it, it is worked out from the numbers.
   */
  async screen(genes: Genes) {
    const { lo, hi } = pack(genes);
    const [[fitness, honestRefused, lost, championFitness, perAttack], v3] = await Promise.all([
      this.read<readonly [bigint, bigint, bigint, bigint, readonly bigint[]]>(this.requireCrucible(), crucibleAbi, "screen", [lo, hi]),
      this.read<number>(this.requireCrucible(), crucibleAbi, "screenVerdict", [lo, hi]).then(Number, () => null),
    ]);
    const verdict = v3 ?? (honestRefused > 0n ? 1 : fitness < championFitness ? 2 : 0);
    return { fitness, honestRefused, lost, championFitness, perAttack, verdict, verdictText: PROPOSAL_VERDICTS[verdict] ?? PROPOSAL_VERDICTS[0], wouldPass: verdict === 0 };
  }

  placeBet(lineageRoot: bigint, value: bigint) {
    return this.write(this.arena, arenaAbi, "placeBet", [lineageRoot], value);
  }

  settleBet(epoch: bigint) {
    return this.write(this.arena, arenaAbi, "settleBet", [epoch]);
  }

  claim() {
    return this.write(this.arena, arenaAbi, "claim");
  }

  closeEpoch() {
    return this.write(this.arena, arenaAbi, "closeEpoch");
  }

  deposit(value: bigint) {
    return this.write(this.vault, vaultAbi, "deposit", [], value);
  }

  /** pay out a held payment once its release block has come. Anyone may; earlier it reverts `TooEarly`. */
  release(id: bigint) {
    return this.write(this.vault, vaultAbi, "release", [id]);
  }

  /** cancel a held payment; the money stays in the vault. Only the vault's owner or a guardian (else `NotGuardian`). */
  veto(id: bigint) {
    return this.write(this.vault, vaultAbi, "veto", [id]);
  }

  // ------------------------------------------------------------ agents (contract wallets)

  /** Deploy an AgentProxy owned by this account (for contract hops and delegate-then-drain). */
  async deployAgent(): Promise<Address> {
    if (!this.wallet?.account) throw new Error("walletClient required");
    const hash = await this.wallet.deployContract({
      abi: agentProxyAbi,
      bytecode: agentProxyBytecode,
      args: [this.account],
      account: this.wallet.account,
      chain: this.wallet.chain ?? null,
    } as never);
    const rc = await this.pub.waitForTransactionReceipt({ hash });
    if (!rc.contractAddress) throw new Error("agent deploy failed");
    return rc.contractAddress as Address;
  }

  /** Spend from the vault through an agent contract (call depth f5 = 1000). Labels are always "attack". */
  async agentSpend(agent: Address, o: { to: Address; amount: bigint; kind?: number }): Promise<SpendOutcome> {
    const commit = labelCommit(LABEL.ATTACK, randomSalt(), agent);
    const hash = await this.write(agent, agentProxyAbi, "act", [this.vault, o.to, o.amount, o.kind ?? KIND.PAY, commit]);
    return this.outcome(hash);
  }
}
