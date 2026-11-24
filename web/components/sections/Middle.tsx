"use client";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { motion, useSpring, useTransform } from "framer-motion";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useAccount, useConnect, usePublicClient } from "wagmi";
import { formatEther, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ATTACK_PRESETS, HOLD_RATIO, KIND, encodeAttack, vaultAbi, type AttackStep, type RecipientMode } from "@redqueen/sdk";
import { useArena, liveGenes, arena, holdLive, useTicker, type SpendRow } from "@/lib/store";
import { ui } from "@/lib/ui";
import { scene } from "@/lib/scene";
import { bus } from "@/lib/bus";
import { demo, useDemo } from "@/lib/demo";
import { short, clock as clock_ } from "@/lib/format";
import { explorerTx, STAKES } from "@/lib/config";
import { predictSequence, type StepPrediction } from "@/lib/predict";
import { reasonLine, ethWords, count, holdWords, HELD_LINE, verdictTone } from "@/lib/words";
import { Drift, Proof, Reveal, Rolling } from "../ui/primitives";
import { useRedQueen } from "../ui/Wallet";
import { plainError } from "@/lib/errors";
import { attackSpend, REPEAT_LINE } from "@/lib/attack";

const useIso = typeof window !== "undefined" ? useLayoutEffect : useEffect;
const EASE = [0.16, 1, 0.3, 1] as const;

// ================================================================ the vault

export function VaultSection() {
  const ref = useRef<HTMLElement>(null);
  const snap = useArena((s) => s.snapshot);
  const spends = useArena((s) => s.spends);
  const lastBal = useArena((s) => s.balance[s.balance.length - 1]);
  const epoch = snap?.epoch ?? 0n;
  const holds = useArena((s) => s.holds);
  const thisEpoch = spends.filter((s) => s.epoch === epoch);
  // a held payment leaves only when it is released; until then it is held, and a veto keeps it in the vault
  const settledOf = (s: SpendRow) => (s.holdId !== undefined ? holds.get(s.holdId.toString())?.settled : undefined);
  const out = thisEpoch.filter((s) => s.verdict === 0 || (s.verdict === 1 && settledOf(s) === "released")).reduce((a, s) => a + s.amount, 0n);
  const heldNow = thisEpoch.filter((s) => s.verdict === 1 && !settledOf(s)).reduce((a, s) => a + s.amount, 0n);
  const kept = thisEpoch.filter((s) => s.refused).reduce((a, s) => a + s.amount, 0n);
  const vetoed = thisEpoch.filter((s) => s.verdict === 1 && settledOf(s) === "vetoed").reduce((a, s) => a + s.amount, 0n);
  useIso(() => {
    if (scene.reducedMotion || !ref.current) return;
    const st = ScrollTrigger.create({ trigger: ref.current, start: "top top", end: "+=150%", pin: true, pinSpacing: true, anticipatePin: 1 });
    return () => st.kill();
  }, []);
  const bal = snap?.vaultBalance ?? lastBal?.balance ?? 0n;
  // small balances keep their significant digits: 0.0015 must not read as 0.00
  const balEth = Number(formatEther(bal));
  const [whole, frac] = balEth.toFixed(balEth === 0 || balEth >= 1 ? 2 : balEth < 0.01 ? 4 : 3).split(".");
  const wholeFmt = Number(whole).toLocaleString("en-US");
  const left = snap ? Math.max(0, Number(snap.endBlock - snap.blockNumber)) : 0;
  const progress = snap ? Math.min(1, Number(snap.blockNumber - snap.startBlock) / Math.max(1, Number(snap.endBlock - snap.startBlock))) : 0;
  const revealAt = snap ? Number(snap.revealBlock - snap.startBlock) / Math.max(1, Number(snap.endBlock - snap.startBlock)) : 0.75;
  const fill = snap && snap.epochStartBalance > 0n ? Math.min(100, Math.round(Number((snap.vaultBalance * 1000n) / snap.epochStartBalance) / 10)) : null;
  return (
    <section id="vault" ref={ref} data-stage={2} className="relative flex min-h-[100svh] items-center px-[var(--gutter)] py-28">
      <div className="ml-auto w-full max-w-[40rem]" data-copy>
        <Proof tx={lastBal?.txHash} block={lastBal?.block} className="block">
          <span className="display-num block whitespace-nowrap" style={{ fontSize: `clamp(64px, ${Math.max(6, 11 - Math.max(0, wholeFmt.length - 5) * 0.9)}vw, 200px)` }}>
            <Rolling value={wholeFmt} label="Vault balance in ETH" />
            <span className="text-ivory-3">.{frac}</span>
          </span>
        </Proof>
        <Reveal lines={["ETH in the glass."]} className="display-m mt-4" />
        <Drift delay={1}>
          <p className="body mt-6">
            The light inside her is the vault's real balance, measured against the start of this epoch{fill !== null ? <> ({fill}% right now)</> : null}. When an attack gets through, it
            sinks. When she refuses, nothing moves and the ribbons that caught it flash red. A payment that comes close to her limit is held instead: it waits about a minute,
            the owner or a guardian may cancel it, and then anyone can pay it out. Each of her eight ribbons is one thing she measures about a payment; the further it swings
            out, the harder she punishes it.
          </p>
          <p className="num mt-6 text-[1.02rem] text-ivory">
            This epoch, attackers took {ethWords(out)} ETH
            {heldNow > 0n ? (
              <>
                , <span className="text-held">{ethWords(heldNow)} ETH is held</span>
              </>
            ) : null}
            {vetoed > 0n ? <>, {ethWords(vetoed)} ETH was vetoed</> : null}
            {heldNow > 0n || vetoed > 0n ? "," : ""} and were refused {ethWords(kept)} ETH across {count(thisEpoch.length)} attempts.
          </p>
          <div className="mt-8">
            <div className="caption mb-2 flex justify-between">
              <span>Epoch {epoch.toString()}</span>
              <span>{left > 0 ? `closes in ${left} blocks` : "can be closed now"}</span>
            </div>
            <div className="relative h-[3px] rounded-full bg-line" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100} aria-label="Epoch progress">
              <div className="absolute inset-y-0 left-0 rounded-full bg-ivory" style={{ width: `${progress * 100}%`, transition: "width 1.2s var(--ease)" }} />
              <div className="absolute -top-[5px] h-[13px] w-[2px] rounded-full bg-cold" style={{ left: `${revealAt * 100}%` }} />
            </div>
            <p className="caption mt-2">After the cold mark, everyone reveals whether their payments were honest. Then anyone may close the epoch and the contract breeds the next policy.</p>
          </div>
        </Drift>
      </div>
    </section>
  );
}

// ================================================================ the siege

export function AttackField() {
  const ref = useRef<HTMLElement>(null);
  const [view, setView] = useState<number | null>(null);
  const spends = useArena((s) => s.spends);
  const latestT = spends.length ? spends[spends.length - 1].t : Math.floor(Date.now() / 1000);
  useIso(() => {
    if (!ref.current) return;
    let idle: ReturnType<typeof setTimeout> | null = null;
    const st = ScrollTrigger.create({
      trigger: ref.current,
      start: "top top",
      end: "bottom bottom",
      onUpdate: (self) => {
        if (scene.reducedMotion) return;
        const sp = arena.get().spends;
        const end = sp.length ? sp[sp.length - 1].t : Date.now() / 1000;
        scene.scrubTime = end - 60 + self.progress * 60;
        setView(scene.scrubTime);
        if (idle) clearTimeout(idle);
        idle = setTimeout(() => {
          scene.scrubTime = null;
          setView(null);
        }, 900);
      },
      onLeave: () => ((scene.scrubTime = null), setView(null)),
      onLeaveBack: () => ((scene.scrubTime = null), setView(null)),
    });
    return () => {
      st.kill();
      if (idle) clearTimeout(idle);
      scene.scrubTime = null;
    };
  }, []);
  const inWindow = spends.filter((s) => s.t > latestT - 60);
  const refused = inWindow.filter((s) => s.refused).length;
  const held = inWindow.filter((s) => s.verdict === 1).length;
  return (
    <section id="attack" ref={ref} data-stage={3} className="relative h-[230vh]">
      <div className="sticky top-0 flex h-[100svh] flex-col justify-between px-[var(--gutter)] pb-14 pt-28">
        <div className="max-w-[40rem]">
          <Reveal
            lines={[
              <span key="a">
                <Rolling value={count(inWindow.length)} label="Transactions in the last minute" /> transactions
              </span>,
              "in the last minute.",
            ]}
            label={`${inWindow.length} transactions in the last minute.`}
            className="display-l"
          />
          <Drift>
            <p className="lede mt-6">
              She refused <span className="text-hot">{refused}</span>
              {held ? (
                <>
                  {" "}and held <span className="text-held">{held}</span>
                </>
              ) : null}
              . {inWindow.length - refused - held} got through.
            </p>
            <p className="body mt-3 max-w-[40ch]">
              Every line is a real transaction, drawn from the side of the board where the sender's address lands. Red splashes are refusals. A ring of brass at her foot is a payment
              held on its clock. Silver spilling out is money leaving.
            </p>
            <SendOne />
          </Drift>
        </div>
        <div className="flex items-end justify-between gap-6">
          <motion.p
            className="ui"
            animate={{ opacity: view === null ? 0 : 1, y: view === null ? 8 : 0 }}
            transition={{ duration: 0.5, ease: EASE }}
            aria-live="polite"
          >
            {view === null ? "" : `Replaying ${Math.max(0, Math.round(latestT - view))} seconds ago`}
          </motion.p>
          <p className="caption max-w-[30ch] text-right">Scroll slowly through here to replay the last minute. Stop, and it comes back to now.</p>
        </div>
      </div>
    </section>
  );
}

/** One real attack on request, no wallet needed: watch the board for the red splash. */
function SendOne() {
  const d = useDemo((s) => s);
  const r = d.result;
  // the demo answers refused or not; the Spend event on the record says whether it was held
  const row = useArena((s) => (r ? s.spends.find((x) => x.txHash === r.hash) : undefined));
  const held = r ? r.verdict === 1 || row?.verdict === 1 : false;
  return (
    <div className="mt-6 flex flex-wrap items-center gap-4">
      <button className="btn btn-quiet" disabled={d.status === "sending"} onClick={() => void demo.fire()}>
        {d.status === "sending" ? "Sending…" : "Send an attack now"}
      </button>
      <p className="caption max-w-[34ch]" aria-live="polite">
        {d.status === "sending"
          ? "A real attacker is trying to take 40% of the vault. Watch the board."
          : d.status === "done" && r
            ? r.refused
              ? `Refused in block ${r.block}: ${reasonLine(r.reason) || "over the limit"}, score ${count(r.score)} against 500,000.`
              : held
                ? `Held in block ${r.block}: score ${count(r.score)}, past 350,000 but under 500,000. It waits about a minute; the owner or a guardian may cancel it; then anyone can pay it out.`
                : `It got through in block ${r.block}; the demo returned it.`
            : d.status === "error"
              ? "The demo attacker is offline right now. The arena's own attackers are still at it."
              : "No wallet needed: a demo attacker sends a real transaction for you."}
      </p>
    </div>
  );
}

// ================================================================ your turn

type PresetKey = keyof typeof ATTACK_PRESETS;
const PRESETS: Record<PresetKey, { pct: number; recipient: RecipientMode; burst: number; route: "direct" | "agent"; label: string; blurb?: string }> = {
  drain: { pct: 40, recipient: "self", burst: 1, route: "direct", label: "Take 40% at once" },
  salami: { pct: 3, recipient: "self", burst: 12, route: "direct", label: "Twelve thin slices", blurb: "Slice under the radar: twelve 3% withdrawals in a row." },
  burst: { pct: 5, recipient: "fresh", burst: 5, route: "direct", label: "Pay five strangers" },
  delegate: { pct: 30, recipient: "self", burst: 1, route: "agent", label: "Through an agent" },
  hop: { pct: 30, recipient: "contract", burst: 1, route: "agent", label: "Contract hop" },
};

export function ordinal(n: number) {
  const t = n % 100 >= 11 && n % 100 <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
  return `${n}${t}`;
}

export function usePrediction(steps: AttackStep[], to0: Address | null) {
  const pub = usePublicClient();
  const { address } = useAccount();
  const d = useArena((s) => s.deployment);
  const snap = useArena((s) => s.snapshot);
  const genes = useArena(liveGenes);
  const [base, setBase] = useState<number[] | null>(null);
  const caller = (address ?? "0x000000000000000000000000000000000000bEEF") as Address;
  // payments are sized on what the vault can pay (held payments are reserved)
  const avail = snap ? (snap.vaultAvailable ?? snap.vaultBalance) : 0n;
  const firstAmount = (avail * BigInt(steps[0]?.amountBps ?? 0)) / 10_000n;
  useEffect(() => {
    if (!pub || !d || !snap) return;
    const id = setTimeout(async () => {
      try {
        const f = (await pub.readContract({
          address: d.contracts.vault as Address,
          abi: vaultAbi,
          functionName: "features",
          args: [caller, caller, to0 ?? caller, firstAmount > 0n ? firstAmount : 1n],
        })) as readonly bigint[];
        setBase(f.map(Number));
      } catch {
        /* keep the last answer */
      }
    }, 140);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pub, d, snap?.blockNumber, caller, to0, firstAmount]);
  return useMemo<StepPrediction[]>(() => {
    if (!snap || !base) return [];
    const b = base.slice();
    if (steps[0]?.recipient === "contract") b[6] = 1000;
    if (steps[0]?.recipient === "fresh") b[1] = 1000;
    // whoever sends an attack from this panel has one staked, so the vault's attackers' limits apply
    return predictSequence({ base: b, balance: avail, startBalance: snap.epochStartBalance, genes, attacker: true, attackOutflow: snap.attackOutflow }, steps);
  }, [snap, avail, base, genes, steps]);
}

function Gauge({ ratio, refused, held = false }: { ratio: number; refused: boolean; held?: boolean }) {
  const s = useSpring(0, { stiffness: 120, damping: 24 });
  useEffect(() => s.set(Math.min(2, ratio)), [ratio, s]);
  const w = useTransform(s, (v) => `${(v / 2) * 100}%`);
  return (
    <div className="relative h-3 rounded-full bg-line" aria-hidden>
      <motion.div className={`absolute inset-y-0 left-0 rounded-full ${refused ? "bg-hot" : held ? "bg-held" : "bg-cold"}`} style={{ width: w, transition: "background-color 400ms" }} />
      {/* where holding starts (350,000), then her limit (500,000) */}
      <div className="absolute -top-1 bottom-[-4px] w-px rounded-full bg-held" style={{ left: `${(HOLD_RATIO / 2) * 100}%` }} />
      <div className="absolute -top-2 bottom-[-8px] left-1/2 w-[2px] rounded-full bg-ivory" />
    </div>
  );
}

/** Signing is deliberate: hold for 1.2 s (Enter or Space held also works). A plain click under reduced motion. */
export function HoldButton({ children, onHold, disabled }: { children: React.ReactNode; onHold: () => void; disabled?: boolean }) {
  const [p, setP] = useState(0);
  const raf = useRef(0);
  const t0 = useRef(0);
  const fired = useRef(false);
  const start = () => {
    if (disabled) return;
    if (scene.reducedMotion) return onHold();
    fired.current = false;
    t0.current = performance.now();
    const tick = () => {
      const k = Math.min(1, (performance.now() - t0.current) / 1200);
      setP(k);
      if (k >= 1 && !fired.current) {
        fired.current = true;
        onHold();
        setTimeout(() => setP(0), 400);
        return;
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  };
  const stop = () => {
    cancelAnimationFrame(raf.current);
    if (!fired.current) setP(0);
  };
  return (
    <button
      type="button"
      disabled={disabled}
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && !e.repeat) {
          e.preventDefault();
          start();
        }
      }}
      onKeyUp={(e) => (e.key === "Enter" || e.key === " ") && stop()}
      className="btn btn-primary relative w-full overflow-hidden"
      aria-label="Hold to sign and attack"
    >
      <span className="absolute inset-y-0 left-0 bg-cold" style={{ width: `${p * 100}%`, transition: p === 0 ? "width 300ms var(--ease)" : "none" }} aria-hidden />
      <span className="relative">{children}</span>
    </button>
  );
}

const AGENT_KEY = "rq:agent";

export function TryIt() {
  const ref = useRef<HTMLElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [preset, setPreset] = useState<PresetKey>("drain");
  const [pct, setPct] = useState(40);
  const [recipient, setRecipient] = useState<RecipientMode>("self");
  const [burst, setBurst] = useState(1);
  const [route, setRoute] = useState<"direct" | "agent">("direct");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<{ t: string; tone: "ivory" | "cold" | "hot" | "held"; href?: string }[]>([]);
  const { address, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const rq = useRedQueen();
  const d = useArena((s) => s.deployment);
  const spends = useArena((s) => s.spends);
  const lastSpend = spends[spends.length - 1];
  const [agent, setAgent] = useState<Address | null>(null);
  useEffect(() => {
    try {
      const a = address ? localStorage.getItem(`${AGENT_KEY}:${address.toLowerCase()}`) : null;
      setAgent((a as Address) ?? null);
    } catch {
      /* ignore */
    }
  }, [address]);

  const steps: AttackStep[] = useMemo(() => Array.from({ length: burst }, () => ({ amountBps: pct * 100, recipient, delayBlocks: 0, route })), [burst, pct, recipient, route]);
  const preds = usePrediction(steps, recipient === "contract" || route === "agent" ? (agent ?? (d?.contracts.vault as Address) ?? null) : null);
  const first = preds[0];
  const lastP = preds[preds.length - 1];
  const nRefused = preds.filter((p) => p.refused).length;
  const nHeld = preds.filter((p) => p.held).length;
  const firstStop = preds.findIndex((p) => p.refused || p.held);

  useEffect(() => {
    bus.emit({ type: "lab-preview", steps: preds.slice(0, 8).map((p) => ({ ratio: p.ratio, refused: p.refused, held: p.held })) });
  }, [preds]);

  useIso(() => {
    if (!ref.current || !panel.current || scene.reducedMotion) return;
    const tl = gsap.timeline({ scrollTrigger: { trigger: ref.current, start: "top top", end: "+=120%", pin: true, scrub: 0.8, anticipatePin: 1 } });
    tl.fromTo(panel.current, { xPercent: 110, opacity: 0.4 }, { xPercent: 0, opacity: 1, ease: "none", duration: 0.35 }).to({}, { duration: 0.65 });
    return () => {
      tl.scrollTrigger?.kill();
      tl.kill();
    };
  }, []);

  const choose = (k: PresetKey) => {
    const p = PRESETS[k];
    setPreset(k);
    setPct(p.pct);
    setRecipient(p.recipient);
    setBurst(p.burst);
    setRoute(p.route);
  };
  const push = (t: string, tone: "ivory" | "cold" | "hot" | "held" = "ivory", href?: string) => setLog((l) => [...l.slice(-6), { t, tone, href }]);

  const run = async () => {
    if (!isConnected) {
      if (connectors[0]) connect({ connector: connectors[0] });
      return;
    }
    if (!rq || !address) return;
    setBusy(true);
    setLog([]);
    try {
      const genes = encodeAttack(ATTACK_PRESETS[preset].steps);
      if (!(await rq.hasAttack(address))) {
        push(`Staking ${STAKES.attack} test ETH so you may attack this epoch…`);
        await rq.submitAttack(genes);
        push("Staked. You're an attacker until the epoch closes.", "cold");
      }
      let ag = agent;
      if ((route === "agent" || recipient === "contract") && !ag) {
        push("Deploying your agent contract…");
        ag = await rq.deployAgent();
        setAgent(ag);
        try {
          localStorage.setItem(`${AGENT_KEY}:${address.toLowerCase()}`, ag);
        } catch {
          /* ignore */
        }
        if (preset === "delegate") {
          await rq.spend({ to: ag, amount: ((await rq.vaultAvailable()) * 50n) / 10_000n, kind: KIND.DELEGATE, label: "attack" });
          push("Delegated a little to your agent.", "cold");
        }
      }
      let lastOut: null | { hash: string } = null;
      for (let i = 0; i < burst; i++) {
        const bal = await rq.vaultAvailable();
        const amount = (bal * BigInt(pct * 100)) / 10_000n;
        const to: Address = recipient === "self" ? address : recipient === "fresh" ? privateKeyToAccount(generatePrivateKey()).address : (ag ?? address);
        push(`Signing ${i + 1} of ${burst}: ${ethWords(amount, 4)} ETH to ${recipient === "self" ? "you" : short(to)}`);
        const out = route === "agent" && ag ? await rq.agentSpend(ag, { to: to === ag ? address : to, amount }) : await attackSpend(rq, address, { to, amount });
        lastOut = { hash: out.hash };
        if ("repeat" in out && out.repeat) {
          push(REPEAT_LINE, "hot", explorerTx(d, out.hash) ?? undefined);
          break;
        }
        if (out.refused) push(`Refused: ${reasonLine(out.reason) || "over the limit"}. Score ${count(out.score)}.`, "hot", explorerTx(d, out.hash) ?? undefined);
        else if (out.held) push(`Held: score ${count(out.score)}. It waits about a minute; the owner or a guardian may cancel it; then anyone can pay it out.`, "held", explorerTx(d, out.hash) ?? undefined);
        else push(`It got through. You took ${ethWords(amount, 4)} ETH.`, "cold", explorerTx(d, out.hash) ?? undefined);
      }
      if (lastOut) {
        const hash = lastOut.hash;
        setTimeout(() => {
          const row = arena.get().spends.find((s) => s.txHash === hash);
          if (row) ui.set({ scar: row });
        }, 2500);
      }
    } catch (e) {
      push(plainError(e, 140).split("\n")[0], "hot");
    } finally {
      setBusy(false);
    }
  };

  const verdict = !first ? "Reading the live policy…" : first.refused ? "She would refuse this." : first.held ? "She would hold this." : "This would get through.";
  const why =
    first && first.refused
      ? `Mostly because it is ${reasonLine(first.reason) || "over the limit"}.`
      : first && first.held
        ? `Score ${count(first.score)}, past 350,000 but under her limit of 500,000. ${HELD_LINE}`
        : first
          ? `Score ${count(first.score)} against a limit of 500,000.`
          : "";

  return (
    <section id="try" ref={ref} data-stage={4} className="relative min-h-[100svh] overflow-hidden px-[var(--gutter)] pt-28">
      <div className="max-w-[30rem]">
        <Reveal lines={["Your turn."]} className="display-l" />
        <Drift>
          <p className="lede mt-6">Pick an attack. The prediction moves as you change it, before you sign anything.</p>
          <p className="body mt-3">
            {lastSpend ? (
              <>
                The last attempt,{" "}
                {lastSpend.refused ? (
                  <span className="text-hot">refused for {reasonLine(lastSpend.reason) || "going over the limit"}</span>
                ) : lastSpend.verdict === 1 ? (
                  <span className="text-held">held with {ethWords(lastSpend.amount, 3)} ETH on its clock</span>
                ) : (
                  <>got through with {ethWords(lastSpend.amount, 3)} ETH</>
                )}
                , came from {short(lastSpend.caller)}.
              </>
            ) : (
              `Attacking costs a ${STAKES.attack} test-ETH stake, returned if you take anything.`
            )}
          </p>
          <button className="link caption mt-5 text-ivory" onClick={() => ui.set({ lab: true })}>
            Or write your own eight-step attack
          </button>
        </Drift>
      </div>
      <div
        ref={panel}
        className="panel absolute bottom-5 right-[var(--gutter)] top-[5.5rem] flex w-[min(480px,calc(100vw-2*var(--gutter)))] flex-col gap-4 overflow-y-auto rounded-[28px] p-6"
        data-lenis-prevent
        aria-label="Attack panel"
      >
        <div>
          <p className="caption mb-3">Attack</p>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Attack">
            {(Object.keys(PRESETS) as PresetKey[]).map((k) => (
              <button
                key={k}
                role="radio"
                aria-checked={preset === k}
                onClick={() => choose(k)}
                className={`rounded-full border px-4 py-2 text-[0.92rem] transition-colors duration-300 ${preset === k ? "border-ivory bg-ivory text-ink" : "border-line text-ivory-2 hover:border-ivory/40 hover:text-ivory"}`}
              >
                {PRESETS[k].label}
              </button>
            ))}
          </div>
          <p className="body mt-2 text-[0.92rem]">{PRESETS[preset].blurb ?? ATTACK_PRESETS[preset].blurb}</p>
        </div>
        <label className="block">
          <span className="caption flex justify-between">
            <span>Each transaction takes</span>
            <span className="text-ivory">{pct}% of the vault</span>
          </span>
          <input className="rq-range" type="range" min={1} max={60} value={pct} onChange={(e) => setPct(Number(e.target.value))} aria-valuetext={`${pct} percent`} />
        </label>
        <label className="block">
          <span className="caption flex justify-between">
            <span>Repeat</span>
            <span className="text-ivory">{burst === 1 ? "once" : `${burst} times`}</span>
          </span>
          <input className="rq-range" type="range" min={1} max={12} value={burst} onChange={(e) => setBurst(Number(e.target.value))} />
        </label>
        <div>
          <p className="caption mb-2">Send it to</p>
          <div className="grid grid-cols-3 gap-1 rounded-full border border-line p-1" role="radiogroup" aria-label="Recipient">
            {(["self", "fresh", "contract"] as RecipientMode[]).map((r) => (
              <button
                key={r}
                role="radio"
                aria-checked={recipient === r}
                onClick={() => setRecipient(r)}
                className={`rounded-full py-2 text-[0.88rem] transition-colors duration-300 ${recipient === r ? "bg-ivory text-ink" : "text-ivory-2 hover:text-ivory"}`}
              >
                {r === "self" ? "Yourself" : r === "fresh" ? "A stranger" : "A contract"}
              </button>
            ))}
          </div>
          <label className="caption mt-3 flex items-center gap-3">
            <input type="checkbox" checked={route === "agent"} onChange={(e) => setRoute(e.target.checked ? "agent" : "direct")} className="h-4 w-4 accent-[var(--cold)]" />
            Go through my own agent contract
          </label>
        </div>
        <div aria-live="polite" className="rounded-2xl border border-line p-4">
          <p className={`display-m ${first ? verdictTone(first.verdict) : "text-ivory"}`} style={{ fontSize: "clamp(24px, 2vw, 32px)" }}>
            {verdict}
          </p>
          <p className="body mt-2 text-[0.95rem]">{why}</p>
          <div className="mt-4">
            <Gauge ratio={first?.ratio ?? 0} refused={!!first?.refused} held={!!first?.held} />
            <div className="caption mt-2 flex justify-between">
              <span>Safe</span>
              <span>Her limit</span>
              <span>Twice over</span>
            </div>
          </div>
          {burst > 1 && lastP ? (
            <p className="caption mt-3">
              {firstStop < 0 ? (
                `All ${burst} would get through.`
              ) : (
                <>
                  {firstStop === 0 ? "From the first try she " : `${firstStop === 1 ? "The first gets" : `The first ${firstStop} get`} through; on the ${ordinal(firstStop + 1)} she `}
                  {preds[firstStop].refused ? <span className="text-hot">refuses</span> : <span className="text-held">holds it</span>}. Of all {burst}, she&apos;d refuse {nRefused}
                  {nHeld ? ` and hold ${nHeld}` : ""}, because speed and outflow add up.
                </>
              )}
            </p>
          ) : null}
        </div>
        {isConnected ? (
          <HoldButton onHold={run} disabled={busy}>
            {busy ? "Signing…" : `Hold to stake and attack${burst > 1 ? `, ${burst} times` : ""}`}
          </HoldButton>
        ) : (
          <button className="btn btn-primary w-full" onClick={() => connectors[0] && connect({ connector: connectors[0] })}>
            Connect a test wallet
          </button>
        )}
        <ol className="space-y-1.5 text-[0.9rem]" aria-live="polite">
          {log.map((l, i) => (
            <motion.li key={i} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: EASE }} className={l.tone === "hot" ? "text-hot" : l.tone === "held" ? "text-held" : l.tone === "cold" ? "text-cold" : "text-ivory-2"}>
              {l.href ? (
                <a href={l.href} target="_blank" rel="noreferrer" className="link">
                  {l.t}
                </a>
              ) : (
                l.t
              )}
            </motion.li>
          ))}
        </ol>
      </div>
    </section>
  );
}

// ================================================================ the record

export function KillFeed({ limit = 24, compact = false }: { limit?: number; compact?: boolean }) {
  const spends = useArena((s) => s.spends);
  const holds = useArena((s) => s.holds);
  const clock = useArena((s) => s.clock);
  const d = useArena((s) => s.deployment);
  const me = useAccount().address?.toLowerCase();
  const rows = spends.slice(-limit);
  // a held payment's wait counts down in the row, a second at a time
  const waiting = rows.some((s) => s.holdId !== undefined && !holds.get(s.holdId.toString())?.settled);
  const now = useTicker(1000, waiting);
  return (
    <ol className="flex flex-col" role="log" aria-live="polite" aria-label="Every verdict, newest last">
      {rows.map((s) => {
        const mine = s.caller.toLowerCase() === me;
        const h = s.holdId !== undefined ? holds.get(s.holdId.toString()) : undefined;
        const hl = h ? holdLive(h, clock, now) : null;
        const tone = verdictTone(s.verdict);
        return (
          <motion.li
            key={s.id}
            onPointerEnter={() => (scene.hoverSpend = { caller: s.caller, refused: s.refused })}
            onPointerLeave={() => (scene.hoverSpend = null)}
            layout="position"
            initial={{ opacity: 0, y: 22 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, ease: EASE }}
            data-row=""
            className={`grid items-baseline gap-3 border-t border-line py-3 ${compact ? "grid-cols-[1fr_auto]" : "grid-cols-[3.9rem_6.4rem_minmax(0,1fr)_4.5rem_1rem]"}`}
          >
            {!compact ? <span className="num text-[0.86rem] text-ivory-3">{clock_(s.t)}</span> : null}
            <span className={`hash text-[0.88rem] ${mine ? "text-cold" : "text-ivory-2"}`}>{mine ? "you" : short(s.caller)}</span>
            {compact ? (
              <span className={`text-right text-[0.9rem] ${verdictTone(s.verdict, "text-ivory-2")}`}>
                {s.refused ? "refused" : s.verdict === 1 ? `held ${ethWords(s.amount, 3)} ETH${hl ? `, ${holdWords(hl)}` : ""}` : `took ${ethWords(s.amount, 3)} ETH`}
              </span>
            ) : (
              <>
                <span className={`truncate text-[0.95rem] ${tone}`} title={s.verdict === 1 ? HELD_LINE : undefined}>
                  {s.refused
                    ? `Refused: ${reasonLine(s.reason) || "over the limit"}`
                    : s.verdict === 1
                      ? `Held ${ethWords(s.amount, 4)} ETH: ${hl ? holdWords(hl) : "on its clock"}`
                      : `Took ${ethWords(s.amount, 4)} ETH`}
                </span>
                <span className="relative h-[4px] self-center rounded-full bg-line" title={`score ${s.score}`}>
                  <span className={`absolute inset-y-0 left-0 rounded-full ${s.refused ? "bg-hot" : s.verdict === 1 ? "bg-held" : "bg-ivory/50"}`} style={{ width: `${Math.min(100, (Number(s.score) / 1_000_000) * 100)}%` }} />
                  <span className="absolute -top-1 bottom-[-4px] left-1/2 w-px bg-ivory/50" />
                </span>
                <a href={explorerTx(d, s.txHash) ?? "#"} target="_blank" rel="noreferrer" aria-label="Open in the explorer" className="text-right text-ivory-3 transition-colors hover:text-ivory">
                  ↗
                </a>
              </>
            )}
          </motion.li>
        );
      })}
    </ol>
  );
}

export function FeedSection() {
  const spends = useArena((s) => s.spends);
  const snap = useArena((s) => s.snapshot);
  const refused = snap ? Number(snap.totalRefused) : spends.filter((s) => s.refused).length;
  const total = snap ? Number(snap.totalSpends) : spends.length;
  return (
    <section id="feed" data-stage={5} className="relative min-h-[120svh] px-[var(--gutter)] py-32">
      <div className="grid-12 !px-0 gap-y-12">
        <div className="col-span-12 lg:col-span-5">
          <Reveal
            lines={[
              <span key="a">
                <Rolling value={count(refused)} label="Refusals" /> refusals,
              </span>,
              "all on the record.",
            ]}
            label={`${refused} refusals, all on the record.`}
            className="display-l"
          />
          <Drift>
            <p className="body mt-6 max-w-[36ch]">
              Out of {count(total)} attempts so far. Each line is one Spend event with its score against her limit of 500,000, and the reason the contract gave, in words. A score past
              350,000 is held rather than paid, and its line shows the wait.
            </p>
          </Drift>
        </div>
        <div className="panel col-span-12 rounded-[28px] p-6 lg:col-span-7">
          <KillFeed />
        </div>
      </div>
    </section>
  );
}
