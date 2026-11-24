"use client";
/**
 * The menu: her crown opens it. A dark sheet of glass over the world, and on it only the chapters, cut
 * in ruby, numbered like the film. The cursor on a chapter sends the camera there behind the glass; choosing it
 * takes you there. The few switches the site has sit at the foot as a single line of italic words.
 *
 * Keyboard: Tab and the arrows move, Enter goes, Esc closes; focus stays inside while it is open.
 */
import { motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { ui, useUI } from "@/lib/ui";
import { scene } from "@/lib/scene";
import { tour } from "@/lib/tour";
import { holdScroll, scrollToId } from "./SmoothScroll";
import { useGlass } from "./Glass";

const EASE = [0.16, 1, 0.3, 1] as const;
const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];

const ITEMS: { id: string; stage: number; title: string }[] = [
  { id: "vault", stage: 2, title: "The vault" },
  { id: "attack", stage: 3, title: "The siege" },
  { id: "try", stage: 4, title: "Your turn" },
  { id: "feed", stage: 5, title: "The record" },
  { id: "generations", stage: 6, title: "Generations" },
  { id: "lineage", stage: 7, title: "The family tree" },
  { id: "charts", stage: 8, title: "Is she learning?" },
  { id: "bet", stage: 9, title: "Back a bloodline" },
  { id: "roles", stage: 9.5, title: "Three roles" },
  { id: "proof", stage: 10, title: "Check every number" },
];

/** the menu: two lines in a drop of glass that cross into an X while it is open */
export function MenuButton() {
  const open = useUI((s) => s.menu);
  const ref = useGlass<HTMLButtonElement>({ bevel: 9, frost: 10 });
  return (
    <span className="jewel-wrap">
      <button ref={ref} className="lq" aria-expanded={open} aria-controls="site-menu" aria-label={open ? "Close the menu" : "Open the menu"} onClick={() => ui.set({ menu: !open })}>
        <svg viewBox="0 0 24 24" aria-hidden>
          <path className="bar b1" d="M5 9.5h14" />
          <path className="bar b2" d="M5 14.5h14" />
        </svg>
      </button>
      <span className="jewel-name" aria-hidden>
        {open ? "Close" : "Menu"}
      </span>
    </span>
  );
}

export function Menu() {
  const open = useUI((s) => s.menu);
  const verify = useUI((s) => s.verify);
  const [on, setOn] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const rows = useRef<(HTMLButtonElement | null)[]>([]);

  // the camera previews the chapter under the cursor (or in focus); it goes home when the menu closes
  useEffect(() => {
    scene.previewStage = open && on !== null ? ITEMS[on].stage : null;
  }, [open, on]);
  useEffect(() => {
    if (!open) {
      setOn(null);
      scene.previewStage = null;
      return;
    }
    const prev = document.activeElement as HTMLElement | null;
    const t = setTimeout(() => rows.current[0]?.focus({ preventScroll: true }), 60);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        ui.set({ menu: false });
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const i = rows.current.findIndex((r) => r === document.activeElement);
        const n = Math.max(0, Math.min(ITEMS.length - 1, (i < 0 ? -1 : i) + (e.key === "ArrowDown" ? 1 : -1)));
        rows.current[n]?.focus();
      } else if (e.key === "Tab" && box.current) {
        const f = box.current.querySelectorAll<HTMLElement>("button");
        if (!f.length) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    document.documentElement.setAttribute("data-menu", "");
    holdScroll(true);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", onKey, true);
      document.documentElement.removeAttribute("data-menu");
      holdScroll(false);
      prev?.focus?.({ preventScroll: true });
    };
  }, [open]);

  const go = (id: string) => {
    ui.set({ menu: false });
    setTimeout(() => scrollToId(id), 60);
  };
  const key = (k: string) => window.dispatchEvent(new KeyboardEvent("keydown", { key: k }));
  const words: [string, () => void, boolean?][] = [
    ["Watch the demo", () => (ui.set({ menu: false }), setTimeout(() => tour.start(), 120))],
    ["Block numbers", () => ui.set({ verify: !verify }), verify],
    ["Her history", () => (ui.set({ menu: false }), key("t"))],
    ["Cinema", () => (ui.set({ menu: false }), key("c"))],
    ["Attack lab", () => ui.set({ menu: false, lab: true })],
  ];

  return (
    <motion.div
      ref={box}
      id="site-menu"
      className="menu"
      role="dialog"
      aria-modal="true"
      aria-label="Menu"
      initial={false}
      animate={{ opacity: open ? 1 : 0 }}
      transition={{ duration: open ? 0.55 : 0.35, ease: EASE }}
      style={{ pointerEvents: open ? "auto" : "none", visibility: open ? "visible" : "hidden" }}
      inert={!open}
      onPointerLeave={() => setOn(null)}
    >
      <ol className="menu-list">
        {ITEMS.map((it, i) => (
          <li key={it.id}>
            <motion.button
              ref={(el) => {
                rows.current[i] = el;
              }}
              className="menu-row"
              data-on={on === i ? "" : undefined}
              onPointerEnter={() => setOn(i)}
              onFocus={() => setOn(i)}
              onClick={() => go(it.id)}
              initial={false}
              animate={open ? { opacity: 1, y: 0 } : { opacity: 0, y: 22 }}
              transition={{ duration: 0.75, ease: EASE, delay: open ? 0.06 + i * 0.04 : 0 }}
            >
              <span className="menu-num">{ROMAN[i]}</span>
              <span className="menu-title ruby">{it.title}</span>
            </motion.button>
          </li>
        ))}
      </ol>
      <motion.p className="menu-words" initial={false} animate={{ opacity: open ? 1 : 0 }} transition={{ duration: 0.6, ease: EASE, delay: open ? 0.45 : 0 }}>
        {words.map(([w, act, state], i) => (
          <span key={w}>
            {i ? <span className="menu-sep" aria-hidden /> : null}
            <button className="menu-word" onClick={act} aria-pressed={state}>
              {w}
            </button>
          </span>
        ))}
      </motion.p>
    </motion.div>
  );
}
