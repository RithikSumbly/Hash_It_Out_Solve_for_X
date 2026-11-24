"""
The chain, as the Red Queen sees it: live numbers for her answers, and her attack tool.

`snapshot()` reads Base Sepolia directly (the vault's balance and counters, the round, the latest verdicts), so
every figure she says comes from the chain at that moment, never from the visitor's browser.

`attack(...)` sends the attack a visitor describes, from her own test wallet: a payment out of the vault of some
share of its balance, once or a few times in quick succession, to her wallet or to a fresh address. The contract
decides; she reports what it decided. There are three verdicts: paid, held, refused. Anything paid is sent straight back
into the vault, so a demo never costs it anything (a fresh address is one she derives and holds the key to). Anything
held moves nothing for HOLD_DELAY blocks (about a minute); the owner or a guardian may veto it in that time, then
anyone may release it. Her keeper releases her own held payments once they are due and puts the money back. She is
not a guardian and never touches anyone else's hold.

QUEEN_DEPLOYMENT (optional) points at another deployment file than deployment.json, e.g. a local test chain's.
"""

from __future__ import annotations

import calendar
import json
import os
import re
import secrets
import threading
import time
from pathlib import Path

from eth_account import Account
from web3 import Web3
from web3.logs import DISCARD

HERE = Path(__file__).parent
RPC = os.environ.get("RPC_URL", "https://sepolia.base.org")
LIMIT = 500_000  # the global threshold (sdk/src/genome.ts GLOBAL_THRESHOLD): over it, refused
HOLD_LINE = 350_000  # Vault.HOLD_SCORE: over it (and not over LIMIT), held
HOLD_DELAY = 300  # Vault.HOLD_DELAY: blocks a held payment waits (about a minute at Base Sepolia's 0.2 s blocks)
VERDICT_PAID, VERDICT_HELD, VERDICT_REFUSED = 0, 1, 2  # Spend.verdict
VERDICT_WORDS = ["paid", "held", "refused"]
LABEL_ATTACK = 2
KIND_PAY = 0
REASONS = [
    "too large", "unknown recipient", "too fast", "odd timing", "reputation", "sent through a contract",
    "paid to a contract", "vault already draining", "large, to a stranger", "large while draining",
    "burst to strangers", "salami slicing", "contract hop", "delegated drain", "rapid repeats", "contract sink",
]


def reasons(mask: int) -> list[str]:
    out = [REASONS[i] for i in range(16) if (mask >> i) & 1]
    if (mask >> 16) & 1:  # the vault's own hard limits, which no evolved rule can lift
        out.append("over the hard cap of half the vault in one payment")
    if (mask >> 17) & 1:
        out.append("over the hard cap of half the round's balance out")
    if (mask >> 18) & 1:  # the tighter limits for a wallet with an attack staked this round
        out.append("over an attacker's cap of a tenth of the vault in one payment")
    if (mask >> 19) & 1:
        out.append("over the attackers' cap of a fifth of the round's balance out")
    if (mask >> 20) & 1:
        out.append("an attacker's payment is refused where others would be held")
    return out


def _load():
    d = json.loads(Path(os.environ.get("QUEEN_DEPLOYMENT") or HERE / "deployment.json").read_text())
    abi = {n: json.loads((HERE / "abi" / f"{n}.json").read_text()) for n in ("vault", "arena", "firewall", "crucible")}
    return d, abi


D, ABI = _load()
w3 = Web3(Web3.HTTPProvider(RPC, request_kwargs={"timeout": 12}))
VAULT = w3.eth.contract(address=Web3.to_checksum_address(D["contracts"]["vault"]), abi=ABI["vault"])
ARENA = w3.eth.contract(address=Web3.to_checksum_address(D["contracts"]["arena"]), abi=ABI["arena"])
FIREWALL = w3.eth.contract(address=Web3.to_checksum_address(D["contracts"]["firewall"]), abi=ABI["firewall"])
CRUCIBLE = w3.eth.contract(address=Web3.to_checksum_address(D["contracts"]["crucible"]), abi=ABI["crucible"])
VERDICTS = ["accepted", "refuses an honest payment", "weaker than the live champion", "already proposed this round",
            "the pool is full", "lets a drain canary through", "not monotone: a bigger or later payment could score lower"]  # Crucible.Proposed.verdict (sdk/src/v2.ts PROPOSAL_VERDICTS)


def pack(genes: list[int]) -> tuple[int, int]:
    """32 genes as the chain stores them: 16 signed 16-bit values per word, gene i at bits 16·i (sdk genome.pack)."""
    g = [max(-32768, min(32767, int(x))) for x in (list(genes) + [0] * 32)[:32]]
    words = [0, 0]
    for i, x in enumerate(g):
        words[i // 16] |= (x & 0xFFFF) << (16 * (i % 16))
    return words[0], words[1]


def unpack(lo: int, hi: int) -> list[int]:
    out = []
    for w in (lo, hi):
        for i in range(16):
            x = (w >> (16 * i)) & 0xFFFF
            out.append(x - 0x10000 if x >= 0x8000 else x)
    return out
EXPLORER = D.get("explorer", "")
ERRORS = json.loads((HERE / "abi" / "errors.json").read_text())  # custom error selector -> name, for the log
# The attack plan she files with the Arena each round, as every attacker must before the vault will judge its
# payments: the SDK's "drain" preset (one step, 40% of the vault, to herself, direct). 32 genes, 4 per step.
DRAIN = [4000, 0, 0, 0] + [0] * 28


def eth(wei: int) -> str:
    """0.004 rather than 4000000000000000"""
    return f"{wei / 1e18:.6f}".rstrip("0").rstrip(".") or "0"


# ------------------------------------------------------------------------------------------------- reading
_snap = {"at": 0.0, "data": {}}
_snap_lock = threading.Lock()


# Event history: the public endpoint allows only 200 blocks a query, and Base makes a block every 0.2 s, so logs come
# from gateways that take wide ranges (checked 21 Nov 2026), best first, with the span each accepts.
LOG_SOURCES = [(u, span) for u, span in (
    (os.environ.get("LOGS_RPC_URL", ""), 49_000),
    *((("https://base-sepolia.gateway.tenderly.co", 250_000), ("https://base-sepolia-rpc.publicnode.com", 49_000))
      if int(D["chainId"]) == 84532 else ()),  # Base Sepolia's gateways only for Base Sepolia (not a local test chain)
) if u]
_log_vaults = [(Web3(Web3.HTTPProvider(u, request_kwargs={"timeout": 12})), span) for u, span in LOG_SOURCES]
LOOKBACK = 500_000  # about a day of blocks


def _recent_verdicts(head: int, n: int = 5) -> list[dict]:
    lo = max(int(D.get("deployBlock", 0)), head - LOOKBACK)
    for w, span in _log_vaults:
        vault = w.eth.contract(address=VAULT.address, abi=ABI["vault"])
        out = []
        try:
            for end in range(head, lo, -span):  # newest first
                logs = vault.events.Spend().get_logs(from_block=max(lo, end - span + 1), to_block=end)
                for e in reversed(logs):
                    a = e["args"]
                    out.append({
                        "block": e["blockNumber"],
                        "verdict": VERDICT_WORDS[int(a["verdict"])] if int(a["verdict"]) < 3 else str(a["verdict"]),
                        "refused": bool(a["refused"]),
                        "amount_eth": eth(a["amount"]),
                        "score": int(a["score"]),
                        "limit": LIMIT,
                        "reasons": " and ".join(reasons(int(a["reason"]))) or "none",
                        "caller": a["caller"][:6] + "…" + a["caller"][-4:],
                    })
                    if len(out) >= n:
                        return out
            return out
        except Exception:
            continue  # this gateway refused: the next one
    return []


def snapshot(max_age: float = 4.0) -> dict:
    """The arena right now (cached a few seconds: many visitors asking at once read the chain once)."""
    with _snap_lock:
        if time.time() - _snap["at"] < max_age and _snap["data"]:
            return _snap["data"]
    try:
        head = w3.eth.block_number
        st = ARENA.functions.status().call()
        lo, hi, gid, installs = FIREWALL.functions.exportGenome().call()
        genes = unpack(int(lo), int(hi))
        data = {
            "network": "base sepolia (test network, test ether with no real value)",
            "block": head,
            # what the vault can pay (its balance minus the held payments it has reserved)
            "vault_balance_eth": eth(VAULT.functions.balance().call()),
            "held_payments_waiting_eth": eth(VAULT.functions.heldTotal().call()),
            "payments_judged": int(VAULT.functions.totalSpends().call()),
            "payments_refused": int(VAULT.functions.totalRefused().call()),
            "payments_held_ever": int(VAULT.functions.heldCount().call()),
            "total_paid_out_eth": eth(VAULT.functions.totalOutflow().call()),
            "round": int(st[0]),
            "round_closes_with_the_next_move_after_block": int(st[2]),
            "blocks_until_the_round_can_close": max(0, int(st[2]) - head),
            "live_policy": int(gid),
            "live_weights_f0_to_f7": genes[0:8],
            "live_pattern_weights_k0_to_k7": genes[8:16],
            "live_thresholds_t0_to_t7": genes[16:24],
            "challengers": int(st[5]),
            "attack_plans": int(st[6]),
            "generation": int(installs),
            "refusal_limit": LIMIT,
            "hold_line": HOLD_LINE,
            "hold_delay_blocks": HOLD_DELAY,
            "latest_verdicts": _recent_verdicts(head),
        }
    except Exception as e:  # the chain is unreachable: she says so instead of guessing
        data = {"unavailable": "the chain could not be read just now", "error": str(e)[:80].lower().replace("'", "")}
    with _snap_lock:
        _snap.update(at=time.time(), data=data)
    return data


# ------------------------------------------------------------------------------------------------ attacking
_attack_lock = threading.Lock()
_last_attack = {"at": 0.0}


def _key() -> str:
    k = os.environ.get("DEMO_PRIVATE_KEY", "")
    if not k:
        raise RuntimeError("no attack wallet is configured")
    return k if k.startswith("0x") else "0x" + k


def _fresh(i: int):
    """A 'stranger' she controls: a key derived from hers, so anything sent there can be swept back."""
    seed = Web3.keccak(text=f"{_key()}:fresh:{i}")
    return Account.from_key(seed)


_nonce_lock = threading.Lock()  # her attack, her proposal and the round keeper share one wallet: one nonce at a time
# the next nonce each key may use. A load-balanced RPC can answer a stale "pending" count right after a send, and a
# reused nonce fails, which would leave a passed slice of the vault in her wallet
_next_nonce: dict = {}


def _send(acct, fn=None, to=None, value=0) -> dict:
    with _nonce_lock:
        nonce = max(w3.eth.get_transaction_count(acct.address, "pending"), _next_nonce.get(acct.address, 0))
        base = {"from": acct.address, "nonce": nonce, "chainId": int(D["chainId"]), "value": value}
        # build_transaction would fill in the bare estimate (no headroom, and a spend's try/catch reputation lookup
        # can need more than the estimate shows), so build with a placeholder and estimate with 30% on top
        tx = fn.build_transaction({**base, "gas": 1}) if fn is not None else {**base, "to": to, "gas": 21_000}
        if fn is not None:
            est = w3.eth.estimate_gas({k: v for k, v in tx.items() if k != "gas"})
            tx["gas"] = min(int(est * 1.3), 16_000_000)  # under the 2^24 per-transaction cap
        tx.setdefault("maxFeePerGas", int(w3.eth.gas_price * 2))
        tx.setdefault("maxPriorityFeePerGas", min(int(w3.eth.gas_price), 1_000_000))
        signed = acct.sign_transaction(tx)
        h = w3.eth.send_raw_transaction(signed.raw_transaction)
        _next_nonce[acct.address] = nonce + 1
    return w3.eth.wait_for_transaction_receipt(h, timeout=45)


# ------------------------------------------------------------------------------------------- the round keeper
# A round closes with the first move after its end block by a wallet not staked in it. When she is the only one
# moving (she stakes before attacking), nobody would close her round, so the generation her attack should provoke
# would never be bred. The keeper closes a due round from her wallet when it saw a move (payments, stakes, bets, her
# proposals), and a quiet one on a schedule (`_plan`): while someone has the site open, and in the bursts that put
# real history on chain before judging. After closing a quiet round it spars: she
# attacks the new round the way an attacker would, so every grade has real refusals in it. Queued proposals go
# first, before her sparring. Closes measured 1.9M gas on a pool of one and 3.9-4.6M on a full pool (~0.000025 test
# ETH at 0.006 gwei); the closer's tip is 0.00002 from the protocol pool, which forfeited stakes refill.
# On every pass the keeper first releases her own held payments that are due and puts the money back
# (`_release_held`). An attack's stake comes back only once her wallet has taken at least the stake (0.0002)
# that round, so a round in which every spar is refused or held would cost her the stake (0.0002 every ten minutes):
# each spar therefore opens with an ordinary payment of exactly the stake, which is paid and put
# back, so the stake returns at once. She still stakes at most every SPAR_STAKE_EVERY_S unless it came back.
_activity = {"at": 0.0}
KEEP_RESERVE = 6 * 10**14  # attacks and proposals come first: never close or spar below this balance
KEEP_WATCHED_S = float(os.environ.get("KEEP_WATCHED_S", "300"))  # while someone has the site open: a generation this often
SPAR_STAKE_EVERY_S = float(os.environ.get("SPAR_STAKE_EVERY_S", "600"))
_staked = {"at": 0.0}  # when she last put down an attack stake that has not come back
FIRST_LIGHT_ROUNDS = 30  # a young arena gets a burst, so a judge finds a real lineage, not a deployment
_T = lambda iso: calendar.timegm(time.strptime(iso, "%Y-%m-%dT%H:%M"))  # UTC "YYYY-MM-DDTHH:MM" -> epoch seconds
TUESDAY_BURST = (_T("2026-11-24T14:00"), _T("2026-11-24T15:15"))  # 18:00-19:15 in Dubai, the evening before judging
JUDGING_DAY = _T("2026-11-24T20:00")  # midnight in Dubai: from here, watched-only (visitors and the film attack)
_kept: dict = {"at": 0.0, "epoch": -1, "tries": 0, "failed_at": 0.0, "last": None, "spar": None, "claimed": None,
               "spar_skipped": None, "released": None}


def _plan(epoch: int, now: float) -> tuple[float, bool]:
    """How often a quiet round is closed whether or not anyone watches (0: only while watched), and whether she spars
    after closing one. KEEP_QUIET_S and KEEP_SPAR (Space variables) override it."""
    if os.environ.get("KEEP_QUIET_S"):
        return float(os.environ["KEEP_QUIET_S"]), os.environ.get("KEEP_SPAR", "1") != "0"
    if epoch <= FIRST_LIGHT_ROUNDS or TUESDAY_BURST[0] <= now < TUESDAY_BURST[1]:
        plan = (150.0, True)
    elif now < JUDGING_DAY:
        plan = (3600.0, True)
    else:
        plan = (0.0, False)
    return plan[0], plan[1] and os.environ.get("KEEP_SPAR", "1") != "0"


def keep(watched: bool = False) -> dict | None:
    """Close the current round if it is due and worth closing: something happened in it, or it is quiet and the plan
    or a watching visitor (`watched`) says it is time. Then her queued proposals, her sparring and her claim. Returns
    what happened, or None."""
    if not os.environ.get("DEMO_PRIVATE_KEY"):
        return None
    try:  # her own held payments that are due: released and put back
        _release_held()
    except Exception as ex:
        print("keeper: release pass failed:", _why(ex), flush=True)
    for acct, wei in list(_owed_fresh):  # from her derived addresses first
        if wei and _put_back(acct, wei):
            _owed_fresh.remove((acct, wei))
            print("keeper: repaid", eth(wei), "from a derived address", flush=True)
    if _owed["wei"]:  # a put-back that failed earlier: repay it first
        me = Account.from_key(_key())
        if w3.eth.get_balance(me.address) >= KEEP_RESERVE + _owed["wei"] and _put_back(me, _owed["wei"]):
            print("keeper: repaid", eth(_owed["wei"]), "to the vault", flush=True)
            _owed["wei"] = 0
    st = ARENA.functions.status().call()
    e, end, txs, bets = int(st[0]), int(st[2]), int(st[4]), int(st[8])
    if w3.eth.block_number < end or ARENA.functions.epochClosed(e).call():
        return None
    busy = txs > 0 or bets > 0 or len(ARENA.functions.epochAttackerList(e).call()) > 0 or _activity["at"] > _kept["at"]
    every, spar = _plan(e, time.time())
    since = time.time() - _kept["at"]
    quiet_due = (every > 0 and since >= every) or (watched and since >= KEEP_WATCHED_S)
    if not (busy or quiet_due or _queue):
        return None
    if e != _kept["epoch"]:
        _kept.update(epoch=e, tries=0)
    if _kept["tries"] >= 3 or time.time() - _kept["failed_at"] < 60:  # a failed close is retried twice, a minute apart
        return None
    me = Account.from_key(_key())
    if w3.eth.get_balance(me.address) < KEEP_RESERVE:
        return None
    _kept["tries"] += 1
    try:
        rc = _send(me, ARENA.functions.closeEpoch())
        if rc["status"] != 1:
            raise RuntimeError("the close reverted")
    except Exception as ex:
        _kept["failed_at"] = time.time()
        print("keeper: close failed:", re.sub(r"(0x)?[0-9a-fA-F]{40,}", "[hex]", str(ex).split("\n")[0])[:200], flush=True)
        return None
    _kept["at"] = time.time()
    installed = ARENA.events.PolicyInstalled().process_receipt(rc, errors=DISCARD)
    out = {"epoch": e, "hash": _hex(rc["transactionHash"]), "block": rc["blockNumber"], "gas": rc["gasUsed"],
           "installed": int(installed[-1]["args"]["id"]) if installed else None}
    _kept["last"] = out
    print("keeper: closed round", e, out, flush=True)
    # first moves of the new round: her queued proposals (so they are judged on every payment that follows) ...
    while _queue:
        item = _queue.pop(0)
        item["result"] = _propose_now(me, item["genes"])
        item["done"].set()
    # ... then, after a quiet round, her sparring, so the next grade has real attacks in it
    if spar and not busy and w3.eth.get_balance(me.address) >= KEEP_RESERVE + int(ARENA.functions.ATTACK_STAKE().call()):
        try:
            s = _spar(me)
            if "skipped" in s:
                _kept["spar_skipped"] = {**s, "at": time.time()}
            else:
                _kept["spar"] = s
        except Exception as ex:
            print("keeper: spar failed:", _why(ex), flush=True)
    try:
        if int(ARENA.functions.claimable(me.address).call()) >= 10**14:  # tips and returned stakes, back to her wallet
            crc = _send(me, ARENA.functions.claim())
            _kept["claimed"] = {"hash": _hex(crc["transactionHash"]), "at": time.time()}
    except Exception as ex:
        print("keeper: claim failed:", _why(ex), flush=True)
    return out


def _spar(me) -> dict:
    """She attacks the round she just opened, as an attacker would: a 40% drain, then three 10% slices back to back
    (bursts are what the velocity gene can learn on a 0.2 s chain). Anything paid is put back; anything held is
    released by the keeper when it is due and put back then. A new stake at most every SPAR_STAKE_EVERY_S."""
    if not ARENA.functions.hasAttack(me.address).call() and time.time() - _staked["at"] < SPAR_STAKE_EVERY_S:
        return {"skipped": "her last stake was under ten minutes ago"}
    if not _attack_lock.acquire(blocking=False):
        return {"skipped": "busy"}
    try:
        _ensure_stake(me)
        vault_wei = int(VAULT.functions.balance().call())  # what it can pay (held payments are reserved)
        if vault_wei == 0:
            return {"skipped": "empty vault"}
        # first an ordinary payment of exactly the stake, while the round is quiet: paid, it is the take that brings
        # her stake back at once (and it goes straight back into the vault), so a spar costs gas, not 0.0002 each time
        stake = int(ARENA.functions.ATTACK_STAKE().call())
        first = [_pay(me, me, stake)] if stake * 4 <= vault_wei else []
        rs = first + [_pay(me, me, int(vault_wei * pct / 100)) for pct in (40, 10, 10, 10)]
        return {"at": time.time(), "verdicts": "".join("Rhp"[2 - r["verdict"]] for r in rs), "hash": rs[len(first)]["hash"],
                "stake_back": _staked["at"] == 0.0}
    finally:
        _attack_lock.release()


_owed = {"wei": 0}  # payments that got through to her own wallet and are not back in the vault yet
_owed_fresh: list = []  # (derived account, wei): payments to a fresh address of hers not yet put back
_held: list = []  # her own held payments, from her receipts' Held events (never anyone else's)
_held_lock = threading.Lock()


def _put_back(acct, amount: int) -> bool:
    """Deposit what got through back into the vault: three tries, logged, a moment apart."""
    for i in range(3):
        try:
            if _send(acct, VAULT.functions.deposit(), value=amount)["status"] == 1:
                return True
        except Exception as e:
            print(f"put back failed (try {i + 1}):", re.sub(r"(0x)?[0-9a-fA-F]{40,}", "[hex]", str(e).split("\n")[0])[:160], flush=True)
        time.sleep(1.5 * (i + 1))
    return False


def _return(me, target, amount: int) -> bool:
    """Money that reached her wallet or one of her derived addresses goes back into the vault; if that fails, the
    keeper repays it on a later pass."""
    if target.address != me.address:
        gas = 120_000 * int(w3.eth.gas_price * 2)
        returned = _put_back(target, max(0, amount - gas))
        if not returned:  # it sits in the derived address: the keeper repays it from there
            _owed_fresh.append((target, max(0, amount - gas)))
        return returned
    returned = _put_back(me, amount)
    if not returned:  # it is in her wallet: the keeper repays it on its next pass
        _owed["wei"] += amount
    return returned


def _stake_back(rc, me) -> bool:
    """The arena returns an attack stake in the payment that takes the wallet past the stake (a spend, or the
    release of a hold). Seen in her receipt, her last stake cost her nothing, so it does not count against sparring."""
    back = any(e["args"]["to"] == me.address and e["args"]["attack"]
               for e in ARENA.events.StakeReturned().process_receipt(rc, errors=DISCARD))
    if back:
        _staked["at"] = 0.0
    return back


def _earlier_refusal(me) -> dict | None:
    """Her latest refusal over a hard limit in the last ~2000 blocks, shaped like `_pay`'s result (`repeat` set)."""
    head = w3.eth.block_number
    logs = VAULT.events.Spend().get_logs(from_block=max(0, head - 2000), to_block=head,
                                         argument_filters={"caller": me.address})
    for lg in reversed(logs):
        a = lg["args"]
        if a["refused"] and int(a["reason"]):
            rc = w3.eth.get_transaction_receipt(lg["transactionHash"])
            return {"verdict": VERDICT_REFUSED, "refused": True, "held": False, "ev": a, "rc": rc, "returned": False,
                    "hash": _hex(lg["transactionHash"]), "hold_id": None, "release_block": None, "repeat": True}
    return None


def _pay(me, target, amount: int) -> dict:
    """One payment request from her wallet: the contract's verdict (paid, held or refused), the money put back if it
    was paid, and a held one recorded for the keeper to release and put back when it is due."""
    salt = secrets.token_bytes(32)
    commit = Web3.solidity_keccak(["uint8", "bytes32", "address"], [LABEL_ATTACK, salt, me.address])
    rc = _send(me, VAULT.functions.spend(target.address, amount, KIND_PAY, commit))
    ev = VAULT.events.Spend().process_receipt(rc, errors=DISCARD)[0]["args"]
    verdict = int(ev["verdict"])
    returned, hold = False, None
    if verdict == VERDICT_PAID:  # it got through: put it back
        _stake_back(rc, me)
        returned = _return(me, target, amount)
    elif verdict == VERDICT_HELD:  # nothing moved yet: the keeper releases it when due, then puts it back
        h = VAULT.events.Held().process_receipt(rc, errors=DISCARD)
        if h:
            a = h[0]["args"]
            hold = {"id": int(a["id"]), "release_block": int(a["releaseBlock"]), "block": int(rc["blockNumber"]),
                    "to": target, "amount": int(a["amount"]), "tries": 0, "next_at": 0.0}
            with _held_lock:
                _held.append(hold)
            print(f"held: payment {hold['id']} of {eth(hold['amount'])}, due at block {hold['release_block']}", flush=True)
    return {"verdict": verdict, "refused": verdict == VERDICT_REFUSED, "held": verdict == VERDICT_HELD, "ev": ev,
            "rc": rc, "returned": returned, "hash": _hex(rc["transactionHash"]),
            "hold_id": hold["id"] if hold else None, "release_block": hold["release_block"] if hold else None}


HOLD_RETRY_MAX_S = 300  # a failed release is retried on later keeper passes, backing off up to five minutes
HOLD_RECOVER_SCAN = 64  # after a restart: how many of the vault's latest holds to look through for her own
_recovered = {"done": False}


def _recover_held(me) -> int:
    """Once per process (a Space restart forgets `_held`): her own unsettled holds among the vault's latest, paid from
    and to her own wallet, go back on the keeper's list. One to a derived address can't be found again this way (its
    key came from a random index); it waits in the vault until anyone releases it."""
    n = int(VAULT.functions.heldCount().call())
    with _held_lock:
        known = {h["id"] for h in _held}
    found = 0
    for i in range(max(0, n - HOLD_RECOVER_SCAN), n):
        if i in known:
            continue
        g = VAULT.functions.getHeld(i).call()  # (from, amount, to, releaseBlock, kind, settled, ...)
        if g[0] == me.address and g[2] == me.address and not g[5]:
            with _held_lock:
                _held.append({"id": i, "release_block": int(g[3]), "block": int(g[3]) - HOLD_DELAY, "to": me,
                              "amount": int(g[1]), "tries": 0, "next_at": 0.0})
            found += 1
    if found:
        print(f"keeper: found {found} held payment(s) of hers from before a restart", flush=True)
    return found


def _release_held() -> list[dict]:
    """Her own held payments whose delay is over: each is released from her own wallet (release is open to anyone
    once due; she has no guardian powers) and the money put back. Only ids from her own receipts (or, after a restart,
    from the vault's record of holds paid from and to her wallet) are here, and each is checked on chain to be from
    her wallet before she touches it. One that someone else settled first is put back if it was released (the money
    reached her) and dropped if the owner or a guardian vetoed it (it never left)."""
    if not _recovered["done"]:
        _recover_held(Account.from_key(_key()))
        _recovered["done"] = True
    with _held_lock:
        due_list = list(_held)
    if not due_list:
        return []
    me = Account.from_key(_key())
    head = w3.eth.block_number
    done = []
    for h in due_list:
        if head < h["release_block"] or time.time() < h["next_at"]:
            continue
        try:
            got = VAULT.functions.getHeld(h["id"]).call()  # (from, amount, to, releaseBlock, kind, settled, ...)
            if got[0] != me.address or got[2] != h["to"].address or int(got[1]) != h["amount"]:
                print(f"keeper: hold {h['id']} is not hers as recorded; left alone", flush=True)
                outcome, hash_ = "not hers", None
            elif got[5]:  # settled already: someone released it, or the owner or a guardian vetoed it
                outcome, hash_ = _hold_outcome(h["id"], h["block"]) or "settled", None
            else:
                rc = _send(me, VAULT.functions.release(h["id"]))
                if rc["status"] != 1:
                    raise RuntimeError("the release reverted")
                _stake_back(rc, me)
                outcome, hash_ = "released", _hex(rc["transactionHash"])
            returned = outcome == "released" and _return(me, h["to"], h["amount"])
            with _held_lock:
                if h in _held:
                    _held.remove(h)
            r = {"id": h["id"], "outcome": outcome, "by_her": hash_ is not None, "hash": hash_, "returned": returned,
                 "amount_eth": eth(h["amount"]), "at": time.time()}
            done.append(r)
            _kept["released"] = r
            print("keeper: hold", r, flush=True)
        except Exception as ex:
            h["tries"] += 1
            h["next_at"] = time.time() + min(HOLD_RETRY_MAX_S, 15 * 2 ** (h["tries"] - 1))
            print(f"keeper: release of hold {h['id']} failed (try {h['tries']}):", _why(ex), flush=True)
    return done


def _hold_outcome(hid: int, since: int) -> str:
    """How one of her holds that someone else settled ended: "released" (the money went to its recipient, one of
    her addresses), "vetoed" (it stayed in the vault), or "" if the logs could not say."""
    head = w3.eth.block_number
    sources = [(w.eth.contract(address=VAULT.address, abi=ABI["vault"]), span) for w, span in _log_vaults]
    sources.append((VAULT, 190))  # the public endpoint answers 200 blocks a query
    for vault, span in sources:
        try:
            for start in list(range(since, head + 1, span))[:40]:
                end = min(head, start + span - 1)
                if vault.events.Released().get_logs(from_block=start, to_block=end, argument_filters={"id": hid}):
                    return "released"
                if vault.events.Vetoed().get_logs(from_block=start, to_block=end, argument_filters={"id": hid}):
                    return "vetoed"
            return ""
        except Exception:
            continue
    return ""


VISITOR_FLOOR_WEI = int(float(os.environ.get("VISITOR_FLOOR_ETH", "0.002")) * 10**18)


def attack(amount_pct: float = 40, repeats: int = 1, fresh_recipient: bool = False) -> dict:
    """Send the attack; return what the contract decided for each payment, in plain values."""
    amount_pct = max(1.0, min(60.0, float(amount_pct)))
    repeats = max(1, min(3, int(repeats)))
    if not _attack_lock.acquire(blocking=False):
        return {"ok": False, "error": "busy"}
    try:
        if time.time() - _last_attack["at"] < 4:
            return {"ok": False, "error": "busy"}
        _last_attack["at"] = time.time()
        me = Account.from_key(_key())
        # attacks a visitor asks for (chat or film) stop above the judges' top-up reserve
        if w3.eth.get_balance(me.address) < VISITOR_FLOOR_WEI:
            return {"ok": False, "error": "I'm keeping my last test ether for the judges"}
        vault_wei = int(VAULT.functions.balance().call())  # what it can pay (held payments are reserved)
        if vault_wei == 0:
            return {"ok": False, "error": "the vault is empty"}
        staked = _ensure_stake(me)
        results = []
        for n in range(repeats):
            amount = int(vault_wei * amount_pct / 100)
            target = _fresh(secrets.randbelow(1 << 30)) if fresh_recipient else me
            try:
                p = _pay(me, target, amount)
            except Exception as e:
                names = _names(e)
                if "HardLimit" in names:
                    # a wallet's second over-the-limit request in a round reverts instead of being logged.
                    # Her first one this round (often her own sparring) is the refusal on the record: show that one.
                    p = _earlier_refusal(me)
                    if p is None:
                        raise
                elif "NotParticipant" in names:
                    # her keeper (or anyone's spend) can close the round between her stake and her payment, and a
                    # stake counts only in its own round: file this round's plan and send it again, once
                    staked = _ensure_stake(me) or staked
                    amount = int(int(VAULT.functions.balance().call()) * amount_pct / 100)
                    p = _pay(me, target, amount)
                else:
                    raise
                if p.get("repeat"):
                    amount = int(p["ev"]["amount"])
            ev, rc = p["ev"], p["rc"]
            results.append({
                "verdict": VERDICT_WORDS[p["verdict"]] if p["verdict"] < 3 else str(p["verdict"]),
                "refused": p["refused"],
                "held": p["held"],
                # a held payment moves nothing yet: it waits HOLD_DELAY blocks (the owner or a guardian may veto
                # it), then her keeper releases it and puts it back
                "hold_id": p["hold_id"],
                "release_block": p["release_block"],
                "hold_line": HOLD_LINE,
                "amount_eth": eth(amount),
                "share_of_vault_pct": round(amount_pct, 1),
                "score": int(ev["score"]),
                "limit": LIMIT,
                "reasons": " and ".join(reasons(int(ev["reason"]))) or "none",
                "block": rc["blockNumber"],
                "hash": p["hash"],
                "returned": p["returned"],
                "to_stranger": bool(fresh_recipient),
                # the raw values, for the site's film (lib/demo.ts reads these)
                "amount_wei": str(amount),
                "reason_mask": int(ev["reason"]),
                "caller": me.address,
                "features_packed": str(int(ev["features"])),
                "balance_after_wei": str(int(ev["balanceAfter"])),
                "verdict_code": p["verdict"],
                "repeat": bool(p.get("repeat")),
            })
            if p.get("repeat"):
                break  # every further one this round would be turned away the same way
            vault_wei = int(VAULT.functions.balance().call())
            if vault_wei == 0:
                break
        return {"ok": True, "results": results, "explorer": EXPLORER, "staked_now": staked}
    except Exception as e:
        return {"ok": False, "error": _why(e)}
    finally:
        _attack_lock.release()


def _hex(h) -> str:
    """0x-prefixed (HexBytes.hex() lost its prefix in hexbytes 1.0)."""
    s = h.hex() if hasattr(h, "hex") else str(h)
    return s if s.startswith("0x") else "0x" + s


def _ensure_stake(me) -> bool:
    """File her attack plan with the Arena for this round if she hasn't (the attack stake, 0.0002 test ETH). The
    arena returns it only once her wallet has taken at least the stake itself that round (a held payment counts when it
    is released), so a round in which every attack is refused or still held costs her the stake; `_spar` therefore
    opens with a payment of exactly the stake.
    If the attack pool is full this round she adopts the pool's
    first plan instead. Returns True if she staked just now."""
    if ARENA.functions.hasAttack(me.address).call():
        return False
    stake = int(ARENA.functions.ATTACK_STAKE().call())
    if w3.eth.get_balance(me.address) < stake + 3 * 10**14:  # the stake, plus the gas reserve a close may need
        raise RuntimeError("cannot cover the stake")
    try:
        _send(me, ARENA.functions.submitAttack(DRAIN), value=stake)
    except Exception as e:
        if "PoolFull" not in _names(e):
            raise
        _send(me, ARENA.functions.adoptAttack(int(ARENA.functions.getAttackPool().call()[0])), value=stake)
    _staked["at"] = time.time()
    return True


def _names(e: Exception) -> str:
    """The custom error names in an exception's text (abi/errors.json), for matching."""
    raw = str(e)
    return " ".join(ERRORS[m] for m in re.findall(r"0x[0-9a-fA-F]{8}\b", raw) if m.lower() in ERRORS) + " " + raw


def _why(e: Exception) -> str:
    """A short reason for her to say; the detail goes to the Space's log only, with any long hex scrubbed out."""
    raw = str(e).split("\n")[0]
    names = [ERRORS[m] for m in re.findall(r"0x[0-9a-fA-F]{8}\b", raw) if m.lower() in ERRORS]
    msg = re.sub(r"(0x)?[0-9a-fA-F]{40,}", "[hex]", raw)[:300]
    print("attack failed:", msg, ("(" + ", ".join(sorted(set(names))) + ")") if names else "", flush=True)
    low = msg.lower() + " " + " ".join(names).lower()
    if "cannot cover the stake" in low:
        return "the attack wallet cannot cover its stake"
    if "notparticipant" in low:
        return "the attack wallet has no attack plan filed"
    if "private key" in low or "32 bytes" in low or "no attack wallet" in low:
        return "the attack wallet is not set up"
    if "insufficient funds" in low:
        return "the attack wallet is out of test ether"
    return "failed"


# ------------------------------------------------------------------------------------------------ proposing
_propose_lock = threading.Lock()
_queue: list[dict] = []  # proposals held for the top of the next round (the keeper sends them right after its close)


# ------------------------------------------------------------------------- a policy that waves a drain through
# A port of the contract's scoring (GenomeLib.refusesFast, which matches Firewall.explainWith). Before she enters a
# policy, she tries it on drain-sized payments, so she can't
# be talked into proposing a back door: a genome that matches the champion where the Crucible looks
# and waves a large payment through where it doesn't.
PAIRS = [(0, 1), (0, 7), (1, 2), (2, 7), (5, 6), (0, 5), (2, 3), (6, 7)]


def refuses(g: list[int], f: list[int]) -> bool:
    raw, fired = 0, 0
    for i in range(8):
        fi = min(int(f[i]), 1000)
        raw += g[i] * fi
        t = g[16 + i]
        if (fi >= t) if t >= 0 else (fi < -t):
            fired |= 1 << i
    for k, (a, b) in enumerate(PAIRS):
        if (fired >> a) & 1 and (fired >> b) & 1:
            raw += g[8 + k] * 1000
    return raw > LIMIT


def _crucible_would_accept(genes: list[int]) -> bool:
    """The Crucible's own verdict, read for free (screenVerdict: 0 = it would accept; it checks the monotone rule,
    the honest bench, the drain canaries and the champion's fitness). If the read fails, assume it would, so a flagged
    genome is never sent."""
    try:
        lo, hi = pack((list(genes) + [0] * 32)[:32])
        return int(CRUCIBLE.functions.screenVerdict(lo, hi).call()) == 0
    except Exception:
        return True


def monotone(genes: list[int]) -> tuple[list[int], int]:
    """Her genome with every weight that breaks the monotone rule set to zero (Firewall.monotoneGenome, a free
    view: w0 and w7 never negative, and interactions gated on amount or outflow carry their gate's direction), and
    how many genes that changed. She writes sound policies; this keeps one from being refused for a sign alone. A
    weak policy stays weak and still goes to the chain, which refuses it on the record. If the read fails, the genome
    goes as written and the chain judges it."""
    g = (list(genes) + [0] * 32)[:32]
    lo, hi = pack(g)
    try:
        ok, clamped = FIREWALL.functions.monotoneGenome(lo, hi).call()
    except Exception:
        return g, 0
    if ok:
        return g, 0
    out = unpack(int(clamped), hi)
    return out, sum(1 for a, b in zip(out, unpack(lo, hi)) if a != b)


def passes_drain(g: list[int]) -> list[int] | None:
    """The first drain-sized payment (35% of the vault or more, every recipient and route the gates can tell apart)
    the genome lets through, else None."""
    g = (list(g) + [0] * 24)[:24]
    near = lambda t, lo, hi: {v for v in (abs(t), abs(t) - 1, abs(t) + 1) if lo <= v <= hi}
    for f0 in {350, 400, 450, 499, 550, 700, 900, 1000} | near(g[16], 350, 1000):
        for f7 in {0, f0, 500, 1000} | near(g[23], 0, 1000):
            for f1 in {1000, 500, 100, 50, 1} | near(g[17], 1, 1000):
                for f2 in (0, 200, 400, 600, 1000):
                    for f3 in {0, 1000} | near(g[19], 0, 1000):
                        for f4 in (0, 200):
                            for f5 in (0, 1000):
                                for f6 in (0, 1000):
                                    f = [f0, f1, f2, f3, f4, f5, f6, f7]
                                    if not refuses(g, f):
                                        return f
    return None


def propose(genes: list[int], wait_s: float = 230) -> dict:
    """Her own policy, written by her, graded by the chain: the Crucible plays it against every attack plan in the
    pool and the honest bench, and either enters it as a challenger or refuses it, on the record (Proposed event).

    A policy that enters after some of a round's payments has no shadow verdicts for them and is ranked at the close
    as if it had let them all through, so it dies however strong it is. So if this round already has payments, it is held and sent as the first move of the next round, right
    after the keeper's close; the result says `waited`.

    Weights that break the monotone rule are set to zero first (`monotone`, a free view), so a sound policy is
    not refused for a sign alone; the result says how many with `clamped`."""
    genes, clamped = monotone(genes)
    hole = passes_drain(genes)
    if hole is not None and _crucible_would_accept(genes):
        # a back door: the chain's screen would accept it, yet it waves a drain through. She never
        # enters one, whoever asks. A merely weak policy still goes to the chain, which refuses it on the record.
        print("propose: refused a back door the screen would accept", hole, flush=True)
        return {"ok": False, "error": "it would wave through a single payment of a third of the vault or more"}
    if _queue or not _propose_lock.acquire(blocking=False):
        return {"ok": False, "error": "busy"}
    try:
        me = Account.from_key(_key())
        if w3.eth.get_balance(me.address) < 3 * 10**14:
            raise RuntimeError("cannot cover the stake")  # gas reserve for a proposal that may close a round
        st = ARENA.functions.status().call()
        e, end, txs = int(st[0]), int(st[2]), int(st[4])
        closes_it = w3.eth.block_number >= end and not ARENA.functions.hasAttack(me.address).call()
        if txs == 0 or closes_it:  # first in this round, or her proposal closes the overdue round and goes first
            return {**_propose_now(me, genes), "clamped": clamped}
        item = {"genes": genes, "done": threading.Event(), "result": None}
        _queue.append(item)
        if not item["done"].wait(wait_s):
            if item in _queue:
                _queue.remove(item)
            return {"ok": False, "error": "the round has not closed yet"}
        return {**item["result"], "waited": True, "clamped": clamped}
    except Exception as e:
        return {"ok": False, "error": _why(e)}
    finally:
        _propose_lock.release()


def _propose_now(me, genes: list[int]) -> dict:
    try:
        lo, hi = pack(genes)
        _activity["at"] = time.time()  # a proposal is a move the round's counters don't show
        rc = _send(me, CRUCIBLE.functions.propose(lo, hi))
        ev = CRUCIBLE.events.Proposed().process_receipt(rc, errors=DISCARD)[-1]["args"]
        v = int(ev["verdict"])
        return {
            "ok": True,
            "verdict": v,
            "verdict_name": VERDICTS[v] if v < len(VERDICTS) else str(v),
            "id": int(ev["id"]),
            "honest_refused": int(ev["honestRefused"]),
            "lost_ppm": int(ev["lost"]),
            "fitness_ppm": int(ev["fitness"]),
            "champion_ppm": int(ev["championFitness"]),
            "genes": unpack(lo, hi)[:24],
            "block": rc["blockNumber"],
            "hash": _hex(rc["transactionHash"]),
            "explorer": EXPLORER,
        }
    except Exception as e:
        return {"ok": False, "error": _why(e)}


def wallet() -> dict:
    """Her wallet and what the keeper is doing, for /health."""
    try:
        me = Account.from_key(_key())
        e = int(ARENA.functions.currentEpoch().call())
        every, spar = _plan(e, time.time())
        return {"address": me.address, "eth": eth(w3.eth.get_balance(me.address)),
                "claimable": eth(int(ARENA.functions.claimable(me.address).call())), "round": e,
                "quiet_close_every_s": every, "spars": spar, "queued_proposals": len(_queue),
                "owed_to_vault": eth(_owed["wei"]), "her_holds_waiting": len(_held),
                "her_held_eth": eth(sum(h["amount"] for h in list(_held))),
                "next_spar_stake_in_s": max(0, int(SPAR_STAKE_EVERY_S - (time.time() - _staked["at"])))}
    except Exception as ex:
        return {"error": _why(ex)}


# ------------------------------------------------------------------------------------------ the judges' top-up
# The live moment is a judge attacking from their own MetaMask and being refused, but Base Sepolia faucets
# often want a mainnet balance first. A wallet that connects to the site with almost nothing gets enough from hers
# for one attack. A wallet that has not staked must bring a 10M-gas limit to its first move (Arena._advance) and
# reserve fees for all of it, so the SDK passes explicit fees (twice the base fee plus the tip): 0.0005 covers the
# 0.0002 stake and that reservation up to a base fee of about 0.011 gwei (0.006 today). Replayed on a fork at Base
# Sepolia's fees, the stake (carrying an overdue close) and a 40% attack spent 0.000026 in gas. She keeps a reserve.
TOPUP_WEI = int(float(os.environ.get("TOPUP_ETH", "0.0005")) * 10**18)
TOPUP_MIN_WEI = 5 * 10**14  # a wallet already holding this much can stake and attack without help
TOPUP_RESERVE_WEI = int(float(os.environ.get("TOPUP_RESERVE_ETH", "0.0015")) * 10**18)
# from the Tuesday before judging, so visitors before then don't spend what her sparring needs (TOPUP_ALWAYS=1: now)
TOPUP_FROM = _T("2026-11-24T00:00")


def topup(to: str) -> dict:
    """Send TOPUP_ETH to `to` if it holds less than 0.0005 and her wallet stays above its reserve. Returns
    {"sent": wei, "hash"} or {"sent": 0, "why"}."""
    if time.time() < TOPUP_FROM and os.environ.get("TOPUP_ALWAYS") != "1":
        return {"sent": 0, "why": "visitors' test ether starts on 24 November"}
    try:
        to = Web3.to_checksum_address(to)
        if w3.eth.get_balance(to) >= TOPUP_MIN_WEI:
            return {"sent": 0, "why": "already has enough to try"}
        me = Account.from_key(_key())
        if w3.eth.get_balance(me.address) - TOPUP_WEI < TOPUP_RESERVE_WEI:
            return {"sent": 0, "why": "her wallet is low on test ether"}
        rc = _send(me, to=to, value=TOPUP_WEI)
        if rc["status"] != 1:
            return {"sent": 0, "why": "the transfer failed"}
        return {"sent": TOPUP_WEI, "hash": _hex(rc["transactionHash"])}
    except Exception as e:
        return {"sent": 0, "why": _why(e)}


def is_tx(h: str) -> bool:
    """A real transaction on this chain (so a pasted 64-hex value is a hash to check, not a private key)."""
    try:
        return w3.eth.get_transaction(h) is not None
    except Exception:
        return False
