"use client";
/**
 * The three roles the hackathon guide asks for, each with the rule the contract enforces on it, tried live with
 * whatever wallet the visitor has:
 *
 *   admin          the Vault's owner appoints registrars; only a registrar can allow a wallet (`registerHonest`,
 *                  else `NotRegistrar`). The owner, or a guardian the owner appointed, may veto a held payment
 *                  (`veto`, else `NotGuardian`); once its wait is over anyone may release it (`release`)
 *   operator       an allowed wallet, or an attacker staked for the round, asks the vault for money (`spend`, else
 *                  `NotParticipant`); the live rule judges every request and a refusal is recorded
 *   public reader  no wallet: paste a transaction and read its verdict from the chain
 *
 * A wrong wallet is refused when the transaction is checked against the live chain, before the wallet is asked to
 * sign, so nothing is sent and nothing is spent. No camera stop of its own: the stage holds where the bets left it.
 */
import { useEffect, useMemo, useState } from "react";
import { useAccount, usePublicClient } from "wagmi";
import { decodeEventLog, isAddress, type Address, type Hex } from "viem";
import { arenaAbi, crucibleAbi, GLOBAL_THRESHOLD, HOLD_THRESHOLD, PROPOSAL_VERDICTS, vaultAbi, verdictOf } from "@redqueen/sdk";
import { arena, holdLive, useArena, useTicker, type HoldRow } from "@/lib/store";
import { explorerAddress, explorerTx } from "@/lib/config";
import { count, ethWords, holdWords, reasonLine } from "@/lib/words";
import { short } from "@/lib/format";
import { plainError } from "@/lib/errors";
import { Drift, Reveal } from "../ui/primitives";
import { useRedQueen } from "../ui/Wallet";

type Result = { tone: "hot" | "cold" | "held" | "ivory"; text: string; tx?: string } | null;

const errText = (e: unknown) => {
  const x = e as { shortMessage?: string; message?: string; cause?: { data?: { errorName?: string } } };
  return [x?.cause?.data?.errorName, x?.shortMessage, x?.message].filter(Boolean).join(" ");
};

function Line({ r }: { r: Result }) {
  const d = useArena((s) => s.deployment);
  if (!r) return null;
  const color = r.tone === "hot" ? "text-hot" : r.tone === "cold" ? "text-cold" : r.tone === "held" ? "text-held" : "text-ivory-2";
  return (
    <p className={`mt-4 text-[0.95rem] leading-snug ${color}`} role="status" aria-live="polite">
      {r.text}
      {r.tx ? (
        <>
          {" "}
          <a className="link whitespace-nowrap text-ivory" href={explorerTx(d, r.tx) ?? "#"} target="_blank" rel="noreferrer">
            On Basescan ↗
          </a>
        </>
      ) : null}
    </p>
  );
}

function Role({ n, who, rule, children }: { n: string; who: string; rule: string; children: React.ReactNode }) {
  return (
    <article className="panel flex flex-col rounded-[28px] p-7">
      <p className="caption">{n}</p>
      <h3 className="mt-2 text-[1.45rem] leading-tight">{who}</h3>
      <p className="body mt-3">{rule}</p>
      <div className="pt-7">{children}</div>
    </article>
  );
}

const field = "hash h-12 w-full rounded-full border border-line bg-transparent px-5 text-[0.92rem] text-ivory outline-none placeholder:text-ivory-3 focus:border-ivory";

// ---------------------------------------------------------------- the admin
function Admin() {
  const d = useArena((s) => s.deployment);
  const pub = usePublicClient();
  const rq = useRedQueen();
  const { address, isConnected } = useAccount();
  const [owner, setOwner] = useState<Address | null>(null);
  const [registrar, setRegistrar] = useState<boolean | null>(null);
  const [who, setWho] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Result>(null);
  const vault = d?.contracts.vault as Address | undefined;
  useEffect(() => {
    if (!pub || !vault) return;
    pub.readContract({ address: vault, abi: vaultAbi, functionName: "owner" }).then((o) => setOwner(o as Address)).catch(() => {});
  }, [pub, vault]);
  // the queen fills it in with an address the visitor gave her; the visitor presses it
  useEffect(() => {
    const on = (e: Event) => {
      const a = String((e as CustomEvent).detail ?? "");
      if (isAddress(a)) {
        setWho(a);
        setRes({ tone: "ivory", text: "Filled in. Press it: only a registrar's wallet can complete it, and the contract refuses any other." });
      }
    };
    window.addEventListener("rq:allow", on);
    return () => window.removeEventListener("rq:allow", on);
  }, []);
  useEffect(() => {
    setRegistrar(null);
    if (!pub || !vault || !address) return;
    pub.readContract({ address: vault, abi: vaultAbi, functionName: "isRegistrar", args: [address] }).then((r) => setRegistrar(Boolean(r))).catch(() => {});
  }, [pub, vault, address]);
  const allow = async () => {
    if (!rq || !isAddress(who.trim())) return setRes({ tone: "ivory", text: "Paste a wallet address first: 0x and 40 characters." });
    setBusy(true);
    setRes(null);
    try {
      const tx = await rq.registerHonest(who.trim() as Address);
      setRes({ tone: "cold", text: `Allowed. ${short(who.trim())} may now ask the vault for payments.`, tx });
    } catch (e) {
      if (/NotRegistrar/.test(errText(e)))
        setRes({ tone: "hot", text: "Refused by the contract: only a registrar the admin appointed can allow a wallet. Nothing was sent." });
      else setRes({ tone: "ivory", text: plainError(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Role
      n="Admin"
      who="Decides who is allowed"
      rule="The vault's owner appoints registrars and guardians. Only a registrar can allow a wallet to ask the vault for payments, and only the owner or a guardian can veto a held one."
    >
      <p className="caption">
        The admin:{" "}
        {owner ? (
          <a className="hash link text-ivory" href={explorerAddress(d, owner) ?? "#"} target="_blank" rel="noreferrer">
            {short(owner)}
          </a>
        ) : (
          "…"
        )}
        {isConnected && registrar !== null ? <span> · your wallet {registrar ? "is a registrar" : "is not a registrar"}</span> : null}
      </p>
      <label className="mt-4 flex flex-col gap-2">
        <span className="caption">Wallet to allow</span>
        <input className={field} value={who} onChange={(e) => setWho(e.target.value)} placeholder="0x…" spellCheck={false} autoComplete="off" />
      </label>
      {isConnected ? (
        <button className="btn btn-quiet mt-4" onClick={allow} disabled={busy}>
          {busy ? "Checking with the contract…" : "Allow this wallet"}
        </button>
      ) : (
        <p className="caption mt-4">Connect a wallet at the top to try it.</p>
      )}
      <Line r={res} />
    </Role>
  );
}

// ---------------------------------------------------------------- the operator
function Operator() {
  const d = useArena((s) => s.deployment);
  const snap = useArena((s) => s.snapshot);
  const pub = usePublicClient();
  const rq = useRedQueen();
  const { address, isConnected } = useAccount();
  const [standing, setStanding] = useState<"allowed" | "staked" | "neither" | null>(null);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Result>(null);
  const vault = d?.contracts.vault as Address | undefined;
  useEffect(() => {
    setStanding(null);
    if (!pub || !vault || !address || !rq) return;
    Promise.all([pub.readContract({ address: vault, abi: vaultAbi, functionName: "isHonest", args: [address] }), rq.hasAttack(address)])
      .then(([honest, staked]) => setStanding(honest ? "allowed" : staked ? "staked" : "neither"))
      .catch(() => {});
  }, [pub, vault, address, rq, res]);
  useEffect(() => {
    const on = () => setRes({ tone: "ivory", text: "Press it when you're ready: your wallet signs, and the contract decides." });
    window.addEventListener("rq:ask", on);
    return () => window.removeEventListener("rq:ask", on);
  }, []);
  const ask = async () => {
    if (!rq || !address) return;
    setBusy(true);
    setRes(null);
    try {
      const amount = (await rq.vaultAvailable()) / 100n;
      const out = await rq.spend({ to: address, amount, label: standing === "allowed" ? "honest" : "attack" });
      if (out.refused)
        setRes({ tone: "hot", text: `Refused: ${reasonLine(out.reason) || "over the limit"}. Score ${count(out.score)} against a limit of ${count(GLOBAL_THRESHOLD)}; nothing moved.`, tx: out.hash });
      else if (out.held)
        setRes({
          tone: "held",
          text: `Held: score ${count(out.score)}, past ${count(HOLD_THRESHOLD)}. It waits about a minute; the owner or a guardian may cancel it; then anyone can pay it out.`,
          tx: out.hash,
        });
      else setRes({ tone: "cold", text: `Paid ${ethWords(amount, 6)} test ETH to you, and recorded.`, tx: out.hash });
    } catch (e) {
      if (/NotParticipant/.test(errText(e)))
        setRes({ tone: "hot", text: "Refused by the contract: only a wallet a registrar allowed, or an attacker who staked for this round, may ask. Nothing was sent." });
      else setRes({ tone: "ivory", text: plainError(e) });
    } finally {
      setBusy(false);
    }
  };
  const bal = snap?.vaultBalance;
  return (
    <Role
      n="Operator"
      who="Asks the vault for money"
      rule="An allowed wallet, or an attacker who staked for the round, can ask for a payment. The live rule judges every request; close to the limit, the payment is held; over it, nothing moves and the refusal is recorded."
    >
      <p className="caption">
        The vault holds {bal !== undefined ? `${ethWords(bal, 4)} test ETH` : "…"}
        {isConnected && standing ? (
          <span>
            {" "}
            · your wallet is {standing === "allowed" ? "allowed" : standing === "staked" ? "staked for this round" : "neither allowed nor staked"}
          </span>
        ) : null}
      </p>
      {isConnected ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button className="btn btn-quiet" onClick={ask} disabled={busy || !rq}>
            {busy ? "Waiting for the verdict…" : "Ask for 1% of the vault"}
          </button>
          <a href="#try" className="link caption text-ivory">
            Or try to drain her
          </a>
        </div>
      ) : (
        <p className="caption mt-4">Connect a wallet at the top to try it.</p>
      )}
      <Line r={res} />
    </Role>
  );
}

// ---------------------------------------------------------------- the public reader
function Reader() {
  const d = useArena((s) => s.deployment);
  const snap = useArena((s) => s.snapshot);
  const spends = useArena((s) => s.spends);
  const installs = useArena((s) => s.installs);
  const pub = usePublicClient();
  const [hash, setHash] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Result>(null);
  const latestRefusal = [...spends].reverse().find((s) => s.refused)?.txHash;
  const check = async (h0?: string) => {
    const h = (h0 ?? hash).trim();
    if (h0) setHash(h0);
    if (!pub || !d) return;
    if (!/^0x[0-9a-fA-F]{64}$/.test(h)) return setRes({ tone: "ivory", text: "Paste a transaction hash: 0x and 64 characters." });
    setBusy(true);
    setRes(null);
    try {
      const rc = await pub.getTransactionReceipt({ hash: h as Hex });
      const lines: Result[] = [];
      for (const log of rc.logs) {
        const at = log.address.toLowerCase();
        try {
          if (at === d.contracts.vault.toLowerCase()) {
            const ev = decodeEventLog({ abi: vaultAbi, data: log.data, topics: log.topics });
            if (ev.eventName === "Spend") {
              const a = ev.args as unknown as { caller: string; amount: bigint; refused: boolean; reason: bigint; score: bigint; epoch: bigint; verdict?: number };
              const v = verdictOf(a);
              lines.push(
                v === 2
                  ? { tone: "hot", text: `Refused. ${short(a.caller)} asked for ${ethWords(a.amount, 5)} test ETH in round ${a.epoch}; the rule scored it ${count(a.score)} against a limit of ${count(GLOBAL_THRESHOLD)} (${reasonLine(a.reason) || "over the limit"}). Nothing moved.` }
                  : v === 1
                    ? {
                        tone: "held",
                        text: `Held. ${short(a.caller)} asked for ${ethWords(a.amount, 5)} test ETH in round ${a.epoch}; the rule scored it ${count(a.score)}, past ${count(HOLD_THRESHOLD)} and under the limit of ${count(GLOBAL_THRESHOLD)} (${reasonLine(a.reason) || "close to the limit"}). It waits about a minute; the owner or a guardian may cancel it; then anyone can pay it out.`,
                      }
                    : { tone: "cold", text: `Paid. ${short(a.caller)} asked for ${ethWords(a.amount, 5)} test ETH in round ${a.epoch}; the rule scored it ${count(a.score)}, under the limit of ${count(GLOBAL_THRESHOLD)}.` }
              );
            }
            if (ev.eventName === "Released") {
              const a = ev.args as unknown as { id: bigint; by: string };
              lines.push({ tone: "cold", text: `Held payment ${a.id} was paid out by ${short(a.by)} once its wait was over.` });
            }
            if (ev.eventName === "Vetoed") {
              const a = ev.args as unknown as { id: bigint; by: string };
              lines.push({ tone: "ivory", text: `Held payment ${a.id} was vetoed by ${short(a.by)}. The money stayed in the vault.` });
            }
            if (ev.eventName === "HonestRegistered") lines.push({ tone: "cold", text: `A registrar allowed ${short(String((ev.args as unknown as { who: string }).who))} to ask the vault for payments.` });
          } else if (at === d.contracts.arena.toLowerCase()) {
            const ev = decodeEventLog({ abi: arenaAbi, data: log.data, topics: log.topics });
            if (ev.eventName === "PolicyInstalled") {
              const a = ev.args as unknown as { id: bigint; epoch: bigint; generation: bigint };
              lines.push({ tone: "cold", text: `At the close of round ${a.epoch}, the contract installed policy ${a.id} (generation ${a.generation}) as the live rule: a new entry, nothing edited.` });
            }
          } else if (d.contracts.crucible && at === String(d.contracts.crucible).toLowerCase()) {
            const ev = decodeEventLog({ abi: crucibleAbi, data: log.data, topics: log.topics });
            if (ev.eventName === "Proposed") {
              const a = ev.args as unknown as { proposer: string; verdict: number };
              const v = PROPOSAL_VERDICTS[Number(a.verdict)] ?? "judged";
              lines.push({ tone: Number(a.verdict) === 0 ? "cold" : "hot", text: Number(a.verdict) === 0 ? `A policy from ${short(a.proposer)} was accepted into the pool.` : `A policy from ${short(a.proposer)} was refused: ${v}.` });
            }
          }
        } catch {
          /* an event this page doesn't describe */
        }
      }
      const first = lines.find((l) => l && l.tone !== "ivory") ?? lines[0];
      setRes(first ? { ...first, tx: h } : { tone: "ivory", text: "That transaction isn't a payment request, a held payment, a new rule or a proposal in this arena.", tx: h });
    } catch {
      setRes({ tone: "ivory", text: "No such transaction on Base Sepolia yet. Check the hash, or wait a moment if it was just sent." });
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    const on = (e: Event) => {
      const h = String((e as CustomEvent).detail ?? "");
      const target = h === "latest" ? [...arena.get().spends].reverse().find((x) => x.refused)?.txHash : h;
      if (target) void check(target);
    };
    window.addEventListener("rq:check", on);
    return () => window.removeEventListener("rq:check", on);
  });
  const generations = new Set(installs.map((i) => i.id.toString())).size;
  return (
    <Role n="Public reader" who="Checks any of it, no wallet" rule="Paste a transaction and read its verdict straight from the chain. No wallet, no account, and nothing to take on trust.">
      <p className="caption">
        {snap ? `${count(snap.totalSpends)} requests judged, ${count(snap.totalRefused)} refused${snap.heldCount ? `, ${count(snap.heldCount)} held` : ""}` : "…"}
        {generations ? `, ${count(generations)} ${generations === 1 ? "rule has" : "different rules have"} been live` : ""}
      </p>
      <label className="mt-4 flex flex-col gap-2">
        <span className="caption">Transaction hash</span>
        <input className={field} value={hash} onChange={(e) => setHash(e.target.value)} placeholder="0x…" spellCheck={false} autoComplete="off" />
      </label>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button className="btn btn-quiet" onClick={() => check()} disabled={busy}>
          {busy ? "Reading the chain…" : "Check it"}
        </button>
        {latestRefusal ? (
          <button className="link caption text-ivory" onClick={() => check(latestRefusal)}>
            Use the latest refusal
          </button>
        ) : null}
      </div>
      <Line r={res} />
    </Role>
  );
}


// ---------------------------------------------------------------- held payments
/**
 * Payments the live rule held: each waits HOLD_DELAY blocks (about a minute on Base), counted down here from the chain's
 * block. Release pays one out once its wait is over, from any wallet; veto cancels one, and the contract takes it only
 * from the vault's owner or a guardian, so anyone else's veto is refused, as the admin's "Allow this wallet" is.
 */
export function HeldPayments({ compact = false }: { compact?: boolean }) {
  const d = useArena((s) => s.deployment);
  const holds = useArena((s) => s.holds);
  const clock = useArena((s) => s.clock);
  const pub = usePublicClient();
  const rq = useRedQueen();
  const { address, isConnected } = useAccount();
  const [owner, setOwner] = useState<Address | null>(null);
  const [guardian, setGuardian] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [res, setRes] = useState<Result>(null);
  const vault = d?.contracts.vault as Address | undefined;
  const all = useMemo(() => [...holds.values()].sort((a, b) => (a.id < b.id ? 1 : -1)), [holds]);
  const open = all.filter((h) => !h.settled);
  // the open ones, then the last few that ended (so a release or a veto shows how it ended)
  const rows: HoldRow[] = [...open, ...all.filter((h) => h.settled).slice(0, compact ? 2 : 3)].slice(0, compact ? 5 : 8);
  const now = useTicker(1000, open.length > 0);
  useEffect(() => {
    if (!pub || !vault) return;
    pub.readContract({ address: vault, abi: vaultAbi, functionName: "owner" }).then((o) => setOwner(o as Address)).catch(() => {});
  }, [pub, vault]);
  useEffect(() => {
    setGuardian(null);
    if (!pub || !vault || !address) return;
    pub.readContract({ address: vault, abi: vaultAbi, functionName: "isGuardian", args: [address] }).then((r) => setGuardian(Boolean(r))).catch(() => {});
  }, [pub, vault, address]);
  const isOwner = !!owner && !!address && owner.toLowerCase() === address.toLowerCase();
  const act = async (h: HoldRow, what: "release" | "veto") => {
    if (!rq) return;
    setBusy(`${h.id}:${what}`);
    setRes(null);
    try {
      const tx = what === "release" ? await rq.release(h.id) : await rq.veto(h.id);
      setRes(
        what === "release"
          ? { tone: "cold", text: `Released. ${ethWords(h.amount, 6)} test ETH went to ${short(h.to)}.`, tx }
          : { tone: "cold", text: `Vetoed. The ${ethWords(h.amount, 6)} test ETH stays in the vault.`, tx },
      );
    } catch (e) {
      if (/NotGuardian/.test(errText(e))) setRes({ tone: "hot", text: `${plainError(e, 160)} Nothing was sent.` });
      else if (/TooEarly/.test(errText(e))) setRes({ tone: "hot", text: `${plainError(e, 160)} Nothing was sent.` });
      else setRes({ tone: "ivory", text: plainError(e) });
    } finally {
      setBusy(null);
    }
  };
  const list = (
    <ol aria-label="Held payments, newest first" className={compact ? "mt-4" : ""}>
      {rows.length ? (
        rows.map((h) => {
          const live = holdLive(h, clock, now);
          const settled = live.status === "released" || live.status === "vetoed";
          return (
            <li key={h.id.toString()} className={`grid items-center gap-x-4 gap-y-2 border-t border-line py-3 first:border-t-0 ${compact ? "grid-cols-1" : "grid-cols-[minmax(0,1fr)_auto]"}`}>
              <span className="text-[0.95rem]">
                <span className={settled ? (live.status === "released" ? "text-ivory" : "text-ivory-2") : "text-held"}>
                  {ethWords(h.amount, 5)} ETH, {holdWords(live)}
                </span>
                <span className="caption ml-2 font-sans">
                  #{h.id.toString()} · {short(h.from)} to {short(h.to)}
                  {settled && h.by ? ` · by ${short(h.by)}` : ` · release from block ${count(h.releaseBlock)}`}
                </span>
              </span>
              {settled ? (
                <a href={explorerTx(d, h.settledTx ?? h.txHash) ?? "#"} target="_blank" rel="noreferrer" aria-label="Open in the explorer" className={`text-ivory-3 transition-colors hover:text-ivory ${compact ? "hidden" : ""}`}>
                  ↗
                </a>
              ) : isConnected ? (
                <span className="flex items-center gap-2">
                  <button className="btn btn-quiet" onClick={() => act(h, "release")} disabled={!!busy || !rq || live.status !== "releasable"}>
                    {busy === `${h.id}:release` ? "Releasing…" : "Release"}
                  </button>
                  <button className="btn btn-quiet" onClick={() => act(h, "veto")} disabled={!!busy || !rq}>
                    {busy === `${h.id}:veto` ? "Checking with the contract…" : "Veto"}
                  </button>
                </span>
              ) : (
                <a href={explorerTx(d, h.txHash) ?? "#"} target="_blank" rel="noreferrer" aria-label="Open in the explorer" className={`text-ivory-3 transition-colors hover:text-ivory ${compact ? "hidden" : ""}`}>
                  ↗
                </a>
              )}
            </li>
          );
        })
      ) : (
        <li className="caption">Nothing is held right now. A payment that scores between {count(HOLD_THRESHOLD)} and {count(GLOBAL_THRESHOLD)} waits here.</li>
      )}
    </ol>
  );
  const who = (
    <p className="caption">
      The admin:{" "}
      {owner ? (
        <a className="hash link text-ivory" href={explorerAddress(d, owner) ?? "#"} target="_blank" rel="noreferrer">
          {short(owner)}
        </a>
      ) : (
        "…"
      )}
      {isConnected && guardian !== null ? <span> · your wallet {isOwner ? "is the admin" : guardian ? "is a guardian" : "is neither the admin nor a guardian"}</span> : null}
    </p>
  );
  if (compact)
    return (
      <div>
        <h2 className="display-m">Held payments.</h2>
        <p className="body mt-3 text-[0.95rem]">Close to her limit, a payment waits about a minute. The owner or a guardian may cancel it; then anyone can pay it out.</p>
        {list}
        {!isConnected && rows.some((h) => !h.settled) ? <p className="caption mt-3">Connect a wallet to release or veto one.</p> : null}
        <Line r={res} />
      </div>
    );
  return (
    <div className="panel col-span-12 rounded-[28px] p-7">
      <div className="grid gap-6 lg:grid-cols-3">
        <div>
          <p className="caption">The admin's new job</p>
          <h3 className="mt-2 text-[1.45rem] leading-tight">Vetoes a held payment</h3>
          <p className="body mt-3">
            A payment that scores past {count(HOLD_THRESHOLD)}, but not past her limit, is held. It waits about a minute; the owner or a guardian may cancel it; then anyone can pay it out.
          </p>
          <div className="mt-5">{who}</div>
          {!isConnected ? <p className="caption mt-3">Connect a wallet at the top to try it.</p> : null}
        </div>
        <div className="lg:col-span-2">
          {list}
          <Line r={res} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- rule authors
/** The Crucible's verdicts on proposed policies (her own included), newest first. */
function RuleAuthors() {
  const d = useArena((s) => s.deployment);
  const proposals = useArena((s) => s.proposals);
  const rows = proposals.slice(-5).reverse();
  const pct = (ppm: bigint) => `${(Number(ppm < 0n ? -ppm : ppm) / 10_000).toFixed(1)}%`;
  return (
    <div className="panel col-span-12 rounded-[28px] p-7">
      <div className="grid gap-6 lg:grid-cols-3">
        <div>
          <p className="caption">And anyone can be a rule author</p>
          <h3 className="mt-2 text-[1.45rem] leading-tight">Proposes a better rule</h3>
          <p className="body mt-3">
            The Crucible plays a proposed policy against the attackers' plans and a bench of honest payments, on chain. It refuses one that would block an honest payment, or that loses more than the live rule. Ask her to write one.
          </p>
        </div>
        <ol className="lg:col-span-2" aria-label="Proposals the chain judged, newest first">
          {rows.length ? (
            rows.map((r) => (
              <li key={r.txHash} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-4 border-t border-line py-3 first:border-t-0">
                <span className={`text-[0.95rem] ${r.verdict === 0 ? "text-cold" : "text-ivory"}`}>
                  {r.verdict === 0
                    ? `Accepted into the pool as policy ${r.id}. Attackers would take ${pct(r.lost)} under it.`
                    : r.verdict === 1
                      ? `Refused: it would block ${r.honestRefused} honest ${r.honestRefused === 1n ? "payment" : "payments"}.`
                      : r.verdict === 2
                        ? `Refused: attackers would take ${pct(r.lost)} of the vault under it, ${pct(r.championFitness)} under the live rule.`
                        : `Refused: ${PROPOSAL_VERDICTS[r.verdict] ?? "judged"}.`}
                  <span className="caption ml-2 font-sans">
                    {short(r.proposer)}, round {r.epoch.toString()}
                  </span>
                </span>
                <a href={explorerTx(d, r.txHash) ?? "#"} target="_blank" rel="noreferrer" aria-label="Open in the explorer" className="text-ivory-3 transition-colors hover:text-ivory">
                  ↗
                </a>
              </li>
            ))
          ) : (
            <li className="caption">No proposals yet. Ask her to write a policy, and the chain's verdict appears here.</li>
          )}
        </ol>
      </div>
    </div>
  );
}

export function RolesSection() {
  return (
    <section id="roles" className="relative min-h-[100svh] px-[var(--gutter)] py-32">
      <div className="grid-12 !px-0 gap-y-12">
        <div className="col-span-12 lg:col-span-7">
          <Reveal lines={["Three roles.", "The contract refuses each."]} className="display-l" />
          <Drift>
            <p className="body mt-6 max-w-[52ch]">
              These rules live in the Vault, not on this page. Try each one with the wallet you have: a wallet without the right role is turned away by the contract itself, checked against the live chain before anything is signed.
            </p>
          </Drift>
        </div>
        <div className="col-span-12 grid items-start gap-5 lg:grid-cols-3">
          <Admin />
          <Operator />
          <Reader />
        </div>
        <HeldPayments />
        <RuleAuthors />
      </div>
    </section>
  );
}
