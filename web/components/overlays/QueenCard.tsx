"use client";
/**
 * The small live cards she can put beside her words: the latest request's eight measurements, how its score was
 * made, this round so far, and her recent bloodline. She only names the card; every number here is read from the
 * chain by the page, so a card can never show a figure she invented.
 */
import { motion } from "framer-motion";
import { explain, PAIR_NAMES } from "@redqueen/sdk";
import { useArena, liveGenes, type ArenaState, type SpendRow } from "@/lib/store";
import type { CardKind } from "@/lib/audience";

const EASE = [0.16, 1, 0.3, 1] as const;
const MEASURES = ["Size", "Stranger", "Speed", "Gap", "Reputation", "Via a contract", "To a contract", "Round outflow"];
const TERMS = [...MEASURES, ...PAIR_NAMES];
const LIMIT = 500_000;
const HOLD = 350_000;
const n = (x: number | bigint) => Number(x).toLocaleString("en-US");
const word = (r: SpendRow) => (r.verdict === 2 ? "refused" : r.verdict === 1 ? "held" : "paid");

function latest(s: ArenaState): SpendRow | undefined {
  return s.spends[s.spends.length - 1];
}

/** the genome that judged a payment: the install live before its round, else today's */
function genesFor(s: ArenaState, r: SpendRow): number[] {
  return [...s.installs].reverse().find((i) => i.epoch < r.epoch)?.genes ?? liveGenes(s);
}

function Measures({ r }: { r: SpendRow }) {
  return (
    <>
      <p className="qc-head">
        The latest request, measured <span className={`qc-tag is-${word(r)}`}>{word(r)}</span>
      </p>
      <ul className="qc-bars" aria-label="Eight measurements, each from 0 to 1,000">
        {MEASURES.map((m, i) => (
          <li key={m}>
            <span className="qc-label">{m}</span>
            <span className="qc-track">
              <span className="qc-fill" style={{ width: `${Math.min(100, (r.features[i] ?? 0) / 10)}%` }} />
            </span>
            <span className="qc-num">{n(r.features[i] ?? 0)}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

function Score({ r, genes }: { r: SpendRow; genes: number[] }) {
  const e = explain(genes, r.features);
  const terms = e.terms
    .map((t, i) => ({ name: TERMS[i], v: Number(t) }))
    .filter((t) => t.v !== 0)
    .sort((a, b) => Math.abs(b.v) - Math.abs(a.v))
    .slice(0, 5);
  const max = Math.max(LIMIT, ...terms.map((t) => Math.abs(t.v)));
  const score = Number(r.score);
  return (
    <>
      <p className="qc-head">
        How it scored {n(score)} <span className={`qc-tag is-${word(r)}`}>{word(r)}</span>
      </p>
      <ul className="qc-bars" aria-label="The biggest terms of the score">
        {terms.map((t) => (
          <li key={t.name}>
            <span className="qc-label">{t.name}</span>
            <span className="qc-track">
              <span className={`qc-fill${t.v < 0 ? " is-minus" : ""}`} style={{ width: `${((Math.abs(t.v) / max) * 100).toFixed(1)}%` }} />
            </span>
            <span className="qc-num">
              {t.v < 0 ? "−" : "+"}
              {n(Math.abs(t.v))}
            </span>
          </li>
        ))}
      </ul>
      <p className="qc-foot">
        Held over {n(HOLD)}, refused over {n(LIMIT)}.{r.reason >> 16n ? " A hard limit also applied." : ""}
      </p>
    </>
  );
}

function Round({ s }: { s: ArenaState }) {
  const epoch = s.snapshot?.epoch;
  const rows = epoch === undefined ? [] : s.spends.filter((r) => r.epoch === epoch);
  const count = (v: number) => rows.filter((r) => r.verdict === v).length;
  const strip = rows.slice(-16);
  return (
    <>
      <p className="qc-head">Round {epoch === undefined ? "" : n(epoch)} so far</p>
      <div className="qc-counts">
        <span>
          <b>{count(0)}</b> paid
        </span>
        <span className="is-held">
          <b>{count(1)}</b> held
        </span>
        <span className="is-refused">
          <b>{count(2)}</b> refused
        </span>
      </div>
      {strip.length ? (
        <div className="qc-strip" aria-label="The round's requests in order">
          {strip.map((r) => (
            <i key={r.id} className={`is-${word(r)}`} title={`${word(r)}, score ${n(r.score)}`} />
          ))}
        </div>
      ) : (
        <p className="qc-foot">Nobody has asked the vault for anything yet this round.</p>
      )}
    </>
  );
}

function Family({ s }: { s: ArenaState }) {
  const seen = new Set<string>();
  const champs = [...s.installs].reverse().filter((i) => (seen.has(i.id.toString()) ? false : (seen.add(i.id.toString()), true))).slice(0, 4);
  return (
    <>
      <p className="qc-head">My recent bloodline</p>
      <ol className="qc-tree">
        {champs.map((c, k) => (
          <li key={c.id.toString()} className={k === 0 ? "is-live" : undefined}>
            <b>Policy {c.id.toString()}</b>
            <span>
              generation {c.generation}
              {c.generation > 0 ? `, from ${c.parentA.toString()} × ${c.parentB.toString()}` : ", genesis"}
              {k === 0 ? ", wearing the crown" : ""}
            </span>
          </li>
        ))}
      </ol>
    </>
  );
}

export function QueenCard({ kind }: { kind: CardKind }) {
  const s = useArena((x) => x);
  const r = latest(s);
  let body: React.ReactNode = null;
  if (kind === "round") body = <Round s={s} />;
  else if (kind === "family") body = s.installs.length ? <Family s={s} /> : null;
  else if (r) body = kind === "measures" ? <Measures r={r} /> : <Score r={r} genes={genesFor(s, r)} />;
  if (!body) return null;
  return (
    <motion.div className="aud-verdict qc" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }} transition={{ duration: 0.6, ease: EASE }}>
      {body}
    </motion.div>
  );
}
