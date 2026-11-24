# Red Queen: the problem, the landscape and our approach

This document explains what Red Queen is for, the evidence behind the problem it addresses, how existing defences
work, and the research that shaped its design. Every external claim links to its source.

## In one paragraph

Red Queen is a vault that decides, inside a smart contract, whether each payment request is paid, held for a minute or
refused, and records every decision on chain. The rule that decides is not written once and left alone: every round a
public tournament on chain grades competing rules against real traffic and stored attacks, breeds the best and installs
a new champion when one clearly wins. Attacks evolve too. The result is a spending rule that keeps getting tested and
improved in the open, under hard limits that no evolved rule can lift, with every version and every verdict verifiable
by anyone.

**Who it is for:** the team responsible for an AI agent's money, or any treasury that lets software spend on its
behalf. **The task it serves:** a payment request that gets a verdict anyone can check, from a rule nobody can quietly
change.

---

## 1. The problem: software that can be talked into paying

AI agents now hold wallets and pay on their own. Coinbase launched AgentKit in November 2024
([Cointelegraph](https://cointelegraph.com/news/coinbase-launches-crypto-wallets-built-ai-agents)) and Agentic Wallets,
with programmable spending limits and session caps, on 11 February 2026
([The Block](https://www.theblock.co/post/389524/coinbase-rolls-out-ai-tool-to-give-any-agent-a-wallet)). The x402
agent payment protocol passed 138 million transactions by Q3 2026
([Decrypt](https://decrypt.co/380989/ai-agents-138-million-crypto-payments-one-year)).

Agents that sign transactions have already been manipulated into paying out:

| Incident | What happened | Loss |
|---|---|---|
| **Freysa**, Nov 2024 | A public game: 195 players made 482 attempts to convince an agent to release funds; the winner reframed its transfer function as a way to accept deposits ([The Block](https://www.theblock.co/post/328747/human-player-outwits-freysa-ai-agent-in-47000-crypto-challenge)) | $47,316 prize pool |
| **AIXBT**, Mar 2025 | An attacker reached an internal dashboard and queued malicious replies into the agent's autonomous tipping pipeline ([Decrypt](https://decrypt.co/310510/aixbt-ai-influencer-hacked-100k-ethereum)) | 55.5 ETH, about $105,000 |
| **Lobstar Wilde**, Feb 2026 | Asked for 4 SOL, a trading bot sent its entire holding of its own token ([The Block](https://www.theblock.co/post/390722/ai-agent-created-by-openai-dev-accidentally-sends-entire-memecoin-holdings-to-reply-guy)) | About 53M tokens, worth about $250,000 when sent |
| **Grok and Bankrbot**, May 2026 | A Morse-coded post led Grok to instruct Bankrbot to transfer tokens from Grok's wallet ([CryptoSlate](https://cryptoslate.com/how-one-trader-exploited-grok-and-morse-code-to-trick-ai-agent-into-sending-billions-of-crypto-tokens-from-a-verified-wallet/); [Giskard](https://www.giskard.ai/knowledge/how-grok-got-prompt-injected-an-x-user-drained-150-000-from-an-ai-wallet)) | About $150,000 to $200,000, about 80% later returned |

Two lessons from these incidents shaped Red Queen:

- **The rule must live outside the model.** Freysa's "never pay" rule lived only in its prompt. After Grok and
  Bankrbot, analysts recommended spend limits and recipient rules enforced in code, treating model output as untrusted
  ([CryptoSlate](https://cryptoslate.com/how-one-trader-exploited-grok-and-morse-code-to-trick-ai-agent-into-sending-billions-of-crypto-tokens-from-a-verified-wallet/);
  [Cointelegraph Magazine](https://cointelegraph.com/magazine/grok-bankr-wallet-free-nft-prompt-injection)). Red
  Queen's rule is enforced by the vault contract, whatever the agent says.
- **Rules regress unless they are re-tested.** Bankr had once hard-coded a block on Grok's replies to stop one model
  injecting another; that protection was dropped in a rewrite
  ([CryptoSlate](https://cryptoslate.com/how-one-trader-exploited-grok-and-morse-code-to-trick-ai-agent-into-sending-billions-of-crypto-tokens-from-a-verified-wallet/)).
  Red Queen re-tests the live rule against stored attacks every round, in public.

**The lab evidence is stronger still.** CrAIBench (Princeton and the Sentient Foundation), a benchmark of more than 150
blockchain tasks and 500 attack cases, found memory injection beat prompt injection on every model tested; the most
advanced reasoning model still followed injected memories 55.1% of the time
([arXiv 2503.16248](https://arxiv.org/html/2503.16248v3)). Off-the-shelf filters missed about half of malicious memory
updates, and defences written into the prompt stopped about 30% of attacks (same source). Outside crypto, StakeBench
measured direct prompt injection succeeding more than 79% of the time against browser agents
([Decrypt](https://decrypt.co/370972/ai-agents-prompt-injection-attacks-research)). And attackers are getting cheaper:
in Anthropic's SCONE-bench simulation, AI exploit revenue on 2025 problems doubled roughly every 1.3 months
([Anthropic](https://www.anthropic.com/research/smart-contracts)).

**The wider theft picture** shows what the techniques that will meet agent wallets already take from people: $83.85M
lost to wallet drainers in 2025 ([Scam Sniffer](https://drops.scamsniffer.io/scam-sniffer-2025-crypto-phishing-losses-fall-83-to-84-million/))
and more than $3.4B in total crypto theft that year ([The Block](https://www.theblock.co/post/382477/crypto-hack-2025-chainalysis)).
Agent wallets are a new kind of signer facing the same signature tricks, impersonation and urgency, and the lab results
show they are easier to deceive persistently.

---

## 2. How payments are defended today

Every shipping defence takes one of two shapes: the rule is fixed in advance and enforced on chain, or a vendor adapts
it where nobody outside can check.

| Family | Examples | Where the rule is enforced | Does it adapt? | Can outsiders verify changes? |
|---|---|---|---|---|
| Caps and session keys on chain | ERC-7715 ([EIP](https://eips.ethereum.org/EIPS/eip-7715)), MetaMask Advanced Permissions ([MetaMask](https://metamask.com/news/introducing-advanced-permissions)), ZeroDev ([docs](https://docs.zerodev.app/sdk/permissions/intro)), Coinbase Spend Permissions ([docs](https://docs.cdp.coinbase.com/wallets/using-wallets/spend-permissions)), Safe and Zodiac Roles ([Safe](https://docs.safe.global/advanced/smart-account-modules)) | Contracts | No | Yes |
| Vendor policy engines | Coinbase CDP policies ([docs](https://docs.cdp.coinbase.com/server-wallets/v2/using-the-wallet-api/policies/overview)), Privy ([docs](https://docs.privy.io/controls/policies/overview)), Turnkey ([docs](https://docs.turnkey.com/concepts/policies/overview)), Fireblocks ([site](https://www.fireblocks.com/platforms/governance-policy-engine)) | Vendor's enclave, at signing | No | No |
| Scored off chain, enforced on chain | Forta Firewall ([docs](https://docs.forta.network/en/latest/what-is-forta-firewall/)), Hypernative Guardian ([site](https://www.hypernative.io/products/hypernative-guardian)), Venn ([docs](https://docs.venn.build/venn-network/detection-performance-internal.md)) | Attestation, guard or sequencer | Yes, by the vendor | No |
| Advisory scanners | Blockaid in MetaMask ([MetaMask](https://support.metamask.com/configure/wallet/security-alerts/)) | A warning in the wallet | Yes, by the vendor | No |
| Public fixed assertions | Phylax Credible Layer ([Linea](https://linea.build/blog/linea-stack-and-mainnet-add-phlyax-credible-layer-onchain-safety)), ERC-7265 circuit breakers ([Ethereum Magicians](https://ethereum-magicians.org/t/eip-7265-circuit-breaker-standard/14909)) | Sequencer or contract | Only when someone writes a new rule | Yes |
| **Red Queen** | Vault, Arena, Crucible | The vault contract | **Yes, every round** | **Yes, every version and every verdict** |

What the families share:

- **Fixed rules are transparent but static.** A public fixed rule whose inputs attackers control can be studied once
  and evaded by shaping those inputs. Targeted changes to a few features dropped one Ethereum phishing classifier's
  accuracy from 96.34% to 1.31% ([arXiv 2408.03441](https://arxiv.org/html/2408.03441v1)).
- **Adaptive systems are opaque.** Forta's risk model is fine-tuned regularly off chain, and an OpenZeppelin audit
  describes its trusted-attester registry as centralized and upgradeable
  ([OpenZeppelin](https://www.openzeppelin.com/news/forta-firewall-incremental-audit)). Users must trust self-reported
  accuracy figures.
- **Delays beat hard blocks for borderline cases.** Base rates make hard-blocking every flag costly: Venn flagged about
  0.08% of 3.1 million transactions to catch 63 hacks ([Venn](https://docs.venn.build/venn-network/detection-performance-internal.md)).
  The pattern that recurs is a delay with an escape hatch: Forta delays high-risk transactions, Venn and Hypernative
  put bypasses behind timelocks ([Venn](https://docs.venn.build/venn-network/getting-started/safe-guard/bypass-mechanism.md);
  [Hypernative](https://www.hypernative.io/products/hypernative-guardian)).
- **Humans are too slow to be the only line.** Euler's $197M drain moved faster than a multisig could pause the
  contract, although alerts fired minutes ahead ([Forta](https://forta.org/blog/detecting-a-197-million-hack-before-exploitation-euler-finance-hack-retrospective)).

**The gap Red Queen fills:** a rule that adapts like the vendor systems, enforced and audited like the on-chain ones.
The rule changes only through a public, mechanical tournament, and every version and every verdict is on chain.

---

## 3. Research foundations of the design

Red Queen borrows directly from work on co-evolution in security and from the design patterns that production
defences converged on.

### Co-evolution as a permanent red team

Evolved attackers that treat a detector as a black box and learn to look normal are an effective way to find a fixed
detector's holes ([Kayacik et al. 2011](https://gpbib.cs.ucl.ac.uk/gp-html/Kayacik_2011_EI.html)). MIT's RIVALS
framework models cyber arms races in explicitly "Red Queen" terms, with attackers and defenders co-evolving
([O'Reilly et al.](https://ar5iv.arxiv.org/html/2004.04647)). Red Queen runs that arms race live: attack plans are
genomes that are staked, graded and bred against the defence, so the defence always has a fresh adversary.

### Remembering old opponents

Co-evolution has well-documented failure modes: disengagement, cycling, focusing on some opponents, and forgetting a
defence once its attack disappears ([O'Reilly et al.](https://ar5iv.arxiv.org/html/2004.04647)). The standard remedy is
an archive of past opponents: Rosin and Belew's "hall of fame" keeps the best attacker of each generation in the test
set ([review, arXiv 1506.05082](https://ar5iv.labs.arxiv.org/html/1506.05082)). Red Queen's Crucible keeps a hall of
fame of recent round-topping attack plans and plays every candidate against it each round, alongside fixed drain
canaries that every policy must refuse forever.

### A floor under the learned rule

Because a learned rule can drift, Red Queen puts limits underneath it that hold even when the rule is known: no
payment over half the vault, no round's outflow over half its starting balance, and tighter caps for staked attackers
(10% a payment, 20% a round). The monotone rule guarantees a larger payment never scores lower. Evolution can only be
stricter than this floor, so safety never depends on the tournament alone.

### Holds instead of hard blocks for the grey zone

Following the delay-plus-escape-hatch pattern, payments that score in the grey zone (over 350,000, not over 500,000)
are held for 300 blocks, about a minute on Base Sepolia, during which the owner or a guardian can veto them. Clear
attacks are refused; borderline requests are delayed, not lost.

### Pricing mistakes in both directions

Detectors that over-block lose their users; Blockaid argues that a system with zero false positives would let attacks
through ([Cointelegraph](https://cointelegraph.com/news/blockaid-caused-crypto-drainer-shut-down-defends-against-claims-false-positives)).
Red Queen makes the trade-off explicit in its fitness function: a wrongly refused honest payment costs twice its amount
plus half a percent of the vault, a fixed honest bench is replayed every round, and honest users the live rule wrongly
refused are compensated from slashed stakes. A rule that refuses everyone can never win.

### Commit-reveal labels

To keep candidate rules from being tuned to known labels, each payment carries a sealed label opened only after the
round's traffic, and only registered honest wallets that have not staked an attack can label a payment honest.

---

## 4. What makes Red Queen different

| Property | How Red Queen delivers it |
|---|---|
| Enforced outside the model | The vault contract judges every payment; the agent's words carry no authority |
| Adapts | A new generation is graded every round (at least 600 blocks, about two minutes on Base Sepolia) |
| Verifiable | Every policy, its parents, its grade, the breeding seed and every verdict are on chain; the SDK recomputes any score bit for bit |
| No admin override | There is no withdraw and no manual install; the owner can only appoint registrars and guardians and veto a held payment |
| Bounded | Hard limits and attacker caps hold whatever the evolved rule says |
| Open participation | Anyone can propose a policy (graded on the spot), stake an attack, bet on a bloodline or close a due round |
| Portable | `PolicyGuard` exposes the champion to any contract; other vaults can subscribe to it |
| Explainable | Every refusal carries a reason bitmask; the site and the Red Queen explain each verdict in plain words |

### Why a blockchain

The value is in the record. A shared spreadsheet or a vendor's database can be edited after the fact, and a rule kept
on a server can be changed without anyone noticing. On chain, the rule that judged a payment, the payment's
measurements, the verdict, and the tournament that installed that rule are all permanent and publicly checkable, and
the money moves only through the contract that applies the rule.

### Why evolve instead of tuning once

A fixed public rule is studied once and evaded for good. A rule that keeps being re-tested against new and remembered
attacks closes gaps as attackers find them, and the hard limits keep that process safe while it runs.

### Why a public rule is still safe

Anyone can read the live genome and preview a payment for free. That is deliberate: safety rests on the limits that
hold when the rule is known, and the evolving part makes the most profitable evasion keep moving.

---

## 5. References

Incidents and threat evidence
- The Block: Freysa challenge. <https://www.theblock.co/post/328747/human-player-outwits-freysa-ai-agent-in-47000-crypto-challenge>
- Decrypt: AIXBT. <https://decrypt.co/310510/aixbt-ai-influencer-hacked-100k-ethereum>
- The Block: Lobstar Wilde. <https://www.theblock.co/post/390722/ai-agent-created-by-openai-dev-accidentally-sends-entire-memecoin-holdings-to-reply-guy>
- CryptoSlate: Grok and Bankrbot. <https://cryptoslate.com/how-one-trader-exploited-grok-and-morse-code-to-trick-ai-agent-into-sending-billions-of-crypto-tokens-from-a-verified-wallet/>
- Giskard: how Grok got prompt-injected. <https://www.giskard.ai/knowledge/how-grok-got-prompt-injected-an-x-user-drained-150-000-from-an-ai-wallet>
- Cointelegraph Magazine: Grok, Bankr and authorization. <https://cointelegraph.com/magazine/grok-bankr-wallet-free-nft-prompt-injection>
- CrAIBench, arXiv 2503.16248. <https://arxiv.org/html/2503.16248v3>
- Decrypt: StakeBench prompt-injection research. <https://decrypt.co/370972/ai-agents-prompt-injection-attacks-research>
- Anthropic: AI agents and smart-contract exploits (SCONE-bench). <https://www.anthropic.com/research/smart-contracts>
- Scam Sniffer: 2025 phishing losses. <https://drops.scamsniffer.io/scam-sniffer-2025-crypto-phishing-losses-fall-83-to-84-million/>
- The Block: Chainalysis 2025 theft. <https://www.theblock.co/post/382477/crypto-hack-2025-chainalysis>

Agent wallets
- Cointelegraph: Coinbase AgentKit. <https://cointelegraph.com/news/coinbase-launches-crypto-wallets-built-ai-agents>
- The Block: Coinbase Agentic Wallets. <https://www.theblock.co/post/389524/coinbase-rolls-out-ai-tool-to-give-any-agent-a-wallet>
- Decrypt: x402 at 138 million payments. <https://decrypt.co/380989/ai-agents-138-million-crypto-payments-one-year>

Defences
- EIP-7715. <https://eips.ethereum.org/EIPS/eip-7715>
- MetaMask Advanced Permissions. <https://metamask.com/news/introducing-advanced-permissions>
- ZeroDev permissions. <https://docs.zerodev.app/sdk/permissions/intro>
- Coinbase Spend Permissions. <https://docs.cdp.coinbase.com/wallets/using-wallets/spend-permissions>
- Coinbase CDP policies. <https://docs.cdp.coinbase.com/server-wallets/v2/using-the-wallet-api/policies/overview>
- Safe smart account modules. <https://docs.safe.global/advanced/smart-account-modules>
- Privy policies. <https://docs.privy.io/controls/policies/overview>
- Turnkey policies. <https://docs.turnkey.com/concepts/policies/overview>
- Fireblocks governance and policy engine. <https://www.fireblocks.com/platforms/governance-policy-engine>
- Forta Firewall. <https://docs.forta.network/en/latest/what-is-forta-firewall/>
- OpenZeppelin: Forta Firewall audit. <https://www.openzeppelin.com/news/forta-firewall-incremental-audit>
- Hypernative Guardian. <https://www.hypernative.io/products/hypernative-guardian>
- Venn detection performance. <https://docs.venn.build/venn-network/detection-performance-internal.md>
- Venn bypass mechanism. <https://docs.venn.build/venn-network/getting-started/safe-guard/bypass-mechanism.md>
- MetaMask security alerts. <https://support.metamask.com/configure/wallet/security-alerts/>
- Cointelegraph: Blockaid on false positives. <https://cointelegraph.com/news/blockaid-caused-crypto-drainer-shut-down-defends-against-claims-false-positives>
- Linea: Phylax Credible Layer. <https://linea.build/blog/linea-stack-and-mainnet-add-phlyax-credible-layer-onchain-safety>
- EIP-7265 circuit breaker. <https://ethereum-magicians.org/t/eip-7265-circuit-breaker-standard/14909>
- Forta: Euler Finance retrospective. <https://forta.org/blog/detecting-a-197-million-hack-before-exploitation-euler-finance-hack-retrospective>
- arXiv 2408.03441: adversarial attacks on phishing detection. <https://arxiv.org/html/2408.03441v1>

Co-evolution research
- Kayacik et al. 2011, evolving attackers against detectors. <https://gpbib.cs.ucl.ac.uk/gp-html/Kayacik_2011_EI.html>
- O'Reilly et al., RIVALS: adversarial co-evolution in cyber security. <https://ar5iv.arxiv.org/html/2004.04647>
- Review of coevolutionary algorithms, arXiv 1506.05082. <https://ar5iv.labs.arxiv.org/html/1506.05082>
