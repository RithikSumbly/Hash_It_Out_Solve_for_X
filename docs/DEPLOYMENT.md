# Deploying Red Queen

The hosted arena has three parts: the contracts on Base Sepolia, the site on Vercel and the Red Queen's server on a
Hugging Face Space. The relay, bots and top-up service are optional extras for a busier arena. Every command runs from
the repository root. Use test wallets only, and never commit `.env`.

## 1. Test wallets

Add two new accounts to MetaMask and the Base Sepolia network (chain 84532, RPC `https://sepolia.base.org`, explorer
`https://sepolia.basescan.org`):

- **The deployer** deploys the contracts and funds the vault. A deployment costs about 0.0046 test ETH in gas, plus
  0.004 for the vault and 0.0005 for the protocol pool: about 0.01 in all. It becomes the Vault's owner.
- **The queen's wallet** sends her attacks, proposals, round closes and sparring. Each round she attacks in stakes
  0.0002; a proposal or a close costs about 0.00003 in gas, and a close earns a small tip back while the pool lasts.
  0.005 covers a long run of sparring; add more if she should top up visitors' wallets.

Fund the deployer from a Base Sepolia faucet, then send the queen's share to her account.

## 2. Contracts

```bash
cp .env.example .env
```

Fill in `DEPLOYER_PRIVATE_KEY` (the test account only). The defaults suit Base Sepolia: a 600-block round (about two
minutes), a 100-block reveal window, 0.004 ETH in the vault and 0.0005 in the pool. Then:

```bash
npm run deploy:base
```

This deploys the Vault, Firewall, Arena, Crucible, Lineage and PolicyGuard (and a test identity registry if
`IDENTITY_REGISTRY` is empty), wires them together, seeds the genesis policy and the scripted attack plans, funds the
vault and the pool, and writes `deployments/84532.json` and `sdk/src/deployments.ts` (addresses only). The site and the
queen's server read these files.

To estimate the cost first without sending anything:

```bash
DRY_RUN=1 FORK_URL=https://sepolia.base.org DEPLOYER_ADDRESS=<deployer address> npm -w contracts exec -- hardhat run scripts/deploy.ts
```

To verify the source on Basescan (needs `ETHERSCAN_API_KEY`):

```bash
npm -w contracts exec -- hardhat run scripts/verify.ts --network baseSepolia
```

**Guardians.** A guardian may veto a held payment. Set `GUARDIAN=<address>` before deploying, or call
`setGuardian(address, true)` on the Vault from the owner wallet afterwards. Anyone else calling `veto` is refused with
`NotGuardian`.

Other networks: `npm run deploy:sepolia` for Ethereum Sepolia, or set `CUSTOM_RPC_URL` and `CUSTOM_CHAIN_ID` and run
`npx hardhat run scripts/deploy.ts --network custom` from `contracts/`.

## 3. The site (Vercel)

Import the repository in Vercel with Root Directory `web` (keep "Include files outside the root directory" on; the site
uses the `sdk` workspace) and framework Next.js. One environment variable:

```
NEXT_PUBLIC_CHAIN_ID=84532
```

Everything else has a working default on Base Sepolia: public RPCs for reads, wide-range gateways for history, and the
queen's Space for her voice and the film's live attack. Optional: `NEXT_PUBLIC_RPC_URL`, `NEXT_PUBLIC_LOGS_RPC_URL`,
`NEXT_PUBLIC_QUEEN_URL` (another Space), `NEXT_PUBLIC_RELAY_URL` and `NEXT_PUBLIC_TOPUP_URL` (step 5).

To build locally:

```bash
npm run build:web
```

## 4. The Red Queen's server (Hugging Face Space)

1. Create a Space with SDK Gradio and hardware ZeroGPU. The app runs on the Space's CPU; only the voice line borrows a
   GPU.
2. Upload the contents of `queen/`.
3. In the Space settings add the secrets `GEMINI_API_KEY` (Google AI Studio) and `DEMO_PRIVATE_KEY` (the queen's
   wallet). Optional settings are listed in `queen/.env.example` and `queen/README.md`.
4. Open `https://<space>.hf.space/health`: `gemini` and `attacks` must be `true`, and `wallet.eth` shows her balance.

Her keeper closes rounds that are due: at once when the round saw activity, and on a schedule when it was quiet. After
a quiet close she spars (a stake-sized payment, a 40% drain and smaller slices against the new champion) so every
grade has real refusals in it. Anything that gets through is put straight back, and held payments are released by her
keeper when due and returned.

If the site is hosted on another domain, add it to `SITE_ORIGINS` so browsers may call her.

## 5. Optional: relay, bots and top-up

These make the arena busier and give visitors test ETH when they connect. On any always-on Node host, run each as a
service:

| Service | Start command | Public |
|---|---|---|
| Relay | `npm run relay` | yes (WebSocket) |
| Top-up | `npm -w bots run topup` | yes |
| Bots | `npm run bots` | no |

Shared variables: `CHAIN_ID=84532`, `RPC_URL`, `DEPLOYER_PRIVATE_KEY`, `BOT_MNEMONIC` (a fresh test mnemonic),
`BOT_TARGET_ETH`, `TOPUP_ETH`, `TOPUP_MIN_ETH`, `RELAY_ADMIN_TOKEN`. Fund the bot wallets once with
`npm -w bots run fund`, then set `NEXT_PUBLIC_RELAY_URL` and `NEXT_PUBLIC_TOPUP_URL` on the site.
`spaces/arena/` packages all three behind one gateway as a container.

## 6. Checks

- The queen's wallet on Basescan holds enough for her schedule; `/health` shows it too.
- The site loads the vault and its history; *Watch the demo* plays and its attack is refused.
- With MetaMask on Base Sepolia, *Try to drain her* sends an attack and the verdict appears with its transaction.
- A 20% payment is held, and a veto from a wallet that is not a guardian is refused (`NotGuardian`).
