"use client";
import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useArena, liveGenes } from "@/lib/store";
import { useUI, ui } from "@/lib/ui";
import { scene, type SceneSection } from "@/lib/scene";
import { sound } from "@/lib/sound";
import { reasonLine, ethWords, count } from "@/lib/words";
import { short } from "@/lib/format";
import { Proof, QueenMark, Rolling } from "../ui/primitives";
import { WalletButton } from "../ui/Wallet";
import { GlassButton, useGlass } from "../ui/Glass";
import { Menu, MenuButton } from "../ui/Menu";
import { scrollToId } from "../ui/SmoothScroll";
import { TourButton } from "../overlays/Tour";
import { SpeakButton } from "../overlays/Audience";
import { audience, useAudience } from "@/lib/audience";
import { ink } from "../stage/ink";

const SECTIONS: SceneSection[] = ["loader", "hero", "vault", "attack", "try", "feed", "generations", "lineage", "charts", "bet", "proof"];
const DIM = [0, 0, 0, 0, 0.05, 0.3, 0.2, 0.78, 0.55, 0.25, 0];

/**
 * One continuous camera stage from the scroll position: stage = i when the viewport centre is at the
 * middle of chapter i (pin spacers included). Crossing into a chapter sends a slow swirl through the ink.
 */
export function StageTracker() {
  useEffect(() => {
    let spans: { i: number; top: number; h: number }[] = [];
    const measure = () => {
      spans = [];
      document.querySelectorAll<HTMLElement>("[data-stage]").forEach((el) => {
        const box = el.parentElement?.classList.contains("pin-spacer") ? el.parentElement : el;
        const r = box.getBoundingClientRect();
        spans.push({ i: Number(el.dataset.stage), top: r.top + window.scrollY, h: r.height });
      });
      spans.sort((a, b) => a.top - b.top);
    };
    measure();
    ScrollTrigger.addEventListener("refresh", measure);
    window.addEventListener("resize", measure);
    let raf = 0;
    let lastIdx = 1;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (!spans.length) return;
      const y = window.scrollY + window.innerHeight / 2;
      let stage = spans[0].i;
      for (const s of spans) if (y >= s.top) stage = s.i - 0.5 + Math.min(1, (y - s.top) / Math.max(1, s.h));
      if (window.scrollY < 4) stage = 1;
      scene.stage = Math.max(1, stage);
      const idx = Math.round(scene.stage);
      scene.section = SECTIONS[idx] ?? "proof";
      if (idx !== lastIdx) {
        lastIdx = idx;
        if (!scene.reducedMotion) for (let k = 0; k < 8; k++) ink.splatPolar((k / 8) * Math.PI * 2, 2.2, 140, (k / 8) * Math.PI * 2 + Math.PI / 2, [0, 0, 0], 0.03);
      }
      const f = scene.stage - Math.floor(scene.stage);
      const a = DIM[Math.floor(scene.stage)] ?? 0;
      const b = DIM[Math.ceil(scene.stage)] ?? 0;
      scene.dim = scene.cinema ? 0 : a + (b - a) * f;
    };
    raf = requestAnimationFrame(loop);
    const t = setTimeout(measure, 900);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t);
      ScrollTrigger.removeEventListener("refresh", measure);
      window.removeEventListener("resize", measure);
    };
  }, []);
  return null;
}

/** The loader is the queen being turned: one point, 32 genes on a helix, then the glass rises around them. */
export function Loader() {
  useEffect(() => {
    let played = false;
    try {
      played = sessionStorage.getItem("rq:intro") === "1";
    } catch {
      /* ignore */
    }
    if (played || scene.reducedMotion) {
      scene.intro = 1;
      return;
    }
    let t0 = 0;
    let raf = 0;
    const step = () => {
      // the intro plays as the curtain lifts, not behind it
      if (!scene.revealed) {
        raf = requestAnimationFrame(step);
        return;
      }
      if (!t0) t0 = performance.now();
      const p = Math.min(1, (performance.now() - t0) / 1600);
      scene.intro = p;
      if (p < 1) raf = requestAnimationFrame(step);
      else
        try {
          sessionStorage.setItem("rq:intro", "1");
        } catch {
          /* ignore */
        }
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, []);
  return null;
}

/** Shown only when the relay is replaying recorded events (the testnet fallback); never a standing badge. */
function ReplayNotice() {
  const mode = useArena((s) => s.mode);
  if (!mode.replay) return null;
  return (
    <span className="caption mr-2 text-cold" role="status">
      Replaying the last minutes at {mode.speed}× while the testnet catches up
    </span>
  );
}

export function StatusBadge() {
  const mode = useArena((s) => s.mode);
  const status = useArena((s) => s.status);
  const snap = useArena((s) => s.snapshot);
  const live = status === "open";
  return (
    <span className="caption inline-flex items-center gap-2 whitespace-nowrap" role="status">
      <span className={`h-[7px] w-[7px] rounded-full ${live || mode.replay ? "bg-cold" : "bg-ash"}`} style={{ animation: live ? "rqpulse 2.4s ease-in-out infinite" : undefined }} />
      {mode.replay ? (
        <span className="text-cold">Replaying the last minutes at {mode.speed}×</span>
      ) : live ? (
        <>Live{snap ? <span className="text-ivory-3"> · block {count(snap.blockNumber)}</span> : null}</>
      ) : status === "connecting" ? (
        "Connecting to the arena"
      ) : (
        "Offline"
      )}
      <style>{`@keyframes rqpulse{0%,100%{opacity:1}50%{opacity:.35}}`}</style>
    </span>
  );
}

/** Sound: a speaker in a drop of glass; its waves move with what you hear, and an x marks it muted. */
function SoundJewel() {
  const snd = useUI((s) => s.sound);
  const gem = useGlass<HTMLButtonElement>({ bevel: 9, frost: 10 });
  useEffect(() => {
    if (!snd) {
      gem.current?.style.setProperty("--lvl", "0");
      return;
    }
    let raf = 0;
    let lv = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const l = Math.min(1, sound.level() * 9);
      lv += (l - lv) * (l > lv ? 0.35 : 0.08);
      gem.current?.style.setProperty("--lvl", lv.toFixed(3));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [snd, gem]);
  return (
    <span className="jewel-wrap hidden sm:inline-flex">
      <button
        ref={gem}
        className="lq lq-sound"
        aria-pressed={snd}
        aria-label={snd ? "Sound on" : "Sound off"}
        onClick={() => (snd ? sound.disable() : sound.enable(), ui.set({ sound: !snd }))}
      >
        <svg viewBox="0 0 24 24" aria-hidden>
          <path className="fill" d="M4 9.6h2.9L11 6.2v11.6l-4.1-3.4H4a.6.6 0 0 1-.6-.6V10.2a.6.6 0 0 1 .6-.6Z" />
          <path className="wave w1" d="M14.4 9.3a3.8 3.8 0 0 1 0 5.4" />
          <path className="wave w2" d="M16.9 6.9a7.2 7.2 0 0 1 0 10.2" />
          <path className="mute" d="m15.3 9.9 4.2 4.2m0-4.2-4.2 4.2" />
        </svg>
      </button>
      <span className="jewel-name" aria-hidden>
        {snd ? "Sound on" : "Sound"}
      </span>
    </span>
  );
}

/** An audience with her: she comes face to face and you speak (lib/audience.ts). */
function SpeakJewel() {
  const open = useAudience((s) => s.open && !s.closing);
  const gem = useGlass<HTMLButtonElement>({ bevel: 9, frost: 10 });
  useEffect(() => audience.warm(), []);
  return (
    <span className="jewel-wrap hidden sm:inline-flex">
      <button
        ref={gem}
        className="lq lq-speak"
        aria-pressed={open}
        aria-label={open ? "End the audience" : "Speak to her"}
        onClick={() => (open ? audience.close() : void audience.open())}
      >
        <svg viewBox="0 0 24 24" aria-hidden>
          <rect x="9" y="3.6" width="6" height="11" rx="3" />
          <path d="M5.8 11.4a6.2 6.2 0 0 0 12.4 0M12 17.6v2.8" />
        </svg>
      </button>
      <span className="jewel-name" aria-hidden>
        {open ? "End the audience" : "Speak to her"}
      </span>
    </span>
  );
}

export function Header() {
  const cinema = useUI((s) => s.cinema);
  const menu = useUI((s) => s.menu);
  const genes = useArena(liveGenes);
  // steps aside while you read downward, returns the moment you scroll up
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    let last = window.scrollY;
    const onScroll = () => {
      const y = window.scrollY;
      if (Math.abs(y - last) < 6) return;
      setHidden(y > last && y > 160);
      last = y;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return (
    <>
    <header
      className="site-head fixed inset-x-0 top-0 z-50 flex items-center justify-between gap-4 px-[var(--gutter)] py-4"
      style={{
        opacity: cinema ? 0 : 1,
        transform: hidden && !cinema && !menu ? "translateY(-110%)" : "translateY(0)",
        transition: "opacity 600ms var(--ease), transform 700ms var(--ease)",
        pointerEvents: cinema ? "none" : "auto",
      }}
      onFocus={() => setHidden(false)}
    >
      <a href="#top" onClick={(e) => (e.preventDefault(), scrollToId("top"))} className="site-mark" aria-label="Red Queen, back to the top">
        <QueenMark genes={genes} size={34} />
        <span className="site-word ruby">Red Queen</span>
      </a>
      <div className="jewels">
        <ReplayNotice />
        <SpeakJewel />
        <SoundJewel />
        <MenuButton />
        <WalletButton compact jewel />
      </div>
    </header>
    <Menu />
    </>
  );
}

/** A slow line of the latest real verdicts along the bottom of the first screen. */
function Ticker() {
  const spends = useArena((s) => s.spends);
  const rows = spends.slice(-18).reverse();
  if (rows.length === 0) return null;
  const item = (s: (typeof rows)[number], k: string) => (
    <span key={k} className="inline-flex items-baseline gap-2 pr-12">
      <span className="hash text-ivory-3">{short(s.caller, 3)}</span>
      {s.refused ? (
        <span className="text-hot">refused: {reasonLine(s.reason) || "over the limit"}</span>
      ) : s.verdict === 1 ? (
        <span className="text-held">held {ethWords(s.amount, 3)} ETH on her clock</span>
      ) : (
        <span className="text-ivory-2">took {ethWords(s.amount, 3)} ETH</span>
      )}
    </span>
  );
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 overflow-hidden border-t border-line py-3.5" aria-hidden>
      <div className="flex w-max whitespace-nowrap text-[0.88rem]" style={{ animation: scene.reducedMotion ? undefined : "rqticker 70s linear infinite" }}>
        <span className="flex">{rows.map((s) => item(s, `a${s.id}`))}</span>
        <span className="flex">{rows.map((s) => item(s, `b${s.id}`))}</span>
      </div>
      <style>{`@keyframes rqticker{from{transform:translateX(0)}to{transform:translateX(-50%)}}`}</style>
    </div>
  );
}

export function Hero() {
  const snap = useArena((s) => s.snapshot);
  const installs = useArena((s) => s.installs);
  const last = installs[installs.length - 1];
  const gen = snap ? Number(snap.live.installCount) : installs.length;
  return (
    <section id="top" data-stage={1} className="relative flex min-h-[100svh] flex-col justify-end px-[var(--gutter)] pb-28 pt-28">
      <div className="max-w-[40rem]">
        <h1 className="display-xxl hero-title" aria-label="Red Queen">
          {["Red", "Queen"].map((w, i) => (
            <motion.span
              key={w}
              aria-hidden
              className="block"
              initial={{ opacity: 0, y: 24, filter: "blur(14px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)", transitionEnd: { filter: "none" } }}
              transition={{ duration: 1.7, ease: [0.16, 1, 0.3, 1], delay: 0.2 + i * 0.16 }}
            >
              <span className="ruby">{w}</span>
            </motion.span>
          ))}
        </h1>
        <motion.div initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 1.3, ease: [0.16, 1, 0.3, 1], delay: 0.7 }}>
          <p className="lede mt-9">A vault on Ethereum whose security rules evolve while people try to drain it.</p>
          <p className="body mt-4 max-w-[40ch]">
            AI agents now hold wallets, guarded by rules that change only when someone edits them, out of sight. Hers change in the open, round after round, bred on chain
            from the attacks she has just survived. Her shape is those rules.
          </p>
          <p className="num mt-7 text-[1.04rem] text-ivory">
            {snap ? (
              <>
                <Proof tx={last?.txHash} block={last?.block}>
                  Generation <Rolling value={String(gen)} label="Generation" />
                </Proof>
                <span className="text-ivory-3"> · </span>
                <Rolling value={count(snap.totalRefused)} label="Transactions refused" /> of {count(snap.totalSpends)} transactions refused
                <span className="text-ivory-3"> · </span>
                {ethWords(snap.vaultBalance, 2)} ETH in the vault
              </>
            ) : (
              <span className="text-ivory-2">Reading the chain…</span>
            )}
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-3">
            <TourButton />
            <SpeakButton />
            <GlassButton onClick={() => scrollToId("try")}>Try to drain her</GlassButton>
          </div>
        </motion.div>
      </div>
      <Ticker />
    </section>
  );
}
