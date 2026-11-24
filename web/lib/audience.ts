"use client";
/**
 * An audience with the queen. The visitor speaks (or types); her Space (queen/, on Hugging Face) hears it, answers
 * in her own voice, and acts on the page: it moves you to a chapter, starts the film, or sends a real attack at her
 * own vault and reports the contract's verdict. Her audio goes through the sound engine's voice channel, so it has
 * the same hall echo as the film's narration.
 *
 * The overlay (components/overlays/Audience.tsx) renders this store. Per-frame levels (the visitor's microphone,
 * her voice) are mutable fields on `scene`, never React state.
 */
import { useSyncExternalStore } from "react";
import { sound } from "./sound";
import { ui } from "./ui";
import { scene } from "./scene";
import { bus } from "./bus";
import { tour } from "./tour";
import { arena } from "./store";
import { QUEEN_URL } from "./config";
import { scrollToId } from "@/components/ui/SmoothScroll";

export type Phase = "idle" | "listening" | "thinking" | "speaking";
export interface Caption {
  id: number;
  text: string;
  /** seconds the line takes to say (0: show at once) */
  dur: number;
  /** "echo": her line in the visitor's own voice, set like theirs until it ends */
  kind: "you" | "her" | "echo";
}
export interface Verdict {
  /** her attack on her own vault, or her own policy put before the chain */
  kind?: "attack" | "proposal";
  running: boolean;
  /** a proposal: the chain's verdict, and what her policy and the champion would give up to the attackers (ppm) */
  verdictName?: string;
  accepted?: boolean;
  honestRefused?: number;
  lostPpm?: number;
  championPpm?: number;
  /** what she asked for */
  pct: number;
  repeats: number;
  fresh: boolean;
  refused?: number;
  /** how many of her payments were held for their wait */
  held?: number;
  total?: number;
  score?: number;
  limit?: number;
  reasons?: string;
  hash?: string;
  explorer?: string;
  failed?: boolean;
}
export interface AudienceState {
  open: boolean;
  closing: boolean;
  /** stepped aside: she took you to a chapter, or is attacking; a single line at the foot of the page */
  mini: boolean;
  phase: Phase;
  /** how the current listen ends: on release (hold) or on silence (tap) */
  hold: boolean;
  you: Caption | null;
  her: Caption | null;
  verdict: Verdict | null;
  mic: "unknown" | "ok" | "denied" | "none";
  /** her Space could not be reached */
  away: boolean;
  /** a passing line under the bead ("A queen can't be interrupted.") */
  note: string | null;
  /** she has said something that can be heard again */
  canReplay: boolean;
  /** a small live card she put beside her words (the numbers come from the chain, not from her) */
  card: CardKind | null;
}

export type CardKind = "measures" | "score" | "round" | "family";
const CARDS = new Set<CardKind>(["measures", "score", "round", "family"]);

interface Reply {
  say: string;
  mood: string;
  line: string;
  voice: string;
  parts: number;
  heard?: string;
  actions: {
    type: string;
    target?: string;
    amount_pct?: number;
    repeats?: number;
    fresh_recipient?: boolean;
    job?: string;
  }[];
  clone?: { say: string; voice: string; parts: number };
}

let state: AudienceState = {
  open: false,
  closing: false,
  mini: false,
  phase: "idle",
  hold: false,
  you: null,
  her: null,
  verdict: null,
  mic: "unknown",
  away: false,
  note: null,
  canReplay: false,
  card: null,
};
const ls = new Set<() => void>();
const set = (p: Partial<AudienceState>) => {
  state = { ...state, ...p };
  for (const l of ls) l();
};
let captionId = 0;
const cap = (text: string, kind: Caption["kind"], dur = 0): Caption => ({
  id: ++captionId,
  text,
  dur,
  kind,
});

// a session per tab: her short memory of this conversation lives on her side under this id
const sid = (() => {
  if (typeof window === "undefined") return "";
  try {
    const k = "rq-audience";
    const v =
      sessionStorage.getItem(k) || Math.random().toString(36).slice(2, 12);
    sessionStorage.setItem(k, v);
    return v;
  } catch {
    return Math.random().toString(36).slice(2, 12);
  }
})();

// Her memory of this visitor, kept in this browser only: the last few exchanges, for a week. It goes with each question,
// so she remembers a returning visitor; her server screens it like anything else the visitor sends and keeps it only in
// her usual half-hour of short memory.
const MEM_KEY = "rq-memory";
const MEM_TURNS = 6;
const MEM_DAYS = 7;
type Mem = { q: string; a: string; t: number };
function recall(): Mem[] {
  try {
    const m = JSON.parse(localStorage.getItem(MEM_KEY) || "[]");
    if (!Array.isArray(m)) return [];
    return m
      .filter((x) => x && typeof x.q === "string" && typeof x.a === "string" && typeof x.t === "number" && Date.now() - x.t < MEM_DAYS * 864e5)
      .slice(-MEM_TURNS);
  } catch {
    return [];
  }
}
function remember(q: string, a: string) {
  if (!q.trim() || !a.trim()) return;
  try {
    localStorage.setItem(MEM_KEY, JSON.stringify([...recall(), { q: q.slice(0, 300), a: a.slice(0, 400), t: Date.now() }].slice(-MEM_TURNS)));
  } catch {
    /* private mode or storage full: she simply won't remember */
  }
}
const memoryOut = () => recall().map(({ q, a }) => ({ q, a }));
function memoryHeader(): Record<string, string> {
  const m = memoryOut();
  if (!m.length) return {};
  try {
    return { "x-rq-memory": btoa(unescape(encodeURIComponent(JSON.stringify(m)))) };
  } catch {
    return {};
  }
}

const CHAPTER: Record<string, string> = {
  top: "top",
  vault: "vault",
  siege: "attack",
  try: "try",
  record: "feed",
  generations: "generations",
  lineage: "lineage",
  learning: "charts",
  bet: "bet",
  roles: "roles",
  proof: "proof",
};
const REFUSALS = new Set(["attack", "code", "secrets"]);
/** her attack picks, matched to the "your turn" buttons on either edition (desktop and phone label them differently) */
const PICK: Record<string, RegExp> = { drain: /40%/, salami: /slice/i, burst: /stranger/i, delegate: /agent/i, hop: /hop/i };
const sentences = (t: string) =>
  t
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean);
const voiceUrl = (vid: string, i: number) =>
  `${QUEEN_URL}/api/voice/${vid}/${i}`;

/**
 * Who is asking, for her limits: a device id that lasts across reloads (limits are per device, so a room of judges on
 * one Wi-Fi are not one visitor), and the presenter's key if this browser was given one (?presenter=… once; it is
 * kept here and taken out of the address bar). Her Space ignores the limits for the presenter.
 */
const device = (() => {
  if (typeof window === "undefined") return { id: "", presenter: "" };
  const keep = (k: string, make: () => string) => {
    try {
      const v = localStorage.getItem(k) || make();
      if (v) localStorage.setItem(k, v);
      return v;
    } catch {
      return make();
    }
  };
  const id = keep("rq-device", () => "d" + crypto.getRandomValues(new Uint32Array(3)).join("").slice(0, 24));
  const url = new URL(window.location.href);
  // #presenter=KEY never leaves the browser; ?presenter=KEY still works but reaches the host's request logs
  const frag = new URLSearchParams(url.hash.slice(1));
  const given = frag.get("presenter") ?? url.searchParams.get("presenter");
  if (given !== null) {
    url.searchParams.delete("presenter");
    frag.delete("presenter");
    url.hash = frag.toString();
    window.history.replaceState(null, "", url.toString());
    try {
      if (given) localStorage.setItem("rq-presenter", given);
      else localStorage.removeItem("rq-presenter");
    } catch {
      /* private window: this tab only */
    }
  }
  const presenter = keep("rq-presenter", () => given || "");
  return { id, presenter };
})();
const who = (): Record<string, string> => ({ "x-rq-device": device.id, ...(device.presenter ? { "x-rq-presenter": device.presenter } : {}) });

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(QUEEN_URL + path, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), ...who() } });
  if (!r.ok) throw new Error(String(r.status));
  set({ away: false });
  return (await r.json()) as T;
}

// --------------------------------------------------------------------------------------------- her voice
/** everything she says plays in order: a reply, then an attack's verdict, then her line in your voice */
let speech: Promise<unknown> = Promise.resolve();
let speechGen = 0;
/** the question being answered: a reply to an older one is never spoken */
let turnId = 0;
const queue = (fn: () => Promise<unknown>) => {
  const gen = speechGen;
  speech = speech
    .then(() => (gen === speechGen && state.open ? fn() : undefined))
    .catch(() => undefined);
  return speech;
};

/** say a reply (its sentences in order, each captioned as it plays); resolves when she has finished */
async function voice(
  text: string,
  vid: string,
  parts: number,
  kind: Caption["kind"] = "her"
) {
  const said = sentences(text);
  const lines = said.length === parts ? said : [text];
  const step = lines.length === parts ? 1 : parts;
  const gen = speechGen;
  set({ phase: "speaking" });
  scene.echo = kind === "echo" ? 1 : 0;
  try {
    for (let i = 0, k = 0; i < parts; i += step, k++) {
      if (gen !== speechGen) return;
      if (i + 1 < parts) void sound.loadVoice(voiceUrl(vid, i + 1)); // the next sentence downloads while this one plays
      const played = await sound.speak(voiceUrl(vid, i), {
        duck: kind === "echo" ? 0.14 : 0.35,
        onStart: (dur) =>
          set(
            kind === "echo"
              ? { her: cap(lines[k], "echo", dur) }
              : { her: cap(lines[k], "her", dur) }
          ),
      });
      if (!played) {
        // no sound (or it failed): the caption still shows, held for about the time it would take to say
        if (gen !== speechGen) return;
        const dur = Math.max(1.4, lines[k].split(/\s+/).length * 0.36);
        set({ her: cap(lines[k], kind === "echo" ? "echo" : "her", dur) });
        await new Promise((r) => setTimeout(r, dur * 1000));
      }
    }
  } finally {
    scene.echo = 0;
  }
}

function done() {
  sound.unduck();
  if (state.phase === "speaking") set({ phase: "idle" });
}

/**
 * Everything she or the visitor can leave open over the page: closed together by her own "close" action, and by
 * the film before it starts (a sheet left open behind the letterbox shows through its transparent middle, since
 * the theatre's bars don't cover the full screen).
 */
function closeOverlays() {
  const tm = ui.get().timeMachine;
  ui.set({ inspector: null, lab: false, scar: null, cinema: false, verify: false, timeMachine: { ...tm, on: false, playing: false } });
  scene.cinema = false;
}

// ---------------------------------------------------------------------------------------------- her actions
function act(r: Reply) {
  // the film takes the whole screen; while it plays, nothing else may open over it. Her "sound" is the one
  // exception: its toggle is also the film's own control, and it opens nothing.
  let filming = tour.get().active;
  for (const a of r.actions) {
    if (filming && a.type !== "film" && a.type !== "sound") continue;
    if (a.type === "go" && a.target && CHAPTER[a.target]) {
      step(true);
      scrollToId(CHAPTER[a.target]);
    } else if (a.type === "film") {
      if (a.target === "start") {
        if (ui.get().phone) continue; // no theatre on the phone edition: leave her chat open rather than close it on nothing
        filming = true;
        void queue(async () => {
          audience.close();
          closeOverlays(); // a clean stage: nothing left open earlier shows through the letterbox
          setTimeout(() => tour.start(), 750);
        });
      } else {
        filming = false;
        tour.stop();
      }
    } else if (a.type === "attack" && a.job) {
      step(true);
      scrollToId("try");
      set({
        verdict: {
          running: true,
          pct: a.amount_pct ?? 40,
          repeats: a.repeats ?? 1,
          fresh: !!a.fresh_recipient,
        },
      });
      void follow(a.job);
    } else if (a.type === "propose" && a.job) {
      // her own policy before the chain: she stays face to face, and the verdict pane shows what the chain decides
      set({ verdict: { kind: "proposal", running: true, pct: 0, repeats: 0, fresh: false } });
      void follow(a.job);
    } else if (a.type === "card" && a.target && CARDS.has(a.target as CardKind)) {
      // beside her words, where she is: no scrolling, the page stays put
      set({ card: a.target as CardKind });
    } else if (a.type === "explain_latest") {
      // the record's full explanation of the latest verdict (a refusal if there is one), as the visitor would open it
      const rows = arena.get().spends;
      const row = [...rows].reverse().find((r) => r.refused) ?? rows[rows.length - 1];
      step(true);
      scrollToId("feed");
      if (row) setTimeout(() => ui.set({ scar: row }), 900);
    } else if (a.type === "pick_attack" && a.target) {
      // set the attack up on "your turn": the visitor sees her predicted verdict, and signs it themselves
      step(true);
      scrollToId("try");
      const want = PICK[a.target];
      setTimeout(() => {
        const radio = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => want?.test(b.textContent ?? ""));
        radio?.click();
      }, 1100);
    } else if (a.type === "inspect") {
      // a policy by number when she names one the page knows, else her live genome
      const st = arena.get();
      const want = a.target && /^\d+$/.test(a.target) ? BigInt(a.target) : null;
      const known = want !== null && (st.nodes.has(want.toString()) || (st.snapshot?.pool ?? []).some((p) => p.id === want));
      const id = known ? want : st.snapshot?.live.id;
      if (id !== undefined && id !== null) {
        step(true);
        ui.set({ inspector: id });
      }
    } else if (a.type === "proof") {
      step(true);
      ui.set({ verify: true });
    } else if (a.type === "time_machine") {
      step(true);
      const tm = ui.get().timeMachine;
      ui.set({ timeMachine: { ...tm, on: true, playing: false, index: Math.max(0, arena.get().installs.length - 1) } });
    } else if (a.type === "open_lab") {
      void queue(async () => {
        step(true);
        ui.set({ lab: true });
      });
    } else if (a.type === "connect_wallet") {
      void queue(async () => {
        document.querySelector<HTMLButtonElement>(".jewels .lq-pill")?.click();
      });
    } else if (a.type === "cinema") {
      const on = a.target === "on";
      ui.set({ cinema: on });
      scene.cinema = on;
    } else if (a.type === "sound") {
      // off waits until she has finished saying so: her own voice goes through the same sound
      if (a.target === "on") {
        if (!sound.enabled) sound.enable();
        ui.set({ sound: true });
      } else
        void queue(async () => {
          sound.disable();
          ui.set({ sound: false });
        });
    } else if (a.type === "close") {
      closeOverlays();
    } else if (a.type === "check_tx" && a.target) {
      // the public reader: the page reads the transaction from the chain, no wallet
      step(true);
      scrollToId("roles");
      const hash = a.target;
      setTimeout(() => window.dispatchEvent(new CustomEvent("rq:check", { detail: hash })), 900);
    } else if (a.type === "allow_wallet" && a.target) {
      // prepared, never sent: the visitor presses it, and the contract decides whether their wallet may
      step(true);
      scrollToId("roles");
      const who = a.target;
      setTimeout(() => window.dispatchEvent(new CustomEvent("rq:allow", { detail: who })), 900);
    } else if (a.type === "ask_payment") {
      step(true);
      scrollToId("roles");
      setTimeout(() => window.dispatchEvent(new CustomEvent("rq:ask")), 900);
    } else if (a.type === "back_bloodline" && a.target) {
      step(true);
      scrollToId("bet");
      const id = a.target;
      setTimeout(() => window.dispatchEvent(new CustomEvent("rq:bloodline", { detail: id })), 900);
    }
  }
}

/**
 * Development only (stripped from production builds): carry out synthetic actions without spending her Gemini budget,
 * and look at the stores, for the QA of everything she can do on the page.
 */
if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") {
  Object.assign(window, {
    __rqAct: (actions: Reply["actions"]) => act({ say: "", actions, mood: "calm", line: "", voice: "", parts: 0 }),
    __rq: { audience: () => audience, ui, tour, scene, arena },
  });
}

/** follow her attack until the contract has decided, then let her say the verdict */
async function follow(job: string) {
  const t0 = Date.now();
  while (Date.now() - t0 < 260_000) {
    await new Promise((r) => setTimeout(r, 1500));
    if (!state.open) return;
    let a: {
      status: string;
      say?: string;
      mood?: string;
      voice?: string;
      parts?: number;
      result?: {
        ok: boolean;
        explorer?: string;
        verdict?: number;
        verdict_name?: string;
        honest_refused?: number;
        lost_ppm?: number;
        champion_ppm?: number;
        hash?: string;
        results?: {
          refused: boolean;
          /** 0 paid, 1 held, 2 refused (older servers send only `refused`) */
          verdict?: number;
          held?: boolean;
          score: number;
          limit: number;
          reasons: string;
          hash: string;
        }[];
      };
    };
    try {
      a = await api(`/api/attack/${job}`);
    } catch {
      continue;
    }
    if (a.status !== "done") continue;
    const rs = a.result?.results ?? [];
    const v = state.verdict;
    if (v?.kind === "proposal") {
      const r = a.result;
      set({
        verdict: {
          ...v,
          running: false,
          failed: !r?.ok,
          accepted: r?.verdict === 0,
          verdictName: r?.verdict_name,
          honestRefused: r?.honest_refused,
          lostPpm: r?.lost_ppm,
          championPpm: r?.champion_ppm !== undefined ? Math.abs(r.champion_ppm) : undefined,
          hash: r?.hash,
          explorer: r?.explorer,
        },
      });
      if (r?.ok && r.verdict !== 0) bus.emit({ type: "queen-refuses" });
    } else if (v) {
      const top = rs.reduce(
        (m, r) => (r.score > (m?.score ?? -1) ? r : m),
        rs[0]
      );
      // a hold: from her server when it says so, else from the Spend event on the record
      const spends = arena.get().spends;
      const isHeld = (r: (typeof rs)[number]) => !r.refused && (r.verdict === 1 || r.held === true || spends.some((x) => x.txHash === r.hash && x.verdict === 1));
      set({
        verdict: {
          ...v,
          running: false,
          failed: !a.result?.ok,
          total: rs.length,
          refused: rs.filter((r) => r.refused).length,
          held: rs.filter(isHeld).length,
          score: top?.score,
          limit: top?.limit,
          reasons: top?.reasons,
          hash: rs[rs.length - 1]?.hash,
          explorer: a.result?.explorer,
        },
      });
    }
    if (rs.some((r) => r.refused)) bus.emit({ type: "queen-refuses" });
    if (a.say && a.voice)
      await queue(() => voice(a.say!, a.voice!, a.parts ?? 1).then(done));
    return;
  }
}

/** step aside (a single line at the foot of the page) or come back face to face */
function step(aside: boolean) {
  set({ mini: aside });
  scene.audience = aside ? 2 : 1;
  document.documentElement.dataset.audience = aside ? "mini" : "full";
}

// ------------------------------------------------------------------------------------------ handling a reply
/** what she said last, so the visitor can hear it again: her answer, and her line in their voice if it followed */
type Clip = { say: string; voice: string; parts: number; kind: Caption["kind"] };
let lastSaid: Clip[] = [];

async function answer(r: Reply, typed?: string, turn = turnId) {
  if (turn !== turnId) return;
  // her answer is here: no filler starts now, and one already under way is finished, not cut off
  if (fillerTimer) clearTimeout(fillerTimer);
  fillerSaid = true;
  if (fillerPlaying) await fillerPlaying;
  if (turn !== turnId) return;
  const heard = typed ?? r.heard ?? "";
  if (heard && heard !== state.you?.text) set({ you: cap(heard, "you") });
  else if (!heard) set({ you: null });
  if (REFUSALS.has(r.line)) bus.emit({ type: "queen-refuses" });
  set({ card: null });
  act(r);
  if (heard && !r.line) remember(heard, r.say);
  lastSaid = [{ say: r.say, voice: r.voice, parts: r.parts, kind: "her" }];
  if (r.clone) lastSaid.push({ ...r.clone, kind: "echo" });
  set({ canReplay: true });
  await queue(() => voice(r.say, r.voice, r.parts));
  if (r.clone) {
    const c = r.clone;
    // a breath, then her line in their voice; the room drops away around it
    await queue(async () => {
      await new Promise((res) => setTimeout(res, 900));
      await voice(c.say, c.voice, c.parts, "echo");
    });
  }
  await queue(async () => done());
}

// ----------------------------------------------------------------------------------------- filling a pause
/** while she thinks she fills the pause the way people do, with words that fit what was asked */
let filler: { say: string; voice?: string; url?: string; topic: string }[] = [];
let fillerTimer: ReturnType<typeof setTimeout> | null = null;
let fillerSaid = false;
/** the filler she is saying: her answer waits for it to end rather than cutting it off */
let fillerPlaying: Promise<boolean> | null = null;
const recent: string[] = [];
const TOPICS: [string, RegExp][] = [
  ["policy", /\b(polic(y|ies)|write (a|me|one)|propose|design (a|one)|a (better|new) rule|defen[cs]e)\b/i],
  ["go", /\b(take me|go to|show me (the|your|my|where)|where (is|are|can)|open (the|your)|bring me|scroll)\b/i],
  ["roles", /\b(admin|registrar|allow(ed)?|roles?|who can|operator|permission)\b/i],
  [
    "trust",
    /\b(secure|security|trust|safe|blockchain|poison\w*|sybil|gam(e|ed|ing) (it|the)|cheat|spreadsheet|why not|weakness|flaw|honest(ly)?)\b/i,
  ],
  [
    "attack",
    /\b(attack|drain|steal|hack|hit (it|her|the vault)|show me|try (it|one|to)|take (half|some|all|\d+)|salami|empty (it|the vault)|send (one|it))\b/i,
  ],
  [
    "record",
    /\b(refus\w*|verdict\w*|payments?|transactions?|last (one|attack|payment)|record|blocked|why did)\b/i,
  ],
  ["vault", /\b(vault|balance|how much|money|ether|eth|funds|holding)\b/i],
  [
    "lineage",
    /\b(evolv\w*|generations?|breed\w*|bred|genes?|genome|lineage|family|parents?|child(ren)?|mutat\w*|rounds?|rivals?|challengers?)\b/i,
  ],
  [
    "self",
    /\b(who are you|what are you|your name|about you(rself)?|are you (an? )?(ai|real|alive|human|afraid))\b/i,
  ],
  ["explain", /\b(how|why|explain|what is|what's|what are|difference|mean|works?)\b/i],
];
/** the fillers rendered and checked on the team's machine (tools/voice/render_fillers.py), else the Space's */
async function loadFillers() {
  try {
    const r = await fetch("/voice/fillers/manifest.json");
    if (r.ok) {
      const m = (await r.json()) as { topic: string; say: string; file: string }[];
      if (Array.isArray(m) && m.length) {
        filler = m.map((f) => ({ topic: f.topic, say: f.say, url: `/voice/fillers/${f.file}` }));
        return;
      }
    }
  } catch {
    /* the Space's */
  }
  api<typeof filler>("/api/fillers")
    .then((f) => (filler = f))
    .catch(() => undefined);
}
const topicOf = (words: string) =>
  TOPICS.find(([, re]) => re.test(words))?.[0] ?? "any";

function fill(words = "") {
  if (fillerSaid || state.phase !== "thinking" || !filler.length) return;
  const topic = topicOf(words);
  const fresh = (t: string) =>
    filler.filter((f) => f.topic === t && !recent.includes(f.say));
  const pool = fresh(topic).length
    ? fresh(topic)
    : fresh("any").length
    ? fresh("any")
    : filler.filter((f) => f.topic === "any");
  const f = pool[Math.floor(Math.random() * pool.length)];
  if (!f) return;
  fillerSaid = true;
  recent.push(f.say);
  if (recent.length > 4) recent.shift();
  fillerPlaying = sound.speak(f.url ?? voiceUrl(f.voice ?? "", 0)).finally(() => (fillerPlaying = null));
}

function thinking(words = "") {
  set({ phase: "thinking" });
  fillerSaid = false;
  if (fillerTimer) clearTimeout(fillerTimer);
  // she fills the pause only if her answer is slow to come; what you said decides how
  fillerTimer = setTimeout(
    () => fill(words || live.text),
    words || live.text ? 650 : 1100
  );
}

// ------------------------------------------------------------------------------------- your words, live
/**
 * Where the browser can (Chrome, Safari), it writes down your words as you say them, so they appear under her
 * while you speak and her pause-filler fits them. Her answer always comes from the recording itself.
 */
type Rec = {
  start(): void;
  stop(): void;
  abort(): void;
  onresult:
    | ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void)
    | null;
  onerror: (() => void) | null;
  continuous: boolean;
  interimResults: boolean;
  lang: string;
};
const live: { rec: Rec | null; text: string } = { rec: null, text: "" };
function liveStart() {
  live.text = "";
  if (mic.defaultBt) return; // it would reopen the headset's microphone and put the headset back in call mode
  const W = window as unknown as {
    SpeechRecognition?: new () => Rec;
    webkitSpeechRecognition?: new () => Rec;
  };
  const R = W.SpeechRecognition ?? W.webkitSpeechRecognition;
  if (!R) return;
  try {
    const r = new R();
    r.continuous = true;
    r.interimResults = true;
    r.lang = navigator.language || "en-US";
    r.onresult = (e) => {
      let t = "";
      for (let i = 0; i < e.results.length; i++)
        t += e.results[i][0].transcript;
      live.text = t.trim();
      if (live.text && state.phase === "listening")
        set({ you: { ...(state.you ?? cap("", "you")), text: live.text } });
    };
    r.onerror = () => undefined;
    r.start();
    live.rec = r;
  } catch {
    live.rec = null;
  }
}
function liveStop() {
  try {
    live.rec?.stop();
  } catch {
    /* already stopped */
  }
  live.rec = null;
}

/** read her streamed reply: {"heard"} first (your words, as she heard them), then {"reply"} */
async function readHear(res: Response): Promise<Reply> {
  if (!res.ok || !res.body) throw new Error(String(res.status));
  set({ away: false });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let reply: Reply | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const d = JSON.parse(line) as { heard?: string; reply?: Reply };
      if (typeof d.heard === "string" && d.heard) {
        set({ you: cap(d.heard, "you") });
        fill(d.heard);
      } else if (d.reply) reply = d.reply;
    }
    if (done) break;
  }
  if (!reply) throw new Error("no reply");
  return reply;
}

function offline() {
  const gone = herDown();
  set({
    phase: "idle",
    away: true,
    her: cap(
      gone
        ? "My voice is offline right now: it runs on a separate server that isn't answering. Everything else here still reads the chain directly, so you can watch the film, try to drain the vault from your own wallet, or look through my history."
        : "I can't reach my own voice just now. Give me a moment, then ask again.",
      "her",
      gone ? 7 : 3.2
    ),
  });
}

/**
 * Her server could not be reached even after a full wait (or it no longer exists): remembered for ten minutes, so
 * every later question gets one quick check and a plain answer, not another long wait.
 */
let downAt = 0;
const herDown = () => Date.now() - downAt < 600_000;
async function reachable(ms = 5000): Promise<boolean | "gone"> {
  try {
    const r = await fetch(QUEEN_URL + "/alive", { signal: AbortSignal.timeout(ms) });
    if (r.ok) {
      downAt = 0;
      return true;
    }
    return r.status === 404 ? "gone" : false;
  } catch {
    return false;
  }
}

/**
 * Her Space sleeps when nobody has visited for a while and takes about a minute to start. Rather than a silent
 * minute or an error, she says so in words (her voice lives on that Space) and waits for it to answer.
 */
function wakingNote() {
  set({
    phase: "idle",
    away: true,
    her: cap(
      "I'm waking up. I sleep when nobody visits, and it takes me a minute to start. I'll speak the moment I'm ready.",
      "her",
      4.5
    ),
  });
}
let waking: Promise<boolean> | null = null;
function awake(): Promise<boolean> {
  if (!waking)
    waking = (async () => {
      const until = Date.now() + 150_000;
      while (Date.now() < until) {
        const r = await reachable(10_000);
        if (r === true) return true;
        if (r === "gone") break; // no such server: nothing is starting
        await new Promise((ok) => setTimeout(ok, 4000));
      }
      downAt = Date.now();
      return false;
    })().finally(() => (waking = null));
  return waking;
}

/**
 * A reply failed. If her Space answers at once, something else went wrong (the usual line). If it doesn't, it is
 * starting: say so, wait, then resend a typed question (`again`) or ask for a spoken one to be said again.
 */
async function lost(turn: number, again?: () => Promise<unknown>) {
  const r = await reachable();
  if (r === true) return offline();
  if (r === "gone" || herDown()) {
    downAt = downAt || Date.now();
    return offline();
  }
  wakingNote();
  const up = await awake();
  if (!state.open || turn !== turnId) return;
  if (!up) return offline();
  if (!again) return set({ away: false, her: cap("I'm awake now. Say that again?", "her", 1.6) });
  try {
    await again();
  } catch {
    offline();
  }
}

// ------------------------------------------------------------------------------------------------- listening
const mic: {
  stream: MediaStream | null;
  ctx: AudioContext | null;
  node: AudioWorkletNode | null;
  chunks: Float32Array[];
  rate: number;
  heard: number;
  quiet: number;
  started: number;
  floor: number;
  /** the microphone in use belongs to a Bluetooth headset (see openMic) */
  bt: boolean;
  /** the system's default microphone is a headset's: the browser's live transcription would open it, so it is skipped */
  defaultBt: boolean;
} = {
  stream: null,
  ctx: null,
  node: null,
  chunks: [],
  rate: 48000,
  heard: 0,
  quiet: 0,
  started: 0,
  floor: 0.004,
  bt: false,
  defaultBt: false,
};

/**
 * A Bluetooth headset's microphone (AirPods and the like) drags the whole headset into its call mode while it is
 * open: low-rate, crackly sound for everything, her voice included. So when the default microphone is a headset's,
 * the computer's own microphone is used instead, which leaves the headset playing in full quality; and if there is
 * none, the headset's microphone is released as soon as the visitor has spoken, so her answer plays clean.
 */
const BT_MIC = /airpods|bluetooth|headset|hands-?free|buds|beats|bose|jabra|sony wh|sony wf|pixel buds/i;
const BUILT_IN_MIC = /built-?in|macbook|internal|imac|microphone array/i;

async function openMic(): Promise<boolean> {
  if (mic.node) return true;
  if (!navigator.mediaDevices?.getUserMedia) {
    set({ mic: "none" });
    return false;
  }
  try {
    // raw, as the voice reaches the microphone: the browser's echo cancelling, noise suppression and automatic gain
    // reshape the voice (and its 16 kHz path cuts everything above 8 kHz), and her line in the visitor's own voice
    // copies whatever the recording carries. She never speaks while listening, and the world goes quiet then.
    const want = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    };
    let stream = await navigator.mediaDevices.getUserMedia({ audio: want });
    mic.bt = BT_MIC.test(stream.getAudioTracks()[0]?.label ?? "");
    mic.defaultBt = mic.bt;
    if (mic.bt) {
      const inputs = (await navigator.mediaDevices.enumerateDevices()).filter(
        (d) => d.kind === "audioinput" && d.deviceId !== "default" && d.deviceId !== "communications"
      );
      const own = inputs.find((d) => BUILT_IN_MIC.test(d.label) && !BT_MIC.test(d.label));
      if (own) {
        const alt = await navigator.mediaDevices
          .getUserMedia({ audio: { ...want, deviceId: { exact: own.deviceId } } })
          .catch(() => null);
        if (alt) {
          stream.getTracks().forEach((t) => t.stop());
          stream = alt;
          mic.bt = false;
        }
      }
    }
    mic.stream = stream;
    mic.ctx = new AudioContext();
    mic.rate = mic.ctx.sampleRate;
    await mic.ctx.audioWorklet.addModule("/rq-mic.js");
    const src = mic.ctx.createMediaStreamSource(mic.stream);
    mic.node = new AudioWorkletNode(mic.ctx, "rq-mic");
    mic.node.port.onmessage = (e: MessageEvent<Float32Array>) =>
      hearBlock(e.data);
    src.connect(mic.node);
    set({ mic: "ok" });
    return true;
  } catch (err) {
    closeMic();
    set({
      mic:
        (err as DOMException)?.name === "NotAllowedError" ? "denied" : "none",
    });
    return false;
  }
}

function closeMic() {
  sound.silence(false);
  mic.node?.port.close();
  mic.node?.disconnect();
  mic.stream?.getTracks().forEach((t) => t.stop());
  void mic.ctx?.close().catch(() => undefined);
  mic.node = null;
  mic.stream = null;
  mic.ctx = null;
  scene.mic = 0;
}

/** a block of microphone samples: keep it while listening, measure it, and end a tapped turn on silence */
function hearBlock(b: Float32Array) {
  let e = 0;
  for (let i = 0; i < b.length; i++) e += b[i] * b[i];
  const rms = Math.sqrt(e / b.length);
  const lvl = Math.min(1, rms * 9);
  scene.mic += (lvl - scene.mic) * (lvl > scene.mic ? 0.5 : 0.15);
  if (state.phase !== "listening") return;
  mic.chunks.push(b);
  const secs = b.length / mic.rate;
  const speaking = rms > Math.max(0.005, mic.floor * 3.2); // no automatic gain: a quiet voice stays quiet
  if (!speaking) mic.floor += (rms - mic.floor) * 0.05;
  if (speaking) {
    mic.heard += secs;
    mic.quiet = 0;
  } else mic.quiet += secs;
  const long = (performance.now() - mic.started) / 1000;
  if (!state.hold) {
    if (mic.heard > 0.35 && mic.quiet > 2.0) void finishListening();
    else if (mic.heard < 0.2 && long > 7) cancelListening();
  }
  if (long > 15) void finishListening();
}

/** the rate she records at: the voice model's own (her Space accepts 16 or 24 kHz) */
const WAV_RATE = 24000;

/**
 * `x` from `from` Hz to `to` Hz with a windowed-sinc filter (Blackman, cut a little under the lower Nyquist). The
 * browser's own resampling (a buffer played into an OfflineAudioContext) folds everything above the new Nyquist
 * back down at full strength, so it is done here: flat to 10 kHz, nothing folded back, a few tens of ms a second.
 */
function resample(x: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return x;
  const ratio = from / to;
  const fc = 0.45 / Math.max(1, ratio); // cycles per input sample
  const H = 32 * Math.max(1, Math.ceil(ratio));
  const P = 256;
  const W = 2 * H;
  const table = new Float32Array((P + 1) * W);
  for (let p = 0; p <= P; p++) {
    let sum = 0;
    for (let j = 0; j < W; j++) {
      const d = j - H + 1 - p / P;
      const u = d / H;
      const w = Math.abs(u) >= 1 ? 0 : 0.42 + 0.5 * Math.cos(Math.PI * u) + 0.08 * Math.cos(2 * Math.PI * u);
      const a = 2 * Math.PI * fc * d;
      const h = (d === 0 ? 1 : Math.sin(a) / a) * w;
      table[p * W + j] = h;
      sum += h;
    }
    for (let j = 0; j < W; j++) table[p * W + j] /= sum;
  }
  const out = new Float32Array(Math.floor(x.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const t = i * ratio;
    const k0 = Math.floor(t);
    const row = Math.round((t - k0) * P) * W;
    const base = k0 - H + 1;
    let s = 0;
    for (let j = 0; j < W; j++) {
      const k = base + j;
      if (k >= 0 && k < x.length) s += x[k] * table[row + j];
    }
    out[i] = s;
  }
  return out;
}

/** 24 kHz, 16-bit mono WAV (what her Space and Gemini read), with one fixed gain */
function wav(chunks: Float32Array[], rate: number): Blob {
  const n = chunks.reduce((s, c) => s + c.length, 0);
  const all = new Float32Array(n);
  let o = 0;
  for (const c of chunks) all.set(c, (o += c.length) - c.length);
  const pcm = resample(all, rate, WAV_RATE);
  // the microphone runs without automatic gain: one gain for the whole question, peaks to about -1 dBFS, at most +20 dB
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]));
  const gain = peak > 1e-4 ? Math.min(10, 0.89 / peak) : 1;
  const out = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    const v = Math.max(-1, Math.min(1, pcm[i] * gain));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  const head = new DataView(new ArrayBuffer(44));
  const str = (p: number, t: string) =>
    [...t].forEach((ch, k) => head.setUint8(p + k, ch.charCodeAt(0)));
  str(0, "RIFF");
  head.setUint32(4, 36 + out.byteLength, true);
  str(8, "WAVE");
  str(12, "fmt ");
  head.setUint32(16, 16, true);
  head.setUint16(20, 1, true);
  head.setUint16(22, 1, true);
  head.setUint32(24, WAV_RATE, true);
  head.setUint32(28, WAV_RATE * 2, true);
  head.setUint16(32, 2, true);
  head.setUint16(34, 16, true);
  str(36, "data");
  head.setUint32(40, out.byteLength, true);
  return new Blob([head.buffer, out.buffer], { type: "audio/wav" });
}

function cancelListening() {
  sound.silence(false);
  liveStop();
  if (mic.bt) closeMic();
  mic.chunks = [];
  set({ phase: "idle", hold: false });
}

async function finishListening() {
  if (state.phase !== "listening") return;
  const chunks = mic.chunks;
  mic.chunks = [];
  set({ hold: false });
  sound.silence(false);
  liveStop();
  if (mic.bt) closeMic(); // a headset's microphone: release it so her answer plays in full quality
  if (mic.heard < 0.3) {
    set({ phase: "idle" });
    return;
  }
  const turn = ++turnId;
  thinking(live.text);
  try {
    const res = await fetch(`${QUEEN_URL}/api/hear?sid=${sid}`, {
      method: "POST",
      body: wav(chunks, mic.rate),
      headers: { "content-type": "audio/wav", ...who(), ...memoryHeader() },
    });
    await answer(await readHear(res), undefined, turn);
  } catch {
    await lost(turn);
  }
}

// ------------------------------------------------------------------------------------------------- the store
let levelLoop = 0;
let holdWanted = false;
function levels() {
  cancelAnimationFrame(levelLoop);
  const tick = () => {
    if (!state.open) {
      scene.voice = 0;
      scene.mic = 0;
      return;
    }
    levelLoop = requestAnimationFrame(tick);
    const v = Math.min(1, sound.voiceLevel() * 7);
    scene.voice += (v - scene.voice) * (v > scene.voice ? 0.45 : 0.12);
    if (state.phase !== "listening") scene.mic *= 0.9;
  };
  levelLoop = requestAnimationFrame(tick);
}

let noteTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;

export const audience = {
  get: () => state,

  /** she is speaking or composing an answer: she will not be talked over */
  busy: () => state.phase === "speaking" || state.phase === "thinking",
  /** say the last answer again (and her line in the visitor's voice, if it followed): the clips are cached */
  async replay() {
    if (!lastSaid.length || audience.busy() || state.phase === "listening") return;
    speechGen++;
    sound.hush();
    const clips = lastSaid.slice();
    for (const [i, c] of clips.entries()) {
      if (i) await queue(() => new Promise((res) => setTimeout(res, 900)));
      await queue(() => voice(c.say, c.voice, c.parts, c.kind));
    }
    await queue(async () => done());
  },

  /** someone tried to talk over her: she carries on, and says so in writing */
  refuseInterruption() {
    if (noteTimer) clearTimeout(noteTimer);
    set({ note: "A queen can't be interrupted." });
    noteTimer = setTimeout(() => set({ note: null }), 2600);
  },

  /**
   * Wake her Space early (a sleeping Space takes a minute to start), then tell it every two minutes that someone is
   * watching while the page is visible: her server closes quiet rounds while the arena is watched, so it evolves in
   * front of the visitor and costs nothing when nobody is there.
   */
  warm() {
    const ping = () => fetch(QUEEN_URL + "/health").catch(() => undefined);
    ping();
    if (heartbeat || typeof document === "undefined") return;
    heartbeat = setInterval(() => {
      if (document.visibilityState === "visible") ping();
    }, 120_000);
  },

  /** come face to face with her; `listen` starts listening at once (the visitor pressed and held her) */
  async open(listen = false) {
    if (state.open && !state.closing) {
      step(false);
      return;
    }
    if (tour.get().active) tour.stop();
    speechGen++;
    set({
      open: true,
      closing: false,
      mini: false,
      phase: "idle",
      you: null,
      her: null,
      verdict: null,
    });
    step(false);
    if (!sound.enabled) {
      sound.enable();
      ui.set({ sound: true });
    }
    levels();
    if (!filler.length) void loadFillers();
    if (listen) return; // the caller is about to listen
    const gen = speechGen;
    const hello = () =>
      api<{ say: string; voice: string; parts: number }>(`/api/line/hello?sid=${sid}`);
    const greet = async (g: { say: string; voice: string; parts: number }) => {
      if (state.open && state.phase === "idle" && speechGen === gen)
        await queue(() => voice(g.say, g.voice, g.parts).then(done));
    };
    // a sleeping Space holds the request open while it starts: after a few quiet seconds, say she is waking
    if (herDown() && (await reachable()) !== true) {
      if (state.open && speechGen === gen) offline();
      return;
    }
    const slow = setTimeout(() => {
      if (state.open && state.phase === "idle" && !state.her && speechGen === gen) wakingNote();
    }, 4000);
    try {
      await greet(await hello());
    } catch {
      if ((await reachable()) === "gone") {
        downAt = Date.now();
        if (state.open && speechGen === gen) offline();
        return;
      }
      wakingNote();
      try {
        if ((await awake()) && state.open && speechGen === gen) await greet(await hello());
        else if (state.open && speechGen === gen) offline();
      } catch {
        if (state.open && speechGen === gen) offline();
      }
    } finally {
      clearTimeout(slow);
    }
  },

  close() {
    if (!state.open || state.closing) return;
    speechGen++;
    sound.hush();
    liveStop();
    closeMic();
    if (fillerTimer) clearTimeout(fillerTimer);
    set({ closing: true, phase: "idle" });
    scene.audience = 0;
    delete document.documentElement.dataset.audience;
    setTimeout(
      () =>
        set({
          open: false,
          closing: false,
          mini: false,
          you: null,
          her: null,
          verdict: null,
        }),
      700
    );
  },

  /** come back face to face after she stepped aside */
  face() {
    step(false);
  },

  /** start listening: `hold` ends on release, otherwise on a second of silence */
  async listen(hold: boolean) {
    if (state.open && audience.busy()) {
      audience.refuseInterruption();
      return;
    }
    holdWanted = hold;
    if (!state.open) await audience.open(true);
    if (state.phase === "listening") return;
    if (!(await openMic())) {
      try {
        const m = await api<{ say: string; voice: string; parts: number }>(
          `/api/line/mic?sid=${sid}`
        );
        await queue(() => voice(m.say, m.voice, m.parts).then(done));
      } catch {
        offline();
      }
      return;
    }
    void mic.ctx?.resume();
    mic.chunks = [];
    mic.heard = 0;
    mic.quiet = 0;
    mic.started = performance.now();
    // the press may have ended while the browser asked for the microphone: then this is a tap
    set({ phase: "listening", hold: holdWanted, you: null });
    sound.silence(true); // the microphone has no echo cancelling: the world must not be recorded with the voice
    liveStart();
  },

  /** the visitor let go (hold), or pressed again (tap): send what was said */
  release() {
    if (state.phase !== "listening") {
      holdWanted = false;
      return;
    }
    void finishListening();
  },

  /** the press was short: keep listening, and answer at the pause */
  tapMode() {
    holdWanted = false;
    if (state.phase === "listening") set({ hold: false });
  },

  cancel() {
    cancelListening();
  },

  /** a typed question */
  /** a typed question; false if she would not take it yet (she is speaking) */
  async ask(q: string): Promise<boolean> {
    const text = q.trim();
    if (!text) return false;
    if (state.open && audience.busy()) {
      audience.refuseInterruption();
      return false;
    }
    if (!state.open) await audience.open();
    speechGen++;
    sound.hush();
    set({ you: cap(text, "you") });
    const turn = ++turnId;
    const send = async () => {
      thinking(text);
      const r = await api<Reply>("/api/ask", {
        method: "POST",
        body: JSON.stringify({ q: text, sid, memory: memoryOut() }),
        headers: { "content-type": "application/json" },
      });
      await answer(r, text, turn);
    };
    try {
      await send();
    } catch {
      await lost(turn, send);
    }
    return true;
  },
};

export function useAudience<T>(sel: (s: AudienceState) => T): T {
  return useSyncExternalStore(
    (l) => {
      ls.add(l);
      return () => ls.delete(l);
    },
    () => sel(state),
    () => sel(state)
  );
}
