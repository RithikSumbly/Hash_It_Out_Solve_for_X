"use client";
/**
 * The demonstration: the site plays itself as a short film, live, narrated by the queen.
 *
 * The frame closes to a letterbox, the page's own copy steps aside and the camera travels chapter by
 * chapter. She speaks every line (a synthesised voice, rendered by tools/voice/render.py), the subtitles follow her word by
 * word, and the film's clock is her voice: each line starts a third of a second after the last ends, so
 * nothing waits. Every chapter shows the machinery at work with live data:
 *
 *   I     the vault, its balance, generations and refusals
 *   II    a wallet's fixed rules against hers
 *   III   the eight measurements (each lights as she names it) and her 32 genes, live
 *   IV    a real attack: the pipeline from signature to block to verdict, then the contract's own
 *         arithmetic for it (re-scored with the SDK's bit-exact mirror, shown only if it matches)
 *   V     the shadow pool: every candidate's verdict on that same payment
 *   VI    the last epoch's grading table, F = R − λ·B, the four survivors and the dead
 *   VII   a real child, gene by gene from its two parents, its mutations marked
 *   VIII  the best attack plan in the attackers' pool, step by step
 *   IX    the contracts it all runs in
 *   X     your turn
 *
 * Space pauses, the arrows skip, the timeline jumps, Esc leaves. Without sound it plays the same, timed
 * to the same lines, with the subtitles.
 */
import { motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { decodeAttack, explain, GLOBAL_THRESHOLD, HOLD_THRESHOLD, PAIR_NAMES } from "@redqueen/sdk";
import { arena, useArena, type Node as LineageNode } from "@/lib/store";
import { tour, useTour } from "@/lib/tour";
import { demo, useDemo } from "@/lib/demo";
import { ui, useUI } from "@/lib/ui";
import { sound } from "@/lib/sound";
import { scene } from "@/lib/scene";
import { count, ethWords, reasonLine } from "@/lib/words";
import { short } from "@/lib/format";
import { RELAY_URL, explorerTx } from "@/lib/config";
import { scrollToId } from "../ui/SmoothScroll";

const EASE = [0.16, 1, 0.3, 1] as const;
const LEAD = 0.45; // the headline lands just before she speaks
const GAP = 0.3; // between lines within a chapter
const TAIL = 0.5; // after her last word, before the camera moves on
const ATTACK_EST = 36; // for the timecode, before the verdict is known (her two paragraphs, about 34 s, and a block)
const LIMIT = Number(GLOBAL_THRESHOLD);
const HOLD = Number(HOLD_THRESHOLD);
const VOICE = "/voice/";

/**
 * Her script: one continuous paragraph per chapter, spoken the way a person talks, continuous and natural. The voice manifest (when present) carries the same text, the
 * clip and its word timings; visuals land on phrases inside the paragraphs.
 */
const SCRIPT: Record<string, string> = {
  c01: "Hello. I'm the Red Queen. I guard a vault on Ethereum. People try to take money from it all day long, and every few minutes, I rewrite the rules I use to stop them. Let me show you how it works.",
  c02: "Here's the problem. More and more machines have wallets now, and the rules that protect them change only when someone edits them, out of sight. Attackers keep changing. So I change too, in the open.",
  c03: "Anyone can ask me for money. Before I answer, I check eight things: how big the payment is compared with everything I hold, how new the person receiving it is, how quickly the requests are coming in, how long it's been since the last one, who's asking, whether it came through a contract, whether it's going to one, and how much has already left this round. Each of those gets a weight from my genome, thirty-two numbers stored on the chain.",
  c04a: "Now watch. Someone has just asked me for forty percent of the vault, all at once. The request is signed, and it's on its way into the next block.",
  c04w: "It's in the chain's hands now. Give it a moment.",
  c04f: "The chain is quiet right now, so here's one I turned away a little earlier.",
  c04r: "Here it is. First, I measure it. Then I weigh each measurement against my genes, and I look for the patterns I've learned to be wary of, like a large payment while money is already flowing out. Add it all up, and it's well over my limit. Refused. Nothing left the vault, and that refusal stays on the chain for good.",
  c04p: "Here it is. First, I measure it. Then I weigh each measurement against my genes, and I look for the patterns I've learned to be wary of. Add it all up, and it comes in under my limit, so this one goes through. I'll remember it, though. My next generation is bred from attacks like this.",
  // a payment close to her limit is held. This line has no recording: it plays as subtitles only.
  c04h: "Here it is. First, I measure it. Then I weigh each measurement against my genes, and I look for the patterns I've learned to be wary of. Add it all up, and it comes in under my limit, but close to it, so I hold it. It waits about a minute; the owner or a guardian may cancel it; then anyone can pay it out.",
  c05: "But I'm not the only rule. Up to sixteen others sit in the background and judge every payment as well. They don't move any money. They just keep score.",
  c06: "Every few minutes, the contract grades all of us. How much would each of us have saved from attackers, minus twice every honest payment we'd have refused? The best four survive. The rest are eliminated, and their stakes go to the winners.",
  c07: "Then the survivors breed. Each gene comes from one parent or the other, a couple of them mutate at random, and only a clear winner takes the crown. Even my shape changes to match my genes.",
  c08: "The attackers evolve too. Their plans are genomes as well, bred from whatever worked last time. As the old line goes, it takes all the running you can do to keep in the same place. That's the race we're in.",
  c09: "None of this runs on a server. There's no oracle and no one behind the curtain. Every rule, every refusal and every generation is right there on the chain.",
  c10: "That's how it works. Now it's your turn. Pick an attack, and see if you can get anything past me.",
};

/** the eight measurements, in words a visitor uses, with how the contract computes each */
const MEASURES: [name: string, how: string][] = [
  ["Size of the payment", "amount × 1,000 ÷ vault"],
  ["How new the recipient is", "1,000 ÷ (1 + times paid)"],
  ["How fast they are coming", "200 per request, last 20 blocks"],
  ["Time since the last one", "blocks since, up to 100"],
  ["Sender's reputation", "honest wallet 500, up to 1,000"],
  ["Sent through a contract", "1,000 if a contract called"],
  ["Paid to a contract", "1,000 if the recipient has code"],
  ["Already drained this epoch", "outflow × 1,000 ÷ start balance"],
];
/** the phrases of c03 that name each measurement, in order */
const C03_PHRASES = ["how big", "how new", "how quickly", "how long", "who's asking", "through a contract", "going to one", "how much"];

const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];

type SceneKind = "figures" | "diptych" | "measures" | "attack" | "shadows" | "epoch" | "breed" | "attackers" | "proof" | "finale";
interface Chapter {
  id: string; // the section the camera goes to
  name: string;
  head: string[];
  lines: string[];
  place: "mid" | "top";
  side?: "right";
  scene: SceneKind;
}

interface Verdict {
  refused: boolean;
  /** held for its delay instead of paid */
  held: boolean;
  reason: bigint;
  score: bigint;
  amount: bigint;
  block: bigint;
  hash: string;
  caller: string;
  features: number[];
  /** the genome that judged it (found by re-scoring), or null if it can no longer be identified */
  genes: number[] | null;
  share: number;
  returned: boolean;
  live: boolean; // sent by the demo just now (false: the arena's latest refusal)
}

interface Word {
  w: string;
  s: number;
  e: number;
}
interface Line {
  text: string;
  file: string;
  dur: number;
  words?: Word[];
}
type Voice = Record<string, Line> | null;

interface Beat {
  id: string;
  at: number;
  dur: number;
  text: string;
}

const ease = (t: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
const signed = (n: number) => (n > 0 ? `+${count(n)}` : n < 0 ? `−${count(-n)}` : "0");
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const norm = (s: string) => s.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const est = (t: string) => 0.45 + t.split(/\s+/).length / 2.55;

// ---------------------------------------------------------------- the voice

let manifestP: Promise<Voice> | null = null;
function loadManifest(): Promise<Voice> {
  if (!manifestP)
    manifestP = fetch(VOICE + "manifest.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => (j && j.lines ? (j.lines as Record<string, Line>) : null))
      .catch(() => null);
  return manifestP;
}
function useVoice(): Voice {
  const [v, setV] = useState<Voice>(null);
  useEffect(() => {
    let on = true;
    void loadManifest().then((m) => on && setV(m));
    return () => {
      on = false;
    };
  }, []);
  return v;
}

const lineDur = (v: Voice, id: string) => v?.[id]?.dur ?? est(SCRIPT[id] ?? "");

/** lay lines end to end from `start` */
function lay(v: Voice, ids: string[], start: number): { beats: Beat[]; end: number } {
  let t = start;
  const beats = ids.map((id) => {
    const dur = lineDur(v, id);
    const b = { id, at: t, dur, text: v?.[id]?.text ?? SCRIPT[id] ?? "" };
    t += dur + GAP;
    return b;
  });
  return { beats, end: t - GAP };
}

/** when each phrase is spoken (chapter time), in order: from the word timings, or by position in the text */
function phraseCues(v: Voice, b: Beat | undefined, phrases: string[]): number[] {
  if (!b) return phrases.map(() => Infinity);
  const ws = v?.[b.id]?.words;
  if (ws && ws.length) {
    // one token per word part ("thirty-two" is two), each carrying its word's start
    const toks: { t: string; s: number }[] = [];
    for (const w of ws) for (const t of norm(w.w).split(" ")) if (t) toks.push({ t, s: w.s });
    let from = 0;
    const found = phrases.map((p) => {
      const pt = norm(p).split(" ");
      for (let i = from; i <= toks.length - pt.length; i++) {
        if (pt.every((x, j) => toks[i + j].t === x)) {
          from = i + pt.length;
          return b.at + toks[i].s;
        }
      }
      return NaN;
    });
    if (found.every((x) => Number.isFinite(x))) return found;
  }
  const txt = norm(b.text);
  let from = 0;
  return phrases.map((p) => {
    const k = txt.indexOf(norm(p), from);
    if (k >= 0) from = k + 1;
    return b.at + (Math.max(0, k) / Math.max(1, txt.length)) * b.dur;
  });
}
const cue = (v: Voice, beats: Beat[], id: string, phrase?: string) => {
  const b = beats.find((x) => x.id === id);
  if (!b) return Infinity;
  return phrase ? phraseCues(v, b, [phrase])[0] : b.at;
};

// ---------------------------------------------------------------- live facts

function useFacts() {
  const snap = useArena((s) => s.snapshot);
  const installs = useArena((s) => s.installs);
  const nodes = useArena((s) => s.nodes);
  const epochs = useArena((s) => s.epochs);
  const spends = useArena((s) => s.spends);
  const deployment = useArena((s) => s.deployment);
  return useMemo(() => {
    const champions = new Set(installs.map((i) => i.id.toString())).size;
    const alive = Array.from(nodes.values()).filter((n) => n.alive).length;
    const ts = epochs.slice(-6).map((e) => e.t);
    const span = ts.length >= 2 ? (ts[ts.length - 1] - ts[0]) / (ts.length - 1) : 120;
    const minutes = Math.max(1, Math.round(span / 60));
    const lastRefusal = [...spends].reverse().find((s) => s.refused && s.features?.length === 8) ?? null;
    const held = (() => {
      let n = 0;
      const cur = installs[installs.length - 1]?.id;
      for (let i = installs.length - 1; i >= 0 && installs[i].id === cur; i--) n++;
      return n;
    })();
    // the latest graded epoch with candidates
    const epoch = [...epochs].reverse().find((e) => e.ids.length > 1) ?? null;
    // the latest child whose two parents' genes are known: the lineage on record, or the live pool (the
    // relay's history may begin after an old parent was born, while that parent is still competing)
    const pool = (snap?.pool ?? []).filter((p) => p.genes.length === 32);
    const known = (id: bigint): { id: bigint; generation: number; genes: number[] } | null => {
      const n = nodes.get(id.toString());
      if (n && n.genes.some((g) => g !== 0)) return n;
      const p = pool.find((q) => q.id === id);
      return p && p.genes.some((g) => g !== 0) ? p : null;
    };
    let child: LineageNode | null = null;
    let parents: [{ id: bigint; generation: number; genes: number[] }, { id: bigint; generation: number; genes: number[] }] | null = null;
    for (const n of [...nodes.values()].filter((x) => x.parentA !== 0n && x.parentB !== 0n && x.genes.some((g) => g !== 0)).sort((a, b) => b.bornT - a.bornT)) {
      const a = known(n.parentA);
      const b = known(n.parentB);
      if (a && b) {
        child = n;
        parents = [a, b];
        break;
      }
    }
    return {
      vault: snap ? ethWords(snap.vaultBalance, 2) : "…",
      vaultWei: snap?.vaultBalance ?? 0n,
      startWei: snap?.epochStartBalance ?? 0n,
      generation: snap ? Number(snap.live.installCount) : installs.length,
      liveId: snap?.live.id ?? 0n,
      genes: snap?.live.genes ?? [],
      champions,
      bred: nodes.size,
      alive,
      refused: snap ? count(snap.totalRefused) : "…",
      total: snap ? count(snap.totalSpends) : "…",
      block: snap?.blockNumber ?? 0n,
      minutes,
      held,
      lastRefusal,
      installs,
      deployment,
      pool: (snap?.pool ?? []).filter((p) => p.alive && p.genes.length === 32),
      attackPool: (snap?.attackPool ?? []).filter((a) => a.alive && a.genes.length === 32),
      epoch,
      child,
      parents,
    };
  }, [snap, installs, nodes, epochs, spends, deployment]);
}
type Facts = ReturnType<typeof useFacts>;

function chapters(f: Facts): Chapter[] {
  return [
    { id: "top", name: "The vault", head: ["The Red Queen."], lines: ["c01"], place: "mid", scene: "figures" },
    { id: "top", name: "The problem", head: ["Rules that change", "out of sight."], lines: ["c02"], place: "mid", scene: "diptych" },
    { id: "vault", name: "Eight measurements", head: ["Every payment,", "measured eight ways."], lines: ["c03"], place: "top", side: "right", scene: "measures" },
    { id: "attack", name: "A live attack", head: ["Watch her", "refuse one."], lines: [], place: "top", scene: "attack" },
    { id: "generations", name: "The shadows", head: [`${f.pool.length || 16} rules`, "judge in silence."], lines: ["c05"], place: "top", scene: "shadows" },
    { id: "charts", name: "The epoch", head: ["Graded every", `${f.minutes} minute${f.minutes === 1 ? "" : "s"}.`], lines: ["c06"], place: "top", scene: "epoch" },
    { id: "lineage", name: "Breeding", head: ["Bred,", "not written."], lines: ["c07"], place: "top", scene: "breed" },
    { id: "feed", name: "The attackers", head: ["The attackers", "breed too."], lines: ["c08"], place: "top", scene: "attackers" },
    { id: "proof", name: "On the chain", head: ["Nothing", "off the chain."], lines: ["c09"], place: "top", scene: "proof" },
    { id: "try", name: "Your turn", head: ["Your turn."], lines: ["c10"], place: "mid", scene: "finale" },
  ];
}

export function TourButton({ className = "btn btn-primary", children = "Watch the demo" }: { className?: string; children?: ReactNode }) {
  return (
    <button className={className} onClick={() => tour.start()}>
      {children}
    </button>
  );
}

export function Tour() {
  const active = useTour((s) => s.active);
  return active ? <Theatre /> : null;
}

/**
 * The attack chapter's timeline: she speaks while the attack is sent; if the block is slow she says so
 * (only then); once the verdict is known she walks through the arithmetic in one breath.
 */
function attackBeats(v: Voice, verdict: Verdict | null, tr: number | null, failed: boolean) {
  const open = lay(v, ["c04a"], LEAD);
  // "give it a moment" only if the block has not come by the time she would say it; once she has started it,
  // it stays (the arithmetic follows it rather than cutting it off)
  const waitAt = open.end + GAP;
  const slow = verdict && tr !== null ? tr > waitAt : !failed;
  const first = slow ? lay(v, ["c04a", "c04w"], LEAD) : open;
  if (!verdict || tr === null) return { beats: first.beats, end: failed ? first.end + 1.2 : Infinity };
  const start = Math.max(tr, first.end + GAP);
  const ids = [...(verdict.live ? [] : ["c04f"]), verdict.refused ? "c04r" : verdict.held ? "c04h" : "c04p"];
  const rest = lay(v, ids, start);
  return { beats: [...first.beats, ...rest.beats], end: rest.end + 1.4 };
}

function Theatre() {
  const intro = useTour((s) => s.intro);
  const stepIx = useTour((s) => s.step);
  const playing = useTour((s) => s.playing);
  const closing = useTour((s) => s.closing);
  const snd = useUI((s) => s.sound);
  const v = useVoice();
  const f = useFacts();
  const d = useDemo((s) => s);
  const list = useMemo(() => chapters(f), [f]);
  const ch = list[Math.min(stepIx, list.length - 1)];
  // the clock belongs to a chapter: a new chapter reads 0 at once (a stale clock could skip a short chapter)
  const ckey = intro ? "intro" : String(stepIx);
  const keyRef = useRef(ckey);
  keyRef.current = ckey;
  const [clk, setClk] = useState({ k: "", t: 0 });
  const elapsed = clk.k === ckey ? clk.t : 0;
  const setElapsed = (t: number) => setClk({ k: keyRef.current, t });
  const el = useRef(0);
  el.current = elapsed;
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [tr, setTr] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const firedAt = useRef(0);
  const [features, setFeatures] = useState<number[] | null>(null); // the attack's measurements, for the shadows

  // the frame: the page's copy steps aside while the film plays
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-theatre", "");
    return () => {
      root.removeAttribute("data-theatre");
      root.removeAttribute("data-theatre-ch");
      sound.hush();
    };
  }, []);
  useEffect(() => {
    document.documentElement.setAttribute("data-theatre-ch", intro ? "intro" : String(stepIx));
  }, [intro, stepIx]);

  // her voice is fetched as soon as the sound is on
  useEffect(() => {
    if (!snd || !v) return;
    for (const l of Object.values(v)) void sound.loadVoice(VOICE + l.file);
  }, [snd, v]);

  // each chapter: travel there, reset the clock; the attack chapter sends its attack while she speaks
  useEffect(() => {
    if (intro) return;
    scrollToId(ch.id);
    sound.hush();
    if (ch.scene === "attack") {
      setVerdict(null);
      setTr(null);
      setFailed(false);
      const t = setTimeout(() => {
        firedAt.current = Date.now();
        void demo.fire();
      }, 450);
      return () => clearTimeout(t);
    }
  }, [intro, stepIx, ch.id, ch.scene]);

  // the verdict arrives: from the demo, or (if it is down) the arena's latest refusal
  useEffect(() => {
    if (ch.scene !== "attack" || verdict || !firedAt.current || d.at < firedAt.current) return;
    const candidates = [f.genes, ...f.installs.slice(-8).reverse().map((i) => i.genes)].filter((g) => g && g.length === 32);
    const judge = (feat: number[], score: bigint) => candidates.find((g) => feat.length === 8 && explain(g, feat).score === score) ?? null;
    if (d.status === "done" && d.result) {
      const r = d.result;
      const before = r.refused ? r.balanceAfter : r.balanceAfter + r.amount;
      // the demo says whether it was held; else the Spend event on the record does
      const held = r.verdict === 1 || arena.get().spends.find((x) => x.txHash === r.hash)?.verdict === 1;
      setVerdict({
        refused: r.refused,
        held,
        reason: r.reason,
        score: r.score,
        amount: r.amount,
        block: r.block,
        hash: r.hash,
        caller: r.caller,
        features: r.features,
        genes: judge(r.features, r.score),
        share: before > 0n ? Number((r.amount * 10_000n) / before) / 10_000 : 0.4,
        returned: r.returned,
        live: true,
      });
      setFeatures(r.features);
      setTr(el.current);
    } else if (d.status === "error") {
      setFailed(true);
      const lr = f.lastRefusal;
      if (lr) {
        setVerdict({
          refused: true,
          held: false,
          reason: lr.reason,
          score: lr.score,
          amount: lr.amount,
          block: lr.block,
          hash: lr.txHash,
          caller: lr.caller,
          features: lr.features,
          genes: judge(lr.features, lr.score),
          share: lr.balanceAfter > 0n ? Number((lr.amount * 10_000n) / lr.balanceAfter) / 10_000 : 0,
          returned: false,
          live: false,
        });
        setFeatures(lr.features);
        setTr(el.current);
      }
    }
  }, [ch.scene, d.status, d.result, d.at, verdict, f.genes, f.installs, f.lastRefusal]);
  // the Spend event can land after the demo's answer: a hold it reports is taken up before she reaches the verdict
  const spends = useArena((s) => s.spends);
  useEffect(() => {
    if (!verdict || !verdict.live || verdict.held || verdict.refused) return;
    if (spends.some((x) => x.txHash === verdict.hash && x.verdict === 1)) setVerdict({ ...verdict, held: true });
  }, [spends, verdict]);

  // the chapter's lines on its clock
  const { beats, end } = useMemo(() => {
    if (ch.scene === "attack") return attackBeats(v, verdict, tr, failed);
    const r = lay(v, ch.lines, LEAD);
    return { beats: r.beats, end: r.end + TAIL + (ch.scene === "finale" ? 0.6 : 0) };
  }, [ch, v, verdict, tr, failed]);
  const dur = end;
  // once the attack has played, the timeline keeps its real length (an estimate would move the clock backwards)
  const played = useRef<Record<number, number>>({});
  if (Number.isFinite(dur) && ch.scene === "attack") played.current[stepIx] = dur;
  const durOf = (c: Chapter, i: number) => {
    if (i === stepIx) return Number.isFinite(dur) ? dur : played.current[i] ?? ATTACK_EST;
    if (c.scene === "attack") return played.current[i] ?? ATTACK_EST;
    return lay(v, c.lines, LEAD).end + TAIL;
  };
  const durs = list.map(durOf);
  const total = durs.reduce((a, b) => a + b, 0);
  const before = durs.slice(0, stepIx).reduce((a, b) => a + b, 0);

  // the clock: real time, not ticks (a throttled timer in a background tab must not slow the film)
  useEffect(() => {
    if (intro || !playing) return;
    let last = performance.now();
    const t = setInterval(() => {
      const now = performance.now();
      // capped, so a tab that comes back after minutes away does not leap ahead; 1.1 s still keeps time in a
      // background tab, whose timers fire about once a second (her voice keeps playing there)
      const dt = Math.min(1.1, (now - last) / 1000);
      last = now;
      setClk((c) => ({ k: keyRef.current, t: (c.k === keyRef.current ? c.t : 0) + dt }));
    }, 50);
    return () => clearInterval(t);
  }, [intro, playing]);
  useEffect(() => {
    if (intro || elapsed < dur) return;
    if (ch.scene === "finale") tour.set({ playing: false });
    else if (stepIx < list.length - 1) tour.set({ step: stepIx + 1 });
  }, [elapsed, dur, intro, ch.scene, stepIx, list.length]);

  // her voice follows the clock: a line starts when the clock reaches it (from where it is, after a pause)
  const spoken = useRef("");
  useEffect(() => {
    if (intro || !playing || !snd) {
      if (spoken.current) {
        sound.hush();
        spoken.current = "";
      }
      return;
    }
    const b = beats.find((x) => elapsed >= x.at && elapsed < x.at + x.dur - 0.08);
    if (!b) return;
    const key = `${stepIx}:${b.id}:${b.at.toFixed(2)}`;
    if (spoken.current === key) return;
    spoken.current = key;
    // a line the manifest has no recording for (c04h) plays as subtitles only
    if (v && !v[b.id]) return;
    sound.say(VOICE + (v?.[b.id]?.file ?? `${b.id}.mp3`), elapsed - b.at);
  }, [elapsed, beats, playing, snd, intro, stepIx, v]);

  // keys: arrows step, space pauses, Esc leaves
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = tour.get();
      if (e.key === "Escape") tour.stop();
      else if (s.intro) return;
      else if (e.key === "ArrowRight") tour.set({ step: Math.min(list.length - 1, s.step + 1), playing: true });
      else if (e.key === "ArrowLeft") tour.set({ step: Math.max(0, s.step - 1), playing: true });
      else if (e.key === " " && (e.target as HTMLElement)?.tagName !== "BUTTON") {
        e.preventDefault();
        tour.set({ playing: !s.playing });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [list.length]);

  const again = () => {
    setVerdict(null);
    setTr(null);
    setFailed(false);
    setElapsed(LEAD);
    spoken.current = "";
    firedAt.current = Date.now();
    void demo.fire();
  };

  // the subtitle: the line being spoken, held through the gap after it
  const sub = [...beats].reverse().find((b) => elapsed >= b.at) ?? null;
  const t = elapsed;

  return (
    <motion.div className="theatre" role="dialog" aria-label="Demonstration" data-tour="" initial={{ opacity: 1 }} animate={{ opacity: closing ? 0 : 1 }} transition={{ duration: 0.6, ease: EASE }}>
      {/* the letterbox */}
      <motion.div className="th-bar th-top" initial={{ scaleY: 0 }} animate={{ scaleY: closing ? 0 : 1 }} transition={{ duration: 0.9, ease: EASE }}>
        <div className="th-top-in">
          {!intro ? (
            <motion.div key={stepIx} className="th-chapter" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: EASE }}>
              <span className="th-numeral">{ROMAN[stepIx]}</span>
              <span>{ch.name}</span>
            </motion.div>
          ) : (
            <motion.div key="title" className="th-chapter" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
              <span className="th-numeral">Red Queen</span>
            </motion.div>
          )}
          <button className="th-ctl" onClick={() => tour.stop()} aria-label="Leave the demonstration">
            Leave <span className="th-key">Esc</span>
          </button>
        </div>
      </motion.div>

      <motion.div className="th-bar th-bottom" initial={{ scaleY: 0 }} animate={{ scaleY: closing ? 0 : 1 }} transition={{ duration: 0.9, ease: EASE }}>
        <div className="th-sub" aria-live="polite">
          {sub && !intro ? <Subtitle key={`${stepIx}:${sub.id}:${sub.at.toFixed(2)}`} b={sub} v={v} t={t} /> : null}
        </div>
        {!intro ? (
          <div className="th-controls">
            <div className="flex items-center gap-1">
              <button className="th-ctl" onClick={() => tour.set({ playing: !playing })} aria-label={playing ? "Pause" : "Play"}>
                <PlayIcon playing={playing} />
              </button>
              <button className="th-ctl" aria-pressed={snd} onClick={() => (snd ? sound.disable() : sound.enable(), ui.set({ sound: !snd }))}>
                <span className="sound-dot" aria-hidden />
                {snd ? "Her voice on" : "Her voice off"}
              </button>
            </div>
            <div className="th-timeline" role="group" aria-label="Chapters">
              {list.map((c, i) => (
                <button key={i} className="th-seg" style={{ flexGrow: durs[i] }} onClick={() => tour.set({ step: i, playing: true })} aria-label={`Chapter ${i + 1}: ${c.name}`} aria-current={i === stepIx}>
                  <span className="th-seg-label">{c.name}</span>
                  <span className="th-seg-track">
                    <span className="th-seg-fill" style={{ width: i < stepIx ? "100%" : i > stepIx ? "0%" : `${Math.min(100, (elapsed / durs[stepIx]) * 100)}%` }} />
                  </span>
                </button>
              ))}
            </div>
            <span className="th-time num">
              {clock(before + Math.min(elapsed, durs[stepIx]))} <span className="text-ivory-3">/ {clock(total)}</span>
            </span>
          </div>
        ) : null}
      </motion.div>

      {/* the chapter */}
      {!intro ? (
        <motion.div key={stepIx} className={`th-stage th-place-${ch.place} ${ch.side === "right" ? "th-side-right" : ""}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4 }}>
          <h2 className={`th-head ${ch.place === "top" ? "th-head-s" : ""}`} aria-label={ch.head.join(" ")}>
            {ch.head.map((l, i) => (
              <span key={i} className="th-line" aria-hidden>
                <motion.span
                  className="block"
                  initial={scene.reducedMotion ? { opacity: 0 } : { opacity: 0, y: 26 }}
                  animate={scene.reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
                  transition={{ duration: 0.95, ease: EASE, delay: 0.1 + i * 0.1 }}
                >
                  <span className="ruby">{l}</span>
                </motion.span>
              </span>
            ))}
          </h2>
          {ch.scene === "figures" ? <Figures f={f} t={t} beats={beats} v={v} /> : null}
          {ch.scene === "diptych" ? <Diptych f={f} t={t} beats={beats} v={v} /> : null}
          {ch.scene === "measures" ? <Measures f={f} t={t} beats={beats} v={v} /> : null}
          {ch.scene === "shadows" ? <Shadows f={f} t={t} beats={beats} features={features} /> : null}
          {ch.scene === "epoch" ? <Epoch f={f} t={t} beats={beats} v={v} /> : null}
          {ch.scene === "breed" ? <Breed f={f} t={t} beats={beats} v={v} /> : null}
          {ch.scene === "attackers" ? <Attackers f={f} t={t} beats={beats} /> : null}
          {ch.scene === "proof" ? <Proof f={f} t={t} beats={beats} /> : null}
          {ch.scene === "finale" ? <Finale show={t > LEAD + 0.6} /> : null}
        </motion.div>
      ) : null}

      {ch.scene === "attack" && !intro ? <Ledger key={`ledger-${stepIx}`} v={verdict} t={t} tr={tr} beats={beats} voice={v} status={d.status} failed={failed} f={f} onAgain={again} /> : null}

      <Intro shown={intro} />
    </motion.div>
  );
}

/**
 * Subtitles a phrase at a time (7 to 14 words, broken at sentence ends, or at a comma or colon once a phrase
 * is long enough), like a film's; with word timings, each word brightens as she says it.
 */
function phrases(b: Beat, v: Voice): { words: Word[]; at: number }[] {
  const ws: Word[] =
    v?.[b.id]?.words ??
    (() => {
      // no timings: spread the words over the line by length
      const parts = b.text.split(/\s+/);
      const total = parts.reduce((a, w) => a + w.length + 1, 0);
      let acc = 0;
      return parts.map((w) => {
        const s0 = (acc / total) * b.dur;
        acc += w.length + 1;
        return { w, s: s0, e: (acc / total) * b.dur };
      });
    })();
  const out: { words: Word[]; at: number }[] = [];
  let cur: Word[] = [];
  for (const w of ws) {
    cur.push(w);
    const end = /[.?!]["”’]?$/.test(w.w);
    const soft = /[,:;]$/.test(w.w) && cur.length >= 7;
    if (end || soft || cur.length >= 14) {
      out.push({ words: cur, at: cur[0].s });
      cur = [];
    }
  }
  if (cur.length) out.push({ words: cur, at: cur[0].s });
  return out;
}

function Subtitle({ b, v, t }: { b: Beat; v: Voice; t: number }) {
  const ps = phrases(b, v);
  const rel = t - b.at;
  let i = 0;
  for (let k = 0; k < ps.length; k++) if (rel >= ps[k].at - 0.05) i = k;
  const p = ps[i];
  const timed = !!v?.[b.id]?.words;
  return (
    <motion.p
      key={i}
      className="th-sub-line"
      initial={scene.reducedMotion ? { opacity: 0 } : { opacity: 0, y: 6, filter: "blur(5px)" }}
      animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      transition={{ duration: 0.32, ease: EASE }}
    >
      <span aria-hidden>
        {p.words.map((w, k) => (
          <span key={k} className={`th-word ${!timed || rel >= w.s - 0.03 ? "on" : ""}`}>
            {w.w}{" "}
          </span>
        ))}
      </span>
      <span className="sr-only">{p.words.map((w) => w.w).join(" ")}</span>
    </motion.p>
  );
}

function PlayIcon({ playing }: { playing: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
      {playing ? (
        <g fill="currentColor">
          <rect x="3" y="2" width="2.4" height="10" rx="0.6" />
          <rect x="8.6" y="2" width="2.4" height="10" rx="0.6" />
        </g>
      ) : (
        <path d="M4 2.2v9.6a.6.6 0 0 0 .9.5l7.6-4.8a.6.6 0 0 0 0-1L4.9 1.7a.6.6 0 0 0-.9.5Z" fill="currentColor" />
      )}
    </svg>
  );
}

function Intro({ shown }: { shown: boolean }) {
  return (
    <motion.div
      className="th-intro"
      initial={{ opacity: 0 }}
      animate={{ opacity: shown ? 1 : 0 }}
      transition={{ duration: shown ? 0.8 : 0.7, ease: EASE }}
      style={{ pointerEvents: shown ? "auto" : "none" }}
      aria-hidden={!shown}
      inert={!shown}
    >
      <div className="th-intro-in">
        <h2 className="th-head" aria-label="Three minutes, all of it live.">
          {["Three minutes,", "all of it live."].map((l, i) => (
            <span key={i} className="th-line" aria-hidden>
              <motion.span className="block" initial={{ opacity: 0, y: 26 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 1.1, ease: EASE, delay: 0.35 + i * 0.12 }}>
                <span className="ruby">{l}</span>
              </motion.span>
            </span>
          ))}
        </h2>
        <motion.p className="lede mt-7 max-w-[34ch]" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.9, ease: EASE, delay: 0.8 }}>
          She tells it herself: a real vault, a real attack sent while you watch, and the contract that decides. Nothing here is recorded.
        </motion.p>
        <motion.div className="mt-9 flex flex-wrap items-center gap-3" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.9, ease: EASE, delay: 1.0 }}>
          <button
            className="btn btn-primary"
            autoFocus
            onClick={() => {
              sound.enable();
              ui.set({ sound: true });
              tour.begin();
            }}
          >
            Begin with her voice
          </button>
          <button className="btn btn-quiet" onClick={() => tour.begin()}>
            Begin in silence
          </button>
        </motion.div>
        <motion.p className="caption mt-8 text-ivory-3" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.9, delay: 1.3 }}>
          Space pauses, the arrow keys skip, Esc leaves.
        </motion.p>
      </div>
    </motion.div>
  );
}

interface SceneProps {
  f: Facts;
  t: number;
  beats: Beat[];
  v?: Voice;
}

/** something that appears when the film reaches `at` */
function Reveal({ at, t, children, className = "", y = 10 }: { at: number; t: number; children: ReactNode; className?: string; y?: number }) {
  const on = t >= at;
  return (
    <div className={`th-reveal ${className}`} style={{ opacity: on ? 1 : 0, transform: on ? "none" : `translateY(${y}px)`, filter: on ? "none" : "blur(4px)" }}>
      {children}
    </div>
  );
}

function Figures({ f, t, beats, v }: SceneProps & { v: Voice }) {
  const [vault, rob, rules] = phraseCues(v, beats.find((b) => b.id === "c01"), ["vault", "take", "rewrite"]);
  const rows: [string, string, number][] = [
    [f.vault, "ETH in the vault", vault],
    [count(f.generation), "generations of her rules, bred on-chain", rules],
    [f.refused, `attempts refused, of ${f.total}`, rob],
  ];
  return (
    <div className="th-figures th-reveal" style={{ opacity: t >= Math.min(vault, rules, rob) - 0.2 ? 1 : 0 }}>
      {rows.map(([n, l, at]) => (
        <Reveal key={l} at={at} t={t}>
          <div className="th-fig num">{n}</div>
          <div className="th-fig-label">{l}</div>
        </Reveal>
      ))}
    </div>
  );
}

function Diptych({ f, t, beats, v }: SceneProps) {
  const left = ["A spending cap", "An allowlist", "Edited by its owner, by hand", "Changed: out of sight"];
  const right = ["Eight measurements, 32 genes", `Bred from ${count(f.bred)} candidates`, `Rewritten every ${f.minutes} minute${f.minutes === 1 ? "" : "s"}`, `Generation ${count(f.generation)}`];
  const a = cue(v ?? null, beats, "c02", "machines");
  const b = cue(v ?? null, beats, "c02", "So I change");
  return (
    <div className="th-diptych">
      <div>
        <div className="th-dip-h">A wallet&rsquo;s rules</div>
        {left.map((x, i) => (
          <Reveal key={x} at={a + 0.3 + i * 0.45} t={t} className="th-dip-row text-ivory-3">
            {x}
          </Reveal>
        ))}
      </div>
      <div>
        <div className="th-dip-h text-ivory">Her rules</div>
        {right.map((x, i) => (
          <Reveal key={x} at={b + 0.2 + i * 0.3} t={t} className="th-dip-row">
            {x}
          </Reveal>
        ))}
      </div>
    </div>
  );
}

/** the eight measurements, each lit as she names it, then her 32 genes */
function Measures({ f, t, beats, v }: SceneProps & { v: Voice }) {
  const cues = phraseCues(v, beats.find((b) => b.id === "c03"), C03_PHRASES);
  const genome = cue(v, beats, "c03", "Each of those");
  const q07 = genome;
  const w = f.genes.slice(0, 8);
  const lit = cues.findIndex((c, i) => t >= c && (i === cues.length - 1 || t < cues[i + 1]));
  return (
    <div className="th-measures">
      <div className="th-meas-list" style={{ opacity: t >= q07 ? 0.45 : 1 }}>
        {MEASURES.map(([name, how], i) => {
          const on = t >= cues[i];
          return (
            <div key={name} className={`th-meas-item ${on ? "on" : ""} ${lit === i && t < q07 ? "now" : ""}`}>
              <span className="th-meas-i num">f{i}</span>
              <span className="th-meas-name">{name}</span>
              <span className="th-meas-how">{how}</span>
              <span className="th-meas-val num">{on ? `× ${signed(w[i] ?? 0)}` : ""}</span>
            </div>
          );
        })}
      </div>
      <Reveal at={genome} t={t} className="mt-5">
        <Genome genes={f.genes} t={t} at={genome} label={`Her genome now, generation ${count(f.generation)}`} />
      </Reveal>
    </div>
  );
}

const ROLES = ["Weights", "Patterns", "Thresholds", "Spare"];

/** 32 numbers in their four roles; cells arrive one by one from `at` */
function Genome({ genes, t, at, label, marks }: { genes: number[]; t: number; at: number; label?: string; marks?: (i: number) => string }) {
  return (
    <div className="th-genome">
      {label ? <div className="th-dip-h">{label}</div> : null}
      {ROLES.map((r, row) => (
        <div key={r} className="th-gen-row">
          <span className="th-gen-role">{r}</span>
          {Array.from({ length: 8 }, (_, k) => {
            const i = row * 8 + k;
            const on = t >= at + i * 0.035;
            return (
              <span key={k} className={`th-gen-cell num ${marks ? marks(i) : ""}`} style={{ opacity: on ? 1 : 0 }}>
                {genes[i] ?? 0}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** the shadow pool: every live candidate's verdict on the payment just judged */
function Shadows({ f, t, beats, features }: SceneProps & { features: number[] | null }) {
  const feat = features ?? f.lastRefusal?.features ?? null;
  const start = cue(null, beats, "c05");
  const rows = f.pool.slice(0, 16).map((p) => {
    const ex = feat ? explain(p.genes, feat) : null;
    return { id: p.id, gen: p.generation, score: ex ? Number(ex.score) : 0, refused: ex?.refused ?? false, held: ex?.held ?? false, live: p.id === f.liveId };
  });
  const n = rows.filter((r) => r.refused).length;
  const h = rows.filter((r) => r.held).length;
  const max = Math.max(LIMIT * 1.6, ...rows.map((r) => r.score));
  return (
    <div className="th-panel-list">
      <div className="th-dip-h">{feat ? `The same payment, judged by each candidate in the pool` : "The candidates in the pool now"}</div>
      {rows.map((r, i) => (
        <Reveal key={r.id.toString()} at={start + 0.4 + i * 0.16} t={t} className="th-shadow-row" y={6}>
          <span className="num text-ivory-2">
            #{r.id.toString()}
            {r.live ? <span className="text-cold"> · live</span> : null}
          </span>
          <span className="num text-ivory-3">gen {r.gen}</span>
          <span className="th-shadow-bar">
            <span className="th-gauge-limit" style={{ left: `${(LIMIT / max) * 100}%` }} />
            <span className={r.refused ? "hot" : r.held ? "held" : ""} style={{ transform: `scaleX(${Math.min(1, r.score / max)})` }} />
          </span>
          <span className={`th-shadow-v ${r.refused ? "text-hot" : r.held ? "text-held" : "text-ivory-2"}`}>{feat ? (r.refused ? "refuses" : r.held ? "holds" : "pays") : ""}</span>
        </Reveal>
      ))}
      {feat ? (
        <Reveal at={start + 0.6 + rows.length * 0.16} t={t} className="th-led-sum-line">
          {n} of {rows.length} would have refused it{h ? `, and ${h} would have held it` : ""}. Only the live one decides; the rest keep score.
        </Reveal>
      ) : null}
    </div>
  );
}

const ethSigned = (wei: bigint, d = 2) => (wei < 0n ? `−${ethWords(-wei, d)}` : ethWords(wei, d));

/**
 * The last epoch's grading for every candidate, the four survivors and the dead. Fitness is F = R − C + S, the
 * Crucible's sparring score S (what the attackers' plans would take, and the honest bench) added to the retained
 * funds R less the cost C of mistakes, where R credits a held attack at half and C is what refusing
 * (or, at a tenth, holding) honest payments cost, in wei (EpochClosed.honestCost), so S = F − R + C. Deployments before the cost was priced in wei counted the refused honest
 * payments instead and charged λ = 2% of the round's starting balance for each (Arena.LAMBDA_BPS).
 */
function Epoch({ f, t, beats, v }: SceneProps & { v: Voice }) {
  const e = f.epoch;
  const start = cue(v, beats, "c06");
  const survive = cue(v, beats, "c06", "survive");
  const die = cue(v, beats, "c06", "eliminated");
  if (!e) return <Reveal at={start} t={t} className="th-led-sum-line">No epoch has been graded yet on this chain.</Reveal>;
  const rows = e.ids
    .map((id, i) => ({ id, F: e.fitness[i] ?? 0n, R: e.retained[i] ?? 0n, B: e.honestCost[i] ?? 0n }))
    .sort((a, b) => (b.F > a.F ? 1 : b.F < a.F ? -1 : 0));
  const v3 = (f.deployment?.version ?? 0) >= 3;
  const sparring = v3 || Boolean(f.deployment?.contracts?.crucible) || f.deployment?.version === 2;
  const lam = (f.startWei * 200n) / 10_000n;
  const withB = rows.find((r) => r.B > 0n);
  const lambda = sparring ? (lam > 0n ? lam : null) : withB ? (withB.R - withB.F) / withB.B : null;
  // the cost is already in wei
  const costOf = (r: { B: bigint }) => (v3 ? r.B : lam * r.B);
  const cls = `th-epoch-row${sparring ? " has-s" : ""}`;
  return (
    <div className="th-panel-list">
      <div className="th-epoch-f">
        {v3 ? (
          <>
            <span className="th-f-sym">F</span> = <span className="th-f-sym">R</span> − <span className="th-f-sym">C</span> + <span className="th-f-sym">S</span>
            <span className="th-f-note">
              kept (half for a payment held), minus what refusing honest payments cost (twice the payment and 0.5% of the vault; a tenth for one held), plus sparring: what the
              attackers' plans would take, and the honest bench
            </span>
          </>
        ) : (
          <>
            <span className="th-f-sym">F</span> = <span className="th-f-sym">R</span> − λ · <span className="th-f-sym">B</span>
            {sparring && (
              <>
                {" "}+ <span className="th-f-sym">S</span>
              </>
            )}
            <span className="th-f-note">
              kept, minus {lambda !== null ? `${ethWords(lambda, 3)} ETH` : "2% of the vault"} for each honest payment blocked
              {sparring ? ", plus sparring: what the attackers' plans would take, and the honest bench" : ""}
            </span>
          </>
        )}
      </div>
      <div className={`${cls} th-epoch-h`}>
        <span>Epoch {count(e.epoch)}</span>
        <span>R, kept</span>
        <span>{v3 ? "C, cost" : "B"}</span>
        {sparring && <span>S, sparring</span>}
        <span>F</span>
        <span />
      </div>
      {rows.slice(0, 10).map((r, i) => {
        const top = i < 4;
        const marked = top ? t >= survive : t >= die;
        return (
          <Reveal key={r.id.toString()} at={start + 0.5 + i * 0.22} t={t} className={`${cls} ${marked ? (top ? "survive" : "dead") : ""}`} y={6}>
            <span className="num">#{r.id.toString()}</span>
            <span className="num">{ethWords(r.R, 2)}</span>
            <span className="num">{v3 ? ethWords(r.B, 3) : count(Number(r.B))}</span>
            {sparring && <span className="num">{ethSigned(r.F - r.R + costOf(r), 3)}</span>}
            <span className="num">{ethSigned(r.F, 2)}</span>
            <span className="th-epoch-tag">{marked ? (top ? (i === 0 ? "crowned" : "survives") : "out") : ""}</span>
          </Reveal>
        );
      })}
    </div>
  );
}

/** a real child, gene by gene from its parents; its mutations marked */
function Breed({ f, t, beats, v }: SceneProps & { v: Voice }) {
  const c = f.child;
  const p = f.parents;
  const start = cue(v, beats, "c07");
  const from = cue(v, beats, "c07", "Each gene");
  const mut = cue(v, beats, "c07", "mutate");
  const crown = cue(v, beats, "c07", "crown");
  if (!c || !p) return <Reveal at={start} t={t} className="th-led-sum-line">No child with both parents on record yet.</Reveal>;
  const muts = new Set(c.mutGenes ?? c.genes.map((g, i) => (g !== p[0].genes[i] && g !== p[1].genes[i] ? i : -1)).filter((i) => i >= 0));
  const src = (i: number) => (muts.has(i) ? "mut" : c.genes[i] === p[0].genes[i] ? "a" : c.genes[i] === p[1].genes[i] ? "b" : "mut");
  return (
    <div className="th-breed">
      <Reveal at={start + 0.2} t={t}>
        <Genome genes={p[0].genes} t={t} at={start + 0.2} label={`Parent #${p[0].id.toString()}, generation ${p[0].generation}`} marks={() => "pa"} />
      </Reveal>
      <Reveal at={start + 0.6} t={t} className="mt-3">
        <Genome genes={p[1].genes} t={t} at={start + 0.6} label={`Parent #${p[1].id.toString()}, generation ${p[1].generation}`} marks={() => "pb"} />
      </Reveal>
      <Reveal at={from} t={t} className="mt-3">
        <Genome
          genes={c.genes}
          t={t}
          at={from}
          label={`Child #${c.id.toString()}, generation ${c.generation}`}
          marks={(i) => {
            const s = src(i);
            return s === "mut" ? (t >= mut ? "mut" : "pa") : s === "a" ? "pa" : "pb";
          }}
        />
      </Reveal>
      <Reveal at={crown} t={t} className="th-led-sum-line">
        {muts.size} gene{muts.size === 1 ? "" : "s"} mutated. The live crown is generation {count(f.generation)}, policy #{f.liveId.toString()}.
      </Reveal>
    </div>
  );
}

const RECIP: Record<string, string> = { self: "to itself", fresh: "to a new address", contract: "to a contract", previous: "to the last recipient" };
const ROUTE: Record<string, string> = { direct: "directly", agent: "through an agent", delegate: "delegate, then drain" };

/** the best plan in the attackers' pool, step by step */
function Attackers({ f, t, beats }: SceneProps) {
  const start = cue(null, beats, "c08");
  const best = [...f.attackPool].sort((a, b) => (b.lastExtracted > a.lastExtracted ? 1 : b.lastExtracted < a.lastExtracted ? -1 : b.bornEpoch - a.bornEpoch))[0];
  if (!best) return <Reveal at={start} t={t} className="th-led-sum-line">The attack pool is empty right now.</Reveal>;
  const steps = decodeAttack(best.genes).filter((s) => s.amountBps > 0);
  return (
    <div className="th-panel-list">
      <div className="th-dip-h">
        Attack plan #{best.id.toString()}, generation {best.generation}
        {best.lastExtracted > 0n ? `: took ${ethWords(best.lastExtracted, 2)} ETH last epoch` : ""}
      </div>
      <div className="th-steps">
        {steps.map((s, i) => (
          <Reveal key={i} at={start + 0.5 + i * 0.3} t={t} className="th-step" y={8}>
            <span className="th-step-n num">{i + 1}</span>
            <span className="th-step-amt num">{s.amountBps < 10 ? "<0.1" : (s.amountBps / 100).toFixed(s.amountBps % 100 ? 1 : 0)}%</span>
            <span className="th-step-txt">
              {RECIP[s.recipient]}, {ROUTE[s.route]}
              {s.delayBlocks ? `, after ${s.delayBlocks} block${s.delayBlocks === 1 ? "" : "s"}` : ""}
            </span>
          </Reveal>
        ))}
      </div>
      <Reveal at={start + 0.8 + steps.length * 0.3} t={t} className="th-led-sum-line">
        {f.attackPool.length} plans in the pool. The ones that take the most breed; she has to close what they find.
      </Reveal>
    </div>
  );
}

function Proof({ f, t, beats }: SceneProps) {
  const start = cue(null, beats, "c09");
  const c = f.deployment?.contracts;
  const rows: [string, string][] = c
    ? [
        ["Vault", "measures, judges, pays, holds or refuses"],
        ["Firewall", "holds her 32 genes, scores"],
        ["Arena", "grades, selects, breeds, slashes"],
        ...(c.crucible ? ([["Crucible", "spars every policy against the attackers"]] as [string, string][]) : []),
        ["Lineage", "the family tree, append-only"],
      ]
    : [];
  const addr = (k: string) => (c ? short(String((c as Record<string, string>)[k.toLowerCase()]), 4) : "");
  return (
    <div className="th-panel-list">
      {rows.map(([k, what], i) => (
        <Reveal key={k} at={start + 0.4 + i * 0.35} t={t} className="th-proof-row" y={6}>
          <span className="th-proof-k">{k}</span>
          <span className="hash text-ivory-2">{addr(k)}</span>
          <span className="text-ivory-3">{what}</span>
        </Reveal>
      ))}
      <Reveal at={start + 0.6 + rows.length * 0.35} t={t} className="th-led-sum-line">
        Block {count(f.block)}, live. 99 contract tests pass. Every figure in this film was read from the chain while you watched.
      </Reveal>
    </div>
  );
}

function Finale({ show }: { show: boolean }) {
  return (
    <motion.div className="mt-10 flex flex-wrap items-center gap-3" initial={{ opacity: 0, y: 12 }} animate={show ? { opacity: 1, y: 0 } : { opacity: 0, y: 12 }} transition={{ duration: 0.9, ease: EASE }}>
      <button
        className="btn btn-primary"
        onClick={() => {
          tour.stop();
          setTimeout(() => scrollToId("try"), 50);
        }}
      >
        Try to drain her
      </button>
      <button className="btn btn-quiet" onClick={() => tour.set({ step: 0, playing: true })}>
        Watch again
      </button>
      <button className="btn btn-quiet" onClick={() => tour.stop()}>
        Leave
      </button>
    </motion.div>
  );
}

/** a number that counts up once it is told to run */
function CountUp({ to, run, dur = 1.1 }: { to: number; run: boolean; dur?: number }) {
  const [val, setVal] = useState(0);
  useEffect(() => {
    if (!run) return setVal(0);
    if (scene.reducedMotion) return setVal(to);
    let raf = 0;
    const t0 = performance.now();
    const step = (now: number) => {
      const p = ease((now - t0) / (dur * 1000));
      setVal(Math.round(to * p));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [to, run, dur]);
  return <>{count(val)}</>;
}

/** a block that opens and closes its own height */
function Fold({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div className="th-fold" style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0 }}>
      <div className="th-fold-in">{children}</div>
    </div>
  );
}

/**
 * The contract at work, for the one transaction just sent: the path it took through the system, what was
 * asked, the eight measurements from its Spend event times her weights, the patterns that fired, the
 * score against her limit, the verdict. Re-scored in the browser with the SDK's bit-exact mirror of
 * GenomeLib, and shown only if it matches the score the contract emitted. Every beat lands on her words.
 */
function Ledger({
  v,
  t,
  tr,
  beats,
  voice,
  status,
  failed,
  f,
  onAgain,
}: {
  v: Verdict | null;
  t: number;
  tr: number | null;
  beats: Beat[];
  voice: Voice;
  status: string;
  failed: boolean;
  f: Facts;
  onAgain: () => void;
}) {
  const ex = v?.genes ? explain(v.genes, v.features) : null;
  const pairs = ex ? ex.terms.slice(8).map((x, k) => ({ k, t: Number(x) })).filter((p) => p.t !== 0) : [];
  const linear = ex ? ex.terms.slice(0, 8).reduce((a, x) => a + Number(x), 0) : 0;
  const pattern = pairs.reduce((a, p) => a + p.t, 0);
  const raw = ex ? Number(ex.raw) : Number(v?.score ?? 0);
  const max = Math.max(raw, LIMIT) * 1.18;
  const link = v ? explorerTx(f.deployment, v.hash) : null;

  // the beats, on her words (one paragraph: "First, I measure it. Then I weigh ... the patterns ... Add it all
  // up ... Refused.")
  const id = v?.refused ? "c04r" : v?.held ? "c04h" : "c04p";
  const q09 = cue(voice, beats, id, "measure");
  const q10 = cue(voice, beats, id, "weigh");
  const q11 = cue(voice, beats, id, "patterns");
  const fold = cue(voice, beats, id, "Add it all up");
  const word = cue(voice, beats, id, v?.refused ? "Refused" : v?.held ? "hold it" : "goes through");
  const q12 = fold + 0.6;
  const at = (s: number) => t >= s;

  // the path through the system, lit step by step
  const path: [string, number][] = [
    ["Signed", 0.6],
    [v ? `Block ${count(v.block)}` : "Mining", tr ?? Infinity],
    ["Vault.spend()", q09 - 0.25],
    ["8 measurements", q09],
    ["× 32 genes", q10],
    ["Patterns", q11],
    ["Score", fold],
    ["Spend event", word],
    [RELAY_URL ? "Relay → you" : "Chain → you", word + 0.35],
  ];
  return (
    <motion.aside className="th-ledger panel" aria-label="The contract's verdict" initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.8, ease: EASE, delay: 0.5 }}>
      <div className="th-path" aria-hidden>
        {path.map(([label, s], i) => (
          <span key={i} className={`th-path-step ${at(s) ? "on" : ""} ${at(s) && (i === path.length - 1 || !at(path[i + 1][1])) ? "now" : ""}`}>
            {label}
          </span>
        ))}
      </div>
      <div className="th-led-top">
        <span>{v && !v.live ? "Latest refusal on the record" : "Transaction"}</span>
        <span className="num">
          {v ? (
            <>
              block {count(v.block)} · {short(v.hash, 4)}
            </>
          ) : failed ? (
            "demo attacker offline"
          ) : (
            <span className="th-wait">
              waiting for a block<span className="th-wait-line" />
            </span>
          )}
        </span>
      </div>
      <div className="th-led-amount num">{v ? `${ethWords(v.amount, 2)} ETH` : `${ethWords((f.vaultWei * 4n) / 10n, 2)} ETH`}</div>
      <div className="th-led-who">{v ? `${Math.round(v.share * 100)}% of the vault, from ${short(v.caller, 4)} to itself` : "40% of the vault, to the attacker's own address"}</div>

      {/* the eight measurements, then each times her weight */}
      <Fold open={at(q09) && !at(fold)}>
        <div className="th-led-h">
          <span>Measured, 0 to 1,000</span>
          {ex && at(q10) ? <span>× her weight</span> : null}
        </div>
        {MEASURES.map(([m], i) => {
          const fv = v?.features[i] ?? 0;
          const term = ex ? Number(ex.terms[i]) : 0;
          const on = at(q09 + 0.05 + i * 0.12);
          const weighed = at(q10 + i * 0.1);
          return (
            <div key={m} className="th-led-row" style={{ opacity: on ? 1 : 0, transform: on ? "none" : "translateY(6px)" }}>
              <span className="th-led-name">{m}</span>
              <span className="th-led-bar">
                <span style={{ transform: `scaleX(${on ? fv / 1000 : 0})` }} />
              </span>
              <span className="th-led-w num">{ex && v?.genes && weighed ? `${fv} × ${v.genes[i]}` : `${fv}`}</span>
              <span className={`th-led-term num ${term <= 0 ? "dim" : ""}`}>{ex && weighed ? signed(term) : ""}</span>
            </div>
          );
        })}
      </Fold>
      {ex ? (
        <Fold open={at(fold)}>
          <div className="th-led-row th-led-sum">
            <span className="th-led-name">Eight measurements, weighed</span>
            <span className="th-led-term num">{signed(linear)}</span>
          </div>
        </Fold>
      ) : null}

      {/* the patterns: pairs of measurements that fire together */}
      {ex ? (
        <>
          <Fold open={at(q11) && !at(fold)}>
            <div className="th-led-h">
              <span>Patterns that fired</span>
            </div>
            {pairs.length ? (
              pairs.map((p, j) => (
                <div key={p.k} className="th-led-row" style={{ opacity: at(q11 + 0.3 + j * 0.25) ? 1 : 0 }}>
                  <span className="th-led-name">{PAIR_NAMES[p.k]}</span>
                  <span />
                  <span />
                  <span className={`th-led-term num ${p.t <= 0 ? "dim" : ""}`}>{signed(p.t)}</span>
                </div>
              ))
            ) : (
              <div className="th-led-row">
                <span className="th-led-name text-ivory-3">None this time</span>
              </div>
            )}
          </Fold>
          <Fold open={at(fold)}>
            <div className="th-led-row th-led-sum">
              <span className="th-led-name">
                {pairs.length} pattern{pairs.length === 1 ? "" : "s"} fired
              </span>
              <span className="th-led-term num">{signed(pattern)}</span>
            </div>
          </Fold>
        </>
      ) : null}

      {/* the score against her limit */}
      <Fold open={at(fold)}>
        <div className="th-led-h">
          <span>Score</span>
          <span>her limit {count(LIMIT)}</span>
        </div>
        <div className="th-gauge">
          <span className="th-gauge-hold" style={{ left: `${(HOLD / max) * 100}%` }} />
          <span className="th-gauge-limit" style={{ left: `${(LIMIT / max) * 100}%` }} />
          <span className={`th-gauge-fill ${at(q12) ? (v?.refused ? "hot" : v?.held ? "held" : "") : ""}`} style={{ transform: `scaleX(${at(fold + 0.1) ? Math.max(0, raw) / max : 0})` }} />
        </div>
        <div className="th-led-total num">{v ? <CountUp to={Number(v.score)} run={at(fold + 0.1)} /> : "0"}</div>
      </Fold>

      <Fold open={!!v && at(word)}>
        {v ? (
          <div className="th-verdict">
            <div className={`th-verdict-word ${v.refused ? "text-hot" : v.held ? "text-held" : ""}`}>{v.refused ? "Refused." : v.held ? "Held." : "Paid."}</div>
            <div className="th-verdict-why">
              {v.refused
                ? `${reasonLine(v.reason) || "over the limit"}. Nothing left the vault.`
                : v.held
                  ? `${reasonLine(v.reason) || "close to the limit"}. It waits about a minute; the owner or a guardian may cancel it; then anyone can pay it out.`
                  : v.returned
                    ? "The demo returned it to the vault."
                    : "It left the vault."}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
              {link ? (
                <a className="th-link" href={link} target="_blank" rel="noreferrer">
                  View the transaction
                </a>
              ) : (
                <span className="th-hash">{short(v.hash, 6)}</span>
              )}
              {v.live && status !== "sending" ? (
                <button className="th-link" onClick={onAgain}>
                  Send another
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </Fold>
    </motion.aside>
  );
}
