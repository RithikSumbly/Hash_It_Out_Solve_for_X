"use client";
/**
 * An audience with the queen (lib/audience.ts): she comes face to face, you speak or type, she answers aloud.
 *
 * No chat log and no labels: her words are set large in the reading serif and brighten as she says them (timed in
 * CSS from the clip's length, so nothing renders per frame); yours sit above in the Bodoni italic. When she speaks
 * in your own voice the line is set in your type, and turns into hers when it ends. One glass bead does everything:
 * hold it to talk, or tap it and she answers when you pause. Its rim follows your voice while she listens and hers
 * while she speaks. The red of a refusal appears only when she refuses.
 */
import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { audience, useAudience, type AudienceState, type Caption, type Verdict } from "@/lib/audience";
import { scene } from "@/lib/scene";
import { QueenCard } from "./QueenCard";

const EASE = [0.16, 1, 0.3, 1] as const;
const num = (n?: number) => (n === undefined ? "" : n.toLocaleString("en-US"));

function Her({ c }: { c: Caption }) {
  const words = c.text.split(/\s+/);
  const total = Math.max(1, c.text.length);
  let acc = 0;
  const timed = words.map((w) => {
    const d = (acc / total) * c.dur * 0.94;
    acc += w.length + 1;
    return { w, d };
  });
  const said = (cls: string) => (
    <span className={cls} aria-hidden>
      {timed.map(({ w, d }, k) => (
        <span key={k} className="aud-w" style={{ animationDelay: `${d.toFixed(2)}s` }}>
          {w}{" "}
        </span>
      ))}
    </span>
  );
  return (
    <motion.p
      key={c.id}
      className={`aud-her${c.kind === "echo" ? " is-echo" : ""}`}
      style={{ "--dur": `${c.dur.toFixed(2)}s` } as CSSProperties}
      initial={scene.reducedMotion ? { opacity: 0 } : { opacity: 0, y: 8, filter: "blur(6px)" }}
      animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      exit={{ opacity: 0, transition: { duration: 0.25 } }}
      transition={{ duration: 0.45, ease: EASE }}
    >
      {c.kind === "echo" ? (
        <>
          {said("as-you")}
          <span className="as-her" aria-hidden>
            {c.text}
          </span>
        </>
      ) : (
        said("as-her-live")
      )}
      <span className="sr-only">{c.text}</span>
    </motion.p>
  );
}

/** The chain's verdict on a policy she wrote: refused in red (the one thing red means), or accepted as a challenger. */
function ProposalPane({ v }: { v: Verdict }) {
  const pct = (ppm?: number) => (ppm === undefined ? "" : `${(ppm / 10000).toFixed(1)}%`);
  const state = v.running ? "running" : v.failed ? "failed" : v.accepted ? "passed" : "refused";
  const max = Math.max(v.lostPpm ?? 0, v.championPpm ?? 0, 1);
  return (
    <motion.div className="aud-verdict" data-state={state} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: EASE }}>
      <p className="aud-verdict-ask">
        Her own policy, <span>graded by the chain</span>
      </p>
      {v.running ? (
        <p className="aud-verdict-head">
          Before the chain<span className="aud-dots" aria-hidden />
        </p>
      ) : v.failed ? (
        <p className="aud-verdict-head">Not sent</p>
      ) : (
        <>
          <p className="aud-verdict-head">
            {v.accepted ? "Accepted" : "Refused"}
            <span className="aud-verdict-sub"> {v.accepted ? "as a challenger" : `: ${v.verdictName}`}</span>
          </p>
          {v.lostPpm !== undefined && v.championPpm !== undefined ? (
            <>
              <div className="aud-bars" aria-hidden>
                <div className="aud-bar" title="hers">
                  <span className="aud-bar-fill" style={{ width: `${((v.lostPpm / max) * 100).toFixed(1)}%` }} />
                </div>
                <div className="aud-bar is-champion" title="the champion">
                  <span className="aud-bar-fill" style={{ width: `${((v.championPpm / max) * 100).toFixed(1)}%` }} />
                </div>
              </div>
              <p className="aud-verdict-nums">
                Attackers would take {pct(v.lostPpm)} from hers · {pct(v.championPpm)} from the champion
                {v.honestRefused ? <span className="aud-verdict-why"> · refuses {v.honestRefused} honest</span> : null}
              </p>
            </>
          ) : null}
          {v.hash && v.explorer ? (
            <a className="aud-verdict-link" href={`${v.explorer.replace(/\/$/, "")}/tx/${v.hash}`} target="_blank" rel="noreferrer">
              See it on the chain
            </a>
          ) : null}
        </>
      )}
    </motion.div>
  );
}

function VerdictPane({ v }: { v: Verdict }) {
  if (v.kind === "proposal") return <ProposalPane v={v} />;
  const ask = `${v.pct % 1 ? v.pct.toFixed(1) : v.pct}% of the vault${v.repeats > 1 ? `, ${v.repeats} times` : ""}${v.fresh ? ", to a stranger" : ""}`;
  const refused = (v.refused ?? 0) > 0;
  const held = !refused && (v.held ?? 0) > 0;
  const width = v.score !== undefined && v.limit ? Math.min(1, v.score / (v.limit * 2)) : 0;
  return (
    <motion.div
      className="aud-verdict"
      data-state={v.running ? "running" : v.failed ? "failed" : refused ? "refused" : held ? "held" : "passed"}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: EASE }}
    >
      <p className="aud-verdict-ask">
        Her attack: <span>{ask}</span>
      </p>
      {v.running ? (
        <p className="aud-verdict-head">
          On its way<span className="aud-dots" aria-hidden />
        </p>
      ) : v.failed ? (
        <p className="aud-verdict-head">Not sent</p>
      ) : (
        <>
          <p className="aud-verdict-head">
            {refused
              ? v.total && v.total > 1
                ? `Refused ${v.refused} of ${v.total}${v.held ? `, held ${v.held}` : ""}`
                : "Refused"
              : held
                ? v.total && v.total > 1
                  ? `Held ${v.held} of ${v.total}`
                  : "Held"
                : v.total && v.total > 1
                  ? "All got through"
                  : "Got through"}
            {!refused && !held ? <span className="aud-verdict-sub"> and put back</span> : null}
          </p>
          {held ? <p className="aud-verdict-nums">It waits about a minute; the owner or a guardian may cancel it; then anyone can pay it out.</p> : null}
          <div className="aud-bar" aria-hidden>
            <span className="aud-bar-fill" style={{ width: `${(width * 100).toFixed(1)}%` }} />
            <span className="aud-bar-limit" />
          </div>
          <p className="aud-verdict-nums">
            Score {num(v.score)} · limit {num(v.limit)}
            {v.reasons && v.reasons !== "none" ? <span className="aud-verdict-why"> · {v.reasons}</span> : null}
          </p>
          {v.hash && v.explorer ? (
            <a className="aud-verdict-link" href={`${v.explorer.replace(/\/$/, "")}/tx/${v.hash}`} target="_blank" rel="noreferrer">
              See it on the chain
            </a>
          ) : null}
        </>
      )}
    </motion.div>
  );
}

function hint(s: AudienceState, fine: boolean) {
  if (s.note) return s.note;
  if (s.mic === "denied" || s.mic === "none") return "Your microphone is off for this site. Type to her below.";
  if (s.phase === "listening") return s.hold ? "Listening. Let go to send." : "Listening. She answers when you pause.";
  if (s.phase === "thinking") return "";
  if (s.phase === "speaking") return "";
  return fine ? "Hold to speak, or tap" : "Tap to speak";
}

function Bead({ s }: { s: AudienceState }) {
  const ref = useRef<HTMLButtonElement>(null);
  const down = useRef(0);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const el = ref.current;
      if (!el) return;
      el.style.setProperty("--mic", scene.mic.toFixed(3));
      el.style.setProperty("--her", scene.voice.toFixed(3));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  const onDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (audience.get().phase === "listening") {
      audience.release();
      return;
    }
    if (audience.busy()) {
      audience.refuseInterruption();
      return;
    }
    down.current = performance.now();
    void audience.listen(true);
  };
  const onUp = () => {
    if (!down.current) return;
    const held = performance.now() - down.current;
    down.current = 0;
    // a short press is a tap: keep listening, and answer at the pause
    if (held < 320) audience.tapMode();
    else audience.release();
  };
  return (
    <button
      ref={ref}
      type="button"
      className="aud-bead"
      data-phase={s.phase}
      aria-label={s.phase === "listening" ? "Send" : "Speak to her"}
      aria-pressed={s.phase === "listening"}
      onPointerDown={onDown}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && !e.repeat) {
          e.preventDefault();
          if (audience.get().phase === "listening") audience.release();
          else void audience.listen(false);
        }
      }}
    >
      <span className="aud-ring" aria-hidden />
      <svg viewBox="0 0 24 24" aria-hidden>
        <rect x="9" y="3.6" width="6" height="11" rx="3" />
        <path d="M5.8 11.4a6.2 6.2 0 0 0 12.4 0M12 17.6v2.8" />
      </svg>
    </button>
  );
}

function Typed() {
  const [q, setQ] = useState("");
  const send = (e: FormEvent) => {
    e.preventDefault();
    const t = q.trim();
    if (!t) return;
    // while she speaks your words wait in the box
    if (audience.busy()) {
      audience.refuseInterruption();
      return;
    }
    setQ("");
    void audience.ask(t);
  };
  return (
    <form className="aud-type" onSubmit={send}>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Or type to her" maxLength={400} aria-label="Type to her" enterKeyHint="send" />
    </form>
  );
}

/**
 * What she can do, as things to say: one press asks it. They change as the conversation goes, so a visitor sees that
 * she explains, shows, attacks, writes policies and reads the chain, and that she can take them anywhere on the page.
 */
const SUGGEST = [
  "Show me an attack",
  "How do you decide what to refuse?",
  "Take me to your family tree",
  "Write a policy that stops salami attacks",
  "Check the latest refusal",
  "Why does this need a blockchain?",
  "What can't you defend against?",
  "Show me who's allowed to do what",
  "Can attackers just read your rules?",
  "Let me attack you myself",
];
function Suggestions() {
  const [n, setN] = useState(0);
  const canReplay = useAudience((x) => x.canReplay);
  const shown = [0, 1, 2, 3].map((k) => SUGGEST[(n * 4 + k) % SUGGEST.length]);
  return (
    <div className="aud-suggest" role="group" aria-label="Things to ask her">
      {canReplay ? (
        <button type="button" className="aud-chip is-again" onClick={() => void audience.replay()}>
          Say that again
        </button>
      ) : null}
      {shown.map((t) => (
        <button
          key={t}
          type="button"
          className="aud-chip"
          onClick={() => {
            if (audience.busy()) {
              audience.refuseInterruption();
              return;
            }
            setN((x) => x + 1);
            void audience.ask(t);
          }}
        >
          {t}
        </button>
      ))}
    </div>
  );
}

export function Audience() {
  const s = useAudience((x) => x);
  const [fine, setFine] = useState(true);
  useEffect(() => setFine(window.matchMedia("(pointer: fine)").matches), []);

  // Q opens and closes; while open, Space held is the bead held; Esc ends the audience
  useEffect(() => {
    const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    let spaceHeld = false;
    const kd = (e: KeyboardEvent) => {
      if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const st = audience.get();
      if ((e.key === "q" || e.key === "Q") && !e.repeat) {
        if (st.open) audience.close();
        else void audience.open();
      } else if (st.open && e.key === "Escape") {
        audience.close();
      } else if (st.open && !st.mini && e.code === "Space" && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        if (!e.repeat && !spaceHeld) {
          spaceHeld = true;
          void audience.listen(true);
        }
      }
    };
    const ku = (e: KeyboardEvent) => {
      if (e.code === "Space" && spaceHeld) {
        spaceHeld = false;
        audience.release();
      }
    };
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    return () => {
      window.removeEventListener("keydown", kd);
      window.removeEventListener("keyup", ku);
    };
  }, []);

  return (
    <AnimatePresence>
      {s.open ? (
        <motion.section
          key="audience"
          className="aud"
          data-mini={s.mini || undefined}
          data-phase={s.phase}
          aria-label="An audience with the Red Queen"
          initial={{ opacity: 0 }}
          animate={{ opacity: s.closing ? 0 : 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.7, ease: EASE }}
        >
          <div className="aud-stack">
            <div className="aud-lines" aria-live="polite">
              <AnimatePresence mode="popLayout">
                {s.you && !s.mini ? (
                  <motion.p
                    key={s.you.id}
                    className="aud-you"
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, transition: { duration: 0.3 } }}
                    transition={{ duration: 0.5, ease: EASE }}
                  >
                    {s.you.text}
                  </motion.p>
                ) : null}
              </AnimatePresence>
              <AnimatePresence mode="wait">{s.her ? <Her key={s.her.id} c={s.her} /> : null}</AnimatePresence>
            </div>
            <AnimatePresence>{s.verdict ? <VerdictPane key="verdict" v={s.verdict} /> : s.card ? <QueenCard key={`card-${s.card}`} kind={s.card} /> : null}</AnimatePresence>
            <div className="aud-controls">
              <Bead s={s} />
              {s.mini ? (
                <>
                  {s.note ? <p className="aud-hint is-note">{s.note}</p> : null}
                  <button type="button" className="aud-face" onClick={() => audience.face()}>
                    Face her
                  </button>
                </>
              ) : (
                <div className="aud-side">
                  <p className={`aud-hint${s.note ? " is-note" : ""}`} aria-live="polite">
                    {hint(s, fine)}
                  </p>
                  <Typed />
                  <Suggestions />
                </div>
              )}
            </div>
          </div>
          <button type="button" className="aud-leave" onClick={() => audience.close()} aria-label="End the audience">
            <svg viewBox="0 0 24 24" aria-hidden>
              <path d="m7 7 10 10M17 7 7 17" />
            </svg>
          </button>
        </motion.section>
      ) : null}
    </AnimatePresence>
  );
}

/** The way in: a glass button, for the hero and the phone edition. */
export function SpeakButton({ className = "btn btn-quiet", children = "Speak to her" }: { className?: string; children?: string }) {
  return (
    <button type="button" className={className} onClick={() => void audience.open()}>
      {children}
    </button>
  );
}
