/**
 * A wallet or contract error as one plain sentence for the visitor: the contracts'
 * custom errors and the wallet's usual complaints, instead of `EpochSaturated()` or a viem stack.
 */
const PLAIN: [RegExp, string][] = [
  [/User rejected|User denied|rejected the request/i, "You cancelled it in your wallet."],
  [/insufficient funds|exceeds the balance/i, "This wallet doesn't hold enough test ETH for that, gas included."],
  [/chain mismatch|does not match the target chain|wrong network|ChainMismatch|walletClient with account required/i, "Switch your wallet to Base Sepolia first."],
  [/EpochSaturated/, "This round's log is full. It closes within a couple of minutes; try again then."],
  [/CallerSaturated/, "This wallet has asked the vault 16 times this round, the most one wallet may. Try again next round."],
  [/HardLimit/, "Refused by the contract: this wallet already asked for more than the hard cap once this round. Ask for less, or wait for the next round."],
  [/PayToVault/, "The vault can't pay itself. Choose another recipient."],
  [/NeedGas/, "Your wallet sent too little gas for closing the round. Send it again; it will use more."],
  [/NotParticipant/, "Stake for this round first: attacks need a plan filed with the arena."],
  [/AlreadySubmitted/, "You've already filed a plan this round."],
  [/PoolFull/, "The pool is full this round. It reopens at the close."],
  [/AlreadyBet/, "You've already bet this round."],
  [/BetTooSmall/, "That bet is under the minimum."],
  [/UnknownLineage/, "That bloodline isn't in the pool any more."],
  [/EpochOpen/, "That round hasn't closed yet."],
  [/NothingToClaim/, "There's nothing to claim yet."],
  [/NoBet/, "No bet of yours to settle there."],
  [/BadStake/, "The stake amount doesn't match the arena's."],
  [/NotStarted/, "The arena hasn't started yet."],
  [/NotRegistrar/, "Only a registrar the vault's admin appointed can allow a wallet."],
  [/NotGuardian/, "Refused by the contract: only the vault's owner or a guardian they appointed can veto a held payment."],
  [/TooEarly/, "Refused by the contract: a held payment can be released only once its wait is over."],
  [/AlreadySettled/, "That held payment has already been released or vetoed."],
  [/Screened/, "The Crucible refused that policy at the door: it failed the same screen as a free proposal."],
  [/BettingClosed/, "Betting has closed for this round: the labels are being revealed."],
  [/AlreadyDelegated/, "That agent already acts for another wallet; only it or that wallet can release it."],
];

export function plainError(e: unknown, max = 110): string {
  const x = e as { shortMessage?: string; message?: string; cause?: { data?: { errorName?: string } } };
  const text = [x?.cause?.data?.errorName, x?.shortMessage, x?.message].filter(Boolean).join(" ");
  for (const [re, said] of PLAIN) if (re.test(text)) return said;
  return (x?.shortMessage ?? x?.message ?? String(e)).slice(0, max);
}
