"use client";
import { useEffect, useLayoutEffect, useRef, useState, type ElementType, type ReactNode } from "react";
import { motion, useMotionValue, useSpring } from "framer-motion";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useUI } from "@/lib/ui";
import { useArena } from "@/lib/store";
import { explorerBlock, explorerTx } from "@/lib/config";
import { scene } from "@/lib/scene";
import { queenPath } from "@/lib/queen";

if (typeof window !== "undefined") gsap.registerPlugin(ScrollTrigger);

const useIso = typeof window !== "undefined" ? useLayoutEffect : useEffect;
const SOFT = { type: "spring" as const, stiffness: 170, damping: 26, mass: 1 };

// ---------------------------------------------------------------- rolling digits

/** Live numbers change digit by digit. A screen-reader mirror announces the value. */
export function Rolling({ value, className = "", label }: { value: string; className?: string; label?: string }) {
  const chars = value.split("");
  return (
    <span className={`relative inline-flex ${className}`}>
      <span className="sr-only" aria-live="polite">
        {label ? `${label}: ` : ""}
        {value}
      </span>
      <span aria-hidden className="inline-flex">
        {chars.map((c, i) =>
          /\d/.test(c) ? <Digit key={`${chars.length - i}`} d={Number(c)} /> : <span key={`${chars.length - i}`}>{c}</span>,
        )}
      </span>
    </span>
  );
}

function Digit({ d }: { d: number }) {
  // an invisible in-flow digit gives the column a real baseline, so rolling numbers sit on the line
  return (
    <span className="relative inline-block overflow-hidden align-baseline" style={{ lineHeight: "inherit" }}>
      <span className="invisible">0</span>
      <span className="absolute inset-x-0 flex flex-col" style={{ top: "50%", marginTop: "-0.5lh", transform: `translateY(${-d}lh)`, transition: "transform 1100ms cubic-bezier(0.16,1,0.3,1)", lineHeight: "inherit" }}>
        {Array.from({ length: 10 }, (_, i) => (
          <span key={i} style={{ height: "1lh", textAlign: "center" }}>
            {i}
          </span>
        ))}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------- heading reveal

/**
 * Headings rise line by line out of a mask as they scroll into view, scrubbed to the scroll position
 * (never fired once on enter), and lean slightly into fast scrolls via the global velocity variable.
 */
export function Reveal({ lines, as: Tag = "h2", className = "", label }: { lines: ReactNode[]; as?: ElementType; className?: string; label?: string }) {
  const ref = useRef<HTMLElement>(null);
  useIso(() => {
    const el = ref.current;
    if (!el || scene.reducedMotion) return;
    const parts = el.querySelectorAll("[data-line]");
    // the glass lines rise into place and clear, rather than slide out of a mask (which would cut off their
    // shadow and the Q's tail). They fade through --o: opacity or a filter on the line itself would hide the
    // world behind from the glass.
    const tw = gsap.fromTo(
      parts,
      { y: 34, "--o": 0 },
      { y: 0, "--o": 1, ease: "none", stagger: 0.12, scrollTrigger: { trigger: el, start: "top 92%", end: "top 50%", scrub: 0.8 } },
    );
    return () => {
      tw.scrollTrigger?.kill();
      tw.kill();
    };
  }, [lines.length]);
  const aria = label ?? lines.filter((l) => typeof l === "string").join(" ");
  return (
    <Tag ref={ref} className={`velo ${className}`} aria-label={aria || undefined}>
      {lines.map((l, i) => (
        <span key={i} aria-hidden data-line className="block will-change-transform">
          <span className="ruby">{l}</span>
        </span>
      ))}
    </Tag>
  );
}

/** Body copy that drifts in with the scroll (scrubbed). */
export function Drift({ children, className = "", delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useIso(() => {
    const el = ref.current;
    if (!el || scene.reducedMotion) return;
    const tw = gsap.fromTo(el, { y: 48, opacity: 0 }, { y: 0, opacity: 1, ease: "none", scrollTrigger: { trigger: el, start: `top ${96 - delay * 6}%`, end: `top ${62 - delay * 6}%`, scrub: 0.8 } });
    return () => {
      tw.scrollTrigger?.kill();
      tw.kill();
    };
  }, []);
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- magnetism

export function Magnetic({ children, strength = 0.28, radius = 80, className = "" }: { children: ReactNode; strength?: number; radius?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const sx = useSpring(x, SOFT);
  const sy = useSpring(y, SOFT);
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const el = ref.current;
      if (!el || scene.reducedMotion) return;
      const r = el.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      const reach = radius + Math.max(r.width, r.height) / 2;
      if (Math.hypot(dx, dy) < reach) {
        x.set(dx * strength);
        y.set(dy * strength);
      } else {
        x.set(0);
        y.set(0);
      }
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, [radius, strength, x, y]);
  return (
    <motion.div ref={ref} style={{ x: sx, y: sy }} className={`inline-block ${className}`}>
      {children}
    </motion.div>
  );
}

// ---------------------------------------------------------------- cursor

/** the cursor is a drop of her glass (see Cursor.tsx) */
export { Cursor } from "./Cursor";

// ---------------------------------------------------------------- type-in

export function TypeIn({ text, className = "", speed = 18 }: { text: string; className?: string; speed?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [n, setN] = useState(0);
  const [go, setGo] = useState(false);
  useEffect(() => {
    if (scene.reducedMotion) {
      setN(text.length);
      return;
    }
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setGo(true), { threshold: 0.4 });
    if (ref.current) io.observe(ref.current);
    return () => io.disconnect();
  }, [text]);
  useEffect(() => {
    if (!go) return;
    setN(0);
    const id = setInterval(() => setN((v) => (v >= text.length ? (clearInterval(id), v) : v + 1)), speed);
    return () => clearInterval(id);
  }, [go, text, speed]);
  return (
    <span ref={ref} className={className} aria-label={text}>
      <span aria-hidden>
        {text.slice(0, n)}
        <span className="opacity-0">{text.slice(n)}</span>
      </span>
    </span>
  );
}

// ---------------------------------------------------------------- explorer-grade proof

/** Every number links to the event that produced it; Verify overlays its block and transaction. */
export function Proof({ tx, block, children, className = "" }: { tx?: string; block?: bigint; children: ReactNode; className?: string }) {
  const verify = useUI((s) => s.verify);
  const d = useArena((s) => s.deployment);
  const href = tx ? explorerTx(d, tx) : block !== undefined ? explorerBlock(d, block) : null;
  const tag =
    verify && (tx || block !== undefined) ? (
      <span className="hash pointer-events-none absolute left-0 top-full mt-1 whitespace-nowrap text-[11px] leading-none text-cold">
        {block !== undefined ? `block ${block}` : ""}
        {tx ? ` · ${tx.slice(0, 10)}…` : ""}
      </span>
    ) : null;
  if (!href)
    return (
      <span className={`relative ${className}`}>
        {children}
        {tag}
      </span>
    );
  return (
    <a href={href} target="_blank" rel="noreferrer" className={`relative ${className}`} title="Open the transaction">
      {children}
      {tag}
    </a>
  );
}

// ---------------------------------------------------------------- the queen's silhouette

export function QueenMark({ genes, size = 120, className = "", fill = "var(--ivory)", stroke = "none", opacity = 1 }: { genes: number[]; size?: number; className?: string; fill?: string; stroke?: string; opacity?: number }) {
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} className={className} aria-hidden>
      <path d={queenPath(genes, 100, 100, 0.04)} fill={fill} stroke={stroke} strokeWidth={stroke === "none" ? 0 : 1.2} vectorEffect="non-scaling-stroke" opacity={opacity} fillRule="nonzero" />
    </svg>
  );
}

/** Back-compat name used by older components. */
export function Silhouette({ genes, size = 120, className = "", stroke = "var(--ivory)" }: { genes: number[]; size?: number; className?: string; stroke?: string; fill?: string }) {
  return <QueenMark genes={genes} size={size} className={className} fill="none" stroke={stroke} />;
}

// ---------------------------------------------------------------- buttons

export function Btn({
  children,
  onClick,
  tone = "primary",
  disabled,
  className = "",
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  tone?: "primary" | "quiet" | "bone" | "cold" | "hot" | "ghost";
  disabled?: boolean;
  className?: string;
  type?: "button" | "submit";
  label?: string;
}) {
  const cls = tone === "quiet" || tone === "ghost" ? "btn-quiet" : "btn-primary";
  return (
    <button type={type} disabled={disabled} onClick={onClick} className={`btn ${cls} ${className}`}>
      {children}
    </button>
  );
}

// ---------------------------------------------------------------- refusal edge + toasts

export function EdgePulse() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let off = () => {};
    import("@/lib/bus").then(({ bus }) => {
      off = bus.on((e) => {
        if (e.type !== "chain" || e.event.name !== "Spend" || !e.event.args.refused) return;
        setTimeout(() => {
          const el = ref.current;
          if (!el) return;
          el.classList.remove("on");
          void el.offsetWidth;
          el.classList.add("on");
        }, 900);
      });
    });
    return () => off();
  }, []);
  return <div ref={ref} className="edge-pulse" aria-hidden />;
}

export function Toasts() {
  const toasts = useUI((s) => s.toasts);
  return (
    <div className="pointer-events-none fixed bottom-6 left-1/2 z-[80] flex -translate-x-1/2 flex-col items-center gap-2" role="status" aria-live="polite">
      {toasts.map((t) => (
        <motion.div
          key={t.id}
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          className={`panel pointer-events-auto rounded-full px-5 py-3 text-[0.92rem] ${t.tone === "hot" ? "text-hot" : t.tone === "held" ? "text-held" : t.tone === "cold" ? "text-cold" : "text-ivory"}`}
        >
          {t.href ? (
            <a href={t.href} target="_blank" rel="noreferrer" className="link">
              {t.text}
            </a>
          ) : (
            t.text
          )}
        </motion.div>
      ))}
    </div>
  );
}

/** Old name kept for the overlays file while it is restyled. */
export const Kinetic = ({ text, as, className }: { text: string; as?: ElementType; className?: string }) => <Reveal lines={[text]} as={as} className={className} />;

/**
 * One listener for the pointer: the 3D stage reads scene.pointer (her lean, the camera's parallax), and the
 * surface under the cursor gets --mx/--my so its sheen follows the light (see .panel[data-lit]).
 */
/** text the cursor lights as it passes: a soft light follows it across the words */
const TEXT_SEL = "main p, main h1, main h2, main h3, main li, main blockquote, main figcaption, main dd, main dt, [data-tour] p, [data-tour] h2";

export function PointerField() {
  useEffect(() => {
    let lit: HTMLElement | null = null;
    let text: HTMLElement | null = null;
    const fades = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
    const release = (el: HTMLElement) => {
      el.setAttribute("data-lit-text", "off");
      fades.set(
        el,
        setTimeout(() => {
          el.removeAttribute("data-lit-text");
          fades.delete(el);
        }, 520),
      );
    };
    const onMove = (e: PointerEvent) => {
      scene.pointer.x = e.clientX;
      scene.pointer.y = e.clientY;
      scene.pointer.nx = (e.clientX / innerWidth) * 2 - 1;
      scene.pointer.ny = -((e.clientY / innerHeight) * 2 - 1);
      let t = (e.target as HTMLElement | null)?.closest?.<HTMLElement>(TEXT_SEL) ?? null;
      // the light is a background clipped to the text, and Chrome paints every glyph inside through it, even
      // hidden ones: a screen-reader label or a rolling number's other digits would show through. Skip those.
      if (t && (t.querySelector(".sr-only, .absolute, [aria-hidden] .invisible, .ruby") || t.closest(".ruby"))) t = null;
      if (t !== text) {
        if (text) release(text);
        text = t;
        if (t && !scene.reducedMotion) {
          const f = fades.get(t);
          if (f) clearTimeout(f), fades.delete(t);
          if (!t.hasAttribute("data-lit-text")) t.style.setProperty("--lit-base", getComputedStyle(t).color);
          t.setAttribute("data-lit-text", "on");
        }
      }
      if (text) {
        const r = text.getBoundingClientRect();
        text.style.setProperty("--tx", `${e.clientX - r.left}px`);
        text.style.setProperty("--ty", `${e.clientY - r.top}px`);
      }
      const el = (e.target as HTMLElement | null)?.closest?.<HTMLElement>(".btn, .glass, [data-row], [role=radio], .panel, [data-sheen]") ?? null;
      if (el !== lit) {
        lit?.removeAttribute("data-lit");
        lit = el;
        el?.setAttribute("data-lit", "");
      }
      if (el) {
        const r = el.getBoundingClientRect();
        el.style.setProperty("--mx", `${e.clientX - r.left}px`);
        el.style.setProperty("--my", `${e.clientY - r.top}px`);
      }
    };
    const onLeave = () => {
      lit?.removeAttribute("data-lit");
      lit = null;
      if (text) release(text);
      text = null;
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointerleave", onLeave);
    return () => {
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerleave", onLeave);
    };
  }, []);
  return null;
}
