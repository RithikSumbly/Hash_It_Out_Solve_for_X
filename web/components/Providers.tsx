"use client";
import { useEffect, type ReactNode } from "react";
import { WagmiProvider, useAccount } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createPublicClient, http, type Log } from "viem";
import { connectRelay, decodeLog, eventAddresses, RedQueen, sortEvents, type Deployment } from "@redqueen/sdk";
import { readTransport, wagmiConfig } from "@/lib/wallet";
import { arena } from "@/lib/store";
import { ui } from "@/lib/ui";
import { scene } from "@/lib/scene";
import { sound } from "@/lib/sound";
import { bus } from "@/lib/bus";
import { ethWords, HELD_LINE } from "@/lib/words";
import { BUNDLED_DEPLOYMENT, LOG_SOURCES, RELAY_URL, TOPUP_URL, explorerTx } from "@/lib/config";

const queryClient = new QueryClient();

/** Relay first (one heartbeat for the room); straight to the chain if the relay is unreachable. */
function useArenaConnection() {
  useEffect(() => {
    let direct: (() => void) | null = null;
    let gotHello = false;
    let opened = false;
    // no relay configured (a hosted build before the relay is up): straight to the chain
    if (!RELAY_URL) {
      if (BUNDLED_DEPLOYMENT) direct = readChainDirectly(BUNDLED_DEPLOYMENT);
      return () => direct?.();
    }
    const relay = connectRelay(RELAY_URL, {
      onStatus: (s) => {
        if (s === "open") opened = true;
        arena.setStatus(s);
      },
      onHello: (m) => {
        gotHello = true;
        direct?.();
        direct = null;
        arena.setDeployment(m.deployment);
        arena.load(m.history);
        if (m.snapshot) arena.setSnapshot(m.snapshot);
        arena.setMode(m.mode);
      },
      onEvent: (e) => arena.push(e),
      onSnapshot: (s) => arena.setSnapshot(s),
      onMode: (m) => arena.setMode(m),
    });
    // read the chain directly only if the relay could not be reached (not while its hello is still arriving)
    const fallback = setTimeout(() => {
      if (!gotHello && !opened && BUNDLED_DEPLOYMENT) direct = readChainDirectly(BUNDLED_DEPLOYMENT);
    }, 6000);
    return () => {
      clearTimeout(fallback);
      relay.close();
      direct?.();
    };
  }, []);
}

/**
 * Direct-to-chain mode: the same events, decoded in the browser. The live snapshot (contract reads) comes first, so
 * the page has numbers at once; the history follows from a log gateway that takes wide block ranges (LOG_SOURCES),
 * moving to the next source when one refuses. Events found before a failure are kept.
 */
function readChainDirectly(d: Deployment) {
  const pub = createPublicClient({ transport: readTransport(true) });
  const logClients = LOG_SOURCES.map((s) => ({ ...s, client: createPublicClient({ transport: http(s.url) }) }));
  let src = 0;
  const rq = new RedQueen({ deployment: d, publicClient: pub });
  // the Crucible's verdicts on proposed policies are shown in the roles section
  const addresses = eventAddresses(d);
  let cursor = BigInt(d.deployBlock);
  let stopped = false;
  let first = true;
  const history: ReturnType<typeof decodeLog>[] = [];
  // Block times: gateways that return `blockTimestamp` on each log need no other request. Otherwise one anchor block
  // and the chain's measured block interval place every block, instead of a request per block (hundreds of
  // sequential requests on a busy deployment, which the public endpoint rate-limits until history never loads).
  let anchor: { block: bigint; time: number; interval: number } | null = null;
  const timeOf = async (l: Log) => {
    const stamped = (l as Log & { blockTimestamp?: bigint | null }).blockTimestamp;
    if (stamped != null) return Number(stamped);
    if (!anchor) {
      const [a, b] = await Promise.all([pub.getBlock({ blockNumber: BigInt(d.deployBlock) }), pub.getBlock()]);
      const span = Number(b.number - a.number);
      anchor = { block: b.number, time: Number(b.timestamp), interval: span > 0 ? (Number(b.timestamp) - Number(a.timestamp)) / span : 2 };
    }
    return Math.round(anchor.time - Number(anchor.block - l.blockNumber!) * anchor.interval);
  };
  arena.setDeployment(d);
  arena.setStatus("open");
  const tick = async () => {
    if (stopped) return;
    // the snapshot and the history are fetched side by side: the first screen waits for both
    const snap = rq
      .snapshot()
      .then((s) => arena.setSnapshot(s))
      .catch(() => {
        /* the next tick tries again */
      });
    try {
      const head = await pub.getBlockNumber();
      while (cursor <= head) {
        const { client, span } = logClients[src];
        const to = cursor + span - 1n < head ? cursor + span - 1n : head;
        const logs = (await client.getLogs({ address: addresses, fromBlock: cursor, toBlock: to })) as Log[];
        // a chunk counts only once all of it is decoded, so a failure part-way never leaves duplicates behind
        const found: ReturnType<typeof decodeLog>[] = [];
        for (const l of logs) {
          const e = decodeLog(d, l, await timeOf(l));
          if (e) found.push(e);
        }
        history.push(...found);
        cursor = to + 1n;
      }
      const batch = history.splice(0).filter((e): e is NonNullable<typeof e> => !!e).sort(sortEvents);
      if (first) {
        arena.load(batch);
        first = false;
      } else for (const e of batch) arena.push(e);
    } catch {
      // this source refused (range, rate or outage): the next one, from where we stopped
      src = (src + 1) % logClients.length;
    }
    await snap;
    if (!stopped) setTimeout(tick, 4000);
  };
  tick();
  return () => {
    stopped = true;
  };
}

/** First visit with MetaMask: test ETH if the wallet is empty (and, with the local service, registration as an honest user). */
function useJudgeOnboarding() {
  const { address } = useAccount();
  useEffect(() => {
    ui.set({ me: address ?? null });
    window.dispatchEvent(new CustomEvent("rq:me", { detail: address ?? null }));
    if (!address || !TOPUP_URL) return;
    const key = `rq:topup:${address.toLowerCase()}`;
    try {
      if (localStorage.getItem(key)) return;
    } catch {
      /* private mode */
    }
    fetch(`${TOPUP_URL}/topup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address }) })
      .then((r) => r.json())
      .then((j: { ok?: boolean; sent?: string; registered?: boolean; error?: string }) => {
        if (j.ok) {
          try {
            localStorage.setItem(key, "1");
          } catch {
            /* ignore */
          }
          const sent = j.sent && j.sent !== "0" ? j.sent : null;
          // the local service also registers the wallet as honest; her server (Base Sepolia) only sends test ETH
          const line = j.registered
            ? sent
              ? `Registered as an honest user · ${sent} test ETH on its way`
              : "Registered as an honest user"
            : sent
            ? `${sent} test ETH is in your wallet: enough to try an attack`
            : null;
          if (line) ui.toast(line, "cold");
        }
      })
      .catch(() => {});
  }, [address]);
}

/**
 * The visitor's own payments that the rule holds. A toast when one is held (wherever it was sent from), and again
 * when it is paid out or vetoed.
 */
function useHoldToasts() {
  useEffect(
    () =>
      bus.on((e) => {
        if (e.type !== "chain" || e.replay) return;
        const ev = e.event;
        if (ev.name !== "Held" && ev.name !== "Released" && ev.name !== "Vetoed") return;
        const me = ui.get().me?.toLowerCase();
        const h = arena.get().holds.get(String(ev.args.id));
        if (!me || !h || (h.from.toLowerCase() !== me && h.to.toLowerCase() !== me)) return;
        const href = explorerTx(arena.get().deployment, ev.txHash) ?? undefined;
        if (ev.name === "Held") ui.toast(`Your payment of ${ethWords(h.amount, 5)} ETH is held. ${HELD_LINE.replace(/^Held: i/, "I")}`, "held", href);
        else if (ev.name === "Released") ui.toast(`Your held payment was paid out: ${ethWords(h.amount, 5)} ETH.`, "cold", href);
        else ui.toast(`Your held payment was vetoed. The ${ethWords(h.amount, 5)} ETH stayed in the vault.`, "held", href);
      }),
    [],
  );
}

/** Global keys: F full screen, C cinema (full screen without the interface), V verify, T time machine, M sound, L attack lab, Esc close. */
function useKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.metaKey || e.ctrlKey || e.altKey) return;
      const s = ui.get();
      const k = e.key.toLowerCase();
      if (k === "c") {
        const on = !s.cinema;
        ui.set({ cinema: on });
        scene.cinema = on;
        if (on) document.documentElement.requestFullscreen?.().catch(() => {});
        else if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
      } else if (k === "f") {
        // plain full screen: the browser's tabs and bars go, the site stays as it is
        if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
        else document.documentElement.requestFullscreen?.().catch(() => {});
      } else if (k === "v") ui.set({ verify: !s.verify });
      else if (k === "t") {
        const on = !s.timeMachine.on;
        ui.set({ timeMachine: { ...s.timeMachine, on, playing: false, index: Math.max(0, arena.get().installs.length - 1) } });
        if (!on) scene.overrideGenes = null;
      } else if (k === "m") {
        if (s.sound) sound.disable();
        else sound.enable();
        ui.set({ sound: !s.sound });
      } else if (k === "l") ui.set({ lab: !s.lab });
      else if (k === "escape") {
        if (s.cinema) {
          ui.set({ cinema: false });
          scene.cinema = false;
        }
        ui.set({ inspector: null, lab: false, scar: null, timeMachine: { ...s.timeMachine, on: false } });
        scene.overrideGenes = null;
      }
    };
    const onFs = () => {
      if (!document.fullscreenElement && ui.get().cinema) {
        ui.set({ cinema: false });
        scene.cinema = false;
      }
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("fullscreenchange", onFs);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("fullscreenchange", onFs);
    };
  }, []);
}

function Inner({ children }: { children: ReactNode }) {
  useArenaConnection();
  useJudgeOnboarding();
  useHoldToasts();
  useKeys();
  return <>{children}</>;
}

export function Providers({ children }: { children: ReactNode }) {
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    scene.reducedMotion = mq.matches;
    const onChange = () => (scene.reducedMotion = mq.matches);
    mq.addEventListener("change", onChange);
    const params = new URLSearchParams(window.location.search);
    let webgl = false;
    try {
      const c = document.createElement("canvas");
      const g = c.getContext("webgl2");
      // the glass pipeline renders into half-float targets; without them it would draw black
      webgl = !!g && !!(g.getExtension("EXT_color_buffer_float") || g.getExtension("EXT_color_buffer_half_float"));
      g?.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {
      webgl = false;
    }
    const phone = params.get("mode") === "phone" || (window.matchMedia("(max-width: 720px)").matches && params.get("mode") !== "desktop");
    ui.set({ webgl: webgl && params.get("2d") === null, phone });
    // inspection handle for debugging and the venue operator console
    const w = window as unknown as { __rq?: Record<string, unknown> };
    w.__rq = { ...(w.__rq ?? {}), scene, arena, ui };
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <Inner>{children}</Inner>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
