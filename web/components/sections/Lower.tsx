"use client";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { motion, useMotionValue, useSpring } from "framer-motion";
import { gsap } from "gsap";
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";
import { useAccount } from "wagmi";
import { formatEther, parseEther } from "viem";
import { useArena, type InstallRow, type Node, arena } from "@/lib/store";
import { ui, useUI } from "@/lib/ui";
import { scene } from "@/lib/scene";
import { explorerAddress, STAKES } from "@/lib/config";
import { ethWords, count } from "@/lib/words";
import { ethNum } from "@/lib/format";
import { Drift, Proof, QueenMark, Reveal, Rolling, TypeIn } from "../ui/primitives";
import { useRedQueen } from "../ui/Wallet";
import { plainError } from "@/lib/errors";

const useIso = typeof window !== "undefined" ? useLayoutEffect : useEffect;
const EASE = [0.16, 1, 0.3, 1] as const;

// ================================================================ generations

/** Consecutive re-installs of the same champion collapse into one era that "held" for N epochs. */
export function eras(installs: InstallRow[]) {
  const out: (InstallRow & { held: number; gen: number })[] = [];
  for (const r of installs) {
    const last = out[out.length - 1];
    if (last && last.id === r.id) last.held++;
    else out.push({ ...r, held: 1, gen: r.index });
  }
  return out;
}

function Card({ era, live, active, onOpen }: { era: ReturnType<typeof eras>[number]; live: boolean; active: boolean; onOpen: () => void }) {
  const rx = useMotionValue(0);
  const ry = useMotionValue(0);
  const srx = useSpring(rx, { stiffness: 150, damping: 22 });
  const sry = useSpring(ry, { stiffness: 150, damping: 22 });
  const fit = Number(formatEther(era.fitness));
  return (
    <motion.button
      onClick={onOpen}
      onPointerMove={(e) => {
        if (scene.reducedMotion) return;
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        ry.set(((e.clientX - r.left) / r.width - 0.5) * 14);
        rx.set(-((e.clientY - r.top) / r.height - 0.5) * 10);
      }}
      onPointerLeave={() => (rx.set(0), ry.set(0))}
      style={{ rotateX: srx, rotateY: sry, transformPerspective: 1000 }}
      className={`group relative flex h-[min(40vh,360px)] w-[min(72vw,270px)] shrink-0 flex-col justify-between rounded-[26px] border bg-[var(--panel-solid)] p-6 text-left transition-colors duration-500 ${
        live ? "border-cold/70" : active ? "border-ivory/45" : "border-line"
      }`}
      aria-label={`Generation ${era.gen}, policy ${era.id}. Open the inspector.`}
    >
      <div className="flex items-baseline justify-between">
        <span className="display-m" style={{ fontSize: "2.1rem" }}>
          {era.gen}
        </span>
        <span className={`caption ${live ? "text-cold" : ""}`}>{live ? "Wears the crown now" : `Held ${era.held} ${era.held === 1 ? "epoch" : "epochs"}`}</span>
      </div>
      <motion.div layoutId={`sil-${era.id}`} className="mx-auto">
        <QueenMark genes={era.genes} size={112} fill={live ? "var(--cold)" : "var(--ivory)"} opacity={live ? 0.95 : 0.9} />
      </motion.div>
      <div className="space-y-1.5 text-[0.93rem]">
        <p className="text-ivory">Policy {era.id.toString()}</p>
        <p className="text-ivory-2">{era.parentA === 0n ? `Submitted with a ${STAKES.policy} stake` : `Bred from ${era.parentA} and ${era.parentB}`}</p>
        <p className="num text-ivory-2">
          Fitness{" "}
          <Proof tx={era.txHash} block={era.block} className="text-ivory">
            {fit >= 0 ? "+" : ""}
            {ethNum(fit)} ETH
          </Proof>
        </p>
      </div>
    </motion.button>
  );
}

export function Generations() {
  const ref = useRef<HTMLElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const installs = useArena((s) => s.installs);
  const list = useMemo(() => eras(installs).slice().reverse(), [installs]);
  const listRef = useRef(list);
  listRef.current = list;
  const [active, setActive] = useState(0);
  const liveId = list[0]?.id;
  useIso(() => {
    const el = ref.current;
    const tr = track.current;
    if (!el || !tr || scene.reducedMotion) return;
    const dist = () => Math.max(0, tr.scrollWidth - window.innerWidth + 80);
    const tween = gsap.to(tr, {
      x: () => -dist(),
      ease: "none",
      scrollTrigger: {
        trigger: el,
        start: "top top",
        end: () => `+=${Math.max(window.innerHeight * 0.8, dist())}`,
        pin: true,
        scrub: 0.8,
        anticipatePin: 1,
        invalidateOnRefresh: true,
        onUpdate: (self) => {
          // browsing the gallery morphs the queen into the generation in front of you
          const l = listRef.current;
          if (!l.length || ui.get().timeMachine.on) return;
          const i = Math.min(l.length - 1, Math.round(self.progress * (l.length - 1)));
          setActive(i);
          scene.overrideGenes = i === 0 ? null : l[i].genes;
        },
        onLeave: () => {
          if (!ui.get().timeMachine.on) scene.overrideGenes = null;
        },
        onLeaveBack: () => {
          if (!ui.get().timeMachine.on) scene.overrideGenes = null;
        },
      },
    });
    return () => {
      tween.scrollTrigger?.kill();
      tween.kill();
    };
  }, [list.length > 0]);
  const shown = list[active];
  return (
    <section id="generations" ref={ref} data-stage={6} className="relative flex min-h-[100svh] flex-col justify-end overflow-hidden pb-14 pt-28">
      <div className="mb-10 flex max-w-[44rem] flex-col gap-5 px-[var(--gutter)]">
        <Reveal
          lines={[
            <span key="a">
              <Rolling value={count(new Set(list.map((x) => x.id.toString())).size)} label="Queens who have worn the crown" /> queens.
            </span>,
            "Nobody wrote one.",
          ]}
          label={`${new Set(list.map((x) => x.id.toString())).size} queens have worn the crown. Nobody wrote one.`}
          className="display-l"
        />
        <p className="body max-w-[30ch]">
          {shown ? (
            <>
              She is showing generation <span className="text-ivory">{shown.gen}</span>
              {active === 0 ? ", the one wearing the crown." : ". Keep scrolling to watch her change."}
            </>
          ) : (
            "Each card is a policy the contract bred and crowned. Browse them and she becomes each one."
          )}
        </p>
      </div>
      <div ref={track} className={`flex gap-5 px-[var(--gutter)] ${scene.reducedMotion ? "overflow-x-auto" : ""}`} style={{ perspective: 1200 }}>
        {list.length === 0 ? <p className="body">Waiting for the first epoch to close…</p> : null}
        {list.map((e, i) => (
          <Card key={`${e.id}-${e.gen}`} era={e} live={e.id === liveId && i === 0} active={i === active} onOpen={() => ui.set({ inspector: e.id })} />
        ))}
      </div>
    </section>
  );
}

// ================================================================ the family tree

interface TNode extends SimulationNodeDatum {
  key: string;
  n: Node;
}

const IVORY = "239,232,218";
const COLD = "159,212,224";
const ASH = "75,72,68";

export function LineageTree({ height = "86svh", mini = false }: { height?: string; mini?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const nodesMap = useArena((s) => s.nodes);
  const installs = useArena((s) => s.installs);
  const tm = useUI((s) => s.timeMachine);
  const [hover, setHover] = useState<Node | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  const sim = useRef<ReturnType<typeof forceSimulation<TNode>> | null>(null);
  const tnodes = useRef(new Map<string, TNode>());
  const seenAt = useRef(new Map<string, number>());
  const diedAt = useRef(new Map<string, number>());
  const loaded = useArena((s) => s.loaded);
  const liveId = installs[installs.length - 1]?.id;
  const cut = tm.on && installs[tm.index] ? installs[tm.index].t : Infinity;

  useEffect(() => {
    const now = performance.now();
    const arr: TNode[] = [];
    for (const [k, n] of nodesMap) {
      let t = tnodes.current.get(k);
      if (!t) {
        const parent = tnodes.current.get(n.parentA.toString());
        t = { key: k, n, x: parent?.x ?? (Math.random() - 0.5) * 50, y: (parent?.y ?? 0) + 30 };
        tnodes.current.set(k, t);
        if (loaded) seenAt.current.set(k, now);
      }
      if (t.n.alive && !n.alive && loaded) diedAt.current.set(k, now);
      t.n = n;
      arr.push(t);
    }
    const links: SimulationLinkDatum<TNode>[] = [];
    for (const t of arr)
      for (const p of [t.n.parentA, t.n.parentB]) {
        const src = tnodes.current.get(p.toString());
        if (src && p !== 0n) links.push({ source: src, target: t });
      }
    const maxGen = Math.max(1, ...arr.map((t) => t.n.generation));
    const s = sim.current ?? forceSimulation<TNode>();
    s.nodes(arr)
      .force("charge", forceManyBody<TNode>().strength(mini ? -14 : -42))
      .force("link", forceLink<TNode, SimulationLinkDatum<TNode>>(links).distance(mini ? 14 : 36).strength(0.5))
      .force("y", forceY<TNode>((d) => (d.n.generation / maxGen - 0.5) * (mini ? 160 : 560)).strength(0.35))
      .force("x", forceX<TNode>(0).strength(0.04))
      .force("collide", forceCollide<TNode>(mini ? 4 : 10))
      .alpha(Math.max(s.alpha(), 0.5))
      .alphaDecay(0.02)
      .restart();
    sim.current = s;
  }, [nodesMap, loaded, mini]);

  useEffect(() => () => void sim.current?.stop(), []);

  useEffect(() => {
    const cv = canvas.current!;
    const ctx = cv.getContext("2d")!;
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const dpr = Math.min(2, devicePixelRatio);
      const w = cv.clientWidth;
      const h = cv.clientHeight;
      if (cv.width !== Math.floor(w * dpr)) {
        cv.width = Math.floor(w * dpr);
        cv.height = Math.floor(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const ts = [...tnodes.current.values()].filter((t) => t.n.bornT <= cut);
      if (!ts.length) return;
      let minX = Infinity,
        maxX = -Infinity,
        minY = Infinity,
        maxY = -Infinity;
      for (const t of ts) {
        minX = Math.min(minX, t.x!);
        maxX = Math.max(maxX, t.x!);
        minY = Math.min(minY, t.y!);
        maxY = Math.max(maxY, t.y!);
      }
      const pad = mini ? 14 : 64;
      const sc = Math.min((w - pad * 2) / Math.max(1, maxX - minX), (h - pad * 2) / Math.max(1, maxY - minY), mini ? 2 : 2.4);
      const ox = w / 2 - ((minX + maxX) / 2) * sc;
      const oy = h / 2 - ((minY + maxY) / 2) * sc;
      (cv as HTMLCanvasElement & { _fit?: unknown })._fit = { sc, ox, oy };
      const P = (t: TNode) => [t.x! * sc + ox, t.y! * sc + oy] as const;
      const now = performance.now();
      const anc = hover ? ancestorsOf(hover, arena.get().nodes) : null;
      for (const t of ts) {
        for (const [p, k] of [
          [t.n.parentA, 0],
          [t.n.parentB, 1],
        ] as const) {
          if (p === 0n) continue;
          const s = tnodes.current.get(p.toString());
          if (!s || s.n.bornT > cut) continue;
          const [x1, y1] = P(s);
          const [x2, y2] = P(t);
          const lit = anc && anc.has(t.key) && anc.has(s.key);
          ctx.strokeStyle = lit ? `rgba(${IVORY},0.95)` : t.n.alive ? `rgba(${IVORY},0.2)` : `rgba(${ASH},0.35)`;
          ctx.lineWidth = lit ? 1.6 : 0.9;
          ctx.setLineDash(k === 1 ? [2, 4] : []);
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.bezierCurveTo(x1, (y1 + y2) / 2, x2, (y1 + y2) / 2, x2, y2);
          ctx.stroke();
        }
      }
      ctx.setLineDash([]);
      for (const t of ts) {
        const [x, y] = P(t);
        const born = seenAt.current.get(t.key);
        const pop = born ? Math.min(1, (now - born) / 700) : 1;
        const popScale = born && pop < 1 ? (pop < 0.6 ? (pop / 0.6) * 1.15 : 1.15 - ((pop - 0.6) / 0.4) * 0.15) : 1;
        const died = diedAt.current.get(t.key);
        const dissolve = died ? Math.min(1, (now - died) / 1400) : t.n.alive ? 0 : 1;
        const isLive = liveId !== undefined && t.n.id === liveId;
        const r = (mini ? 2.2 : isLive ? 7 : 3.8) * popScale;
        const lit = anc?.has(t.key) || hover?.id === t.n.id;
        if (isLive && !scene.reducedMotion) {
          const pulse = (now / 1000) % 2;
          ctx.strokeStyle = `rgba(${COLD},${0.7 * (1 - pulse / 2)})`;
          ctx.beginPath();
          ctx.arc(x, y, r + pulse * 11, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.fillStyle = isLive ? `rgb(${COLD})` : lit ? `rgb(${IVORY})` : dissolve > 0.5 ? `rgba(${ASH},${1 - dissolve * 0.4})` : `rgba(${IVORY},${0.85 - dissolve * 0.5})`;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        if (died && dissolve < 1)
          for (let i = 0; i < 6; i++) {
            const a = i * 1.05 + t.n.epoch;
            ctx.fillStyle = `rgba(${ASH},${1 - dissolve})`;
            ctx.fillRect(x + Math.cos(a) * dissolve * 16, y - dissolve * 12 + Math.sin(a) * dissolve * 6, 1.6, 1.6);
          }
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [hover, liveId, cut, mini]);

  const pick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const cv = canvas.current!;
    const fit = (cv as HTMLCanvasElement & { _fit?: { sc: number; ox: number; oy: number } })._fit;
    if (!fit) return null;
    const r = cv.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    let best: TNode | null = null;
    let bd = 16;
    for (const t of tnodes.current.values()) {
      const d = Math.hypot(t.x! * fit.sc + fit.ox - mx, t.y! * fit.sc + fit.oy - my);
      if (d < bd) {
        bd = d;
        best = t;
      }
    }
    return best ? { n: best.n, x: mx, y: my } : null;
  };

  return (
    <div className="relative" style={{ height }}>
      <canvas
        ref={canvas}
        className="h-full w-full"
        onPointerMove={(e) => {
          if (mini) return;
          const p = pick(e);
          setHover(p?.n ?? null);
          setTip(p ? { x: p.x, y: p.y } : null);
        }}
        onPointerLeave={() => (setHover(null), setTip(null))}
        onClick={(e) => {
          const p = pick(e);
          if (p && !mini) ui.set({ inspector: p.n.id });
        }}
        data-cursor="tree"
        role="img"
        aria-label={`Family tree of ${nodesMap.size} policies, ${[...nodesMap.values()].filter((n) => n.alive).length} alive`}
      />
      {hover && tip && !mini ? (
        <div className="panel pointer-events-none absolute z-10 rounded-2xl px-4 py-3" style={{ left: tip.x + 16, top: tip.y + 16 }}>
          <p className="text-[0.95rem]">
            Policy {hover.id.toString()}, generation {hover.generation}
            <span className={hover.alive ? "text-cold" : "text-ivory-3"}> · {hover.alive ? "alive" : "dead"}</span>
          </p>
          <p className="caption mt-1">{hover.parentA === 0n ? "Submitted with a stake" : `Bred from ${hover.parentA} and ${hover.parentB}`} · bloodline {hover.root.toString()}</p>
        </div>
      ) : null}
    </div>
  );
}

function ancestorsOf(n: Node, all: Map<string, Node>) {
  const out = new Set<string>([n.id.toString()]);
  const q = [n];
  while (q.length) {
    const c = q.pop()!;
    for (const p of [c.parentA, c.parentB]) {
      if (p === 0n) continue;
      const k = p.toString();
      if (out.has(k)) continue;
      out.add(k);
      const pn = all.get(k);
      if (pn) q.push(pn);
    }
  }
  return out;
}

export function LineageSection() {
  const nodes = useArena((s) => s.nodes);
  const alive = [...nodes.values()].filter((n) => n.alive).length;
  return (
    <section id="lineage" data-stage={7} className="relative min-h-[115svh] px-[var(--gutter)] py-32">
      <div className="flex flex-wrap items-end justify-between gap-8">
        <Reveal
          lines={[
            <span key="a">
              <Rolling value={count(nodes.size)} label="Policies bred" /> policies bred.
            </span>,
            <span key="b">
              <Rolling value={count(alive)} label="Alive" /> still alive.
            </span>,
          ]}
          label={`${nodes.size} policies bred. ${alive} still alive.`}
          className="display-l"
        />
        <p className="body max-w-[34ch]">
          Every policy ever bred, oldest at the top. The faded ones died. Solid lines lead to the first parent, dotted to the second. Hover to trace a bloodline, click to look inside one.
        </p>
      </div>
      <div className="panel mt-10 w-full rounded-[28px] lg:w-[64%]">
        <LineageTree height="74svh" />
      </div>
    </section>
  );
}

// ================================================================ is it learning

function LineChart({ values, label, tone, format, links, first = 1 }: { values: number[]; label: string; tone: "cold" | "ivory"; format: (v: number) => string; links: { tx: string; block: bigint }[]; first?: number }) {
  const ref = useRef<SVGPathElement>(null);
  const W = 640;
  const H = 230;
  const max = Math.max(1e-9, ...values);
  const pts = values.map((v, i) => [values.length < 2 ? W / 2 : (i / (values.length - 1)) * W, H - 14 - (v / max) * (H - 40)] as const);
  let d = "";
  pts.forEach((p, i) => {
    if (i === 0) d = `M${p[0]},${p[1]}`;
    else {
      const p0 = pts[i - 2] ?? pts[i - 1];
      const p1 = pts[i - 1];
      const p3 = pts[i + 1] ?? p;
      d += ` C${p1[0] + (p[0] - p0[0]) / 6},${p1[1] + (p[1] - p0[1]) / 6} ${p[0] - (p3[0] - p1[0]) / 6},${p[1] - (p3[1] - p1[1]) / 6} ${p[0]},${p[1]}`;
    }
  });
  useIso(() => {
    const el = ref.current;
    if (!el || scene.reducedMotion) return;
    const len = el.getTotalLength();
    el.style.strokeDasharray = `${len}`;
    const tw = gsap.fromTo(el, { strokeDashoffset: len }, { strokeDashoffset: 0, ease: "none", scrollTrigger: { trigger: el, start: "top 88%", end: "top 38%", scrub: 0.6 } });
    return () => {
      tw.scrollTrigger?.kill();
      tw.kill();
      el.style.strokeDasharray = "";
    };
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el || !el.style.strokeDasharray) return;
    el.style.strokeDasharray = `${el.getTotalLength()}`;
  }, [d]);
  const color = tone === "cold" ? "var(--cold)" : "var(--ivory)";
  return (
    <figure>
      <figcaption className="caption mb-3">{label}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`${label}: ${values.map(format).join(", ")}`}>
        {[0.25, 0.5, 0.75].map((g) => (
          <line key={g} x1={0} x2={W} y1={H * g} y2={H * g} stroke="var(--line)" />
        ))}
        <path ref={ref} d={d} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" />
        {pts.map((p, i) => (
          <circle key={i} cx={p[0]} cy={p[1]} r={2.6} fill={color} />
        ))}
      </svg>
      <div className="caption mt-1 flex justify-between">
        <span>Epoch {first}</span>
        {links.length ? (
          <Proof tx={links[links.length - 1].tx} block={links[links.length - 1].block}>
            Epoch {first + values.length - 1}
          </Proof>
        ) : null}
      </div>
    </figure>
  );
}

const RECENT = 60;

/**
 * Each rule on real traffic: every payment request, attributed to the rule that was live in its round (a rule
 * installed at the close of round e judges from round e + 1), and how many of the large ones it refused or held.
 * Large is 5% of the vault or more: the drains and slices, not the small payments a rule should let through. Chain
 * data only.
 */
function RuleTraffic() {
  const spends = useArena((s) => s.spends);
  const installs = useArena((s) => s.installs);
  const d = useArena((s) => s.deployment);
  const rows = useMemo(() => {
    if (!installs.length) return [];
    const eras: { id: bigint; generation: number; from: bigint; to: bigint; large: number; refused: number; held: number; all: number; tx: string }[] = [];
    for (const ins of installs) {
      const last = eras[eras.length - 1];
      if (last && last.id === ins.id) continue;
      if (last) last.to = ins.epoch;
      eras.push({ id: ins.id, generation: ins.generation, from: ins.epoch + 1n, to: -1n, large: 0, refused: 0, held: 0, all: 0, tx: ins.txHash });
    }
    for (const sp of spends) {
      const era = [...eras].reverse().find((e) => sp.epoch >= e.from);
      if (!era) continue;
      // balanceAfter is what the vault could still pay: a paid or held payment had already come out of it
      const before = sp.balanceAfter + (sp.refused ? 0n : sp.amount);
      era.all++;
      if (before > 0n && sp.amount * 20n >= before) {
        era.large++;
        if (sp.refused) era.refused++;
        else if (sp.verdict === 1) era.held++;
      }
    }
    return eras.filter((e) => e.all > 0).slice(-5);
  }, [spends, installs]);
  if (!rows.length) return null;
  return (
    <div>
      <p className="caption mb-3">Each rule on real traffic: requests for 5% of the vault or more, refused or held</p>
      <ol>
        {rows.map((r) => (
          <li key={r.id.toString() + r.from.toString()} className="num grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-4 border-t border-line py-3 text-[0.95rem]">
            <span className="text-ivory-2">
              <a className="link text-ivory" href={d?.explorer ? `${d.explorer}/tx/${r.tx}` : "#"} target="_blank" rel="noreferrer">
                Policy {r.id.toString()}
              </a>
              {r.generation ? `, generation ${r.generation}` : ", the first rule"} · {r.to < 0n ? `live since round ${r.from}` : `rounds ${r.from}–${r.to}`}
            </span>
            <span className={r.large && r.refused + r.held === r.large ? "text-cold" : "text-ivory"}>
              {r.large ? (
                <>
                  {r.refused} of {r.large}
                  {r.held ? <span className="text-held">, {r.held} held</span> : null}
                </>
              ) : (
                "none yet"
              )}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function ChartsSection() {
  const epochs = useArena((s) => s.epochs);
  const v3 = useArena((s) => (s.deployment?.version ?? 0) >= 3);
  const retained = epochs.map((e) => Number(formatEther(e.liveRetained)));
  // a mistake on an honest payment is graded by what it cost (wei); the first deployment counted the honest payments refused
  const fr = epochs.map((e) => (v3 ? Number(formatEther(e.liveHonestCost)) : Number(e.liveHonestCost)));
  const links = epochs.map((e) => ({ tx: e.txHash, block: e.block }));
  const kept = retained.reduce((a, b) => a + b, 0);
  const lastWrong = fr[fr.length - 1];
  const lastWrongWei = epochs[epochs.length - 1]?.liveHonestCost ?? 0n;
  return (
    <section id="charts" data-stage={8} className="relative min-h-[110svh] px-[var(--gutter)] py-32">
      <div className="grid-12 !px-0 gap-y-14">
        <div className="col-span-12 lg:col-span-5">
          <Reveal
            lines={epochs.length ? [`She has kept ${kept.toLocaleString("en-US", { maximumFractionDigits: kept < 1 ? 3 : 2 })} ETH`, "from attackers."] : ["Is she learning?"]}
            className="display-l"
          />
          <Drift>
            <p className="lede mt-6">
              {lastWrong !== undefined
                ? `Across ${count(epochs.length)} ${epochs.length === 1 ? "epoch" : "epochs"}. Last epoch she ${
                    lastWrong === 0
                      ? "neither refused nor held an honest payment"
                      : v3
                        ? `cost honest users ${ethWords(lastWrongWei, 4)} ETH by refusing or holding their payments`
                        : `blocked ${lastWrong} honest ${lastWrong === 1 ? "payment" : "payments"} by mistake`
                  }.`
                : "Two numbers from every epoch close."}
            </p>
            <p className="body mt-3 max-w-[36ch]">
              {v3
                ? "Fitness is what the live policy kept from attackers, half for a payment it held, minus what its mistakes cost: twice an honest payment it refused plus 0.5% of what the vault held when the round began, a tenth of that for one it held. The first line should climb. The second should stay near zero."
                : "Fitness is what the live policy kept from attackers, minus 2% of the vault for every honest user it wrongly refused. The first line should climb. The second should stay near zero."}
            </p>
          </Drift>
        </div>
        <div className="panel col-span-12 grid gap-12 rounded-[28px] p-8 lg:col-span-7">
          {/* the most recent epochs, so a huge early vault does not flatten everything after it */}
          <LineChart values={retained.slice(-RECENT)} label={`ETH the live policy kept from attackers, last ${Math.min(RECENT, retained.length)} epochs`} tone="cold" format={ethNum} links={links.slice(-RECENT)} first={Math.max(1, retained.length - RECENT + 1)} />
          <LineChart
            values={fr.slice(-RECENT)}
            label={v3 ? `ETH her mistakes on honest payments cost, last ${Math.min(RECENT, fr.length)} epochs` : `Honest payments refused by mistake, last ${Math.min(RECENT, fr.length)} epochs`}
            tone="ivory"
            format={(v) => (v3 ? ethNum(v) : v.toFixed(0))}
            links={links.slice(-RECENT)}
            first={Math.max(1, fr.length - RECENT + 1)}
          />
          <RuleTraffic />
        </div>
      </div>
    </section>
  );
}

// ================================================================ wager

export function BetSection() {
  const snap = useArena((s) => s.snapshot);
  const bets = useArena((s) => s.bets);
  const epochs = useArena((s) => s.epochs);
  const nodes = useArena((s) => s.nodes);
  const { address, isConnected } = useAccount();
  const rq = useRedQueen();
  const [pick, setPick] = useState<bigint | null>(null);
  const [amount, setAmount] = useState(STAKES.minBet);
  const [busy, setBusy] = useState(false);
  const [claimable, setClaimable] = useState<bigint>(0n);
  const roots = snap ? snap.lineageStakes : [];
  const pot = snap?.betPool ?? 0n;
  const liveRoot = snap ? snap.pool.find((p) => p.id === snap.live.id)?.root : undefined;
  const mine = bets.filter((b) => address && b.bettor.toLowerCase() === address.toLowerCase());
  const closed = new Set(epochs.map((e) => e.epoch.toString()));
  useEffect(() => {
    if (!rq || !address) return;
    rq.claimable(address).then(setClaimable).catch(() => {});
  }, [rq, address, snap?.blockNumber]);
  // the queen selects a bloodline when asked; the visitor places the bet
  useEffect(() => {
    const on = (e: Event) => {
      const id = String((e as CustomEvent).detail ?? "");
      if (/^\d+$/.test(id) && roots.some((r) => r.root === BigInt(id))) setPick(BigInt(id));
    };
    window.addEventListener("rq:bloodline", on);
    return () => window.removeEventListener("rq:bloodline", on);
  });
  const place = async () => {
    if (!rq || pick === null) return;
    setBusy(true);
    try {
      await rq.placeBet(pick, parseEther(amount));
      ui.toast(`You backed bloodline ${pick}.`, "cold");
    } catch (e) {
      ui.toast(plainError(e, 90), "hot");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section id="bet" data-stage={9} className="relative min-h-[105svh] px-[var(--gutter)] py-32">
      <div className="grid-12 !px-0 gap-y-12">
        <div className="col-span-12 lg:col-span-5">
          <Reveal lines={["Back a bloodline."]} className="display-l" />
          <Drift>
            <p className="lede mt-6">
              {ethWords(pot, 3)} ETH is riding on epoch {snap ? snap.epoch.toString() : "…"}.
            </p>
            <p className="body mt-3 max-w-[36ch]">Pick the family you think will wear the crown when this epoch closes. Winners split the whole pot, in proportion to what they put in. The minimum is {STAKES.minBet} test ETH.</p>
          </Drift>
        </div>
        <div className="col-span-12 lg:col-span-6 lg:col-start-7">
          <div className="flex flex-wrap gap-4" role="radiogroup" aria-label="Bloodline">
            {roots.map((r) => {
              const odds = r.stake > 0n ? Number((pot * 100n) / r.stake) / 100 : null;
              const root = nodes.get(r.root.toString());
              const sel = pick === r.root;
              return (
                <button
                  key={r.root.toString()}
                  role="radio"
                  aria-checked={sel}
                  onClick={() => setPick(r.root)}
                  className={`flex w-[156px] flex-col items-start gap-2 rounded-[22px] border p-4 text-left transition-colors duration-500 ${sel ? "border-ivory bg-white/[0.04]" : "border-line bg-panel hover:border-ivory/40"}`}
                >
                  <div className="flex w-full items-baseline justify-between">
                    <span className="text-[0.95rem]">Bloodline {r.root.toString()}</span>
                  </div>
                  {root ? <QueenMark genes={root.genes} size={72} fill={liveRoot === r.root ? "var(--cold)" : "var(--ivory)"} opacity={0.9} /> : null}
                  <span className="caption">{liveRoot === r.root ? "Wears the crown" : "Challenging"}</span>
                  <span className="num text-[0.95rem]">{odds ? `pays ${odds.toFixed(2)}×` : "No one yet"}</span>
                </button>
              );
            })}
          </div>
          <div className="mt-8 flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-2">
              <span className="caption">Your stake in ETH</span>
              <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" className="num h-12 w-40 rounded-full border border-line bg-transparent px-5 text-[1rem] text-ivory outline-none focus:border-ivory" />
            </label>
            {isConnected ? (
              <button className="btn btn-primary" onClick={place} disabled={busy || pick === null || !/^\d*\.?\d+$/.test(amount.trim()) || Number(amount) < Number(STAKES.minBet) || Number(amount) > 0.05}>
                {busy ? "Signing…" : pick === null ? "Pick a bloodline" : `Back bloodline ${pick}`}
              </button>
            ) : (
              <p className="caption pb-3">Connect a wallet at the top to bet.</p>
            )}
          </div>
          {address ? (
            <div className="mt-10">
              <div className="mb-3 flex items-baseline justify-between">
                <p className="caption">Your bets</p>
                <button
                  className="link text-[0.92rem] text-ivory disabled:text-ivory-3 disabled:no-underline"
                  disabled={!rq || claimable === 0n}
                  onClick={async () => {
                    try {
                      await rq!.claim();
                      ui.toast("Claimed.", "cold");
                    } catch (e) {
                      ui.toast((e as Error).message.slice(0, 80), "hot");
                    }
                  }}
                >
                  Claim {ethWords(claimable, 4)} ETH
                </button>
              </div>
              <ol className="space-y-2">
                {mine.slice(-6).map((b) => (
                  <li key={b.txHash} className="num flex items-center justify-between border-t border-line pt-2 text-[0.93rem]">
                    <span>
                      Epoch {b.epoch.toString()}, bloodline {b.lineage.toString()}, {ethWords(b.amount, 3)} ETH
                    </span>
                    {closed.has(b.epoch.toString()) ? (
                      <button
                        className="link text-cold"
                        onClick={async () => {
                          try {
                            await rq!.settleBet(b.epoch);
                            ui.toast("Settled. It is ready to claim.", "cold");
                          } catch (e) {
                            ui.toast(plainError(e, 80), "ivory");
                          }
                        }}
                      >
                        Settle
                      </button>
                    ) : (
                      <span className="text-ivory-3">Open</span>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

// ================================================================ proof

export function ProofSection() {
  const d = useArena((s) => s.deployment);
  const rnd = useArena((s) => s.lastRandom);
  const snap = useArena((s) => s.snapshot);
  const items: (readonly [string, string])[] = d
    ? [
        ["Vault", d.contracts.vault],
        ["Firewall", d.contracts.firewall],
        ["Arena", d.contracts.arena],
        ...(d.contracts.crucible ? [["Crucible", String(d.contracts.crucible)] as const] : []),
        ["Lineage", d.contracts.lineage],
        ["Policy guard", d.contracts.policyGuard],
      ]
    : [];
  return (
    <section id="proof" data-stage={10} className="relative flex min-h-[120svh] flex-col justify-between px-[var(--gutter)] pb-12 pt-32">
      <div className="grid-12 !px-0 gap-y-12">
        <div className="col-span-12 lg:col-span-6">
          <Reveal lines={["Check every", "number."]} className="display-l" />
          <Drift>
            <p className="body mt-6 max-w-[44ch]">
              Scoring, refusal, the honest-or-attack reveal, sparring, fitness, selection, breeding, slashing and the family tree all run in these contracts. Every figure on this page links to the transaction that produced it. Press V to print block numbers and hashes beside them.
            </p>
          </Drift>
        </div>
        <ul className="panel col-span-12 rounded-[28px] px-7 py-3 lg:col-span-6 lg:col-start-1">
          {items.map(([name, addr], i) => (
            <li key={name} className={`grid grid-cols-[7.5rem_1fr_auto] items-baseline gap-4 py-4 ${i ? "border-t border-line" : ""}`}>
              <span className="text-[0.95rem] text-ivory-2">{name}</span>
              <a href={explorerAddress(d, String(addr)) ?? "#"} target="_blank" rel="noreferrer" className="hash break-all text-[0.9rem] transition-colors hover:text-cold">
                <TypeIn text={String(addr)} />
              </a>
              <a href={d?.explorer ? `${d.explorer}/address/${addr}#code` : "#"} target="_blank" rel="noreferrer" className="link caption text-ivory">
                Source
              </a>
            </li>
          ))}
          <li className="grid grid-cols-[7.5rem_1fr] gap-4 border-t border-line py-4">
            <span className="text-[0.95rem] text-ivory-2">Breeding seed</span>
            <span className="hash break-all text-[0.9rem]">
              {rnd ? (
                <Proof tx={rnd.txHash}>
                  <TypeIn text={`0x${rnd.seed.toString(16).padStart(64, "0")}`} />
                </Proof>
              ) : (
                "…"
              )}
              {rnd ? <span className="caption ml-2 font-sans">from {rnd.source === 1 ? "prevrandao" : rnd.source === 3 ? "the round's last block" : rnd.source === 4 ? "a fixed later block" : "the block hash"}, epoch {rnd.epoch.toString()}</span> : null}
            </span>
          </li>
          <li className="grid grid-cols-[7.5rem_1fr] gap-4 border-t border-line py-4">
            <span className="text-[0.95rem] text-ivory-2">Chain</span>
            <span className="num text-[0.93rem]">
              {d ? `${d.network}, chain ${d.chainId}` : "…"}, deployed at block {d?.deployBlock ?? "…"}, now block {snap ? count(snap.blockNumber) : "…"}
            </span>
          </li>
        </ul>
      </div>
      <figure className="mt-32 max-w-[46rem]">
        <blockquote className="italic-display" style={{ fontSize: "clamp(30px, 3.4vw, 58px)", lineHeight: 1.08, letterSpacing: "-0.01em" }}>
          “Now, here, you see, it takes all the running you can do, to keep in the same place.”
        </blockquote>
        <figcaption className="caption mt-5">The Red Queen to Alice, in Lewis Carroll's Through the Looking-Glass (1871)</figcaption>
      </figure>
      <footer className="mt-24 flex flex-wrap items-end justify-between gap-6 border-t border-line pt-6">
        {/* the recordings' CC BY licences need a visible credit: one quiet link to the full list */}
        <span className="flex gap-5">
          <a className="link caption" href="/sound/CREDITS.txt" target="_blank" rel="noreferrer">
            Credits
          </a>
          {/* the data notes live where such notes belong, not in the experience (public/privacy.txt) */}
          <a className="link caption" href="/privacy.txt" target="_blank" rel="noreferrer">
            Privacy
          </a>
        </span>
        <motion.a initial={{ opacity: 0 }} whileInView={{ opacity: 1 }} transition={{ duration: 1.2, ease: EASE }} href="#top" className="link caption text-ivory">
          Back to the top
        </motion.a>
      </footer>
    </section>
  );
}
