"use client";
import { useMemo } from "react";
import { useAccount, useBalance, useConnect, useDisconnect, usePublicClient, useSwitchChain, useWalletClient } from "wagmi";
import { RedQueen, type Deployment } from "@redqueen/sdk";
import type { PublicClient } from "viem";
import { useArena } from "@/lib/store";
import { chain } from "@/lib/wallet";
import { eth, short } from "@/lib/format";
import { Btn } from "./primitives";
import { useGlass } from "./Glass";

export function WalletButton({ compact = false, jewel = false }: { compact?: boolean; jewel?: boolean }) {
  const { address, chainId, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const bal = useBalance({ address, query: { refetchInterval: 8000 } });
  const glass = useGlass<HTMLButtonElement>({ bevel: 10, frost: 8 });
  if (jewel) {
    // the header's capsule of red glass: connect, switch network, or the connected address
    const injected = connectors[0];
    const act = !isConnected ? () => injected && connect({ connector: injected }) : chainId !== chain.id ? () => switchChain({ chainId: chain.id }) : () => disconnect();
    return (
      <span className="jewel-wrap">
        <button ref={glass} className="lq lq-pill" onClick={act} disabled={!isConnected && (!injected || isPending)} title={isConnected && chainId === chain.id ? "Disconnect this wallet" : undefined}>
          {!isConnected ? (isPending ? "Connecting" : "Connect") : chainId !== chain.id ? `Switch to ${chain.name}` : <span className="hash">{short(address, 4)}</span>}
        </button>
      </span>
    );
  }
  if (!isConnected) {
    const injected = connectors[0];
    return (
      <Btn tone="bone" label="connect" onClick={() => injected && connect({ connector: injected })} disabled={!injected || isPending}>
        {isPending ? "Connecting…" : compact ? "Connect" : "Connect a test wallet"}
      </Btn>
    );
  }
  if (chainId !== chain.id) {
    return (
      <Btn tone="hot" onClick={() => switchChain({ chainId: chain.id })}>
        Switch to {chain.name}
      </Btn>
    );
  }
  return (
    <button onClick={() => disconnect()} className="btn btn-quiet gap-2.5" title="Disconnect this wallet">
      <span className="h-[6px] w-[6px] rounded-full bg-cold" style={{ boxShadow: "0 0 10px var(--cold)" }} aria-hidden />
      <span className="hash">{short(address, 4)}</span>
      {!compact ? <span className="num text-ivory-2">{eth(bal.data?.value, 3)} ETH</span> : null}
    </button>
  );
}

/** A RedQueen SDK instance bound to the connected MetaMask wallet. */
export function useRedQueen(): RedQueen | null {
  const d = useArena((s) => s.deployment);
  const pub = usePublicClient();
  const { data: wallet } = useWalletClient();
  return useMemo(() => {
    if (!d || !pub) return null;
    return new RedQueen({
      deployment: d as Deployment,
      publicClient: pub as unknown as PublicClient,
      walletClient: wallet ?? undefined,
    });
  }, [d, pub, wallet]);
}
