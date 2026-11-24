"use client";
import { createConfig, fallback, http } from "wagmi";
import { injected } from "@wagmi/core";
import { defineChain } from "viem";
import { baseSepolia, hardhat, sepolia } from "viem/chains";
import { CHAIN_ID, READ_URLS, RPC_URL } from "./config";

export const chain =
  CHAIN_ID === 84532
    ? { ...baseSepolia, rpcUrls: { default: { http: [RPC_URL] } } }
    : CHAIN_ID === 11155111
    ? { ...sepolia, rpcUrls: { default: { http: [RPC_URL] } } }
    : CHAIN_ID === 31337
      ? { ...hardhat, rpcUrls: { default: { http: [RPC_URL] } } }
      : defineChain({
          id: CHAIN_ID,
          name: `Chain ${CHAIN_ID}`,
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: { default: { http: [RPC_URL] } },
        });

export const wagmiConfig = createConfig({
  chains: [chain],
  connectors: [injected({ shimDisconnect: true })],
  transports: { [chain.id]: readTransport() },
  ssr: true,
});

/** Reads try each endpoint in READ_URLS in turn: a rate-limited one hands over at once instead of retrying. */
export function readTransport(batch = false) {
  return READ_URLS.length > 1 ? fallback(READ_URLS.map((u) => http(u, { batch, retryCount: 0 }))) : http(READ_URLS[0], { batch });
}
