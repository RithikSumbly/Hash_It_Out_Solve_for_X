export type Address = `0x${string}`;
export type Hex = `0x${string}`;

export interface Deployment {
  chainId: number;
  network: string;
  explorer: string;
  faucet: string;
  deployer: Address | string;
  deployBlock: number;
  startBlock: number;
  epochLength: number;
  revealWindow: number;
  contracts: {
    vault: Address | string;
    firewall: Address | string;
    arena: Address | string;
    lineage: Address | string;
    policyGuard: Address | string;
    identityRegistry: Address | string;
    /** the sparring ring and proposal screen */
    crucible?: Address | string;
  };
  /** the genesis policy, live from the first block */
  seedGenome?: { genes: number[]; lo: string; hi: string };
  /** the contract generation: 2 adds the Crucible, 3 adds three verdicts, holds and hard limits; absent on the first deployments */
  version?: number;
  /** the deploy-time economics, in wei (decimal strings) */
  stakes?: { policy: string; attack: string; minBet: string; closeTip: string };
  /** Arena.CLOSE_GAS, the gas a transaction that may close an overdue epoch must bring */
  closeGas?: number;
  deployedAt: string;
}

export type ContractName = "vault" | "firewall" | "arena" | "lineage" | "crucible";

/** A decoded contract event, as streamed by the relay and consumed by the arena. */
export interface ArenaEvent {
  id: string; // `${blockNumber}-${logIndex}`
  name: string;
  contract: ContractName;
  args: Record<string, unknown>;
  blockNumber: bigint;
  logIndex: number;
  txHash: Hex;
  timestamp: number; // unix seconds
  replay?: boolean;
}

export interface PolicyView {
  id: bigint;
  lo: bigint;
  hi: bigint;
  genes: number[];
  parentA: bigint;
  parentB: bigint;
  root: bigint;
  generation: number;
  bornEpoch: number;
  submitter: Address;
  stake: bigint;
  alive: boolean;
  lastFitness: bigint;
}

export interface AttackView {
  id: bigint;
  lo: bigint;
  hi: bigint;
  genes: number[];
  parentA: bigint;
  parentB: bigint;
  generation: number;
  bornEpoch: number;
  submitter: Address;
  alive: boolean;
  lastExtracted: bigint;
}

export interface ArenaSnapshot {
  chainId: number;
  blockNumber: bigint;
  timestamp: number;
  epoch: bigint;
  startBlock: bigint;
  endBlock: bigint;
  revealBlock: bigint;
  epochLength: number;
  txCount: bigint;
  protocolPool: bigint;
  betPool: bigint;
  /** the vault contract's ETH balance (held payments included) */
  vaultBalance: bigint;
  /** what the vault can still pay (`Vault.balance()`: its balance minus held payments); equals vaultBalance when there are no holds */
  vaultAvailable?: bigint;
  /** the sum of open held payments, and how many holds there have ever been (0n on a deployment without holds) */
  heldTotal?: bigint;
  heldCount?: bigint;
  /** what attackers have taken this round (`Vault.attackOutflow()`, capped at 20% of the round's start); absent
   *  on a deployment without attacker limits */
  attackOutflow?: bigint;
  epochStartBalance: bigint;
  totalSpends: bigint;
  totalRefused: bigint;
  totalOutflow: bigint;
  live: { id: bigint; lo: bigint; hi: bigint; genes: number[]; installCount: bigint };
  pool: PolicyView[];
  attackPool: AttackView[];
  lineageStakes: { root: bigint; stake: bigint }[];
}

/** a held payment as `Vault.getHeld(id)` returns it. */
export interface HeldPayment {
  from: Address;
  amount: bigint;
  to: Address;
  releaseBlock: bigint;
  kind: number;
  settled: boolean;
  /** the transaction's sender when it was held (attributes an agent's spend to its owner) */
  origin: Address;
  epoch: bigint;
  txId: bigint;
}

/** where a held payment stands. "waiting" until its release block, then "releasable" until someone settles it. */
export type HoldStatus = "waiting" | "releasable" | "released" | "vetoed";

/** a held payment, read from the Held / Released / Vetoed logs. */
export interface HoldView {
  id: bigint;
  from: Address;
  to: Address;
  amount: bigint;
  releaseBlock: bigint;
  epoch: bigint;
  txId: bigint;
  status: HoldStatus;
  /** who released or vetoed it */
  by?: Address;
  /** the transaction that held it, and the one that settled it */
  heldTx: Hex;
  heldBlock: bigint;
  settledTx?: Hex;
  settledBlock?: bigint;
}

/** one logged payment as `Vault.getTx(epoch, i)` returns it. */
export interface TxRecord {
  caller: Address;
  amount: bigint;
  commit: Hex;
  /** bit j = pool slot j would refuse it */
  shadowMask: number;
  liveRefused: boolean;
  label: number;
  /** bit j = pool slot j would hold it */
  holdMask: number;
  /** 0 paid, 1 held, 2 refused */
  liveVerdict: number;
}

/** the blocks a held payment waits before anyone may release it (Vault.HOLD_DELAY; about a minute on Base). */
export const HOLD_DELAY = 300;

export const KIND = { PAY: 0, WITHDRAW: 1, DELEGATE: 2 } as const;
export const LABEL = { NONE: 0, HONEST: 1, ATTACK: 2 } as const;
