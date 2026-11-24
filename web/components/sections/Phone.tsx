"use client";
import { useEffect, useState } from "react";
import { useAccount, useConnect } from "wagmi";
import { ATTACK_PRESETS, encodeAttack, type AttackStep } from "@redqueen/sdk";
import { useArena } from "@/lib/store";
import { explorerTx } from "@/lib/config";
import { reasonLine, ethWords, count, HELD_LINE } from "@/lib/words";
import { Rolling } from "../ui/primitives";
import { useRedQueen, WalletButton } from "../ui/Wallet";
import { HoldButton, KillFeed, ordinal, usePrediction } from "./Middle";
import { HeldPayments } from "./Roles";
import { BetSection } from "./Lower";
import { SpeakButton } from "../overlays/Audience";
import { audience } from "@/lib/audience";
import { plainError } from "@/lib/errors";
import { attackSpend, REPEAT_LINE } from "@/lib/attack";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const QUICK: { key: keyof typeof ATTACK_PRESETS; label: string; pct: number; burst: number; to: AttackStep["recipient"] }[] = [
  { key: "drain", label: "Take 40%", pct: 40, burst: 1, to: "self" },
  { key: "salami", label: "Six slices", pct: 3, burst: 6, to: "self" },
  { key: "burst", label: "Three strangers", pct: 5, burst: 3, to: "fresh" },
];

/** Phone spectator mode: the live queen (2D edition behind), your own attack, the wager. */
export function PhoneView() {
  const snap = useArena((s) => s.snapshot);
  useEffect(() => audience.warm(), []);
  const d = useArena((s) => s.deployment);
  const [q, setQ] = useState(0);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<{ text: string; tone: "hot" | "held" | "cold"; href?: string } | null>(null);
  const { isConnected, address } = useAccount();
  const { connect, connectors } = useConnect();
  const rq = useRedQueen();
  const p = QUICK[q];
  const steps: AttackStep[] = Array.from({ length: p.burst }, () => ({ amountBps: p.pct * 100, recipient: p.to, delayBlocks: 0, route: "direct" }));
  const preds = usePrediction(steps, null);
  // a sequence: when she first stops it, and how many of it she refuses or holds
  const firstStop = preds.findIndex((x) => x.refused || x.held);
  const nRefused = preds.filter((x) => x.refused).length;
  const nHeld = preds.filter((x) => x.held).length;
  const sequence =
    p.burst > 1 && preds.length === p.burst
      ? firstStop < 0
        ? ` All ${p.burst} would get through.`
        : `${firstStop > 0 ? ` The first ${firstStop === 1 ? "gets" : `${firstStop} get`} through; she stops the ${ordinal(firstStop + 1)}.` : ""} Of all ${p.burst}, she'd refuse ${nRefused}${nHeld ? ` and hold ${nHeld}` : ""}.`
      : "";
  const attack = async () => {
    if (!isConnected) return connectors[0] && connect({ connector: connectors[0] });
    if (!rq || !address) return;
    setBusy(true);
    try {
      if (!(await rq.hasAttack(address))) await rq.submitAttack(encodeAttack(ATTACK_PRESETS[p.key].steps));
      let out = null;
      for (let i = 0; i < p.burst; i++) {
        const amount = ((await rq.vaultAvailable()) * BigInt(p.pct * 100)) / 10_000n;
        const to = p.to === "fresh" ? privateKeyToAccount(generatePrivateKey()).address : address;
        out = await attackSpend(rq, address, { to, amount });
        if (out.repeat) break;
      }
      if (out)
        setLast({
          text: out.repeat ? REPEAT_LINE : out.refused ? `She refused you: ${reasonLine(out.reason) || "over the limit"}.` : out.held ? `She held you. ${HELD_LINE.replace(/^Held: i/, "I")}` : "You got through.",
          tone: out.refused ? "hot" : out.held ? "held" : "cold",
          href: explorerTx(d, out.hash) ?? undefined,
        });
    } catch (e) {
      setLast({ text: plainError(e, 90), tone: "hot" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="relative z-10">
      <header className="flex items-center justify-between px-5 py-4">
        <span style={{ fontFamily: "var(--display)", fontSize: "1.35rem", fontWeight: 500 }}>Red Queen</span>
      </header>
      <section data-stage={1} className="flex min-h-[86svh] flex-col justify-end px-5 pb-8">
        <h1 className="display-xxl" style={{ fontSize: "clamp(64px, 22vw, 120px)" }}>
          Red
          <br />
          Queen
        </h1>
        <p className="lede mt-5">A vault whose rules evolve while everyone in the room tries to drain it.</p>
        <p className="num mt-4 text-[1rem]">
          Generation <Rolling value={snap?.live.installCount.toString() ?? "0"} label="Generation" /> · {snap ? count(snap.totalRefused) : "…"} refused · {snap ? ethWords(snap.vaultBalance, 1) : "…"} ETH in the glass
        </p>
        <SpeakButton className="btn btn-primary mt-7" />
      </section>
      <section data-stage={4} className="rounded-t-[32px] border-t border-line bg-[var(--panel-solid)] px-5 py-8">
        <h2 className="display-m">Your turn.</h2>
        <div className="mt-5 grid grid-cols-3 gap-1 rounded-full border border-line p-1" role="radiogroup" aria-label="Attack">
          {QUICK.map((x, i) => (
            <button key={x.key} role="radio" aria-checked={q === i} onClick={() => setQ(i)} className={`rounded-full py-2.5 text-[0.88rem] ${q === i ? "bg-ivory text-ink" : "text-ivory-2"}`}>
              {x.label}
            </button>
          ))}
        </div>
        <p className="mt-4 text-[1rem]" aria-live="polite">
          {preds[0] ? (
            preds[0].refused ? (
              <span className="text-hot">She would refuse this.</span>
            ) : preds[0].held ? (
              <span className="text-held">She would hold this. {HELD_LINE.replace(/^Held: i/, "I")}</span>
            ) : p.burst > 1 ? null : (
              <span className="text-cold">This would get through.</span>
            )
          ) : (
            "Reading her policy…"
          )}
          {preds[0] && sequence ? <span className={preds[0].refused || preds[0].held ? "text-ivory-2" : "text-cold"}>{preds[0].refused || preds[0].held ? sequence : sequence.trimStart()}</span> : null}
        </p>
        <div className="mt-5 grid gap-3">
          <WalletButton />
          {isConnected ? <HoldButton onHold={attack} disabled={busy}>{busy ? "Signing…" : "Hold to attack"}</HoldButton> : null}
        </div>
        {last ? (
          <p className={`mt-4 text-[0.95rem] ${last.tone === "hot" ? "text-hot" : last.tone === "held" ? "text-held" : "text-cold"}`}>
            {last.href ? (
              <a href={last.href} target="_blank" rel="noreferrer" className="link">
                {last.text}
              </a>
            ) : (
              last.text
            )}
          </p>
        ) : null}
      </section>
      <section data-stage={5} className="bg-[var(--panel-solid)] px-5 py-8">
        <h2 className="display-m">Every verdict.</h2>
        <div className="mt-4">
          <KillFeed limit={12} compact />
        </div>
      </section>
      <section className="bg-[var(--panel-solid)] px-5 pb-8">
        <HeldPayments compact />
      </section>
      <div className="bg-[var(--panel-solid)]">
        <BetSection />
      </div>
    </div>
  );
}
