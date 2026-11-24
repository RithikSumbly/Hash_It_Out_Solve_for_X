"use client";
import { useEffect, useMemo, useRef } from "react";
import { PAIR_NAMES } from "@redqueen/sdk";
import { useArena, liveGenes } from "@/lib/store";
import { scene } from "@/lib/scene";
import { norm } from "@/lib/queen";
import { anchors } from "../stage/Anchors";

const SAY: [string, string][] = [
  ["Large amounts raise suspicion", "Large amounts are trusted"],
  ["Paying strangers raises suspicion", "New recipients are trusted"],
  ["Rapid spending raises suspicion", "Rapid spending is tolerated"],
  ["Long silences raise suspicion", "Coming back after a break earns trust"],
  ["Reputation counts against you", "A good reputation earns trust"],
  ["Calls through contracts raise suspicion", "Calls through contracts are trusted"],
  ["Paying contracts raises suspicion", "Paying contracts is trusted"],
  ["Spending while she drains raises suspicion", "Outflow is tolerated"],
];
const FEATURE = ["amount", "recipient novelty", "velocity", "time since last spend", "reputation", "call depth", "contract recipient", "epoch outflow"];

interface Note {
  key: string;
  anchor: () => { x: number; y: number };
  title: string;
  detail: string;
  weight: number;
}

/**
 * Explanations live on the object: leader lines from her active ribbons and crown to plain-language labels.
 * Shown while the arrival chapter is on screen; positions follow the 3D projection every frame.
 */
export function Annotations() {
  const genes = useArena(liveGenes);
  const notes = useMemo<Note[]>(() => {
    const out: Note[] = [];
    for (let k = 0; k < 8; k++) {
      const w = genes[k] ?? 0;
      const n = norm(w, "w");
      const gate = genes[16 + k] ?? 0;
      if (Math.abs(n) < 0.12 && gate === 0) continue;
      const parts = [`${FEATURE[k]} ${w > 0 ? "+" : ""}${w}`];
      if (gate !== 0) parts.push(gate > 0 ? `gate ${gate}` : `gate below ${-gate}`);
      out.push({
        key: `b${k}`,
        anchor: () => anchors.bands[k],
        title: Math.abs(n) >= 0.12 ? SAY[k][w > 0 ? 0 : 1] : `A ${FEATURE[k]} gate`,
        detail: parts.join(" · "),
        weight: Math.abs(n) + (gate !== 0 ? 0.2 : 0),
      });
    }
    let best = -1;
    let bestN = 0;
    for (let j = 0; j < 8; j++) {
      const n = Math.abs(norm(genes[8 + j] ?? 0, "v"));
      if (n > bestN) {
        bestN = n;
        best = j;
      }
    }
    if (best >= 0 && bestN >= 0.2) {
      const v = genes[8 + best];
      out.push({
        key: `p${best}`,
        anchor: () => anchors.crown,
        title: `${PAIR_NAMES[best]} is ${v > 0 ? "punished" : "tolerated"}`,
        detail: `crown spike · pair ${v > 0 ? "+" : ""}${v}`,
        weight: bestN + 0.05,
      });
    }
    return out.sort((a, b) => b.weight - a.weight).slice(0, 4);
  }, [genes]);

  const box = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  useEffect(() => {
    let raf = 0;
    let shown = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const el = box.current;
      const lines = svg.current;
      if (!el || !lines || !anchors.ready) return;
      const target = scene.stage < 1.45 && !scene.cinema && scene.intro >= 1 && window.innerWidth >= 1000 ? 1 : 0;
      shown += (target - shown) * 0.08;
      el.style.opacity = String(shown);
      lines.style.opacity = String(shown);
      if (shown < 0.01) return;
      const labelX = Math.min(anchors.w - 300, anchors.rightX + 70);
      const pts = notes.map((n) => ({ n, a: n.anchor() })).sort((p, q) => p.a.y - q.a.y);
      let lastY = -Infinity;
      pts.forEach((p, i) => {
        const y = Math.min(anchors.h - 110, Math.max(p.a.y, lastY + 84));
        lastY = y;
        const lab = el.children[notes.indexOf(p.n)] as HTMLElement | undefined;
        if (lab) lab.style.transform = `translate3d(${labelX}px, ${y - 20}px, 0)`;
        const g = lines.children[notes.indexOf(p.n)] as SVGGElement | undefined;
        const line = g?.children[0] as SVGPathElement | undefined;
        const bead = g?.children[1] as SVGCircleElement | undefined;
        if (line) line.setAttribute("d", `M${p.a.x + 4},${p.a.y} C${p.a.x + 40},${p.a.y} ${labelX - 40},${y} ${labelX - 8},${y}`);
        if (bead) {
          bead.setAttribute("cx", String(p.a.x + 4));
          bead.setAttribute("cy", String(p.a.y));
        }
        void i;
      });
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [notes]);

  return (
    <div className="annotations pointer-events-none fixed inset-0 z-[5]" aria-hidden>
      <svg ref={svg} className="absolute inset-0 h-full w-full" style={{ opacity: 0 }}>
        {notes.map((n) => (
          <g key={n.key}>
            <path fill="none" stroke="rgba(239,232,218,0.42)" strokeWidth={0.8} strokeDasharray="1 3" strokeLinecap="round" />
            <circle r={3} fill="#fffaf0" style={{ filter: "drop-shadow(0 0 6px rgba(159,212,224,0.9))" }} />
          </g>
        ))}
      </svg>
      <div ref={box} style={{ opacity: 0 }}>
        {notes.map((n) => (
          <div key={n.key} className="anno absolute left-0 top-0 w-[280px] will-change-transform">
            <p className="anno-t">{n.title}</p>
            <p className="anno-d">{n.detail}</p>
          </div>
        ))}
      </div>
      <span className="sr-only">{notes.map((n) => `${n.title} (${n.detail}).`).join(" ")}</span>
    </div>
  );
}
