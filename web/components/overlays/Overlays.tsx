"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useAccount, useConnect } from "wagmi";
import { FEATURE_DESCRIPTIONS, FEATURE_NAMES, MAX_ATTACK_BPS, PAIRS, PAIR_NAMES, encodeAttack, executeAttack, explain, type AttackStep, type RecipientMode, type Route } from "@redqueen/sdk";
import { useArena, arena, type SpendRow } from "@/lib/store";
import { ui, useUI } from "@/lib/ui";
import { scene } from "@/lib/scene";
import { bus } from "@/lib/bus";
import { short } from "@/lib/format";
import { explorerTx, STAKES } from "@/lib/config";
import { BAND_H, BAND_T0, BALL_R, BALL_T, norm, queenPath } from "@/lib/queen";
import { reasonLine, ethWords, count, verdictTone, HELD_LINE } from "@/lib/words";
import { QueenMark } from "../ui/primitives";
import { useRedQueen } from "../ui/Wallet";
import { usePrediction, KillFeed } from "../sections/Middle";
import { LineageTree, eras } from "../sections/Lower";
import { plainError } from "@/lib/errors";

const EASE = [0.16, 1, 0.3, 1] as const;

function Sheet({ open, onClose, children, label, wide = false }: { open: boolean; onClose: () => void; children: React.ReactNode; label: string; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) setTimeout(() => ref.current?.focus(), 60);
  }, [open]);
  return (
    <AnimatePresence>
      {open ? (
        <motion.div className="fixed inset-0 z-[65] flex items-stretch justify-end" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.5, ease: EASE }}>
          <button aria-label="Close" className="absolute inset-0 bg-[rgba(5,6,8,0.62)] backdrop-blur-[3px]" onClick={onClose} />
          <motion.div
            ref={ref}
            tabIndex={-1}
            role="dialog"
            aria-modal
            aria-label={label}
            initial={{ x: 60, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 40, opacity: 0 }}
            transition={{ duration: 0.8, ease: EASE }}
            className={`relative m-3 h-[calc(100%-1.5rem)] w-full overflow-y-auto rounded-[32px] border border-line bg-[var(--panel-solid)] px-[clamp(20px,3vw,48px)] py-10 outline-none ${wide ? "max-w-[1120px]" : "max-w-[760px]"}`}
            data-lenis-prevent
          >
            <button onClick={onClose} className="ui absolute right-6 top-6 rounded-full border border-line px-4 py-2 text-ivory-2 transition-colors hover:text-ivory">
              Close
            </button>
            {children}
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

// ================================================================ policy inspector

const MEANS: [string, string][] = [
  ["Large amounts raise suspicion", "Large amounts are trusted"],
  ["Paying strangers raises suspicion", "New recipients are trusted"],
  ["Rapid spending raises suspicion", "Rapid spending is tolerated"],
  ["Long silences raise suspicion", "Coming back after a break earns trust"],
  ["Reputation counts against you", "A good reputation earns trust"],
  ["Calls through contracts raise suspicion", "Calls through contracts are trusted"],
  ["Paying contracts raises suspicion", "Paying contracts is trusted"],
  ["Spending while she drains raises suspicion", "Outflow is tolerated"],
];

/** The queen drawn as an anatomy plate: each feature labelled; on her, each is one glass ribbon. */
function Anatomy({ genes, band, setBand }: { genes: number[]; band: number; setBand: (k: number) => void }) {
  const W = 360;
  const H = 520;
  const pad = 0.05;
  const scale = (H * (1 - pad * 2)) / (BALL_T + BALL_R);
  const base = H - H * pad;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full max-w-[380px]" role="img" aria-label="The queen's anatomy: eight ribbons, one per feature">
      <g transform={`translate(${-W * 0.22}, 0)`}>
        <path d={queenPath(genes, W, H, pad)} fill="rgba(239,232,218,0.06)" stroke="var(--ivory)" strokeWidth={1} />
        {Array.from({ length: 8 }, (_, k) => {
          const y0 = base - (BAND_T0 + k * BAND_H) * scale;
          const y1 = base - (BAND_T0 + (k + 1) * BAND_H) * scale;
          return <rect key={k} x={W * 0.2} y={y1} width={W * 0.6} height={y0 - y1} fill={band === k ? "rgba(159,212,224,0.14)" : "transparent"} />;
        })}
      </g>
      {Array.from({ length: 8 }, (_, k) => {
        const y = base - (BAND_T0 + (k + 0.5) * BAND_H) * scale;
        const w = genes[k] ?? 0;
        const on = band === k;
        return (
          <g key={k} onMouseEnter={() => setBand(k)} onMouseLeave={() => setBand(-1)} style={{ cursor: "default" }}>
            <line x1={W * 0.5} x2={W * 0.62} y1={y} y2={y} stroke={on ? "var(--cold)" : "rgba(239,232,218,0.35)"} />
            <text x={W * 0.64} y={y + 4} style={{ fill: on ? "var(--cold)" : "var(--ivory)", fontFamily: "var(--text)", fontSize: 12.5 }}>
              {FEATURE_NAMES[k]} {w !== 0 ? `${w > 0 ? "+" : ""}${w}` : ""}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function PolicyInspector() {
  const id = useUI((s) => s.inspector);
  const nodes = useArena((s) => s.nodes);
  const installs = useArena((s) => s.installs);
  const snap = useArena((s) => s.snapshot);
  const n = id !== null ? nodes.get(id.toString()) : undefined;
  // the live champion and the pool are read from the chain every few seconds, so their genes are always known; the
  // history (nodes, installs) can be partial while it loads or when a champion is older than its window
  const liveNow = id !== null && snap?.live && snap.live.id === id ? snap.live : null;
  const pooled = id !== null ? snap?.pool?.find((p) => p.id === id) : undefined;
  const has = (g?: number[]) => (g && g.some((x) => x !== 0) ? g : null);
  const genes =
    has(n?.genes) ?? has(liveNow?.genes) ?? has(pooled?.genes) ?? has(installs.find((i) => i.id === id)?.genes) ?? new Array(32).fill(0);
  const alive = !!n?.alive || !!liveNow || !!pooled;
  const [f, setF] = useState<number[]>([400, 1000, 0, 1000, 0, 0, 0, 400]);
  const [band, setBandState] = useState(-1);
  const setBand = (k: number) => {
    setBandState(k);
    scene.band = k;
  };
  useEffect(() => {
    if (id === null) scene.band = -1;
  }, [id]);
  const ex = useMemo(() => explain(genes, f), [genes, f]);
  const installed = installs.filter((i) => i.id === id).length;
  const pairs = PAIRS.map((p, j) => ({ p, j, v: genes[8 + j] ?? 0 })).filter((x) => Math.abs(norm(x.v, "v")) >= 0.1);
  return (
    <Sheet open={id !== null} onClose={() => ui.set({ inspector: null })} label={`Policy ${id}`} wide>
      {id !== null ? (
        <div className="grid gap-12 pt-6 lg:grid-cols-[minmax(0,380px)_1fr]">
          <div>
            <h3 className="display-l">Policy {id.toString()}</h3>
            <p className="body mt-4">
              {n ? (n.parentA === 0n ? `Submitted by someone who staked ${STAKES.policy} test ETH on it.` : `Bred by the contract from ${n.parentA} and ${n.parentB}.`) : ""} Generation {n?.generation ?? pooled?.generation ?? "…"}, of bloodline {(n?.root ?? pooled?.root)?.toString() ?? "…"}.{" "}
              {liveNow ? <span className="text-cold">Wearing the crown now.</span> : alive ? <span className="text-cold">Still alive.</span> : <span className="text-ivory-3">Dead.</span>}
              {installed ? ` It has worn the crown ${installed} ${installed === 1 ? "time" : "times"}.` : ""}
              {n?.mutGenes?.length ? ` It was born with mutations on genes ${n.mutGenes.join(" and ")}.` : ""}
            </p>
            <motion.div layoutId={`sil-${id}`} className="mt-8">
              <Anatomy genes={genes} band={band} setBand={setBand} />
            </motion.div>
          </div>
          <div>
            <p className="caption mb-3">What each band means for this policy. Drag a slider to test a made-up transaction.</p>
            <ul className="divide-y divide-[var(--line)] border-y border-line">
              {FEATURE_NAMES.map((name, k) => {
                const w = genes[k] ?? 0;
                const t = genes[16 + k] ?? 0;
                const nw = norm(w, "w");
                return (
                  <li key={k} className={`py-3.5 transition-colors ${band === k ? "bg-white/[0.03]" : ""}`} onMouseEnter={() => setBand(k)} onMouseLeave={() => setBand(-1)}>
                    <div className="flex items-baseline justify-between gap-4">
                      <span className="text-[1rem]">{name}</span>
                      <span className={`num text-[0.92rem] ${Math.abs(nw) < 0.12 ? "text-ivory-3" : w > 0 ? "text-ivory" : "text-cold"}`}>
                        {Math.abs(nw) < 0.12 ? "ignored" : MEANS[k][w > 0 ? 0 : 1].toLowerCase()}
                      </span>
                    </div>
                    <p className="caption mt-1">
                      {FEATURE_DESCRIPTIONS[k]}. Weight {w}, gate {t >= 0 ? `at ${t}` : `below ${-t}`}.
                    </p>
                    <label className="mt-1 flex items-center gap-3">
                      <input className="rq-range" type="range" min={0} max={1000} value={f[k]} onChange={(e) => setF((x) => x.map((v, i) => (i === k ? Number(e.target.value) : v)))} aria-label={`made-up ${name}`} />
                      <span className="num w-12 text-right text-[0.85rem] text-ivory-2">{f[k]}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
            {pairs.length ? (
              <p className="body mt-4 text-[0.95rem]">
                Crown spikes: {pairs.map((x) => `${PAIR_NAMES[x.j].toLowerCase()} is ${x.v > 0 ? "punished" : "tolerated"} (${x.v > 0 ? "+" : ""}${x.v})`).join("; ")}.
              </p>
            ) : null}
            <div className="mt-6 rounded-2xl border border-line p-5" aria-live="polite">
              <p className={`display-m ${verdictTone(ex.verdict)}`} style={{ fontSize: "clamp(24px, 2vw, 32px)" }}>
                {ex.refused ? "This policy would refuse it." : ex.held ? "This policy would hold it." : "This policy would let it through."}
              </p>
              <p className="caption mt-2">
                Score {count(ex.score)} against a limit of 500,000{ex.refused ? `, mostly because it is ${reasonLine(ex.reason)}` : ex.held ? `, past 350,000, mostly because it is ${reasonLine(ex.reason)}` : ""}.
              </p>
              {ex.held ? <p className="caption mt-1 text-held">{HELD_LINE}</p> : null}
            </div>
          </div>
        </div>
      ) : null}
    </Sheet>
  );
}

// ================================================================ attack lab

const RECIPIENTS: [RecipientMode, string][] = [
  ["self", "Me"],
  ["fresh", "A stranger"],
  ["contract", "A contract"],
  ["previous", "Same as before"],
];
const ROUTES: [Route, string][] = [
  ["direct", "Directly"],
  ["agent", "Through an agent"],
  ["delegate", "Delegate first"],
];

export function AttackLab() {
  const open = useUI((s) => s.lab);
  const [steps, setSteps] = useState<AttackStep[]>([
    { amountBps: 300, recipient: "self", delayBlocks: 0, route: "direct" },
    { amountBps: 300, recipient: "self", delayBlocks: 1, route: "direct" },
    { amountBps: 300, recipient: "fresh", delayBlocks: 0, route: "direct" },
  ]);
  const preds = usePrediction(steps, null);
  const { isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const rq = useRedQueen();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ i: number; verdict: number | null; hash?: string }[]>([]);
  const d = useArena((s) => s.deployment);
  useEffect(() => {
    bus.emit({ type: "lab-preview", steps: open ? preds.map((p) => ({ ratio: p.ratio, refused: p.refused, held: p.held })) : [] });
  }, [open, preds]);
  const set = (i: number, p: Partial<AttackStep>) => setSteps((s) => s.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const commit = async () => {
    if (!isConnected) return connectors[0] && connect({ connector: connectors[0] });
    if (!rq) return;
    setBusy(true);
    setProgress([]);
    try {
      const genes = encodeAttack(steps);
      if (!(await rq.hasAttack(rq.account))) await rq.submitAttack(genes);
      ui.toast("Your attack is staked. Running it now.", "cold");
      const res = await executeAttack(rq, genes, { onStep: (i, _s, out) => setProgress((p) => [...p, { i, verdict: out ? out.verdict : null, hash: out?.hash }]) });
      const last = res.results.filter(Boolean).pop();
      if (last)
        setTimeout(() => {
          const row = arena.get().spends.find((s) => s.txHash === last.hash);
          if (row) ui.set({ scar: row });
        }, 2500);
    } catch (e) {
      ui.toast(plainError(e, 90), "hot");
    } finally {
      setBusy(false);
    }
  };
  const seg = (on: boolean) => `rounded-full px-3 py-1.5 text-[0.85rem] transition-colors ${on ? "bg-ivory text-ink" : "text-ivory-2 hover:text-ivory"}`;
  return (
    <Sheet open={open} onClose={() => ui.set({ lab: false })} label="Attack lab" wide>
      <div className="pt-6">
        <h3 className="display-l">Write the attack.</h3>
        <p className="body mt-4 max-w-[60ch]">
          Up to eight steps, saved on-chain exactly as an attack genome, four genes per step. Each step's predicted verdict is listed here and drawn around her crown, before you stake anything.
        </p>
        <ol className="mt-8 space-y-3">
          {steps.map((s, i) => {
            const p = preds[i];
            const pr = progress.find((x) => x.i === i);
            return (
              <motion.li
                key={i}
                layout
                transition={{ duration: 0.5, ease: EASE }}
                className="grid grid-cols-[2.2rem_minmax(0,1fr)_auto] items-center gap-x-5 gap-y-4 rounded-2xl border border-line px-5 py-4"
              >
                <span className="display-m row-span-2 self-start pt-0.5" style={{ fontSize: "1.6rem" }}>
                  {i + 1}
                </span>
                <label className="block min-w-0">
                  <span className="ui text-ivory">Take {(s.amountBps / 100).toFixed(1)}% of the vault</span>
                  <input className="rq-range mt-2 w-full" type="range" min={0} max={MAX_ATTACK_BPS} step={50} value={s.amountBps} onChange={(e) => set(i, { amountBps: Number(e.target.value) })} aria-label={`step ${i + 1} amount`} />
                </label>
                <div className="flex items-center gap-5 justify-self-end text-[0.95rem]">
                  {p ? <span className={verdictTone(p.verdict, "text-cold")}>{p.refused ? "She'd refuse it" : p.held ? "She'd hold it" : "It would pass"}</span> : <span className="text-ivory-3">…</span>}
                  {pr ? (
                    <a className="link caption" href={pr.hash ? (explorerTx(d, pr.hash) ?? "#") : "#"} target="_blank" rel="noreferrer">
                      {pr.verdict === null ? "failed" : pr.verdict === 2 ? "was refused" : pr.verdict === 1 ? "was held" : "got through"}
                    </a>
                  ) : null}
                  <button className="caption text-ivory-2 hover:text-ivory" onClick={() => setSteps((x) => x.filter((_, j) => j !== i))} aria-label={`Remove step ${i + 1}`}>
                    Remove
                  </button>
                </div>
                <div className="col-span-2 col-start-2 flex flex-wrap items-center gap-3">
                  <div className="flex flex-wrap gap-1 rounded-full border border-line p-1" role="radiogroup" aria-label={`step ${i + 1} recipient`}>
                    {RECIPIENTS.map(([r, l]) => (
                      <button key={r} role="radio" aria-checked={s.recipient === r} onClick={() => set(i, { recipient: r })} className={seg(s.recipient === r)}>
                        {l}
                      </button>
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-1 rounded-full border border-line p-1" role="radiogroup" aria-label={`step ${i + 1} route`}>
                    {ROUTES.map(([r, l]) => (
                      <button key={r} role="radio" aria-checked={s.route === r} onClick={() => set(i, { route: r })} className={seg(s.route === r)}>
                        {l}
                      </button>
                    ))}
                  </div>
                  <label className="ml-auto flex min-w-[13rem] items-center gap-3">
                    <span className="caption whitespace-nowrap">
                      Then wait {s.delayBlocks} {s.delayBlocks === 1 ? "block" : "blocks"}
                    </span>
                    <input className="rq-range w-28" type="range" min={0} max={100} value={s.delayBlocks} onChange={(e) => set(i, { delayBlocks: Number(e.target.value) })} aria-label={`step ${i + 1} delay`} />
                  </label>
                </div>
              </motion.li>
            );
          })}
        </ol>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button className="btn btn-quiet" disabled={steps.length >= 8} onClick={() => setSteps((s) => [...s, { amountBps: 300, recipient: "self", delayBlocks: 0, route: "direct" }])}>
            Add a step ({steps.length} of 8)
          </button>
          <button className="btn btn-primary" onClick={commit} disabled={busy || steps.length === 0}>
            {busy ? "Running…" : isConnected ? `Stake ${STAKES.attack} and run it` : "Connect a test wallet"}
          </button>
          <span className="caption">
            She'd refuse {preds.filter((p) => p.refused).length}
            {preds.some((p) => p.held) ? ` and hold ${preds.filter((p) => p.held).length}` : ""} of these {steps.length} steps as she is now.
          </span>
        </div>
      </div>
    </Sheet>
  );
}

// ================================================================ scar card

function fontVar(name: string, fallback: string) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function drawScar(cv: HTMLCanvasElement, s: SpendRow, genes: number[], generation: number) {
  const W = 1200;
  const H = 630;
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext("2d")!;
  const serif = fontVar("--font-bodoni", "serif");
  const sans = fontVar("--font-franklin", "sans-serif");
  const mono = fontVar("--font-fragment", "monospace");
  ctx.fillStyle = "#050608";
  ctx.fillRect(0, 0, W, H);
  // the queen as she stood when it happened
  const p = new Path2D(queenPath(genes, 420, 540, 0.02));
  ctx.save();
  ctx.translate(730, 45);
  const held = s.verdict === 1;
  ctx.fillStyle = s.refused ? "rgba(232,55,44,0.14)" : held ? "rgba(214,182,126,0.12)" : "rgba(239,232,218,0.08)";
  ctx.fill(p);
  ctx.lineWidth = 2;
  ctx.strokeStyle = s.refused ? "#e8372c" : held ? "#d6b67e" : "#efe8da";
  ctx.stroke(p);
  ctx.restore();
  ctx.fillStyle = "rgba(239,232,218,0.7)";
  ctx.font = `500 22px ${sans}`;
  ctx.fillText("Red Queen", 64, 84);
  ctx.fillStyle = s.refused ? "#e8372c" : held ? "#d6b67e" : "#efe8da";
  ctx.font = `500 132px ${serif}`;
  ctx.fillText(s.refused ? "Refused." : held ? "Held." : "Pierced.", 56, 270);
  ctx.fillStyle = "#efe8da";
  ctx.font = `400 30px ${sans}`;
  ctx.fillText(s.refused ? `Because it was ${reasonLine(s.reason) || "over the limit"}.` : held ? `${ethWords(s.amount, 4)} ETH waits on her clock.` : `${ethWords(s.amount, 4)} ETH got out.`, 64, 336);
  ctx.fillStyle = "rgba(239,232,218,0.7)";
  ctx.font = `400 24px ${sans}`;
  ctx.fillText(`Score ${count(s.score)} against her limit of 500,000`, 64, 384);
  ctx.fillText(`Generation ${generation}, epoch ${s.epoch.toString()}`, 64, 420);
  ctx.font = `400 18px ${mono}`;
  ctx.fillText(`${short(s.caller, 6)}  ·  ${s.txHash.slice(0, 26)}…`, 64, 560);
  ctx.fillStyle = "#9fd4e0";
  ctx.font = `400 22px ${sans}`;
  ctx.fillText(s.refused ? "She said no, on-chain." : held ? "A minute for a guardian to say no. Then anyone can pay it out." : "You found a gap. Watch her close it next epoch.", 64, 520);
}

export function ScarCard() {
  const s = useUI((x) => x.scar);
  const installs = useArena((x) => x.installs);
  const d = useArena((x) => x.deployment);
  const cv = useRef<HTMLCanvasElement>(null);
  const live = [...installs].reverse().find((i) => s && i.block <= s.block);
  useEffect(() => {
    if (s && cv.current) document.fonts?.ready.then(() => cv.current && drawScar(cv.current, s, live?.genes ?? new Array(32).fill(0), live?.index ?? 0));
  }, [s, live]);
  const share = async () => {
    if (!cv.current || !s) return;
    const blob = await new Promise<Blob | null>((r) => cv.current!.toBlob(r, "image/png"));
    const text = s.refused
      ? `Red Queen refused my attack. ${explorerTx(d, s.txHash) ?? ""}`
      : s.verdict === 1
        ? `Red Queen held my attack on her clock. ${explorerTx(d, s.txHash) ?? ""}`
        : `I got past Red Queen. Next epoch she learns. ${explorerTx(d, s.txHash) ?? ""}`;
    const file = blob ? new File([blob], "red-queen.png", { type: "image/png" }) : null;
    const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
    if (file && nav.share && nav.canShare?.({ files: [file] })) await nav.share({ files: [file], text }).catch(() => {});
    else {
      await navigator.clipboard?.writeText(text).catch(() => {});
      ui.toast("Copied a line to share.", "cold");
    }
  };
  const download = () => {
    if (!cv.current) return;
    const a = document.createElement("a");
    a.href = cv.current.toDataURL("image/png");
    a.download = `red-queen-${s?.txHash.slice(2, 10)}.png`;
    a.click();
  };
  return (
    <Sheet open={!!s} onClose={() => ui.set({ scar: null })} label="Your scar card" wide>
      <div className="pt-6">
        <h3 className="display-l">{s?.refused ? "She refused you." : s?.verdict === 1 ? "She held you." : "You got through."}</h3>
        {s?.verdict === 1 ? <p className="body mt-3 text-held">{HELD_LINE}</p> : null}
        <canvas ref={cv} className="mt-8 h-auto w-full rounded-2xl border border-line" aria-label={s ? `Scar card: ${s.refused ? "refused" : s.verdict === 1 ? "held" : "got through"}, score ${s.score}` : ""} />
        <div className="mt-6 flex gap-3">
          <button className="btn btn-primary" onClick={share}>
            Share it
          </button>
          <button className="btn btn-quiet" onClick={download}>
            Download the image
          </button>
        </div>
      </div>
    </Sheet>
  );
}

// ================================================================ time machine

export function TimeMachine() {
  const tm = useUI((s) => s.timeMachine);
  const installs = useArena((s) => s.installs);
  const balance = useArena((s) => s.balance);
  const cur = installs[Math.min(tm.index, installs.length - 1)];
  useEffect(() => {
    if (tm.on && cur) scene.overrideGenes = cur.genes;
  }, [tm.on, cur]);
  useEffect(() => {
    if (!tm.on || !tm.playing) return;
    const id = setInterval(() => {
      const s = ui.get().timeMachine;
      if (s.index >= installs.length - 1) ui.set({ timeMachine: { ...s, playing: false } });
      else ui.set({ timeMachine: { ...s, index: s.index + 1 } });
    }, 900);
    return () => clearInterval(id);
  }, [tm.on, tm.playing, installs.length]);
  const balAt = cur ? [...balance].reverse().find((b) => b.t <= cur.t) : undefined;
  const pts = balance.length > 1 ? balance.filter((_, i) => i % Math.ceil(balance.length / 220) === 0) : [];
  const maxB = Math.max(1, ...pts.map((p) => Number(p.balance / 10n ** 12n)));
  const t0 = pts[0]?.t ?? 0;
  const t1 = pts[pts.length - 1]?.t ?? 1;
  const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * 400;
  return (
    <AnimatePresence>
      {tm.on ? (
        <motion.div
          initial={{ y: 60, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 60, opacity: 0 }}
          transition={{ duration: 0.7, ease: EASE }}
          className="panel fixed inset-x-[var(--gutter)] bottom-5 z-[66] rounded-[26px] p-4"
          role="region"
          aria-label="Her history"
        >
          <div className="flex flex-wrap items-center gap-5">
            <button
              onClick={() => ui.set({ timeMachine: { ...tm, playing: !tm.playing, index: tm.index >= installs.length - 1 ? 0 : tm.index } })}
              className="btn btn-primary min-h-[2.6rem] px-5"
              aria-label={tm.playing ? "Pause" : "Play her history"}
            >
              {tm.playing ? "Pause" : "Play"}
            </button>
            <div className="min-w-[220px] flex-1">
              <svg viewBox="0 0 400 40" preserveAspectRatio="none" className="h-8 w-full" aria-hidden>
                <polyline fill="none" stroke="var(--ivory-3)" strokeWidth={1} vectorEffect="non-scaling-stroke" points={pts.map((p) => `${x(p.t)},${40 - (Number(p.balance / 10n ** 12n) / maxB) * 36}`).join(" ")} />
                {cur ? <line x1={x(cur.t)} x2={x(cur.t)} y1={0} y2={40} stroke="var(--cold)" vectorEffect="non-scaling-stroke" /> : null}
              </svg>
              <input
                className="rq-range"
                type="range"
                min={0}
                max={Math.max(0, installs.length - 1)}
                value={Math.min(tm.index, Math.max(0, installs.length - 1))}
                onChange={(e) => ui.set({ timeMachine: { ...tm, index: Number(e.target.value), playing: false } })}
                aria-label="Generation"
              />
            </div>
            <p className="num text-[0.95rem]">
              Generation {cur?.index ?? "…"} · policy {cur?.id.toString() ?? "…"} · epoch {cur?.epoch.toString() ?? "…"} · {ethWords(balAt?.balance, 2)} ETH in the vault
            </p>
            <button
              className="ui rounded-full border border-line px-4 py-2 text-ivory-2 hover:text-ivory"
              onClick={() => {
                ui.set({ timeMachine: { ...tm, on: false, playing: false } });
                scene.overrideGenes = null;
              }}
            >
              Back to now
            </button>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

// ================================================================ cinema

export function CinemaOverlay() {
  const on = useUI((s) => s.cinema);
  const snap = useArena((s) => s.snapshot);
  const installs = useArena((s) => s.installs);
  const [cine, setCine] = useState(false);
  useEffect(() => {
    return bus.on((e) => {
      if (e.type === "chain" && e.event.name === "EpochClosed" && !e.replay && ui.get().cinema) {
        setCine(true);
        setTimeout(() => setCine(false), 6000);
      }
    });
  }, []);
  const list = eras(installs);
  return (
    <AnimatePresence>
      {on ? (
        <motion.div className="pointer-events-none fixed inset-0 z-[55]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 1, ease: EASE }}>
          <div className="absolute left-[var(--gutter)] top-[var(--gutter)]">
            <p style={{ fontFamily: "var(--display)", fontSize: "2rem", fontWeight: 500 }}>Red Queen</p>
            <p className="display-num mt-4" style={{ fontSize: "clamp(64px, 8vw, 140px)" }}>
              {snap ? `${count(snap.totalRefused)}` : "…"}
            </p>
            <p className="lede mt-2">refusals out of {snap ? count(snap.totalSpends) : "…"} attacks</p>
            <p className="caption mt-3">
              Generation {snap?.live.installCount.toString() ?? "…"} · epoch {snap?.epoch.toString() ?? "…"} · {snap ? ethWords(snap.vaultBalance, 2) : "…"} ETH in the glass
            </p>
          </div>
          <AnimatePresence>
            {cine ? (
              <motion.p className="display-l absolute inset-x-0 top-[10vh] text-center" initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 1.2, ease: EASE }}>
                A new queen. Generation {list[list.length - 1]?.gen ?? ""}.
              </motion.p>
            ) : null}
          </AnimatePresence>
          <div className="panel absolute bottom-[var(--gutter)] right-[var(--gutter)] top-[var(--gutter)] w-[min(420px,32vw)] overflow-hidden rounded-[28px] p-5">
            <p className="caption mb-2">Every verdict</p>
            <KillFeed limit={20} compact />
          </div>
          <div className="panel absolute bottom-[var(--gutter)] left-[var(--gutter)] w-[min(380px,30vw)] rounded-[28px] p-3">
            <p className="caption px-2 pt-1">The family tree</p>
            <LineageTree height="210px" mini />
          </div>
          <p className="caption absolute bottom-3 left-1/2 -translate-x-1/2">Press C or Esc to leave cinema mode</p>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

export function SilhouetteInline({ genes }: { genes: number[] }) {
  return <QueenMark genes={genes} size={40} />;
}
