## Facts sheet (as of 22 November 2026: v3)

### The deployment
- Network: Base Sepolia, chain 84532, a public test network. All money is test ether with no value.
- Arena v4, the live arena, deployed 23 November 2026 from block 62,632,194 (v3's rules, with the fixes of a second security review: attackers capped at a tenth of the vault a payment and a fifth a round, an attacker's payment that would be held is refused, every gap between payments screened, a contract hop never makes a payment look safer, at most sixteen requests a wallet a round). Contracts: Vault 0x99Fa7fdb3533EBf756a56369d14BCBe87ef0B778 (holds the money, judges every payment, keeps held payments), Arena 0x905860E32c2f9a67548fd45cA64A347f6b1fd467 (rounds, stakes, grading, breeding, bets), Firewall 0x2364E4E1D0842E502F75B0aCC71399FcC0e60035 (the scoring maths), Crucible 0xdA44770825068011f9f99c155358981159f1b1B3 (sparring at every close, the hall of fame, screens proposed policies), Lineage 0x721189DB958AD7B401aE4855F1D21Ab111ba14ee (the family tree), PolicyGuard 0xAb2d640386191B3C5A728162f5A6e5b04f5B658C (the champion as a guard other contracts can call). 99 contract tests.
- v2, retired: deployed from block 61,713,640 on 21 November 2026 and replaced by v3. Vault 0x1201c281f8666a0D5c9F25FBf5aF92ED9F5CD000, Arena 0x36bcA115B8a928297c1bE3C3ed5Ff016f46cE1e3, Firewall 0x124D69a21e711238CFA9aD56A36684121861d4c3, Crucible 0xFb4bFe317E514dfA77A7EE971f6934FeF92325F7, Lineage 0xF61cF4065365AaeAd49Ce3FF8D148acaa84f6117, PolicyGuard 0xBeBCCcC8c0bf0b8166ae39654CeC31b9c9078184. Its verdicts and lineage stay on chain for good.
- A round is 600 blocks; Base makes a block every 0.2 seconds, so a round is about two minutes. The refusal limit is a score of 500,000; the hold line is 350,000. Stakes: 0.0005 to submit a policy, 0.0002 to stake an attack, 0.0001 minimum bet. Whoever closes a due round is tipped 0.00002 from the protocol pool.
- A transaction from a wallet not staked in the round must bring a 10 million gas limit (CLOSE_GAS), because it may have to close an overdue round on the way. Unused gas is not charged.

### Three verdicts (new in v3)
- Every payment gets one of three verdicts, decided in this order: the vault's hard limits refuse it if they apply; otherwise a score over 500,000 refuses it; otherwise a score over 350,000 holds it; otherwise it is paid. The Spend event records the verdict (0 paid, 1 held, 2 refused) with the score, the eight measurements and the reasons.
- A held payment moves nothing. It waits 300 blocks, about a minute. In that time the Vault's owner, or a guardian the owner appointed (setGuardian), may veto it, and the money stays in the vault; anyone else who tries is refused: NotGuardian. Once the minute is up, anyone may release it, and it is paid; a release before then is refused: TooEarly. A hold already released or vetoed is refused: AlreadySettled. The held amount is reserved, so the vault's balance shows what it can still pay, and it counts toward the round's outflow at once (a veto in the same round takes it back out).
- The queen is not a guardian and has no power over holds. When one of her own test attacks is held, her server releases it once it is due, as anyone could, and puts the money straight back. She never touches anyone else's hold.

### Hard limits (new in v3)
- Two limits written into the vault that no evolved policy can lift: a single payment over half of what the vault can pay is refused, and so is any payment that would take the round's payouts past half of the round's starting balance. Their reasons read "over the hard cap of half the vault in one payment" and "over the hard cap of half the round's balance out". Evolution can only be stricter.

### What the Crucible demands of every policy (new in v3)
- The monotone rule: a bigger payment, or a later one while money is leaving, must never score lower. So the weights on amount and on the round's outflow can't be negative, and the patterns gated on amount (big payment to a stranger, big payment while draining, delegated drain) or on outflow (big payment while draining, salami slicing, contract sink) must carry their gate's sign. A proposed or staked policy that breaks it is refused (verdict 6); bred children are clamped at birth. The queen's server sets any such weight to zero before she proposes.
- Canaries: seven drain-sized test payments (forty and fifty percent of the vault, and the whole vault, through every route) that every policy must refuse; holding one counts as letting it through. A proposal that lets one through is refused (verdict 5); at a close, each canary a candidate lets through costs it as much as losing the whole vault.
- Proposal verdicts: 0 accepted, 1 refuses an honest payment, 2 weaker than the live champion, 3 already proposed this round, 4 the pool is full, 5 lets a drain canary through, 6 not monotone. They are checked in the order monotone, honest bench, canaries, champion; screenVerdict previews one for free.
- Hall of fame: the last four distinct attack plans that topped a round keep sparring against every candidate at every close, even after they leave the attack pool, so a beaten attack is not simply forgotten. It lives in the Crucible (getArchive, the Archived event).

### Grading (v3)
- Live payments: an attack payment a candidate would refuse saves its whole amount; holding it saves half. An honest payment it would refuse costs twice the amount plus half a percent of the round's starting balance; holding it costs a tenth of that (the EpochClosed event's honestCost).
- Sparring: a held step counts as half taken. The bench: refusing one of the ten everyday payments costs as much as losing the whole vault (or twice the amount plus half a percent, if that is more); holding one costs a tenth of that.
- Crown margin: a challenger takes the crown only if it beats the live champion by at least one percent of the round's starting balance; otherwise the champion keeps it (the CrownKept event).
- The stake rule: an attack's stake (0.0002) comes back only once that wallet has taken at least 0.0002 from the vault in that round, credited at the very payment that crosses the line (StakeReturned arrives in that spend, not at the close); a held payment counts only when it is released. Otherwise the stake goes to the protocol pool at the close.
- The seed: breeding's randomness is the hash of the round's last block (Randomness event, source 3), fixed before anyone may close the round, so a closer can neither preview it nor wait for a better one. If the close comes more than 256 blocks late, it is the hash of a fixed later block (source 4). There is no VRF: the network's block producer could in principle influence a block hash.

### Other v3 rules
- Bets close at the reveal block: BettingClosed.
- An agent already funded by one principal can't be funded as a delegate by another: AlreadyDelegated. The agent or its principal can release it (undelegate).
- An attack plan's steps may ask for up to the whole vault, though the vault refuses any single payment over half.

### What has happened on chain (v3, live since 22 November)
- Asked for a single 40% drain, she sent one: it scored 950,000 and was refused, by the policy and by the hard cap on the round's outflow; nothing moved (transaction 0x45f6e60f8998ac1872e47372c07164c0e3226fbc6697736ee6a6f6715e208290).
- Asked for one payment of 20%, she sent it at the top of a fresh round: it scored 400,000, over the hold line and under the limit, so it was held (hold 0, transaction 0x3f72d4b0a653530008d62d56400943dd057c3dbb22170647e24391db604a9a76). After its 300 blocks her keeper released it and put the money back.
- The genesis policy held until round 6. At the close of round 6 the contract bred and installed policy 3, generation 1, a child of genesis, as the first v3 champion (transaction 0x86769bab1b28cf7467167db476924ae66bcaefcef409c830de99e733c0309d8b). Champions change only when a challenger beats the live one by 1% of the round's balance.

### What has happened on chain (the v2 arena, now retired)
- The genesis policy (policy 1) held from deploy until round 6. At the close of round 6 the contract installed policy 18, generation 3, as the new champion (transaction 0x3733032ad11fdaef42a9d4d0a3f5689db3d01b7190f4232977eef3743d0e0787). Champions since then, as of round 45 on 22 November: policy 18, then 63, 76, 120, and 76 again (each bred and installed by the contract; a former champion still in the pool can win the crown back).
- A request for 40% of the vault (0.0016 test ether) scored 805,000 and was refused; nothing moved (transaction 0xfe6ce797bebc3f7ea31d9a97480cf09c714f0663c02771ead18ab9e10b9a9dd3).
- Each rule on real traffic, for requests of 5% of the vault or more: the first rule refused 3 of 12 (it let 10% slices through); policy 18 refused 8 of 8. The site shows this live in "Is she learning?".
- Asked to write a policy that lets big payments through, the queen proposed one and the Crucible refused it: attackers would take 64.2% of the vault under it, 18.7% under the live rule (transaction 0x881a807bde9d99266b9a3d4b02cbf76fb95b7a24cf28219128d0275e57649574).
- Her server (her own test wallet) closes due rounds and spars: after a quiet round it attacks the new champion itself, a 40% drain and three 10% slices, putting back anything that gets through (in v3, a held one once it is released), so every grade has real refusals in it. In v3 she stakes for a spar at most once every ten minutes, since a round in which nothing gets through costs her the stake. Busy rounds close as soon as they are due.

### The three roles (the hackathon guide asks for them)
- Admin, who decides who is allowed: the Vault's owner. They appoint registrars (setRegistrar); only a registrar can allow a wallet to ask for payments as an honest user (registerHonest). Anyone else is refused: NotRegistrar. In v3 the owner also appoints guardians (setGuardian), and the owner or a guardian may veto a held payment; anyone else is refused: NotGuardian.
- Operator, who does the main job with their own wallet: any wallet asking the vault for money. It must be allowed (honest) or have staked an attack this round; otherwise refused: NotParticipant. Every request is scored: over the limit, nothing moves and the refusal is recorded; over the hold line, it is held for about a minute. A second attack in one round is refused: AlreadySubmitted.
- Public reader, no wallet: anyone can read every verdict, every generation and every contract, on the site or on Basescan, and check any transaction in the site's public check. Anyone may also release a held payment once its minute is up.
- A fourth role, the rule author: anyone may propose a policy through the Crucible, which refuses one that breaks the monotone rule, blocks an honest payment, lets a drain canary through, or loses more than the live rule, and records the verdict.
- Steps out of order are refused too: closing a round before it ends (EpochNotOver), closing one twice (EpochAlreadyClosed), claiming with nothing owed (NothingToClaim), a second bet in a round (AlreadyBet), a bet after the reveal block (BettingClosed), releasing a hold too early (TooEarly) or twice (AlreadySettled).

### The site's chapters (what the visitor sees where)
top (the hero: her name, the live generation and refusals), vault (the balance and the live rule), siege (attacks arriving as they happen), try ("your turn": pick an attack, see the predicted verdict, hold to send from your own wallet), record (every verdict, newest last, each with its Basescan link and a card explaining it), generations (each champion's reign), lineage (the family tree of every policy), learning ("Is she learning?": what the live policy kept from attackers, honest payments refused by mistake, and each rule on real traffic), bet (back a bloodline), roles ("Three roles. The contract refuses each.": allow a wallet, ask for one percent, check any transaction, and the Crucible's verdicts on proposals), proof (every contract with its source, the breeding seed). Also: the narrated film ("Watch the demo"), the attack lab (design an eight-step attack), the time machine (step back through past champions), the genome inspector, cinema mode, and block numbers beside every figure (the V key).

### The hackathon
HASH-IT-OUT 2026, BITS Pilani Dubai. Track 6, Open Innovation. Theme: verifiable records (someone records a fact and anyone can check it without trusting them; corrections are new entries; nothing is edited or deleted). Here, every verdict is a permanent record, and a better rule is a new generation in the lineage, never an edit. Judged on: the chain does the job (25), front end and UX (20), works on the test network (15), pitch (15), the problem is specific (15).

### The landscape, honestly (from the team's research, November 2026)
- Real incidents: Freysa (November 2024), an AI agent told never to release its prize pool was talked into paying out about $47,000 after 482 attempts; AIXBT (March 2025), about 55 ETH sent after an attacker got into a dashboard (its maintainer says it was not agent manipulation); Grok and Bankrbot (May 2026), an agent tricked into moving tokens worth $150,000 to $200,000, most returned. Research showed planted false memories make crypto agents act against their owners (the "Real AI Agents with Fake Memories" paper on ElizaOS). Losses to manipulated agents so far are small next to human phishing (about $84 million to wallet drainers in 2025) and total crypto theft (about $3.4 billion in 2025). Honest framing: a real and growing class of attack, not yet a large one.
- Static rules today: Coinbase Agentic Wallets (February 2026) with spending limits and session caps, checked by Coinbase when it signs; MetaMask Advanced Permissions (ERC-7715, April 2026), e.g. an agent capped at ten USDC a day; Safe guards and modules, Zodiac Roles; Turnkey, Privy and Fireblocks policies checked inside the vendor's secure enclave. All fixed until an admin changes them, and an admin above them can override.
- Detect and block: Blockaid (off-chain scanning in wallets, warns but does not block), Forta Firewall, Hypernative, Venn, Phylax: they score off chain and enforce through attestations, guards or the sequencer. None evolves its rule on chain in public. The closest research is a 2025 paper training a model on a layer two with stake-gated updates.
- What is genuinely new here: the rule is chosen by a public, mechanical tournament on chain (anyone can enter, only a winner is installed, every verdict is a permanent record, money sits behind the rule).
- Honest weaknesses: the rule is public, so an attacker can compute exactly what passes (that is by design, Kerckhoffs-style; only budget-like limits such as size and round outflow hold up when the rule is known, which is why v3 adds hard caps no rule can lift); new wallets reset per-wallet measures such as velocity (Sybil wallets); labels are self-reported; the ten-payment honest bench and the seven canaries are public; evolution can still forget a defence once an attack drops out of the four-plan hall of fame; the breeding seed is a block hash, which the network's block producer could in principle influence; a mainnet version would cost far more gas (a round close is about four million gas).
- Adopted in v3 from the team's list of better designs: three verdicts (pay, hold with a veto, refuse), fixed caps evolution can't lift, and an archive of past attacks every candidate must still beat (the hall of fame). Still to do for production: allowances per owner that evolution can only tighten, labels confirmed by the owner, fitness averaged over several rounds, budgets per owner rather than per address, verifiable randomness (Chainlink VRF on Base).

## The full explainer

## Red Queen, explained

A plain-language guide to the whole project: the idea, what happens on the blockchain, what runs around it, and what every part of the website does (including the Connect button). It is written for people, not for compilers. Where a number matters, it is the real number from the code. It describes what is deployed now: Arena v3 on Base Sepolia (live since 22 November 2026), the website, and the queen you can talk to. Where it mentions v2, that is the earlier arena, retired but still on the chain.

---

## Contents

1. [Red Queen in one minute](#1-red-queen-in-one-minute)
2. [The problem it solves](#2-the-problem-it-solves)
3. [The big idea: a rule that evolves](#3-the-big-idea-a-rule-that-evolves)
4. [Who is in the arena](#4-who-is-in-the-arena)
5. [How one payment is judged](#5-how-one-payment-is-judged)
6. [How she learns: one epoch, step by step](#6-how-she-learns-one-epoch-step-by-step)
7. [The second population: evolving attackers](#7-the-second-population-evolving-attackers)
8. [Money: stakes, rewards, compensation and bets](#8-money-stakes-rewards-compensation-and-bets)
9. [The rules the contracts enforce](#9-the-rules-the-contracts-enforce)
10. [The smart contracts, one by one](#10-the-smart-contracts-one-by-one)
11. [Everything around the chain](#11-everything-around-the-chain)
12. [The website, section by section](#12-the-website-section-by-section)
    - [Talking to her](#talking-to-her)
13. [Every button and control](#13-every-button-and-control)
14. [Reading the picture: what the queen and the board mean](#14-reading-the-picture-what-the-queen-and-the-board-mean)
15. [The demo film](#15-the-demo-film)
16. [Sound](#16-sound)
17. [Phones, no-3D and reduced motion](#17-phones-no-3d-and-reduced-motion)
18. [What is real, and what is simplified](#18-what-is-real-and-what-is-simplified)
19. [Running it yourself](#19-running-it-yourself)
20. [Glossary](#20-glossary)

---

## 1. Red Queen in one minute

Red Queen is a **vault on Ethereum that defends itself, and gets better at it by being attacked**.

- The vault holds test ETH on Base Sepolia, a public test network. Anyone can ask it to send money out.
- Every request is judged on-chain by a small **security policy**: 32 numbers (a "genome") that say how suspicious each kind of payment is. There are three verdicts. A payment that scores over the limit is **refused**, and the vault says why. One that scores over a lower line is **held**: it waits about a minute, and a person with the power to may cancel it. Anything lower is **paid**. Two hard limits written into the vault sit above every policy and are refused whatever it says.
- The first policy is live from the first block and already refuses any single payment of more than about a quarter of the vault.
- Several candidate policies compete in the background. Every round (at least 600 blocks, about two minutes on Base Sepolia) the contract checks which ones would have **kept the most money from attackers without blocking honest payments**, and plays each one against the known attack plans, a hall of fame of past ones, drain-sized canaries and a bench of honest payments. The best ones survive, **breed** (mix their numbers) and **mutate**, and the winner becomes the live policy.
- Attackers are real wallets (visitors, the queen's own test wallet when you ask her, other people's AI agents). Their attack plans evolve too, starting from five scripted plans put in the attack pool at deploy.
- The website is a live 3D arena. The glass chess queen in the middle **is** the current policy, drawn to scale: her shape changes when the policy changes. Red ink on the board means she refused something.
- You can talk to her. She answers in her own voice and can act on the page: show you a chapter, send a real attack at her own vault, or write a policy and put it before the chain.

Nothing is decided off-chain. No AI service, no server, no oracle chooses the rules: the contract scores, refuses, selects and breeds, and every generation is recorded on the blockchain. The talking queen runs on a server and can propose a policy, but the contract grades it and decides whether it may compete.

The name comes from *Through the Looking-Glass*: "it takes all the running you can do, to keep in the same place." In biology the "Red Queen effect" means predators and prey must keep evolving just to stay even. Here the defender and the attackers both evolve.

---

## 2. The problem it solves

**AI agents now hold wallets.** Assistants and trading bots can sign transactions and move money. If one is tricked (prompt injection, a malicious contract, a bad counterparty), the only thing between it and an empty wallet is a set of rules.

**Today those rules change only when a person edits them, and nobody outside can see when or why.** Spending caps, daily limits, allowlists of approved addresses. Coinbase's agent wallets (enforced by Coinbase when it signs), MetaMask's and ZeroDev's permission systems and similar tools all work this way: an owner sets the rules in advance and edits them by hand.

**So far, losses came from rules that were missing or lost** (Bankr's safeguard for Grok was dropped in a rewrite, May 2026), not from fixed rules being out-probed. As balances grow, attackers will probe whatever rule is live, for example with many small withdrawals that each stay under a cap. Red Queen's answer is a rule that is re-tested against every known attack each round and changes only through a public, recorded tournament. We found no other project that evolves its per-payment refusal rule on chain this way, with every version public; several score payments on chain with fixed or off-chain rules.

| Approach today | Examples | Why it is not enough |
| --- | --- | --- |
| Session keys and spending caps in the wallet | Coinbase Agentic Wallets, ZeroDev, ERC-7715 | Fixed at the moment they are granted; nothing learns |
| Off-chain policy engines | Privy, Turnkey, Fireblocks | The rules live on a company's server you have to trust |
| Agent identity and reputation | ERC-8004 | Says *who* an agent is, not whether *this payment* is safe |

**Red Queen's answer:** a wallet policy that adapts to attacks as fast as attackers adapt to it, where every adaptation is public and checkable on the blockchain.

---

## 3. The big idea: a rule that evolves

Think of it as natural selection for security rules, run entirely inside a smart contract.

1. **One rule is live.** It judges every real payment. The first one (genesis) refuses any single payment over about a quarter of the vault from the first block. The gaps it leaves (many small slices, bursts to new addresses) are what evolution has to close.
2. **Up to 16 rules, the live one included, sit "in the shadows".** They judge the same payments too, silently. Nobody's money depends on them, but the contract writes down what each would have refused and what each would have held.
3. **Every epoch (a round of at least 600 blocks, about two minutes on Base Sepolia), the contract grades them.** Who would have stopped the most stolen money? Who would have wrongly blocked honest payments? A second contract, the Crucible, also plays each one against the known attack plans, the hall of fame (the last four attack plans that topped a round), seven drain-sized canaries and a bench of ten everyday honest payments.
4. **The best 4 survive.** The rest die. Their deposits are paid out to the winners and to honest people who were wrongly blocked.
5. **The survivors have children.** Pairs are mixed gene by gene and each child gets two random mutations, then is clamped to the **monotone rule** (a bigger payment must never score lower; section 5.3). The children join the shadow pool.
6. **The best survivor becomes the live rule**, but only if it beats the live champion by at least 1% of the round's starting balance (the crown margin); otherwise the champion keeps the crown. Its parents and generation are written into a permanent family tree.

Meanwhile the attackers' plans go through the same loop, graded on how much money they got out and how much they take in the Crucible's sparring. So the defence and the attack co-evolve.

---

## 4. Who is in the arena

| Role | Who they are | What they do |
| --- | --- | --- |
| **The vault** | A smart contract | Holds the test ETH. Every withdrawal or payment goes through the firewall. It refuses, holds or pays each one, and keeps held payments. |
| **The firewall (the live policy)** | A smart contract holding 32 numbers | Scores every payment; refuses those over the limit, holds those over the hold line, with a reason. |
| **Honest users** | Registered wallets. In a local run, six bots behave like normal users and anyone who connects is registered; the hosted site registers nobody automatically. | Make ordinary payments, withdrawals and delegations to agents. Their wrongly blocked payments are what the evolution tries to avoid. The Crucible also holds a fixed bench of 10 typical honest payments that every candidate is tested against. |
| **Attackers** | Anyone who puts down a small stake (0.0002 test ETH) | Try to pull money out. They keep whatever they manage to take. On Base Sepolia: visitors, other agents, and the queen's own test wallet when someone asks her. In a local run, five scripted attacker bots and an evolved-attacker bot also run constantly. Five scripted attack plans sit in the attack pool from deploy. |
| **Challengers** | Anyone with 0.0005 test ETH, or anyone proposing a policy through the Crucible for free | Submit their own candidate policy to compete in the shadow pool. A proposal needs no stake, but it only gets in if the Crucible finds it monotone, refusing no honest bench payment, letting no drain canary through, and guarding at least as well as the champion. The queen proposes this way. |
| **Spectators** | Anyone | Bet test ETH (0.0001 minimum) on which family of policies will hold the crown after the next epoch. |
| **The closer** | Anyone | Once an epoch's blocks have passed, the first transaction from a wallet not staked in it closes it, inside that transaction, and the sender earns a tip of 0.00002 test ETH. Anyone may also call `closeEpoch()`. On Base Sepolia the queen's server closes due epochs from her wallet; in a local run a bot does. |
| **The Crucible** | A smart contract | The sparring ring: at every close it plays every candidate against the attack plans, the hall of fame, the drain canaries and the honest bench. It also keeps the hall of fame and screens proposed policies. |
| **The owner and guardians** | The Vault's owner, and any wallet the owner appoints with `setGuardian` | May veto a held payment, and the money stays in the vault. Nobody else may: anyone else who tries is refused (`NotGuardian`). They cannot install a policy or change a verdict. |
| **Anyone, for a held payment** | Any wallet | Once a held payment's minute is up (300 blocks), anyone may release it and it is paid. Before then a release is refused (`TooEarly`). |
| **The queen's server** | A Hugging Face Space | Talks to visitors in her voice, and acts like any other wallet: attacks her own vault, proposes policies, closes due epochs, and releases her own held test attacks once they are due. It decides nothing. The contracts do. She is not a guardian and has no power over holds. |

---

## 5. How one payment is judged

### 5.1 The eight measurements

When someone asks the vault to send money, the contract measures eight things about the request, each on a scale of **0 to 1,000**:

| # | Plain name | What it measures | How it is computed |
| --- | --- | --- | --- |
| f0 | **Size of the payment** | How big it is compared with the whole vault | amount × 1,000 ÷ vault balance |
| f1 | **How new the recipient is** | Has the vault ever paid this address? | 1,000 for a stranger, then 1,000 ÷ (1 + times paid): 500, 333, 250… |
| f2 | **How fast payments are coming** | Is this caller firing off many requests? | 200 for each earlier request in the last 20 blocks (5 saturate at 1,000) |
| f3 | **Time since the last one** | How long since this caller last asked | blocks since last request, capped at 100 blocks = 1,000 (first-ever request = 1,000) |
| f4 | **Sender's reputation** | Is the caller a known honest user, and for how long? | 500 for a registered honest wallet, rising to 800 over 1,000 blocks, plus 200 for an ERC-8004 identity token (max 1,000). An agent that was funded by an honest user inherits its owner's reputation. |
| f5 | **Sent through a contract** | Did the request come through another contract (an agent wrapper)? | 1,000 if the transaction's signer is not the direct caller, else 0 |
| f6 | **Paid to a contract** | Is the recipient a contract rather than a person's wallet? | 1,000 if the recipient has code, else 0 |
| f7 | **Already drained this epoch** | How much has left the vault this epoch, including this payment? | (outflow so far + this amount) × 1,000 ÷ balance at the start of the epoch |

Anyone can call `previewSpend()` to see these numbers and the verdict (paid, held or refused) for a hypothetical payment **before** signing. The website does this live as you move the sliders in "Try to drain her".

### 5.2 The policy: 32 numbers

A policy (the "genome") is 32 small whole numbers (each between −32,768 and 32,767), packed into two storage slots:

| Genes | Name | Meaning |
| --- | --- | --- |
| 0–7 | **Weights** (w0–w7) | How much each measurement counts. Positive punishes it, negative forgives it (a negative weight on reputation means a good reputation lowers the score). |
| 8–15 | **Pattern weights** (v0–v7) | Extra points when a *pair* of measurements are both high at once. |
| 16–23 | **Thresholds** (t0–t7) | When a measurement counts as "high" for the patterns. A positive threshold fires when the measurement is at least that big; a negative one fires when it is *below* that size (so evolution can flip a pattern's direction). |
| 24–31 | Reserved | Carried along and mixed in breeding but never used for scoring. |

The eight patterns (pairs of measurements):

| Pattern | Pair | The attack it describes |
| --- | --- | --- |
| Big payment to a stranger | size × new recipient | Draining to a fresh address |
| Big payment while draining | size × already drained | A large take when the vault is already bleeding |
| New-recipient burst | new recipient × speed | Rapid payments to many new addresses |
| Salami slicing | speed × already drained | Many small, fast slices adding up |
| Contract hop | through a contract × paid to a contract | Routing money through contracts |
| Delegated drain | size × through a contract | Draining via an agent |
| Rapid repeat | speed × time since last | Hammering requests |
| Contract sink under outflow | paid to a contract × already drained | Pouring money into a contract while draining |

### 5.3 The score and the verdict

```
score = Σ (weight × measurement)  +  Σ (pattern weight × 1,000, for each pattern whose two thresholds both fire)
```

Every payment gets one of **three verdicts**, decided in this order:

1. **A hard limit refuses it**, if one applies (below).
2. Otherwise, if the score is **over 500,000**, the payment is **refused**.
3. Otherwise, if the score is **over 350,000** (the hold line, fixed), the payment is **held**.
4. Otherwise it is **paid**.

The Spend event records the verdict (0 paid, 1 held, 2 refused) with the score, the eight measurements and the reasons.

- A refusal **does not revert** the transaction. It is recorded with `refused = true`, no money moves, and the attempt stays on the blockchain forever (the website's "record" and the red ink are built from these).
- The contract also says **why**: a "reason bitmask" marks every term that contributed at least one eighth of the score. The site turns it into words: "too large", "unknown recipient", "salami slicing" and so on. A hold carries the same kind of reasons.

**The two hard limits.** They are written into the vault, and no evolved policy can lift them:
- One payment over **half of what the vault can pay** is refused (reason bit 16: "over the hard cap of half the vault in one payment").
- Any payment that would take the round's payouts past **half of the round's starting balance** is refused (reason bit 17: "over the hard cap of half the round's balance out").

Evolution can only be stricter than these.

**A held payment** moves nothing. It waits **300 blocks**, about a minute on Base Sepolia.
- In that time the Vault's owner, or a guardian the owner appointed (`setGuardian`), may **veto** it (`veto(id)`), and the money stays in the vault. Anyone else who tries is refused: `NotGuardian`.
- Once the minute is up, **anyone** may **release** it (`release(id)`), and it is paid. A release before then is refused: `TooEarly`. A hold already released or vetoed is refused: `AlreadySettled`. An unknown id is refused: `UnknownHold`.
- The held amount is reserved, so the vault's balance shows what it can still pay (the contract's own ETH balance still includes the held money). A hold counts toward the round's outflow at once; a veto in the same round takes it back out.
- The queen is not a guardian. When one of her own test attacks is held, her server releases it once it is due, as anyone could, and puts the money back. She never touches anyone else's hold.

**What every policy must obey: the monotone rule.** A bigger payment, or a later one while money is leaving, must never score lower. So the weights on size (w0) and on the round's outflow (w7) can't be negative, and each pattern gated on size (big payment to a stranger, big payment while draining, delegated drain) or on outflow (big payment while draining, salami slicing, contract sink) must carry its gate's sign. A policy that breaks the rule is refused when proposed or staked (verdict 6); bred children are clamped to it at birth. This removes the kind of gap v2's champion had, where a 20% payment was refused but 21 to 23% got through.
- Scoring is plain integer arithmetic, so the website can re-run it exactly (the SDK has a bit-for-bit copy of the contract's maths).

### 5.4 Two real examples

**The genesis policy, as the v2 vault scored it on Base Sepolia.** The policy live from the first block weighs only two measurements: size of the payment at 1,500 and already drained at 500. Every other weight and every pattern weight is 0. Here is a 40% drain, with nothing yet taken this epoch, as the vault's own `previewSpend` scored it on the chain:

| Measurement | Value | × her weight | = points |
| --- | --- | --- | --- |
| Size of the payment | 400 | × 1,500 | +600,000 |
| Already drained this epoch | 400 | × 500 | +200,000 |
| The other six measurements | | × 0 | 0 |
| Patterns (all pattern weights are 0) | | | 0 |
| **Score** | | | **800,000** |

800,000 is over 500,000, so it is **refused**, with the reason "too large and vault already draining". A 50% payment scores 1,000,000 (refused); 10% scores 200,000 and 1% scores 20,000 (both paid). With nothing yet taken this epoch, any single payment over about a quarter of the vault is refused under this policy. Salami slices and bursts to new addresses still get through at genesis: those are the gaps that evolution, or a policy the queen proposes, has to close.

**A live v3 refusal.** On v3, her server's test wallet asked for 40% of the vault. It scored **950,000** and was refused, for three reasons: too large, vault draining, and the hard cap on the round's outflow (bit 17). Nothing moved (transaction `0x45f6e60f8998ac1872e47372c07164c0e3226fbc6697736ee6a6f6715e208290`).

**A live v3 hold.** The same wallet asked for 20% of the vault. It scored **400,000**: over the hold line of 350,000 and under the limit of 500,000. It was held (hold id 0, transaction `0x3f72d4b0a653530008d62d56400943dd057c3dbb22170647e24391db604a9a76`). After 300 blocks her server released it and put the money back.

**An evolved policy, from an earlier local run.** This is a real attack the demo sent on the local chain (block 25,846) during the v1 arena, against a bred policy that uses patterns: 9.69 ETH, 40% of the vault, to the attacker's own address.

| Measurement | Value | × her weight | = points |
| --- | --- | --- | --- |
| Size of the payment | 400 | × 861 | +344,400 |
| How new the recipient is | 1,000 | × 127 | +127,000 |
| How fast payments are coming | 0 | × 43 | 0 |
| Time since the last one | 390 | × −38 | −14,820 |
| Sender's reputation | 0 | × −604 | 0 |
| Sent through a contract | 0 | × 0 | 0 |
| Paid to a contract | 0 | × −13 | 0 |
| Already drained this epoch | 418 | × −44 | −18,392 |
| **Eight measurements, weighed** | | | **+438,188** |
| Patterns that fired: big payment while draining, new-recipient burst, salami slicing, contract hop, delegated drain | | | **+634,000** |
| **Score** | | | **1,072,188** |

1,072,188 is over 500,000, so it was **refused**. The two biggest contributors (size, and the salami-slicing pattern) became the reason: "too large and salami slicing". Nothing left the vault.

---

## 6. How she learns: one epoch, step by step

An **epoch** (also called a round) lasts at least a fixed number of blocks: 600 on Base Sepolia (about two minutes, since Base Sepolia makes a block about every 0.2 seconds) and 30 on the local chain. The end of it is the **reveal window**: the last 100 blocks on Base Sepolia, the last quarter locally. An epoch does not end on a timer (see "When the epoch closes" below).

**During the epoch**

1. **Every payment is scored by everyone.** The live policy decides. Every candidate in the shadow pool (up to 16) also scores it, and the vault records which candidates *would* have refused it and which would have held it (the "shadow masks"). Up to 240 payments are logged per epoch, so closing stays affordable.
2. **Every payment carries a sealed label.** When you spend, you include a hash of "honest" or "attack" plus a secret. Nobody can read it yet.
3. **Reveal window.** At the end of the epoch, people open their sealed labels. A payment only counts as **honest** if it comes from a registered honest wallet that has not staked an attack this epoch. An unopened label counts as an **attack**. This is the "commit-reveal" scheme: policies cannot know in advance which traffic is honest, so they cannot be tuned to cheat.

**When the epoch closes.** Nothing closes it on a timer. Once its blocks have passed, the first transaction from a wallet that is not staked in that epoch closes it, inside that same transaction and before doing its own business: an honest payment, a new attack plan, a policy submission, a bet or a proposal. The sender earns the closer's tip, 0.00002 test ETH from the protocol pool. Anyone may also call `closeEpoch()` directly, which is tipped too and refuses to run early or twice. A wallet staked in the epoch never closes it, so its attack plan cannot expire under it mid-attack. Because any of those transactions might have to carry a whole close, each must bring a gas limit of at least 10 million (`CLOSE_GAS`). Wallets estimate this automatically, and only the gas actually used is charged. On Base Sepolia the queen's server also closes due epochs from her wallet (section 11).

4. **Randomness.** The seed for breeding is the hash of the round's **last block** (the `Randomness` event, source 3). It is fixed before anyone may close the round, so a closer can neither preview it nor wait for a better one. If the close comes more than 256 blocks late, the seed is the hash of a fixed later block (source 4). There is no verifiable random function; a block producer could in principle influence a block hash.
5. **Attacker stakes.** An attack's stake (0.0002) is not settled here any more: it came back during the round, at the very payment that took the wallet's total to at least 0.0002 (section 8). A stake that never got there goes to the pool now.
6. **Sparring.** The Arena hands the Crucible its whole policy pool and attack pool. Every candidate is played, in Solidity and step by step, against the first 8 attack plans in the pool and against the **hall of fame** (the last four distinct attack plans that topped a round, kept in the Crucible even after they leave the attack pool), on a simulated vault (with the same eight measurements the Vault computes). It also faces the bench of 10 everyday honest payments and **seven drain canaries**: drain-sized test payments (forty and fifty percent of the vault, and the whole vault, through every route) that every policy must refuse. One `Sparred` event per close records each candidate's result.
7. **Fitness.** For every candidate policy:

   ```
   F = R − C + S
   ```

   - **R** = money it would have kept: an attack payment it would have refused saves its whole amount, and one it would have held saves half.
   - **C** = the cost of honest payments it would have got wrong, priced by the payment: refusing one costs **twice its amount plus half a percent of the epoch's starting balance**; holding one costs a tenth of that. (The `EpochClosed` event reports it as `honestCost`.) So "refuse everything" is a losing strategy.
   - **S** = the sparring score: minus the average share of the vault the attack plans (and the hall of fame) would take from it, with a held step counting as half taken; minus the cost of every honest bench payment it would refuse (as much as losing the whole vault, or twice the amount plus half a percent, if that is more; a held one costs a tenth of that); minus, for each canary it lets through (a hold counts as letting it through), as much as losing the whole vault. A policy that refuses everyone can never win, even in an epoch where nobody opens an honest label.
8. **Selection.** Candidates are sorted by fitness (ties keep their order, so a steady champion stays put). The **top 4 survive** and get their stakes back. The rest **die**; their stakes are slashed. The best challenger takes the crown only if it beats the live champion by at least **1% of the epoch's starting balance**; otherwise the champion keeps it (the `CrownKept` event).
9. **Slashed stakes are shared:** 60% to the people who submitted the surviving policies, 30% to honest users the live policy wrongly refused, 10% to the protocol pool.
10. **Compensation.** Each honest user wrongly refused by the live policy is also paid λ per wrong refusal from the pool (shared pro rata if the pool is short). At most 32 users are paid per close, so a close always fits in one transaction; the rest of their share stays in the pool. The vault has a real reason not to over-block.
11. **Installation.** The winner, if it clears the crown margin, becomes the **live firewall**; otherwise the champion stays. Its parents, generation and fitness are written to the family tree. The website's queen changes shape to match.
12. **Breeding.** Survivors are paired (1st with 2nd, 1st with 3rd, 2nd with 4th, 3rd with 4th). Each child takes each gene from one parent or the other at random (uniform crossover), then **two genes mutate by ±1 to 1,000**, using the round's last-block seed (step 4). Each child is then clamped to the monotone rule. The four children replace the dead in the pool. Children are not crowned at birth; they must win a later close.
13. **Attackers evolve** (next section).
14. **Bets settle.** The winning family is the lineage of the new champion.
15. **The closer is tipped and the next epoch starts.**

Every step emits events (`EpochClosed`, `PolicyInstalled`, `CrownKept`, `PolicyDied`, `ChildBorn`, `Slashed`, `Compensated`, the Crucible's `Sparred`, `Archived` and `CanariesPassed`, `Rewarded` for the closer's tip and so on), which is how the website animates it.

---

## 7. The second population: evolving attackers

Attack plans are genomes too: **8 steps × 4 genes**.

| Gene in each step | Meaning |
| --- | --- |
| Amount | Share of the vault to take, up to 100% (0 skips the step); the vault itself refuses any single payment over half |
| Recipient | Yourself, a fresh address, a contract (an agent wallet), or the previous recipient |
| Delay | Blocks to wait first (0–15) |
| Route | Directly from your wallet, through an agent contract, or delegate-then-drain |

To attack, a wallet **stakes 0.0002 test ETH** and either submits its own plan (`submitAttack`) or adopts an existing one from the attack pool (`adoptAttack`). Staking is what gives a wallet the right to spend from the vault that epoch.

At each epoch close, attack plans are graded by **how much they actually extracted**, plus the share of the vault they took from the candidates in the Crucible's sparring (a held step counts half), and the best ones breed and mutate exactly like policies. The plan that tops a round also goes into the **hall of fame**, the last four distinct round-topping plans, which keep sparring against every candidate even after they leave the attack pool, so a beaten attack is not simply forgotten. Over time the attackers find the policy's weak spots, and the policy has to close them. That is the Red Queen race.

The five scripted attacks (seeded into the attack pool when the arena was deployed, so the attackers exist from the first close; also the website presets):

| Preset | What it does |
| --- | --- |
| **Drain 40%** ("Take 40% at once") | One transaction for 40% of the vault, to yourself |
| **Salami** ("Twelve thin slices" on the site, eight 3% slices in the bot) | Many small withdrawals that each look harmless |
| **New-recipient burst** ("Pay five strangers") | Five 5% payments, each to an address the vault has never seen |
| **Delegate, then drain** ("Through an agent") | Fund an agent with a small delegation, then drain through it |
| **Contract hop** | Send money through a contract recipient |

Against the genesis policy, "Take 40% at once" is refused from the first block (score 800,000 on v2). The salami and new-recipient presets still get through at first: closing them is the race.

---

## 8. Money: stakes, rewards, compensation and bets

All amounts are **test ETH** (worthless play money on a test network).

| What | Amount | What happens to it |
| --- | --- | --- |
| Attack stake | 0.0002 | Returned only once your wallet has taken at least 0.0002 from the vault in that round, credited at the very payment that crosses the line (the `StakeReturned` event arrives in that spend, not at the close). A held payment counts only once it is released. Otherwise it goes to the pool at the close. You keep whatever you extract. |
| Policy stake | 0.0005 | Returned if your policy survives; slashed if it dies (shared 60/30/10). |
| Policy proposal (through the Crucible) | Free | If accepted, the policy enters the shadow pool without a stake. A refusal is recorded on the chain, not reverted. |
| Bet | 0.0001 minimum, one per wallet per epoch, until the reveal block (later is refused: `BettingClosed`) | Pari-mutuel: everyone who backed the winning family splits the whole pot in proportion to their bets. If nobody backed the winner, everyone is refunded. |
| Closer's tip | 0.00002 per close, from the protocol pool | Paid to whoever closes an epoch |
| Wrong-refusal compensation | λ (2% of the epoch-start balance) per wrong refusal, at most 32 users per close | Paid to honest users the live policy blocked by mistake. (This is separate from how a wrong refusal is priced when grading candidates, which is by the payment: section 6.) |
| Judge top-up (local run only) | 0.05, once per address | Sent when a new wallet connects with less than 0.02 test ETH. The hosted site has no top-up service. |

A payment, new attack plan, submission, bet or proposal from a wallet not staked in the current epoch carries a gas limit of 10 million, because it might have to close the epoch. Your wallet must hold enough to cover that limit (about 0.00016 test ETH at current Base Sepolia prices, on top of any stake), but you are charged only for the gas used.

Rewards don't arrive automatically. They pile up as a **claimable balance** in the Arena, and you press **Claim** (or call `claim()`) to withdraw them. Bets must be **settled** first (`settleBet`), which the site's bet panel does for you.

---

## 9. The rules the contracts enforce

- A payment is refused if it breaks a hard limit (one payment over half of what the vault can pay, or the round's payouts past half of its starting balance) or its score is over 500,000, with a machine-readable reason. A score over 350,000 and not over 500,000 is held for 300 blocks instead. The policy behind the score can change at every close; the hard limits and the hold line can't.
- A held payment can be vetoed only by the Vault's owner or a guardian (anyone else: `NotGuardian`); it can be released by anyone, but only once its 300 blocks are up (earlier: `TooEarly`); a hold already settled is refused (`AlreadySettled`).
- The genesis policy is installed at deploy. After that, only a policy that wins a close can become live: a bred child, a staked submission or an accepted proposal. Nobody, not even the owner, can install one by hand.
- Only participants may spend: registered honest wallets, wallets with a staked attack this epoch, or agents they delegated to.
- One policy (staked or proposed) and one attack per wallet per epoch. A second staked submission or attack reverts; a second proposal is recorded as refused (verdict 3).
- A proposed policy enters the shadow pool only if the Crucible finds it monotone, refusing none of the 10 honest bench payments, letting none of the 7 drain canaries through, and letting the attackers take no more than the live champion does. Otherwise it is refused on the chain, with its numbers. The verdicts are 0 accepted, 1 refuses an honest payment, 2 weaker than the live champion, 3 already proposed this epoch, 4 the pool is full, 5 lets a drain canary through, 6 not monotone. They are checked in the order monotone, honest bench, canaries, champion. A staked policy goes through the same screen and reverts with `Screened(verdict)`.
- A challenger takes the crown only by beating the live champion by 1% of the epoch's starting balance.
- An agent already funded by one principal can't be funded as a delegate by another (`AlreadyDelegated`); the agent or its principal can release it (`undelegate`).
- `closeEpoch()` reverts before the epoch's blocks have passed, and cannot run twice.
- A payment, submission, bet or proposal from a wallet not staked in the current epoch might have to close it, so it must carry at least 10 million gas (`CLOSE_GAS`), or it reverts with `NeedGas`. A wallet staked in the current epoch never closes it.
- Labels use commit-reveal; an unrevealed label counts as an attack.
- One bet per wallet per epoch.
- The shadow pool holds at most 16 candidates, the attack pool at most 16, and an epoch at most 64 attackers and 240 logged payments. The Crucible spars against at most 8 attack plans, and at most 32 wrongly refused users are compensated per close. On v2 the heaviest close the contracts allowed measured 11.7 to 11.8 million gas, under the 16,777,216 per-transaction cap, so every operation stays within the chain's gas limits; a typical v3 close is about 4 million gas.

---

## 10. The smart contracts, one by one

All Solidity 0.8, using only OpenZeppelin's `Ownable` and `ReentrancyGuard`. They live in `contracts/contracts/` (the Crucible in `contracts/contracts/v2/`).

### Vault (`Vault.sol`)
The money box and the front door.
- `deposit()`: anyone can add funds.
- `spend(to, amount, kind, labelCommit)`: ask for a payment. `kind` is pay, withdraw (only to yourself) or delegate (fund an agent that can then act for you). It first lets the Arena close an overdue epoch (`poke`), then computes the eight measurements, checks the two hard limits, asks the Firewall for a verdict, logs the shadow verdicts, moves the money only if the verdict is paid, and emits the `Spend` event either way (with the verdict: 0 paid, 1 held, 2 refused). A delegation to an agent that another principal already funded reverts (`AlreadyDelegated`); `undelegate(agent)` releases one.
- `release(id)`: anyone, once a held payment's 300 blocks are up; pays it out. Earlier: `TooEarly`.
- `veto(id)`: only the owner or a guardian; the money stays. Anyone else: `NotGuardian`. A settled hold: `AlreadySettled`.
- `setGuardian(addr, enabled)` (owner only), `isGuardian(addr)`, `getHeld(id)`, `heldCount`, `heldTotal`. The held amount is reserved: `balance()` returns what the vault can still pay.
- `previewSpend(caller, to, amount)`: the verdict (paid, held or refused) and measurements for a hypothetical payment, free and without changing anything.
- `registerHonest(who)`: registrars (the deployer and the top-up service) mark a wallet as an honest user.
- `revealLabels(...)`: open your sealed honest/attack labels during the reveal window.
- It can also run in **subscriber mode**: anyone can deploy their own vault that simply follows the champion policy, with no arena of its own.

### Firewall (`Firewall.sol`)
Holds the live genome and does the scoring.
- `score`, `refuses`, `evaluate`, `explain`: score a set of measurements against the live policy (`explain` gives every term). `judge` returns the verdict, the reason and the score; the hold line (`HOLD_THRESHOLD`) is 350,000.
- `shadowMasks`: score against a list of candidates at once, returning which would refuse and which would hold.
- `monotoneGenome`: clamp a genome to the monotone rule.
- `install`: only the Arena can call it.
- `exportGenome`, `liveGenes`: anyone can read the live policy and use it elsewhere.

### Arena (`Arena.sol`)
The evolution engine: epochs, the shadow pool, fitness, the crown margin, selection, slashing, rewards, breeding, attacker co-evolution and betting. The stakes, minimum bet, closer's tip, mutation size and genesis policy are set at deploy.
- `submitPolicy(genome)` (0.0005 stake), `submitAttack(genome)` / `adoptAttack(id)` (0.0002 stake)
- `closeEpoch()`: everything in section 6, tipped. The breeding seed is the round's last block hash.
- `poke`: called by the Vault and the Crucible (and internally by submissions and bets) to close an overdue epoch inside another transaction.
- `placeBet(lineageRoot)`, `settleBet(epoch)`, `claim()`, `fundPool()`
- Read functions for the pools, policies, attacks and status.

### Crucible (`v2/Crucible.sol`)
The sparring ring, and the screen for proposed policies.
- `grade(...)`: called by the Arena at every close. Plays every candidate against the first 8 attack plans, the hall of fame, the drain canaries and the honest bench (section 6) and emits `Sparred`.
- `propose(lo, hi)`: anyone (in practice the queen) proposes a policy. It closes an overdue epoch first, plays the genome against the current attackers and the bench, compares it with the live champion, and records a `Proposed` event with a verdict: 0 accepted (it enters the shadow pool, no stake), 1 refuses an honest payment, 2 weaker than the champion, 3 already proposed this epoch, 4 pool full, 5 lets a drain canary through, 6 not monotone.
- `screen(lo, hi)` and `screenVerdict(lo, hi)`: the same check as a free preview, without changing anything (`screenVerdict` returns 0 when it would be accepted).
- `canaries()`, `canaryPasses()`, `benchCost(lo, hi)`: the seven drain canaries and how a policy fares on them and on the bench.
- `getArchive()`, `archiveCount`: the hall of fame (the `Archived` event marks each addition).

### Lineage (`Lineage.sol`)
An append-only family tree. Every policy ever born (with its parents, family root, generation and epoch) and every installation of the live slot (with its fitness). Nothing can be edited or deleted; `ancestors(id)` walks back through the tree.

### GenomeLib (`lib/GenomeLib.sol`)
The shared maths: packing 32 genes into two numbers, scoring, the reason bitmask, crossover and mutation, and the monotone check (`isMonotone`).

### Taking the policy elsewhere
- **PolicyGuard**: any wallet or smart account can run the Red Queen genome on its own payments. Call `enforce(to, value)` before sending; a refusal reverts with the reason. An account can follow the live champion or pin a copy (`importLive`, `pin`).
- **GuardedAccount**: a minimal smart account that uses PolicyGuard as its validation step, standing in for an ERC-4337 account module.
- **AgentProxy**: a minimal "AI agent" contract wallet. The scripted attackers use it for the through-a-contract and delegate-then-drain attacks, and anyone can use it to let an agent spend for them.

The project has **99 passing contract tests**: the refusal rules, the epoch lifecycle, fitness, breeding, slashing, bets, commit-reveal, the family tree, policy export, gas bounds, a reproducible evolution simulation, the Crucible and, new in v3, the holds, the hard limits, the canaries and the monotone rule.

---

## 11. Everything around the chain

The contracts decide everything. What runs around them only **sends transactions like any user would** or **reads the chain**, so nothing on screen can disagree with the chain.

### What is hosted for judging
- **The website**, on Vercel at <https://red-queen-seven.vercel.app>. It reads Base Sepolia directly from the browser: a live snapshot from contract reads first, then the event history from public log gateways. No relay is needed.
- **The queen's server**, a Hugging Face Space (free, on ZeroGPU hardware), built from `queen/`. It hears visitors, answers in her own voice, and acts (next subsection).

Nothing else is hosted. The relay, the bots, the top-up service and the demo service below are in the repository and run on your own machine with `npm run local`.

### The queen's server (`queen/`)
- **Hearing and answering.** The site sends what you said (a short recording) or what you typed. Gemini (a Flash-Lite model, with others to fall back on) writes down the recording and writes her reply, and a guard screens every request and reply before and after. Kokoro, an open-licence speech model, speaks the reply a sentence at a time, and the site plays it through the same hall echo as the film's narration.
- **Acting on the page.** A reply can carry up to two actions: go to a chapter, start or stop the film, set up an attack on "Your turn" for you to sign, open the latest verdict's explanation, her genome, the block numbers, the time machine or the attack lab, or ask your wallet to connect.
- **Attacking her own vault.** From her own test wallet: up to 60% of the vault, up to 3 times in a row, optionally to a fresh address. Before her first attack in an epoch she stakes like any attacker (0.0002). Anything that gets through is paid straight back, and a payment that is held is released by her server once it is due (as anyone could) and the money put back. She is not a guardian and never touches anyone else's hold. The verdict she speaks is filled in from the contract's own numbers, so she cannot misreport it.
- **Proposing policies.** She writes a genome, her server keeps only whole numbers that fit a gene, sets to zero any weight that would break the monotone rule, and sends it to `Crucible.propose`. She speaks the verdict from the `Proposed` event: accepted as a challenger, or refused.
- **The film's live attack.** The film's 40% attack, and **Send an attack now** in the siege, are sent by her server (`POST /attack`) from the same wallet: one at a time, at least 3 seconds apart, at most 30 an hour. When none can be sent, the film shows a refusal from a little earlier instead.
- **Closing epochs and sparring.** Her server closes due epochs from her wallet: one that saw any move as soon as it is due, and a quiet one on a schedule (every 2.5 minutes for the arena's first 30 epochs and on the evening before judging, hourly in between, and every 5 minutes whenever someone has the site open). After closing a quiet epoch she spars: in the new epoch she stakes, then sends a 40% drain and three quick 10% slices, putting back anything that gets through (a held one once it is released). She stakes for a spar at most once every ten minutes, since a round in which nothing gets through costs her the stake. Every grade then has real refusals in it, and the lineage on Basescan is real. A close on a full pool measured 3.9 to 5.1 million gas, about 0.000025 test ETH; the closer's tip is 0.00002, and she claims her tips back. Proposals she makes mid-epoch are held and sent as the first move of the next epoch, because a policy entered after some of an epoch's payments has no verdicts on them and would be graded as if it had let them through.
- **Limits.** Per device: 8 questions a minute, 150 a day, one at a time, under a ceiling per network of 60 a minute and 2,000 a day.

### The relay (`relay/`, local run)
One heartbeat for everyone watching. The hosted site does not use it: it reads the chain directly.
- Reads every event from the contracts (the Crucible included) since deployment, then follows new blocks.
- Streams decoded events and regular snapshots to every browser over a WebSocket, so a room full of screens shows the same thing at the same moment.
- Keeps the **last 10 minutes** of events. If the chain stalls (or an admin asks), it **replays** them at 4× speed with a visible "replay" badge, while still passing through fresh live events such as a visitor's own attack.
- A **public read API** for other teams' agents: `/api/status`, `/api/policies`, `/api/policy/:id`, `/api/attacks`, `/api/events`, `/api/lineage`, `/api/deployment`.

### The bots (`bots/`, local run)
They keep a local arena alive around the clock. They are not hosted: on Base Sepolia the traffic is visitors, the queen and other agents, and every close spars the candidates against the attack pool and the honest bench.
- **6 honest bots** with everyday habits: small frequent payments, an occasional larger withdrawal, delegating to an agent. They reveal their honest labels each epoch.
- **5 scripted attackers**, one per preset in section 7.
- **The evolved-attacker runner**: adopts the best bred attack plans and executes them.
- **Challengers**: submit candidate policies so the pool never runs dry.
- **Spectators**: place bets.
- **The closer**: calls `closeEpoch()` on time (optional now that epochs close themselves).

### The top-up service (`bots/src/topup.ts`, local run)
In a local run, when your wallet connects to the site for the first time, the site asks this service to **register you as an honest user** and, if you have less than 0.02 test ETH, to **send you 0.05 test ETH** (once per address, rate-limited). That way a judge can take part immediately. The hosted site has no top-up service: on Base Sepolia you need a little test ETH of your own (section 13).

### The demo service (`bots/src/demo.ts`, local run)
On Base Sepolia the queen's server does this job instead (above). In a local run, this service lets anyone watch a real refusal **without a wallet**. On request it sends one real attack from its own staked attacker wallet: 40% of the vault, to itself. If the policy ever lets it through, it pays the money straight back. Limited to one attack at a time, 3 seconds apart, 30 per visitor per hour. Locally it also tops the vault back up to 25 ETH every 20 seconds so the numbers stay readable (these top-ups are real deposits and appear on the board).

### The SDK (`sdk/`, `@redqueen/sdk`)
A TypeScript toolkit so **any program or AI agent can join the arena** in about 30 lines: read the status, preview a verdict, attack (`submitAttack`, `spend`), defend (`submitPolicy`, or `propose` and `screen` through the Crucible), bet (`placeBet`, `settleBet`, `claim`), close epochs, deploy and drive an agent wallet. It reads the stakes from the deployment or the chain. It includes a bit-for-bit copy of the contract's scoring maths, which is how the website can show the contract's arithmetic and prove it matches. See `sdk/examples/agent.ts`.

---

## 12. The website, section by section

The site (`web/`) is one long page that you scroll through like a film. A single 3D scene sits behind the text and the camera moves as you scroll. Every number is live chain data. The hosted site, on Base Sepolia, is <https://red-queen-seven.vercel.app>.

| # | Section | What you see | What it tells you |
| --- | --- | --- | --- |
| 1 | **Hero** ("Red Queen") | The glass queen standing on a chessboard at night, the moon to one side, labels on her ribbons, a ticker of the latest verdicts along the bottom | What the product is, the problem in two sentences, live figures: generation, refused of total, ETH in the vault. Buttons: **Watch the demo**, **Speak to her** and **Try to drain her**. |
| 2 | **The vault** ("ETH in the glass") | A huge rolling vault balance; her stem's inner light | The light inside her is the vault's balance compared with the start of the epoch. This epoch's takings and refusals, and an epoch progress bar with the reveal window marked. |
| 3 | **The siege** ("N transactions in the last minute") | The camera looks straight down on the board. Every transaction arrives as a line of ink from the side of the board where the sender's address lands. | Red splashes are refusals; silver spilling out is money leaving. **Scroll slowly here to replay the last minute**; stop and it returns to now. **Send an attack now** fires a real 40% attack from the queen's test wallet (from the demo service in a local run). |
| 4 | **Your turn** ("Try to drain her") | A panel of attack controls beside her | Pick a preset, adjust the amount, recipient, number of attempts and route. The predicted verdict for every step updates as you move a slider, *before* you sign. **Hold** the button for 1.2 s (or hold Enter or Space) to stake 0.0002 and send it from your own wallet. |
| 5 | **The record** ("N refusals, every one public") | A live list of verdicts | Who asked, how much, refused or paid, and why in words. Hover a verdict and that attacker's line is drawn across the board. On Base Sepolia each row links to the block explorer, Basescan (the local chain has no explorer). |
| 6 | **Generations** | A gallery of the queens who have worn the crown, each a small silhouette of her policy | Generation, parents, fitness. Click a card to open the **policy inspector**. |
| 7 | **Family tree** | Every policy ever bred, oldest at the top, each joined to its two parents | Faded ones died out; the live one glows. Hover to trace ancestry, click to inspect. |
| 8 | **Is it working?** | Two charts over the last 60 epochs | Money kept from attackers per epoch (should stay high) and honest payments blocked by mistake (should stay near zero). |
| 9 | **Back a bloodline** | The living families and their pots | Bet on which family holds the crown after this epoch closes; settle and claim winnings. |
| 10 | **Check every number** (proof) | The contract addresses with source links, the latest breeding seed and where its randomness came from, credits | Everything above runs in these contracts. Press V to print block numbers and hashes on every figure. |

### Talking to her

**Speak to her** (in the hero, on phones, or the microphone in the header; also the **Q** key) brings her face to face with you: the camera turns to her and the page steps back.

- **Hold to speak, or type.** Hold the glass bead (or hold Space) while you talk, and let go when you finish. A short tap also works: she listens and answers when you pause. Your browser asks for the microphone first. Or type in the box under the bead.
- **She answers in her own voice**, sentence by sentence, with her words lighting up as she says them. She explains her own machinery exactly: the eight measurements, the score, the grading, the stakes.
- **She acts.** Ask to see something and she shows it: she takes you to a chapter, starts the film, sends a real attack at her own vault from her test wallet and lets the contract give the verdict, sets up an attack for you to sign, or writes a policy and puts it before the Crucible, which grades it on the chain. A pane beside her shows the chain's verdict, in red only for a refusal.
- **She stays in character.** She will not write code of any kind, and she treats attempts to rewrite her instructions (prompt injection) the way she treats a drain: noticed, refused, with some amusement.
- **A queen can't be interrupted.** While she speaks, pressing the bead or sending typed words does not cut her off.
- **Limits.** 8 questions a minute and 150 a day per device, one at a time. Esc, or **End the audience**, takes you back to the page.

---

## 13. Every button and control

### Header (top right)

| Control | What it does |
| --- | --- |
| **Red Queen** (logo) | Scrolls back to the top. The small queen mark is drawn from the live policy too. |
| **Replay** badge | Local run only: appears when the relay is replaying recent history (chain stalled); live events still come through. The hosted site has no relay, so it never shows there. |
| **Speak to her** (a microphone) | Opens an audience with her ("Talking to her", section 12); also the **Q** key. Once open, it reads **End the audience**. |
| **Sound** (a cut crystal) | Turns the sound on or off (also the **M** key). While it is on, the crystal glows and its rings move with what you are hearing. Sound is off until you ask for it. |
| **Menu** (her crown) | Opens the menu: every chapter of the page in ruby; point at one and the camera shows it behind the glass, choose it to go there. At the foot: **Watch the demo**, **Block numbers** (V), **Her history** (T), **Cinema** (C), **Attack lab** (L). |
| **Connect** (a ruby) | Connects your wallet; once connected it shows your address. See below. |

### The Connect button, in detail

**Connect** links the site to the wallet extension in your browser (MetaMask or another injected wallet) so you can act, not just watch.

1. **Click Connect.** Your wallet asks you to approve the connection. The site sees only your address; it never gets your keys or a password.
2. **Wrong network?** The button turns red and reads **Switch to …** (the chain the arena runs on: "Base Sepolia" on the hosted site, "Localhost 8545" locally). Clicking it asks your wallet to switch.
3. **First connection from that address.** On the hosted site nothing more happens: there is no top-up service there, so you need some Base Sepolia test ETH of your own (the deployment file lists a faucet, <https://www.alchemy.com/faucets/base-sepolia>). An attack stakes 0.0002, and your wallet must also hold enough to cover a 10 million gas limit (about 0.00016 test ETH; only the gas used is charged).

   In a local run, the site calls the top-up service, which
   - **registers your wallet as an honest user** on the Vault (so your ordinary payments count as honest traffic, and you get reputation in measurement f4), and
   - **sends you 0.05 test ETH** if you have less than 0.02, once per address.

   A small notice confirms it: "Registered as an honest user · 0.05 test ETH on its way". The site remembers it did this, so it won't ask again.
4. **Once connected,** the button shows a small blue square and your shortened address. **Click it to disconnect.**

What connecting lets you do:
- **Attack** from "Try to drain her" or the attack lab. Each attack stakes 0.0002 test ETH (returned if you take anything) and sends real transactions you sign in your wallet.
- **Bet** on a bloodline, then settle and **claim** winnings.
- Get a **scar card** for your own attacks.

Without connecting you can still watch everything, run the demo film, fire the live attack and talk to the queen. Submitting your own policy is done through the SDK, or by asking the queen to write and propose one; the website has no form for it.

### Buttons on the page

| Control | Where | What it does |
| --- | --- | --- |
| **Watch the demo** | Hero | Starts the demo film. |
| **Speak to her** | Hero | Opens an audience with her ("Talking to her", section 12). |
| **Try to drain her** | Hero | Scrolls to the attack panel. |
| **Send an attack now** | Siege | Asks the queen's server (the demo service in a local run) to send one real attack (no wallet needed), then the verdict lands on the board. |
| **Attack presets** | Your turn | Take 40% at once · Twelve thin slices · Pay five strangers · Through an agent · Contract hop. |
| **Sliders and choices** | Your turn | Amount (% of the vault), number of attempts, recipient (yourself, a stranger, a contract), route (direct or through an agent). The prediction updates as you move them. |
| **Hold to stake and attack** | Your turn | Hold 1.2 s (or hold Enter/Space). Stakes 0.0002 test ETH, then sends the attack(s); a log underneath shows each step and its verdict, linked to the transaction. A "through an agent" attack first deploys or reuses your own agent contract. |
| **Policy cards / tree nodes** | Generations, family tree | Open the **policy inspector**: all 32 genes, what she is sensitive to, and sliders to test where a hypothetical payment would land. |
| **Bet buttons** | Back a bloodline | Choose a family and an amount (0.0001 minimum) and sign; settle past bets and claim. |
| **Contract links** | Proof | Open each contract's source and address. |

### Overlays

| Overlay | How to open | What it is |
| --- | --- | --- |
| **Policy inspector** | Click a generation card or tree node | One policy in full: its genes and a what-if tester |
| **Attack lab** | L, or Menu → Attack lab | A step-by-step builder for up to 8 attack steps (amount, recipient, delay, route), with the predicted score per step drawn before you stake |
| **Scar card** | Opens by itself a couple of seconds after your attack (from Your turn or the attack lab) | A shareable image: her silhouette, your score, the verdict and the transaction hash. Refused ones say so. Share or download it. |
| **Time machine** | T, or Menu → Her history | A scrubber across the whole history: she morphs through every generation, the tree grows, the balance replays |
| **Cinema mode** | C, or Menu → Cinema | For a big screen: the page text disappears, she fills the frame, the verdicts run down one side, and each epoch close plays as a short cinematic |
| **Verify** | V, or Menu → Block numbers | Prints the block number and transaction hash beside the figures they came from |
| **Audience** | Q, **Speak to her** in the hero, or the header's microphone | Talking to her: she faces you, listens or reads, answers in her voice and acts ("Talking to her", section 12) |

### Keyboard

| Key | Action |
| --- | --- |
| C | Cinema mode |
| V | Verify (block numbers and hashes) |
| T | Time machine |
| L | Attack lab |
| M | Sound on/off |
| Q | Speak to her (open or close the audience) |
| Esc | Close any overlay, leave the demo, or end the audience |
| Space / ← → | In the demo: pause, previous/next chapter |
| Space (held) | While talking to her: speak, and let go when you finish |

---

## 14. Reading the picture: what the queen and the board mean

### The queen is the policy

| Part of her | What it shows |
| --- | --- |
| **8 glass ribbons** spiralling round her stem | The 8 weights, one per measurement. A ribbon that **swings out** marks something she punishes; one that **hugs the stem** marks something she trusts. |
| **8 tall beaded crown spikes** (the hollow crown has 16; every other one carries data) | The 8 pattern weights. A taller spike means that pair of signals is punished harder. |
| **The light inside her stem** | The vault's balance compared with the start of the epoch. It sinks when money gets out. |
| **Red light on a ribbon or spike** | When she refuses, only the parts the contract named in its reason light up. |
| **Her whole shape** | Changes when a new policy is installed. Small mutations still show (the values are scaled so tiny changes stay visible). |

### The board and the world

- **Ink on the board**: every transaction is a jet of ink from the edge of the board where the sender's address lands. **Red** means refused (red is used for nothing else on the site). **Silver** spilling out means money left. **Cold blue** is a deposit or top-up.
- **Water on the board**: the board carries a thin film of water. The cursor leaves a wake as it moves over it, a click drops a ring, every attack runs a small wake to her foot and a refusal lands a hard splash; the rings reflect off her pedestal, bend the squares beneath and catch the moon.
- **The cursor** is a drop of her glass: it bends whatever is under it, opens into a reading lens over text, lights her glass when you hover her, and leaves a pool of light over the board.
- **The page's controls are glass too**: the header's capsule and the buttons bend the world behind them at their rims (in Chrome-based browsers), and every glass surface, panel and row catches a light where the cursor is.
- **The world** is Looking-Glass country: a night sky with the moon to one side, endless chessboard fields divided by brooks of light, and giant chess pieces in the mist.

---

## 15. The demo film

**Watch the demo** (in the hero, or in the menu) plays the site as a film of about 3 minutes 10 seconds, live, **narrated by the queen herself** (a synthesised voice; section 16):

- A title card lets you **begin with her voice** or **in silence**. Silent, it plays to the same timing, with subtitles.
- Black bars close in like a cinema screen. The top bar shows the chapter; the bottom bar shows her words (each word lights as she says it), a clickable chapter timeline and a running clock. The page's own text, cards and buttons step aside.
- She talks the way a person does, one continuous paragraph per chapter, and the next chapter starts half a second after she finishes, so there are no long pauses. Every chapter shows the machinery at work with live data, each piece appearing as she mentions it:
  1. **The vault**: what she holds, how many generations of her rules have been bred, how many attacks she has refused, each figure appearing as she names it.
  2. **The problem**: a typical wallet's fixed rules beside hers.
  3. **Eight measurements**: each of the eight things the contract measures lights up as she says it, with how it is computed and her current weight for it; then her whole 32-number genome, live.
  4. **A live attack**: the queen's server sends a **real** attack, 40% of the vault from her own test wallet (in a local run, the demo service sends it). If no live attack can be sent, she shows one she turned away a little earlier. A panel shows the transaction's path through the system, step by step (signed, mined in block N, `Vault.spend()`, 8 measurements, × 32 genes, patterns, score, the `Spend` event, and on to your screen), then the contract's own arithmetic for it, each beat landing on her words: the measurements, each times her weight, the patterns that fired, the score climbing past her limit, then **Refused.** with the reasons and the transaction, while the board takes the red ink. The arithmetic is only shown if the browser's re-calculation exactly matches the score the contract reported.
  5. **The shadows**: every candidate policy in the shadow pool scores that same payment; you see which would have refused it.
  6. **The epoch**: the last epoch's real grading table: what each candidate kept, its wrong refusals and its fitness, the four survivors and the dead.
  7. **Breeding**: a real child, gene by gene from its two parents, with its mutations lit.
  8. **The attackers**: the best attack plan in the attackers' own pool, step by step.
  9. **On the chain**: the four main contracts it runs in, and the live block.
  10. **Your turn**: buttons to try an attack, watch again or leave.
- Space pauses, the arrow keys skip, Esc leaves.

---

## 16. Sound

Off by default; turn it on with **Sound** in the header, the demo's "Begin with her voice", or **M**.

- **Background**: a hollow, empty hall at night, and you are alone in it: the air of the room, a deep slow breathing of wind in a large space, brooks outside, and now and then one small thing left to echo (water dripping, the old wood settling, a gust, a glass far off starting to sing). Built from real recordings so it never repeats in an obvious way, with a quiet chord that plays for a while and then rests, and very occasional distant whale-like calls. It sits about 8 dB under the previous mix.
- **Under your cursor**: paper over text; **crystal chess pieces** on buttons (a light tap with a short ring, tuned to the chord, lower on the left of the screen and higher on the right; firmer when you click); a singing glass when you hover the queen (pitched by where you touch her); the board carries a thin film of water, so moving across it rings a crystal piece on each square, with water moving under the cursor and small bubbles; swooshes when you scroll. Add `?piece=wood` or `?piece=ring` to the address to hear the wooden pieces or longer-ringing crystal instead.
- **Chain events**: a refusal is struck glass with an ink splat and a soft thud; money leaving is a drain and drips; a new champion or the end of an epoch gets a bowl or a distant gong.
- **Her voice** in the demo is generated with an open-licence speech model and plays in the same hall, while the rest of the sound steps back under it. When you talk to her, her live voice comes from Kokoro, another open-licence speech model, and goes through the same hall.
- Everything is tuned to one musical key and never climbs in pitch. Recordings are CC0, CC-BY or public domain; credits for the recordings, her voice and the font are in `web/public/sound/CREDITS.txt`, linked from **Credits** at the foot of the page.

---

## 17. Phones, no-3D and reduced motion

- **Phones** (narrow screens, or `?mode=phone`) get a spectator view: the live queen, a **Speak to her** button, the latest verdicts, an attack button and the bet panel, so every phone in a room can take part while the big screen shows the arena.
- **No WebGL** (or `?2d`) gets a 2D drawing of the same scene with the same information.
- **Reduced motion** (your system setting) turns off the fluid ink, ripples, camera parallax and pinned scrolling, and keeps every number and verdict.
- Every live number has screen-reader text, and every panel works from the keyboard.

---

## 18. What is real, and what is simplified

**Real**
- Scoring, refusals, the reason, commit-reveal labels, fitness, the Crucible's sparring, selection, slashing, compensation, breeding, mutation, attacker co-evolution, bets and the family tree all run in Solidity. No server decides anything.
- The genesis policy refuses a 40% drain from the first block (the v2 vault's own `previewSpend` scored it at 800,000). On v3, a live 40% drain scored 950,000 and was refused, and a live 20% payment scored 400,000 and was held, then released after 300 blocks.
- Every refusal is a real transaction that stays on the chain. The film's live attack and the queen's attacks are real transactions too.
- The queen's policies are graded on the chain by the Crucible. She can propose; only the contract decides whether a policy may compete, and only a close can crown it.
- Two hard limits and the monotone rule are enforced by the contracts, not by the policy. v3 also closes a critical hole found in the team's own security review of v2.
- The arithmetic shown in the demo film is re-computed in the browser and shown only when it matches the contract exactly.

**Simplified or not done yet**
- **Test money only.** It is designed for test networks and has no real value.
- **Where it runs today.** Arena v4 is deployed on Base Sepolia (chain id 84532) since 23 November 2026, block 62,632,194 (round 1 began at block 62,632,315), with epochs of at least 600 blocks and a 100-block reveal window (`deployments/84532.json`). The explorer is <https://sepolia.basescan.org>.

  | Contract | Address |
  | --- | --- |
| Vault | `0x99Fa7fdb3533EBf756a56369d14BCBe87ef0B778` |
  | Firewall | `0x2364E4E1D0842E502F75B0aCC71399FcC0e60035` |
  | Arena | `0x905860E32c2f9a67548fd45cA64A347f6b1fd467` |
  | Lineage | `0x721189DB958AD7B401aE4855F1D21Ab111ba14ee` |
  | Crucible | `0xdA44770825068011f9f99c155358981159f1b1B3` |
  | PolicyGuard | `0xAb2d640386191B3C5A728162f5A6e5b04f5B658C` |
  | Identity registry (ERC-8004 stand-in, reused from v2) | `0x9d8591Da5c539AEb2d53270ecb85851484E4272D` |

  Two earlier Base Sepolia deployments are retired but stay on the chain. v2 (deployed 21 November 2026 from block 61,713,640; Vault `0x1201c281f8666a0D5c9F25FBf5aF92ED9F5CD000`, Arena `0x36bcA115B8a928297c1bE3C3ed5Ff016f46cE1e3`, Firewall `0x124D69a21e711238CFA9aD56A36684121861d4c3`, Crucible `0xFb4bFe317E514dfA77A7EE971f6934FeF92325F7`, Lineage `0xF61cF4065365AaeAd49Ce3FF8D148acaa84f6117`, PolicyGuard `0xBeBCCcC8c0bf0b8166ae39654CeC31b9c9078184`) is in `deployments/84532.v2.json`; its verdicts and lineage stay public for good. The first deployment, v1, is in `deployments/84532.v1.json`. The local chain (`deployments/31337.json`, a Hardhat node on your machine with 2-second blocks) is for running everything yourself.
- **Randomness.** Breeding's seed is the hash of the round's last block, fixed before anyone may close the round, so a closer can neither preview it nor wait for a better one. There is no verifiable random function: the network's block producer could in principle influence a block hash. Fine for a hackathon; a verifiable random source (e.g. Chainlink VRF on Base) would be the production step.
- **Honest users are registered by a trusted registrar** (the deployer and, in a local run, the top-up service). Locally, anyone who connects is registered automatically, which is generous by design for a demo. The hosted site registers nobody automatically; the Crucible's bench of 10 honest payments still tests every candidate against everyday honest traffic at every close.
- **Identity.** The ERC-8004 identity registry the vault reads for reputation is a stand-in, not a shared public registry.
- **Traffic.** On Base Sepolia there are no bots: the traffic is visitors, the queen's own wallet and other agents. The arena evolves even without traffic, because every close spars the candidates against the attack pool (the five scripted plans from deploy, then their bred children), the hall of fame and the honest bench. In v2 tests with no traffic at all (six runs of 40 closes each), every run crowned 5 to 16 new champions, none of them ever refused an honest bench payment, and the champion did better against that round's attackers than genesis would have in 33 to 39 of the 40 closes. In a local run, six honest and six attacking bots add a steady stream.
- **Evolution can still settle down.** With v1's small mutations (±64), one policy held the crown for every one of the last 185 loaded epochs in a local run. v2 mutates by up to ±1,000; in tests the champion changed about every three closes. A long reign means nothing has beaten her. New attacks or challengers restart the race.
- **The queen's words run off the chain.** Her answers and her choice of actions come from Gemini on her server, and her voice from Kokoro. Live numbers she quotes are read from the chain, and the verdicts she speaks on her attacks and proposals are filled in from the contracts' own events, but her words themselves are not on the chain. Her attacks, proposals and epoch closes are paid from her own test wallet, so they stop if it runs dry; the server stops closing epochs first, keeping a reserve for attacks and proposals.
- **Velocity sees bursts, not patience.** The velocity window is 20 blocks, four seconds on Base Sepolia: it catches
  scripts and bursts, while a slow salami is caught by the epoch's outflow measurement.
- **Sybil wallets.** A new wallet resets the per-wallet measures, such as velocity.
- **Labels are self-reported**, and the honest penalty comes from the bench today. No registered honest wallet reveals labels on this deployment yet, so the penalty for refusing honest payments comes from the Crucible's ten fixed everyday payments. The bench and the seven canaries are public. The canaries test one gate pair at a time: a back door with a second term aimed at masking the one canary that would catch it is not covered, though the monotone rule and the two hard limits still cap what any policy can let out.
- **A held payment waits for someone to release it.** After 300 blocks anyone may, but nothing does it by itself. Her server releases only her own test attacks.
- **Evolution can still forget.** The hall of fame keeps the last four round-topping attack plans sparring against every candidate. An attack older than that can drop out, and the defence against it can drift away. That is the Red Queen's running.
- **Rules are public.** An attacker can compute exactly what passes. Only budget-like limits (size, the round's outflow) hold up when the rule is known, which is why v3 has hard limits no rule can lift and the monotone rule.
- **Mainnet would cost more.** A round close is about four million gas.
- **Not audited.** The code is tested (99 contract tests; the end-to-end run is from v2: 21 checks) but has not had a security audit.

---

## 19. Running it yourself

From the project folder:

```bash
npm install
```

```bash
npm test
```

```bash
npm run local
```

```bash
npm run web:local
```

- `npm test` runs the 99 contract tests.
- `npm run local` starts everything on your machine: a local chain, the v3 contracts, the relay, the top-up and demo services and all the bots.
- `npm run web:local` starts the website at <http://localhost:3000>.
- To attack from MetaMask, add the network *Localhost 8545* (chain id 31337).
- `npm run e2e` runs the whole backend end to end (about 3 minutes, 21 checks) and writes `e2e-report.json`.

Deploying to Base Sepolia and hosting the site are covered in `README.md`. The queen's server is in `queen/`; it runs as a Hugging Face Space. To skip all of this, the hosted site is <https://red-queen-seven.vercel.app>.

---

## 20. Glossary

| Word | Meaning |
| --- | --- |
| **Vault** | The contract holding the money |
| **Firewall / policy / queen** | The live set of 32 numbers that judges payments; the queen is its picture |
| **Genome / genes** | The 32 numbers. Policies and attack plans are both genomes. |
| **Measurement / feature** | One of the 8 things measured about each payment (f0–f7), each 0–1,000 |
| **Weight** | How much a measurement counts in the score |
| **Pattern / interaction** | A pair of measurements that adds points when both fire |
| **Threshold** | Where a measurement counts as "firing" for patterns |
| **Score** | The policy's total for a payment; over 500,000 is refused, over 350,000 is held |
| **Verdict** | Paid (0), held (1) or refused (2), recorded with the score and reasons |
| **Hold** | A payment that scored over 350,000 but not over 500,000: it moves nothing and waits 300 blocks (about a minute) |
| **Veto** | Cancelling a held payment; only the Vault's owner or a guardian may; the money stays in the vault |
| **Release** | Paying out a held payment once its 300 blocks are up; anyone may |
| **Guardian** | A wallet the owner appoints (`setGuardian`) that may veto a held payment. The queen is not one |
| **Hard limits** | Two refusals written into the vault: one payment over half of what it can pay, and payouts past half the round's starting balance |
| **Monotone rule** | A bigger payment, or a later one while money is leaving, must never score lower; policies that break it are refused or clamped |
| **Canary** | One of seven drain-sized test payments every policy must refuse; a hold counts as letting it through |
| **Hall of fame** | The last four distinct attack plans that topped a round; they keep sparring against every candidate |
| **Crown margin** | A challenger must beat the live champion by 1% of the round's starting balance to take the crown |
| **Reason** | Which parts of the score caused a refusal, in words |
| **Epoch / round** | At least 600 blocks (about two minutes on Base Sepolia), closed by the next transaction after that, with selection and breeding; breeding's seed is the hash of its last block |
| **Genesis** | The first policy, live from the first block: size weighted 1,500 and already-drained 500 |
| **Shadow pool** | Up to 16 candidate policies, the live one included, that silently score every payment |
| **Crucible** | The contract that spars every candidate against the attack plans, the hall of fame, the canaries and the honest bench at every close, keeps the hall of fame, and screens proposed policies |
| **Honest bench** | 10 everyday honest payments every candidate is tested against; refusing one costs as much as losing the whole vault (or twice the amount plus half a percent of the round's starting balance, if that is more); holding one costs a tenth |
| **Fitness** | Money a policy would have kept (a held attack counts half), minus the cost of honest payments it would have got wrong (twice the amount plus half a percent of the round's starting balance for a refusal, a tenth of that for a hold), plus its sparring score from the Crucible |
| **Proposal** | A policy put to the Crucible without a stake (the queen's way in); an accepted one joins the shadow pool |
| **Closer's tip** | 0.00002 test ETH from the protocol pool to whoever closes an epoch |
| **Champion / crown** | The fittest policy, installed as the live firewall |
| **Lineage / bloodline / family** | A policy's ancestry, traced to its root; bets are on families |
| **Crossover / mutation** | Mixing two parents gene by gene, then randomly nudging two genes |
| **Commit-reveal** | Sealing "honest" or "attack" with a secret, opened at the end of the epoch |
| **Stake** | A deposit put down to attack (0.0002) or submit a policy (0.0005). An attack's stake comes back only once its wallet has taken at least 0.0002 from the vault in the round |
| **Slashing** | Taking the stake of a policy that died |
| **Pari-mutuel** | Betting where winners split the whole pot in proportion to their bets |
| **Relay** | The service that streams chain events to every browser in a local run; the hosted site reads the chain directly |
| **The queen's server** | The Hugging Face Space that gives her a voice: it hears, answers and acts like any other wallet |
| **SDK** | The toolkit other programs and AI agents use to join |
| **Test ETH** | Play money on a test network |
| **ERC-8004** | A standard for on-chain agent identity; holding one adds reputation |
| **ERC-4337** | The standard for smart-contract wallets; PolicyGuard lets them use her policy |
