---
title: Red Queen Arena
emoji: ♛
colorFrom: red
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
short_description: Relay, demo attack, top-up and bots for the Red Queen arena
---

# Red Queen · arena service

Runs the live side of [Red Queen](https://red-queen-seven.vercel.app) on Base Sepolia: the relay that streams
contract events to every visitor, the demo attack the film sends, the visitors' test-ETH top-up, and the bots
(honest users, attackers, challengers, the epoch closer) that keep the arena alive.

Routes: `/` status · `/topup/...` · `/demo/...` · everything else (WebSockets too) is the relay.

Secrets (Settings → Variables and secrets): `DEPLOYER_PRIVATE_KEY`, `BOT_MNEMONIC`, `RELAY_ADMIN_TOKEN`, and
optionally `RPC_URL` (a private Base Sepolia RPC), `OFF` (services to leave off, e.g. `bots`).

Source: the `spaces/arena/` folder of the Red Queen repository.
