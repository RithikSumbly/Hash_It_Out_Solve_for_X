"use client";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { arena } from "@/lib/store";
import { scene } from "@/lib/scene";
import { ui } from "@/lib/ui";
import { queenPath } from "@/lib/queen";
import { BUNDLED_DEPLOYMENT } from "@/lib/config";

/**
 * The loading curtain: her genome, before the page opens.
 *
 * In the first HTML, so a reload never shows the page assembling itself. The genesis queen stands in a ring of 32
 * ticks, her 32 genes. The ring lights in four groups of eight as the first screen's parts arrive (the faces, the
 * stage's first frames, the live snapshot, the history), so the progress is her genome. When the snapshot lands each
 * tick grows to her live gene (changed genes turn cold) and the silhouette becomes the live champion's: she evolves
 * before the page opens. Then the genes scatter and the board under her turns over square by square, from the square
 * she stands on, onto the live page.
 *
 * It lifts when the first screen is ready (the history waited for up to HISTORY_WAIT_MS) and never later than CAP_MS;
 * a CSS timer (globals.css) takes it away even if this script never runs. Transforms and opacity only: no WebGL here.
 * `?curtain=hold` keeps it up and `?curtain=slow` plays the reveal six times slower (for captures).
 */
const CAP_MS = 7000;
const HISTORY_WAIT_MS = 4500;
const MIN_MS = 900;
const N = 8; // the board

/** signed log scale: small genes still show, big ones saturate (s = smallest visible change, S = saturation) */
const norm = (x: number, s = 16, S = 4000) => Math.min(1, Math.log1p(Math.abs(x) / s) / Math.log1p(S / s));

const GENESIS: number[] = BUNDLED_DEPLOYMENT?.seedGenome?.genes ?? Array.from({ length: 32 }, () => 0);

export function Curtain() {
  const [parts, setParts] = useState(0);
  const [live, setLive] = useState<number[] | null>(null);
  const [phase, setPhase] = useState<"up" | "lifting" | "gone">("up");
  const [origin, setOrigin] = useState({ x: 0.6, y: 0.55 });
  const partsRef = useRef(0);

  useEffect(() => {
    const q = new URLSearchParams(location.search).get("curtain");
    if (q === "slow") document.documentElement.style.setProperty("--curtain-speed", "6");
    if (q === "hold") document.getElementById("rq-curtain")?.style.setProperty("animation", "none"); // no failsafe while held
    // a reload starts at the top (the stage's camera and the smooth scroller both begin there); a link to a section
    // keeps its place
    if (!location.hash) {
      try {
        history.scrollRestoration = "manual";
      } catch {
        /* older browsers */
      }
      window.scrollTo(0, 0);
    }
    let fonts = !document.fonts;
    document.fonts?.ready.then(() => (fonts = true), () => (fonts = true));
    let raf = 0;
    let timer = 0;
    let slow = 0;
    const lift = () => {
      if (scene.revealed) return;
      clearInterval(slow);
      const p = ui.get().phone ? { x: 0.5, y: 0.42 } : scene.queenAt;
      setOrigin({ x: Math.min(0.95, Math.max(0.05, p.x)), y: Math.min(0.95, Math.max(0.05, p.y)) });
      setPhase("lifting");
      // the page's intro starts a beat in, as the first squares turn
      timer = window.setTimeout(() => {
        scene.revealed = true;
        timer = window.setTimeout(() => setPhase("gone"), 1700 * speed());
      }, 260 * speed());
    };
    const check = () => {
      const st = arena.get();
      const warm = scene.stageWarm || !ui.get().webgl;
      const snap = st.snapshot;
      const now = performance.now();
      const n = (fonts ? 1 : 0) + (warm ? 1 : 0) + (snap ? 1 : 0) + (st.loaded ? 1 : 0);
      if (n !== partsRef.current) {
        partsRef.current = n;
        setParts(n);
      }
      if (snap) setLive((cur) => cur ?? snap.live.genes.map(Number));
      const ready = fonts && warm && !!snap && (st.loaded || now > HISTORY_WAIT_MS);
      if (q !== "hold" && ((ready && now > MIN_MS) || now > CAP_MS)) return lift();
      raf = requestAnimationFrame(check);
    };
    // a hidden tab gets no frames: a slow timer keeps the cap honest there
    slow = window.setInterval(() => {
      if (q !== "hold" && !scene.revealed && performance.now() > CAP_MS) {
        cancelAnimationFrame(raf);
        lift();
      }
    }, 500);
    raf = requestAnimationFrame(check);
    (window as unknown as { __rqCurtain?: unknown }).__rqCurtain = { lift };
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(slow);
      clearTimeout(timer);
    };
  }, []);

  const genes = live ?? GENESIS;
  const marks = useMemo(() => ({ genesis: queenPath(GENESIS, 100, 100, 0.04), live: live ? queenPath(live, 100, 100, 0.04) : null }), [live]);
  const ticks = useMemo(
    () =>
      genes.map((g, i) => {
        const a = (i / 32) * Math.PI * 2 - Math.PI / 2;
        const len = 3 + 15 * norm(g);
        const r0 = 41;
        const c = Math.cos(a);
        const s = Math.sin(a);
        return {
          x1: c * r0,
          y1: s * r0,
          x2: c * (r0 + len),
          y2: s * (r0 + len),
          group: Math.floor(i / 8),
          changed: !!live && g !== GENESIS[i],
          style: { "--i": i, "--dx": `${(c * 38).toFixed(1)}px`, "--dy": `${(s * 38).toFixed(1)}px` } as CSSProperties,
        };
      }),
    [genes, live],
  );
  // each square turns over after a delay that grows with its distance from the queen's square
  const cells = useMemo(() => {
    const ox = origin.x * N - 0.5;
    const oy = origin.y * N - 0.5;
    return Array.from({ length: N * N }, (_, k) => {
      const r = Math.floor(k / N);
      const c = k % N;
      return { k, light: (r + c) % 2 === 0, d: Math.round(Math.hypot(c - ox, r - oy) * 62) };
    });
  }, [origin]);

  if (phase === "gone") return null;
  return (
    <div id="rq-curtain" className={`curtain${phase === "lifting" ? " is-lifting" : ""}`} role="status" aria-live="polite">
      <div className="curtain-board" aria-hidden>
        {cells.map((c) => (
          <i key={c.k} className={c.light ? "is-light" : undefined} style={{ "--d": c.d } as CSSProperties} />
        ))}
      </div>
      <svg className="curtain-sigil" viewBox="-64 -64 128 128" aria-hidden>
        <g className="curtain-ring">
          {ticks.map((t, i) => (
            <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} className={`tick${t.group < parts ? " is-on" : ""}${t.changed ? " is-changed" : ""}`} style={t.style} />
          ))}
        </g>
        <g transform="translate(-28 -30) scale(0.56)">
          <path className={`curtain-mark${marks.live ? " is-past" : ""}`} d={marks.genesis} />
          {marks.live ? <path className="curtain-mark is-live" d={marks.live} /> : null}
        </g>
      </svg>
      <span className="sr-only">{phase === "lifting" ? "" : "Loading the arena"}</span>
    </div>
  );
}

/** the reveal's pace multiplier (`?curtain=slow` sets 6 for captures) */
function speed() {
  const v = Number(getComputedStyle(document.documentElement).getPropertyValue("--curtain-speed"));
  return v > 0 ? v : 1;
}
