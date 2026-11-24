// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GenomeLib} from "../lib/GenomeLib.sol";

interface ICrucibleArena {
    struct AttackGenome {
        uint256 lo;
        uint256 hi;
        uint64 parentA;
        uint64 parentB;
        uint32 generation;
        uint32 bornEpoch;
        address submitter;
        bool alive;
        uint256 lastExtracted;
    }

    function currentEpoch() external view returns (uint256);
    function getPool() external view returns (uint64[] memory);
    function getAttackPool() external view returns (uint64[] memory);
    function getAttack(uint64 id) external view returns (AttackGenome memory);
    function policySubmitted(uint256 epoch, address who) external view returns (bool);
    function poke(address caller) external;
    function enterProposal(uint256 lo, uint256 hi, address proposer) external returns (uint64);
    function attackExtracted(uint256 epoch, uint64 id) external view returns (uint256);
}

interface ICrucibleFirewall {
    function exportGenome() external view returns (uint256 lo, uint256 hi, uint64 policyId, uint256 count);
}

/// @title Crucible — the sparring ring the Arena consults at every close, and the screen for proposed policies.
/// @notice Real traffic alone cannot teach the arena much: it needs funded attackers, honest users who reveal
///         labels, and every epoch closed. So at each close the Arena also hands the Crucible its whole policy
///         pool and its attack pool. Every policy is played against every attack genome (the first 8) inside
///         Solidity, step by step, with the same eight features the Vault computes, and against a fixed bench
///         of honest payments. The result is added to each candidate's fitness (and to each attack genome's):
///
///           sparring score (ppm of the vault) = -(average share the attackers take) - (bench cost)
///                                               - lambdaBench * (drain canaries let through)
///           attack take (ppm of the vault)    =   average share it takes across the pool
///
///         A step the policy would hold (score above 350,000, not above 500,000) counts half
///         as taken, and still raises the outflow the next steps see; the bench costs, for each payment refused,
///         2 x its amount (ppm) + BENCH_FLOOR_PPM, and a tenth of that for each held. Refusing the
///         whole bench costs 538,000 ppm, so a policy that refuses a little can still win. The screen still refuses any policy that would refuse a bench payment
///         (REFUSED_HONEST), but a bred child may refuse a small one when that stops more than it costs.
///
///         It also screens policies written by anyone, the queen included: `propose()` plays the genome against
///         the current attackers and the bench, compares it with the live champion, and records the verdict. A
///         proposal that would refuse an honest payment, or that does worse than the policy guarding the vault,
///         is refused on chain with its numbers; one that passes enters the Arena's shadow pool without a stake.
///
///         No blind spots: sparring steps go up to the whole vault, and every candidate
///         is also held to a fixed set of drain canaries (`canaries()`): drain-sized payments a policy must refuse.
///         Each canary a policy lets through costs it lambdaBench, exactly like refusing an honest bench payment,
///         wherever it is graded: in `propose()`'s screen (a proposal that passes one is refused, REFUSED_DRAIN), in
///         the Arena's screen of staked submissions (`screenVerdict`), and at every close (`grade`), so bred
///         children are held to them too. (Without them, a policy equal to the champion wherever the ring looked,
///         with a huge negative weight where it never looked, would pass the screen and later let the whole vault out.)
///         The screen also refuses a genome that is not monotone in amount and round outflow (REFUSED_NOT_MONOTONE,
///         GenomeLib.monotone; bred children are clamped instead), and every close also spars the Arena's archive of
///         past attack plans.
///
///         A fixed set of canaries can always be stepped around by a back door
///         gated just where no canary looks (for instance on a 16-99 block gap). So each candidate also meets an
///         adaptive canary built from its own genes (`adaptiveCanary`): the lowest score it gives a stranger's payment
///         of a little over a quarter of the vault, over every novelty, velocity and gap and both values of call depth
///         and contract recipient. That minimum is exact (see `adaptiveCanary`), so no gate placement hides from it.
///         The fixed canaries' band starts at 26% of the vault, four of them combine every discount a payment can stack (a
///         fresh recipient, velocity 0, a long gap, through a contract), and sparring delays reach 100 blocks.
///
/// Simulation (mirrors Vault.features for an attacker; checked step by step against the real Vault in tests):
///   The vault starts each bout at SIM_BALANCE. An attack genome is 8 steps x 4 genes (sdk/src/genome.ts):
///     g0 amountBps |g| <= 10000 (0 = skip)  g1 recipient |g| % 4: 0 self, 1 fresh, 2 contract, 3 previous
///     g2 delay |g| % 101 blocks, so sparring sees every gap up to 100 blocks
///                                           g3 route |g| % 3: 0 direct, 1 agent, 2 delegate
///   f0 amount share, f1 recipient novelty, f2 velocity (20-block window, 200 a spend), f3 gap (capped 100),
///   f4 reputation = insiderRep (0 for strangers), f5 call depth (route != direct), f6 contract recipient,
///   f7 outflow this bout including the step. A refused step moves nothing but still counts for velocity.
contract Crucible {
    // ------------------------------------------------------------------ constants
    /// @notice The simulated vault: every share below is in parts per million of it.
    uint256 public constant SIM_BALANCE = 1_000_000;
    /// @notice Only the first 8 attack genomes in the pool spar (the 4 survivors and 4 children after a close).
    uint256 public constant SIM_ATTACKS = 8;
    /// @notice Up to this many archived attack plans (the Arena's hall of fame) spar at every close as well.
    uint256 public constant SIM_ARCHIVE = 4;
    uint256 public constant MAX_HONEST = 16;
    uint256 internal constant MAX_CANDIDATES = 16; // Arena.MAX_CANDIDATES
    uint256 internal constant STEPS = 8;
    uint256 internal constant VELOCITY_WINDOW = 20;
    uint256 internal constant VELOCITY_UNIT = 200;
    uint256 internal constant GAP_CAP = 100;

    uint8 public constant OK = 0;
    uint8 public constant REFUSED_HONEST = 1; // would refuse at least one honest bench payment
    uint8 public constant REFUSED_WEAK = 2; // lets the attackers take more than the live champion does
    uint8 public constant REFUSED_ALREADY = 3; // one policy (staked or proposed) per wallet per epoch
    uint8 public constant REFUSED_FULL = 4; // the shadow pool already holds 16 candidates
    uint8 public constant REFUSED_DRAIN = 5; // lets at least one drain canary through
    uint8 public constant REFUSED_NOT_MONOTONE = 6; // a bigger payment, or a later one in a draining round, could score lower
    /// @notice How many drain canaries every candidate is held to (see `canaries()`).
    uint256 public constant CANARIES = 6;
    /// @notice The bottom of the canaries' band (per mille of the vault, for f0 and f7): a little over a quarter,
    ///         where genesis (1500·f0 + 500·f7) refuses. Every candidate is monotone in f0 and f7, so a payment above
    ///         the band scores at least as high.
    uint256 public constant BAND = 260;
    /// @notice The hold band, as the Vault (Firewall.HOLD_THRESHOLD): above it a payment is held, not paid.
    int256 internal constant HOLD_SCORE = 350_000;
    /// @notice A refused bench payment costs 2 x its amount (in ppm of the vault) plus this floor;
    ///         a held one a tenth of that. (lambdaBench prices only a drain canary let through.)
    uint256 public constant BENCH_FLOOR_PPM = 5000;

    // ------------------------------------------------------------------ config
    ICrucibleArena public immutable arena;
    ICrucibleFirewall public immutable firewall;
    /// @notice Cost of one refused honest bench payment, in ppm of the vault (1_000_000 = a full drain).
    uint256 public immutable lambdaBench;
    /// @notice f4 the simulated attackers carry. 0 = strangers. 500 = insiders: in the Vault a wallet registered as
    ///         honest can also stake an attack and keeps its reputation, so a policy that only gates on f4 is beatable.
    uint256 public immutable insiderRep;

    uint256[] internal honest; // packed feature vectors (16-bit lanes, as Vault.packFeatures)

    uint256 public proposals;
    uint256 public proposalsRefused;

    // ------------------------------------------------------------------ the attack archive (hall of fame)
    /// @dev The last SIM_ARCHIVE distinct attack plans that topped a close (by real extraction plus sparring take),
    ///      in a ring; every close and every screen spars them too, unless they are already among the pool's first 8.
    uint256[2][SIM_ARCHIVE] internal archive;
    uint256 public archiveCount;
    uint256 internal archiveNext;

    // ------------------------------------------------------------------ events
    /// @notice One per close: each candidate's sparring score (ppm, pool order) and bench refusals, and what each
    ///         attack genome takes on average (ppm, attack-pool order; 0 beyond the first SIM_ATTACKS).
    event Sparred(
        uint256 indexed epoch,
        uint64[] policies,
        int256[] fitness,
        uint8[] honestRefused,
        uint64[] attacks,
        uint256[] take
    );
    /// @notice Emitted at a close only when some candidate let a drain canary through: how many each one passed
    ///         (pool order; each cost it lambdaBench, already counted in Sparred's fitness).
    event CanariesPassed(uint256 indexed epoch, uint64[] policies, uint8[] passed);
    /// @notice An attack plan entered the hall of fame at `slot` (it topped the close of `epoch`).
    event Archived(uint256 indexed epoch, uint64 indexed id, uint256 slot, uint256 lo, uint256 hi);
    /// @notice Every proposal's verdict, refused or not. `lost` and both fitnesses are ppm of the vault (the fitness
    ///         includes lambdaBench for each honest bench payment refused and each drain canary let through).
    event Proposed(
        address indexed proposer,
        uint64 indexed id,
        uint256 indexed epoch,
        uint256 lo,
        uint256 hi,
        uint8 verdict,
        uint256 honestRefused,
        uint256 lost,
        int256 fitness,
        int256 championFitness
    );

    // ------------------------------------------------------------------ errors
    error NotArena();
    error TooManyHonest();
    error ZeroAddress();

    constructor(address arena_, address firewall_, uint256[] memory bench_, uint256 lambdaBench_, uint256 insiderRep_) {
        if (arena_ == address(0) || firewall_ == address(0)) revert ZeroAddress();
        if (bench_.length > MAX_HONEST) revert TooManyHonest();
        arena = ICrucibleArena(arena_);
        firewall = ICrucibleFirewall(firewall_);
        honest = bench_;
        lambdaBench = lambdaBench_;
        insiderRep = insiderRep_ > 1000 ? 1000 : insiderRep_;
    }

    // ------------------------------------------------------------------ the simulation

    /// @notice How much of SIM_BALANCE attack genome (aLo, aHi) extracts from a vault guarded by policy (pLo, pHi).
    function extracted(uint256 pLo, uint256 pHi, uint256 aLo, uint256 aHi) public view returns (uint256) {
        return _bout(pLo, pHi, _decode(aLo, aHi));
    }

    /// @dev An attack genome's 8 steps, decoded once: [4*st] amountBps (0 = skip, capped 10000: sparring covers the
    ///      whole range up to the full vault), [4*st+1] recipient 0..3, [4*st+2] delay 0..100, [4*st+3] 1 if
    ///      routed through a contract.
    function _decode(uint256 aLo, uint256 aHi) internal pure returns (uint256[32] memory d) {
        assembly ("memory-safe") {
            for { let g := 0 } lt(g, 32) { g := add(g, 1) } {
                let w := aLo
                if gt(g, 15) { w := aHi }
                let v := signextend(1, shr(shl(4, and(g, 15)), w))
                let m := sar(255, v)
                v := sub(xor(v, m), m) // |gene|
                switch and(g, 3)
                case 0 { if gt(v, 10000) { v := 10000 } }
                case 1 { v := mod(v, 4) }
                case 2 { v := mod(v, 101) }
                default { v := iszero(iszero(mod(v, 3))) }
                mstore(add(d, shl(5, g)), v)
            }
        }
    }

    /// @dev One bout. Same rules as the reference version kept for the tests (helpers/SparReference.sol), checked
    ///      against it on random genomes. Written in assembly with the policy scored inline, one feature at a time
    ///      (no feature array, no call per step), which cuts the sparring's gas by about two fifths; that is what pays
    ///      for the canaries and the archive at every close. Every quantity is bounded (balance <= 1e6, at most 8 steps
    ///      of <= 100 blocks, every feature <= 1000), so nothing overflows.
    function _bout(uint256 lo, uint256 hi, uint256[32] memory d) internal view returns (uint256 taken) {
        uint256 rep = insiderRep;
        assembly ("memory-safe") {
            // bit `i` of `fired` when feature value `fu` passes its gate: threshold lane `i` of hi (t >= 0: fu >= t;
            // t < 0: fu < -t)
            function gate(fu, i, h) -> on {
                let t := signextend(1, shr(shl(4, i), h))
                let m := sar(255, t)
                on := shl(i, xor(iszero(m), lt(fu, sub(xor(t, m), m))))
            }
            // w_i * fu, w_i = lane i of lo
            function weight(fu, i, l) -> v {
                v := mul(signextend(1, shr(shl(4, i), l)), fu)
            }
            let bal := 1000000 // what is left; the bout's outflow is always 1000000 - bal
            let blk := 1000
            let ws := 0 // velocity window start
            let wc := 0 // requests in the window
            let last := 0
            // times paid, 64 bits each: self (bits 0-63), contract (64-127), the current fresh address (128-191);
            // bits 192-255 sum the held steps
            let paid := 0
            let prev := 0 // 0 self, 1 fresh, 2 contract
            // f4 (reputation) is the same at every step
            let raw4 := weight(rep, 4, lo)
            let fired4 := gate(rep, 4, hi)
            for { let p := d } lt(p, add(d, 1024)) { p := add(p, 128) } {
                let bps := mload(p)
                if bps {
                    let rec := mload(add(p, 32))
                    blk := add(blk, mload(add(p, 64)))
                    // "previous": the same counters as last time
                    if eq(rec, 3) {
                        switch prev
                        case 1 { rec := 3 }
                        case 2 { rec := 2 }
                        default { rec := 0 }
                    }
                    let amount := div(mul(bal, bps), 10000)
                    // f0 amount share
                    let fu := div(bps, 10)
                    let raw := add(raw4, weight(fu, 0, lo))
                    let fired := or(fired4, gate(fu, 0, hi))
                    // f1 novelty: a brand-new address, or 1000 / (1 + times this recipient was paid)
                    switch rec
                    case 1 { fu := 1000 }
                    case 0 { fu := div(1000, add(1, and(paid, 0xffffffffffffffff))) }
                    case 2 { fu := div(1000, add(1, and(shr(64, paid), 0xffffffffffffffff))) }
                    default { fu := div(1000, add(1, and(shr(128, paid), 0xffffffffffffffff))) }
                    raw := add(raw, weight(fu, 1, lo))
                    fired := or(fired, gate(fu, 1, hi))
                    // f2 velocity: requests in the 20-block window, 200 each, capped
                    fu := 0
                    if lt(blk, add(ws, 20)) {
                        fu := 1000
                        if lt(wc, 5) { fu := mul(wc, 200) }
                    }
                    raw := add(raw, weight(fu, 2, lo))
                    fired := or(fired, gate(fu, 2, hi))
                    // f3 gap since the last request, capped at 100 blocks
                    fu := 1000
                    if last {
                        let gap := sub(blk, last)
                        if lt(gap, 100) { fu := mul(gap, 10) }
                    }
                    raw := add(raw, weight(fu, 3, lo))
                    fired := or(fired, gate(fu, 3, hi))
                    // f5 call depth, f6 contract recipient
                    fu := mul(mload(add(p, 96)), 1000)
                    raw := add(raw, weight(fu, 5, lo))
                    fired := or(fired, gate(fu, 5, hi))
                    fu := mul(eq(rec, 2), 1000)
                    raw := add(raw, weight(fu, 6, lo))
                    fired := or(fired, gate(fu, 6, hi))
                    // f7 outflow this bout including the step
                    fu := div(mul(add(sub(1000000, bal), amount), 1000), 1000000)
                    if gt(fu, 1000) { fu := 1000 }
                    raw := add(raw, weight(fu, 7, lo))
                    fired := or(fired, gate(fu, 7, hi))
                    // interactions (GenomeLib.PAIRS): k0 (0,1) k1 (0,7) k2 (1,2) k3 (2,7) k4 (5,6) k5 (0,5) k6 (2,3) k7 (6,7)
                    if and(and(shr(0, fired), shr(1, fired)), 1) { raw := add(raw, mul(signextend(1, shr(128, lo)), 1000)) }
                    if and(and(shr(0, fired), shr(7, fired)), 1) { raw := add(raw, mul(signextend(1, shr(144, lo)), 1000)) }
                    if and(and(shr(1, fired), shr(2, fired)), 1) { raw := add(raw, mul(signextend(1, shr(160, lo)), 1000)) }
                    if and(and(shr(2, fired), shr(7, fired)), 1) { raw := add(raw, mul(signextend(1, shr(176, lo)), 1000)) }
                    if and(and(shr(5, fired), shr(6, fired)), 1) { raw := add(raw, mul(signextend(1, shr(192, lo)), 1000)) }
                    if and(and(shr(0, fired), shr(5, fired)), 1) { raw := add(raw, mul(signextend(1, shr(208, lo)), 1000)) }
                    if and(and(shr(2, fired), shr(3, fired)), 1) { raw := add(raw, mul(signextend(1, shr(224, lo)), 1000)) }
                    if and(and(shr(6, fired), shr(7, fired)), 1) { raw := add(raw, mul(signextend(1, shr(240, lo)), 1000)) }
                    switch sgt(raw, 500000)
                    case 0 {
                        // paid or held: either way it leaves what the next steps see, and counts in the outflow
                        bal := sub(bal, amount)
                        switch sgt(raw, 350000)
                        case 0 {
                            switch rec
                            case 0 { paid := add(paid, 1) }
                            case 1 { paid := or(and(paid, not(shl(128, 0xffffffffffffffff))), shl(128, 1)) }
                            case 2 { paid := add(paid, shl(64, 1)) }
                            default { paid := add(paid, shl(128, 1)) }
                        }
                        default {
                            // held: not paid yet (it counts half as taken), so its recipient is not paid either
                            paid := add(paid, shl(192, amount))
                            if eq(rec, 1) { paid := and(paid, not(shl(128, 0xffffffffffffffff))) }
                        }
                    }
                    default {
                        // refused: a fresh address stays unpaid
                        if eq(rec, 1) { paid := and(paid, not(shl(128, 0xffffffffffffffff))) }
                    }
                    prev := rec
                    if eq(rec, 3) { prev := 1 }
                    // velocity and gap count every request, refused or not (Vault._touchCaller)
                    switch lt(blk, add(ws, 20))
                    case 0 {
                        ws := blk
                        wc := 1
                    }
                    default { wc := add(wc, 1) }
                    last := blk
                }
            }
            // what left (paid, and held) minus half of what was only held
            taken := sub(sub(1000000, bal), shr(1, shr(192, paid)))
        }
    }

    /// @notice How many honest bench payments the policy would refuse.
    function honestRefusals(uint256 lo, uint256 hi) public view returns (uint256) {
        return _refusedCount(lo, hi, _unpackAll(honest));
    }

    /// @notice What the honest bench costs a policy (ppm of the vault) and how many of its payments it refuses.
    function benchCost(uint256 lo, uint256 hi) external view returns (uint256 cost, uint256 refused) {
        (refused, cost) = _benchCost(lo, hi, _unpackAll(honest));
    }

    /// @dev How many of the (decoded) feature vectors the policy refuses (a hold is not a refusal).
    function _refusedCount(uint256 lo, uint256 hi, uint256[8][] memory vs) internal pure returns (uint256 n) {
        for (uint256 h = 0; h < vs.length; h++) {
            if (_score(lo, hi, vs[h]) > 500000) n++;
        }
    }

    /// @dev Each bench payment the policy refuses costs 2 x its amount in ppm (f0 is per mille of
    ///      the vault) plus BENCH_FLOOR_PPM; each it holds costs a tenth of that.
    function _benchCost(uint256 lo, uint256 hi, uint256[8][] memory bench) internal view returns (uint256 refused, uint256 cost) {
        for (uint256 h = 0; h < bench.length; h++) {
            int256 raw = _score(lo, hi, bench[h]);
            if (raw <= HOLD_SCORE) continue;
            uint256 c = 2 * bench[h][0] * 1000 + BENCH_FLOOR_PPM;
            if (raw > 500000) {
                // a refused everyday payment costs lambdaBench when that is more: priced by the
                // payment alone, a bred child that refused a 1% payment but stopped a bigger attack won the crown in
                // 13 to 32 of 40 no-traffic closes in testing, so the champion turned honest payments away
                refused++;
                cost += c > lambdaBench ? c : lambdaBench;
            } else {
                cost += c / 10;
            }
        }
    }

    /// @dev Packed feature vectors (16-bit lanes, as Vault.packFeatures) decoded once, so each policy reuses them.
    function _unpackAll(uint256[] memory packed) internal pure returns (uint256[8][] memory vs) {
        vs = new uint256[8][](packed.length);
        for (uint256 h = 0; h < packed.length; h++) {
            uint256 p = packed[h];
            for (uint256 i = 0; i < 8; i++) vs[h][i] = (p >> (16 * i)) & 0xFFFF;
        }
    }

    // ------------------------------------------------------------------ drain canaries

    /// @notice The drain canaries (packed like the bench): drain-sized payments every candidate must refuse. A canary
    ///         a policy lets through costs it lambdaBench, like an honest bench payment it refuses.
    ///         Features: f0 amount, f1 novelty, f2 velocity, f3 gap, f4 reputation, f5 depth, f6 contract, f7 outflow.
    ///
    ///         A gate fires at one end of its feature (t >= 0 at the top, an inverted gate at the bottom), so a large
    ///         negative weight on an interaction is caught by any canary where both its gates fire. The Vault lets
    ///         at most half the vault out in one payment (f0 <= 500) or in one round (f7 <= 500). Levels: f0 and f7
    ///         low = BAND (26%), high = 500 (the most the Vault allows) or 1000; the others low = 0,
    ///         high = 1000. With the adaptive canary (whose search contains a stranger's first payment, so no fixed
    ///         row is needed for it) they cover all four low/high combinations of every interaction pair
    ///         (k0 f0·f1, k1 f0·f7, k2 f1·f2, k3 f2·f7, k4 f5·f6, k5 f0·f5, k6 f2·f3, k7 f6·f7), each feature's high end
    ///         (a large negative linear weight), and reputation both 0 (a stranger) and 500 (an insider). Some rows are
    ///         corners no single real payment produces (velocity high with a long gap, say): they exist so every gate
    ///         fires somewhere.
    ///           0  26% to a recipient paid over and over (novelty 0), through a contract, in a burst, by an insider
    ///           1  26% to a fresh contract, direct, quiet, with the round's outflow already high (it reaches the cap)
    ///           2  50%, the most one payment may take, to a fresh wallet, by an insider (velocity and gap both high)
    ///           3  50% to a recipient paid over and over, through a contract (velocity and gap both 0)
    ///           4  50% to a contract paid over and over, through a contract, in a burst, by an insider
    ///           5  the whole vault, to a contract paid over and over, through a contract, quiet (outflow held at 26%)
    ///         The discounts a payment can stack (a stranger's first payment through a fresh
    ///         agent contract, velocity 0, a long gap, to a fresh wallet or contract) are not fixed rows: the adaptive
    ///         canary is the lowest score over exactly those corners and every other one at 26%, and every candidate is
    ///         monotone in f0 and f7, so it also covers them at 35% (a test checks both). Fixed rows for them would
    ///         only cost each candidate four more scorings at every close.
    ///         Row 5 is the one above the Vault's limit: it costs one check a candidate and catches a back door keyed
    ///         on an amount the limit already refuses (for instance a gate at f0 >= 900, or one re-gated above
    ///         half the vault).
    ///         The adaptive canary (`adaptiveCanary`) is checked as well, as canary number CANARIES.
    function canaries() public pure returns (uint256[] memory c) {
        c = new uint256[](CANARIES);
        c[0] = _pk(BAND, 0, 1000, 0, 500, 1000, 0, BAND);
        c[1] = _pk(BAND, 1000, 0, 1000, 0, 0, 1000, 500);
        c[2] = _pk(500, 1000, 1000, 1000, 500, 0, 0, 500);
        c[3] = _pk(500, 0, 0, 0, 0, 1000, 0, 500);
        c[4] = _pk(500, 0, 1000, 0, 500, 1000, 1000, 500);
        c[5] = _pk(1000, 0, 0, 1000, 0, 1000, 1000, BAND);
    }

    /// @notice The adaptive canary. The lowest score the policy gives a stranger's payment (f4 = 0) of BAND of the
    ///         vault at BAND outflow (f0 = f7 = BAND), over every recipient novelty, velocity and gap (f1, f2, f3, each
    ///         anywhere in 0..1000) and both values of call depth and contract recipient (f5, f6 in {0, 1000}), and a
    ///         feature vector that scores it. The policy lets the canary through when `low` <= 500,000.
    ///
    ///         Exact: each feature's gate splits 0..1000 at |t| into [0, |t|-1] and [|t|, 1000], and
    ///         within one side the score is linear in the feature, so its lowest point there is an end (the low end
    ///         if the weight is >= 0, the high end if not): two candidate values per feature. With f0, f7 and f4 fixed,
    ///         the score splits into a part in (f1, f2, f3) (k0, k2, k3, k6 and their linear terms) plus a part in
    ///         (f5, f6) (k4, k5, k7 and theirs), so the minimum is the fixed part plus the minimum of each part (`_adaptive`,
    ///         which the close runs; this view scores all 32 combinations and returns one that reaches it).
    ///         (A back door's minimum can sit at a gap of exactly |t3| = 16 blocks, where no fixed canary,
    ///         sparring step or bench payment looks.)
    function adaptiveCanary(uint256 lo, uint256 hi) public pure returns (int256 low, uint256[8] memory f) {
        // a view: the 32 combinations scored one by one (the close uses `_adaptive`, which the tests check equals it)
        uint256[2] memory e1 = _ends(lo, hi, 1);
        uint256[2] memory e2 = _ends(lo, hi, 2);
        uint256[2] memory e3 = _ends(lo, hi, 3);
        uint256[8] memory x;
        (x[0], x[7]) = (BAND, BAND);
        low = type(int256).max;
        for (uint256 c = 0; c < 32; c++) {
            (x[1], x[2], x[3]) = (e1[c & 1], e2[(c >> 1) & 1], e3[(c >> 2) & 1]);
            (x[5], x[6]) = (((c >> 3) & 1) * 1000, (c >> 4) * 1000);
            int256 sc = _score(lo, hi, x);
            if (sc < low) {
                low = sc;
                for (uint256 i = 0; i < 8; i++) f[i] = x[i];
            }
        }
    }

    /// @notice The adaptive canary's lowest score as the close works it out (`_adaptive`); equal to
    ///         `adaptiveCanary`'s `low`, for a fraction of the gas.
    function adaptiveLow(uint256 lo, uint256 hi) external pure returns (int256) {
        return _adaptive(lo, hi);
    }

    /// @dev The adaptive canary's lowest score (`adaptiveCanary`'s `low`), worked out in a few dozen operations: the
    ///      close runs it for every candidate. Part A is minimised over f2's two values, with f1's and f3's best value
    ///      for each (k2 and k6 need f2's gate); part B over f6's two values, with f5's best for each (k4 needs f6's
    ///      gate). The same integer math as `_score`; every quantity is bounded (16 terms of |gene| <= 32768 times
    ///      1000), so nothing overflows.
    function _adaptive(uint256 lo, uint256 hi) internal pure returns (int256 low) {
        assembly ("memory-safe") {
            // signed lane i of a genome word
            function lane(w, i) -> v {
                v := signextend(1, shr(shl(4, i), w))
            }
            // 1 when feature i's gate fires at x (0 <= x <= 1000): t >= 0 fires when x >= t, t < 0 when x < -t
            function gate(h, i, x) -> on {
                let t := lane(h, i)
                on := iszero(slt(x, t))
                if slt(t, 0) { on := slt(x, sub(0, t)) }
            }
            function smin(x, y) -> m {
                m := x
                if slt(y, x) { m := y }
            }
            // feature i's two candidate values (`_end2`) as linear terms l0, l1 and gates q0, q1
            function opts(l, h, i) -> l0, l1, q0, q1 {
                let w := lane(l, i)
                let m := lane(h, i)
                if slt(m, 0) { m := sub(0, m) }
                let e0 := 0
                let e1 := 0
                switch or(iszero(m), gt(m, 1000))
                case 1 {
                    if slt(w, 0) { e0 := 1000 }
                    e1 := e0
                }
                default {
                    e1 := m
                    if slt(w, 0) {
                        e0 := sub(m, 1)
                        e1 := 1000
                    }
                }
                l0 := mul(w, e0)
                l1 := mul(w, e1)
                q0 := gate(h, i, e0)
                q1 := gate(h, i, e1)
            }
            let g0 := gate(hi, 0, 260) // BAND
            let g7 := gate(hi, 7, 260)
            // the fixed part: f0 and f7 at the band, f4 = 0, and k1 (f0, f7)
            low := mul(add(lane(lo, 0), lane(lo, 7)), 260)
            if and(g0, g7) { low := add(low, mul(lane(lo, 9), 1000)) }
            // part A: f1, f2, f3 with k0 (f0, f1), k2 (f1, f2), k3 (f2, f7), k6 (f2, f3)
            {
                let l10, l11, q10, q11 := opts(lo, hi, 1)
                let l30, l31, q30, q31 := opts(lo, hi, 3)
                let v0 := mul(mul(lane(lo, 8), 1000), g0)
                let v2 := mul(lane(lo, 10), 1000)
                let v6 := mul(lane(lo, 14), 1000)
                l10 := add(l10, mul(v0, q10))
                l11 := add(l11, mul(v0, q11))
                // f1's and f3's best with f2's gate shut, then open (k2 and k6 fire only with it)
                let shut := add(smin(l10, l11), smin(l30, l31))
                let open := add(smin(add(l10, mul(v2, q10)), add(l11, mul(v2, q11))), smin(add(l30, mul(v6, q30)), add(l31, mul(v6, q31))))
                let l20, l21, q20, q21 := opts(lo, hi, 2)
                let v3open := add(mul(mul(lane(lo, 11), 1000), g7), open)
                let a0 := add(l20, shut)
                if q20 { a0 := add(l20, v3open) }
                let a1 := add(l21, shut)
                if q21 { a1 := add(l21, v3open) }
                low := add(low, smin(a0, a1))
            }
            // part B: f5, f6 in {0, 1000} with k4 (f5, f6), k5 (f0, f5), k7 (f6, f7)
            {
                let v4 := mul(lane(lo, 12), 1000)
                let v5 := mul(mul(lane(lo, 13), 1000), g0)
                let q50 := gate(hi, 5, 0)
                let q51 := gate(hi, 5, 1000)
                let l50 := mul(v5, q50)
                let l51 := add(mul(lane(lo, 5), 1000), mul(v5, q51))
                let shut := smin(l50, l51)
                let open := smin(add(l50, mul(v4, q50)), add(l51, mul(v4, q51)))
                let v7 := mul(mul(lane(lo, 15), 1000), g7)
                let l61 := mul(lane(lo, 6), 1000)
                let b0 := shut
                if gate(hi, 6, 0) { b0 := add(v7, open) }
                let b1 := add(l61, shut)
                if gate(hi, 6, 1000) { b1 := add(add(l61, v7), open) }
                low := add(low, smin(b0, b1))
            }
        }
    }

    /// @dev Signed 16-bit lane `i` of a genome word.
    function _lane(uint256 word, uint256 i) internal pure returns (int256) {
        return int256(int16(uint16(word >> (16 * i))));
    }

    /// @dev Feature i's two candidate values for the adaptive canary: the lowest-scoring end of [0, |t|-1] and of
    ///      [|t|, 1000] (the same value twice when the gate is constant over 0..1000: t = 0 or |t| > 1000).
    function _ends(uint256 lo, uint256 hi, uint256 i) internal pure returns (uint256[2] memory v) {
        (v[0], v[1]) = _end2(lo, hi, i);
    }

    function _end2(uint256 lo, uint256 hi, uint256 i) internal pure returns (uint256 v0, uint256 v1) {
        int256 w = _lane(lo, i);
        int256 t = _lane(hi, i);
        uint256 m = uint256(t < 0 ? -t : t);
        if (m == 0 || m > 1000) {
            v0 = w < 0 ? 1000 : 0;
            return (v0, v0);
        }
        unchecked {
            v0 = w < 0 ? m - 1 : 0;
        }
        v1 = w < 0 ? 1000 : m;
    }

    /// @notice How many drain canaries a policy lets through, and which (bit i = canary i; bit CANARIES = the
    ///         adaptive canary).
    function canaryPasses(uint256 lo, uint256 hi) public pure returns (uint256 n, uint256 mask) {
        uint256[8][] memory cs = _unpackAll(canaries());
        for (uint256 i = 0; i < cs.length; i++) {
            // a canary must be refused: one the policy would only hold counts as let through
            if (_score(lo, hi, cs[i]) <= 500000) {
                n++;
                mask |= 1 << i;
            }
        }
        int256 low = _adaptive(lo, hi);
        if (low <= 500000) {
            n++;
            mask |= 1 << CANARIES;
        }
    }

    /// @dev How many canaries (the fixed ones, then the adaptive one) a policy lets through.
    function _drains(uint256 lo, uint256 hi, uint256[8][] memory cans) internal pure returns (uint256 d) {
        d = cans.length - _refusedCount(lo, hi, cans);
        int256 low = _adaptive(lo, hi);
        if (low <= 500000) d++;
    }

    function _pk(uint256 f0, uint256 f1, uint256 f2, uint256 f3, uint256 f4, uint256 f5, uint256 f6, uint256 f7)
        internal
        pure
        returns (uint256)
    {
        return f0 | (f1 << 16) | (f2 << 32) | (f3 << 48) | (f4 << 64) | (f5 << 80) | (f6 << 96) | (f7 << 112);
    }

    /// @notice Whether a policy refuses a feature vector: exactly GenomeLib.refusesFast (and so Firewall.evaluate's
    ///         verdict), checked against it over random genomes in the tests.
    function refuses(uint256 lo, uint256 hi, uint256[8] memory f) external pure returns (bool) {
        return _score(lo, hi, f) > 500000;
    }

    /// @dev GenomeLib.scoreFast in assembly, unrolled (about half the gas of a loop; the bench and the canaries
    ///      run it 17 times per candidate per close). Returns the raw score; refuse iff it is > 500,000, hold iff
    ///      it is > 350,000 and not above that.
    ///      score = sum_i w_i * min(f_i, 1000) + sum_k v_k * 1000 * gate(a_k) * gate(b_k).
    ///      w_i = lane i of lo, v_k = lane 8+k of lo, t_i = lane i of hi (t >= 0: fires when f >= t; t < 0: f < -t).
    function _score(uint256 lo, uint256 hi, uint256[8] memory f) internal pure returns (int256 raw) {
        assembly ("memory-safe") {
            let fired := 0
            {
                let fu := mload(add(f, 0))
                if gt(fu, 1000) { fu := 1000 }
                raw := add(raw, mul(signextend(1, shr(0, lo)), fu))
                let t := signextend(1, shr(0, hi))
                let m := sar(255, t)
                fired := or(fired, shl(0, xor(iszero(m), lt(fu, sub(xor(t, m), m)))))
            }
            {
                let fu := mload(add(f, 32))
                if gt(fu, 1000) { fu := 1000 }
                raw := add(raw, mul(signextend(1, shr(16, lo)), fu))
                let t := signextend(1, shr(16, hi))
                let m := sar(255, t)
                fired := or(fired, shl(1, xor(iszero(m), lt(fu, sub(xor(t, m), m)))))
            }
            {
                let fu := mload(add(f, 64))
                if gt(fu, 1000) { fu := 1000 }
                raw := add(raw, mul(signextend(1, shr(32, lo)), fu))
                let t := signextend(1, shr(32, hi))
                let m := sar(255, t)
                fired := or(fired, shl(2, xor(iszero(m), lt(fu, sub(xor(t, m), m)))))
            }
            {
                let fu := mload(add(f, 96))
                if gt(fu, 1000) { fu := 1000 }
                raw := add(raw, mul(signextend(1, shr(48, lo)), fu))
                let t := signextend(1, shr(48, hi))
                let m := sar(255, t)
                fired := or(fired, shl(3, xor(iszero(m), lt(fu, sub(xor(t, m), m)))))
            }
            {
                let fu := mload(add(f, 128))
                if gt(fu, 1000) { fu := 1000 }
                raw := add(raw, mul(signextend(1, shr(64, lo)), fu))
                let t := signextend(1, shr(64, hi))
                let m := sar(255, t)
                fired := or(fired, shl(4, xor(iszero(m), lt(fu, sub(xor(t, m), m)))))
            }
            {
                let fu := mload(add(f, 160))
                if gt(fu, 1000) { fu := 1000 }
                raw := add(raw, mul(signextend(1, shr(80, lo)), fu))
                let t := signextend(1, shr(80, hi))
                let m := sar(255, t)
                fired := or(fired, shl(5, xor(iszero(m), lt(fu, sub(xor(t, m), m)))))
            }
            {
                let fu := mload(add(f, 192))
                if gt(fu, 1000) { fu := 1000 }
                raw := add(raw, mul(signextend(1, shr(96, lo)), fu))
                let t := signextend(1, shr(96, hi))
                let m := sar(255, t)
                fired := or(fired, shl(6, xor(iszero(m), lt(fu, sub(xor(t, m), m)))))
            }
            {
                let fu := mload(add(f, 224))
                if gt(fu, 1000) { fu := 1000 }
                raw := add(raw, mul(signextend(1, shr(112, lo)), fu))
                let t := signextend(1, shr(112, hi))
                let m := sar(255, t)
                fired := or(fired, shl(7, xor(iszero(m), lt(fu, sub(xor(t, m), m)))))
            }
            // interaction k fires when both gates of its pair do (GenomeLib.PAIRS):
            // k0 (0,1) k1 (0,7) k2 (1,2) k3 (2,7) k4 (5,6) k5 (0,5) k6 (2,3) k7 (6,7)
            if and(and(shr(0, fired), shr(1, fired)), 1) { raw := add(raw, mul(signextend(1, shr(128, lo)), 1000)) }
            if and(and(shr(0, fired), shr(7, fired)), 1) { raw := add(raw, mul(signextend(1, shr(144, lo)), 1000)) }
            if and(and(shr(1, fired), shr(2, fired)), 1) { raw := add(raw, mul(signextend(1, shr(160, lo)), 1000)) }
            if and(and(shr(2, fired), shr(7, fired)), 1) { raw := add(raw, mul(signextend(1, shr(176, lo)), 1000)) }
            if and(and(shr(5, fired), shr(6, fired)), 1) { raw := add(raw, mul(signextend(1, shr(192, lo)), 1000)) }
            if and(and(shr(0, fired), shr(5, fired)), 1) { raw := add(raw, mul(signextend(1, shr(208, lo)), 1000)) }
            if and(and(shr(2, fired), shr(3, fired)), 1) { raw := add(raw, mul(signextend(1, shr(224, lo)), 1000)) }
            if and(and(shr(6, fired), shr(7, fired)), 1) { raw := add(raw, mul(signextend(1, shr(240, lo)), 1000)) }
        }
    }

    /// @dev Sparring score (ppm) of one policy against the given (decoded) attack genomes, bench (priced by payment)
    ///      and canaries (lambdaBench each let through).
    function _spar(uint256 lo, uint256 hi, uint256[32][] memory dec, uint256[8][] memory bench, uint256[8][] memory cans)
        internal
        view
        returns (int256 fitness, uint256 hon, uint256 lost, uint256 drains)
    {
        uint256 na = dec.length;
        for (uint256 k = 0; k < na; k++) lost += _bout(lo, hi, dec[k]);
        if (na > 0) lost /= na;
        uint256 cost;
        (hon, cost) = _benchCost(lo, hi, bench);
        drains = _drains(lo, hi, cans);
        fitness = -int256(lost) - int256(cost + lambdaBench * drains);
    }

    // ------------------------------------------------------------------ the arena's close

    /// @notice Called by the Arena at every close with its whole policy pool, its attack pool and its archive of
    ///         past strong attack plans. Returns each candidate's sparring score and each attack genome's average take
    ///         (attack-pool order), in wei of `startBalance`.
    function grade(
        uint256 epoch,
        uint256 startBalance,
        uint64[] memory policyIds,
        uint256[] memory policyLo,
        uint256[] memory policyHi,
        uint64[] memory attackIds,
        uint256[] memory attackLo,
        uint256[] memory attackHi
    ) external returns (int256[] memory policyFitness, uint256[] memory attackTake) {
        if (msg.sender != address(arena)) revert NotArena();
        (int256[] memory fit, uint8[] memory hon, uint8[] memory drains, uint256[] memory take, bool anyDrain) =
            _bouts(policyLo, policyHi, attackLo, attackHi);
        emit Sparred(epoch, policyIds, fit, hon, attackIds, take);
        if (anyDrain) emit CanariesPassed(epoch, policyIds, drains);
        policyFitness = new int256[](fit.length);
        attackTake = new uint256[](take.length);
        for (uint256 j = 0; j < fit.length; j++) policyFitness[j] = (fit[j] * int256(startBalance)) / int256(SIM_BALANCE);
        for (uint256 k = 0; k < take.length; k++) attackTake[k] = (take[k] * startBalance) / SIM_BALANCE;
        _archiveTop(epoch, attackIds, attackLo, attackHi, attackTake);
    }

    /// @dev The plan that topped this close (real extraction plus sparring take, as the Arena ranks attackers; the
    ///      first on a tie) enters the hall of fame, replacing the oldest entry, unless it is already there.
    function _archiveTop(uint256 epoch, uint64[] memory ids, uint256[] memory al, uint256[] memory ah, uint256[] memory take)
        internal
    {
        if (ids.length == 0) return;
        uint256 top;
        uint256 best;
        for (uint256 k = 0; k < ids.length; k++) {
            uint256 sc = arena.attackExtracted(epoch, ids[k]) + take[k];
            if (k == 0 || sc > best) (top, best) = (k, sc);
        }
        (uint256 lo, uint256 hi) = (al[top], ah[top]);
        uint256 n = archiveCount;
        for (uint256 k = 0; k < n; k++) {
            if (archive[k][0] == lo && archive[k][1] == hi) return;
        }
        uint256 slot = archiveNext;
        archive[slot] = [lo, hi];
        archiveNext = (slot + 1) % SIM_ARCHIVE;
        if (n < SIM_ARCHIVE) archiveCount = n + 1;
        emit Archived(epoch, ids[top], slot, lo, hi);
    }

    /// @notice The hall of fame in slot order (a ring; the next entry replaces slot `archiveNext`).
    function getArchive() public view returns (uint256[] memory lo, uint256[] memory hi) {
        uint256 n = archiveCount;
        lo = new uint256[](n);
        hi = new uint256[](n);
        for (uint256 k = 0; k < n; k++) (lo[k], hi[k]) = (archive[k][0], archive[k][1]);
    }

    /// @dev Every policy against the first SIM_ATTACKS attack genomes, the archive, the bench and the canaries (all in
    ///      ppm of the vault). `take` is reported for the attack pool only (it ranks the attackers' evolution).
    function _bouts(uint256[] memory pl, uint256[] memory ph, uint256[] memory al, uint256[] memory ah)
        internal
        view
        returns (int256[] memory fit, uint8[] memory hon, uint8[] memory drains, uint256[] memory take, bool anyDrain)
    {
        uint256 np = pl.length;
        uint256 na = al.length < SIM_ATTACKS ? al.length : SIM_ATTACKS;
        uint256[8][] memory bench = _unpackAll(honest);
        uint256[8][] memory cans = _unpackAll(canaries());
        (uint256[] memory xl, uint256[] memory xh) = getArchive();
        (uint256[] memory sl, uint256[] memory sh) = _withArchive(al, ah, na, xl, xh);
        uint256 nx = sl.length - na;
        uint256[32][] memory dec = new uint256[32][](na + nx);
        for (uint256 k = 0; k < na + nx; k++) dec[k] = _decode(sl[k], sh[k]);
        fit = new int256[](np);
        hon = new uint8[](np);
        drains = new uint8[](np);
        take = new uint256[](al.length);
        for (uint256 j = 0; j < np; j++) {
            uint256 lost;
            for (uint256 k = 0; k < na + nx; k++) {
                uint256 x = _bout(pl[j], ph[j], dec[k]);
                lost += x;
                if (k < na) take[k] += x;
            }
            if (na + nx > 0) lost /= na + nx;
            (uint256 h, uint256 cost) = _benchCost(pl[j], ph[j], bench);
            uint256 d = _drains(pl[j], ph[j], cans);
            hon[j] = uint8(h);
            drains[j] = uint8(d);
            if (d > 0) anyDrain = true;
            fit[j] = -int256(lost) - int256(cost + lambdaBench * d);
        }
        if (np > 0) for (uint256 k = 0; k < na; k++) take[k] /= np;
    }

    // ------------------------------------------------------------------ proposals (the queen, or anyone)

    /// @notice Offer a policy. If the current epoch is overdue it is closed first (you are tipped), then the
    ///         genome is played against the current attackers (and the archive) and the honest bench in this
    ///         transaction and the verdict is recorded. It enters the shadow pool, without a stake, only if it is
    ///         monotone in amount and outflow (GenomeLib.monotone), refuses no honest bench payment, lets no drain
    ///         canary through, and lets the attackers take no more than the live champion does. Free apart from gas; refusals are recorded, not reverted.
    /// @return verdict OK, REFUSED_HONEST, REFUSED_WEAK, REFUSED_ALREADY, REFUSED_FULL, REFUSED_DRAIN or
    ///                 REFUSED_NOT_MONOTONE
    /// @return id      the new policy's id in the Arena (0 if refused)
    function propose(uint256 lo, uint256 hi) external returns (uint8 verdict, uint64 id) {
        arena.poke(msg.sender);
        uint256 e = arena.currentEpoch();
        (int256 fit, uint256 hon, uint256 lost, int256 champ, uint256 drains) = _screen(lo, hi);
        if (arena.policySubmitted(e, msg.sender)) verdict = REFUSED_ALREADY;
        else if (arena.getPool().length >= MAX_CANDIDATES) verdict = REFUSED_FULL;
        else verdict = _verdict(lo, hi, fit, hon, champ, drains);
        if (verdict == OK) id = arena.enterProposal(lo, hi, msg.sender);
        proposals++;
        if (verdict != OK) proposalsRefused++;
        emit Proposed(msg.sender, id, e, lo, hi, verdict, hon, lost, fit, champ);
    }

    /// @notice The screen's verdict on a genome, without entering or recording anything: OK,
    ///         REFUSED_NOT_MONOTONE, REFUSED_HONEST, REFUSED_DRAIN or REFUSED_WEAK, checked in that order. The Arena asks
    ///         it before a staked policy may enter the pool; anyone can use it to predict `propose`.
    function screenVerdict(uint256 lo, uint256 hi) external view returns (uint8) {
        (int256 fit, uint256 hon,, int256 champ, uint256 drains) = _screen(lo, hi);
        return _verdict(lo, hi, fit, hon, champ, drains);
    }

    /// @dev Monotonicity first: a policy that judges a bigger payment more leniently is refused as written, not
    ///      edited (bred children, which nobody wrote, are clamped at birth instead).
    function _verdict(uint256 lo, uint256 hi, int256 fit, uint256 hon, int256 champ, uint256 drains)
        internal
        pure
        returns (uint8)
    {
        if (!GenomeLib.isMonotone(lo, hi)) return REFUSED_NOT_MONOTONE;
        if (hon > 0) return REFUSED_HONEST;
        if (drains > 0) return REFUSED_DRAIN;
        if (fit < champ) return REFUSED_WEAK;
        return OK;
    }

    /// @notice Free preview of `propose`: the genome's sparring score against the current attackers and the
    ///         bench (the canaries included), the live champion's, and what each attack plan sparred takes from it
    ///         (the first SIM_ATTACKS of the attack pool, then the archive). `canaryPasses` tells which canaries.
    function screen(uint256 lo, uint256 hi)
        external
        view
        returns (int256 fitness, uint256 honestRefused, uint256 lost, int256 championFitness, uint256[] memory perAttack)
    {
        (fitness, honestRefused, lost, championFitness,) = _screen(lo, hi);
        uint256[32][] memory dec = _attackGenomes();
        perAttack = new uint256[](dec.length);
        for (uint256 k = 0; k < dec.length; k++) perAttack[k] = _bout(lo, hi, dec[k]);
    }

    function _screen(uint256 lo, uint256 hi)
        internal
        view
        returns (int256 fitness, uint256 honestRefused, uint256 lost, int256 championFitness, uint256 drains)
    {
        uint256[32][] memory dec = _attackGenomes();
        uint256[8][] memory bench = _unpackAll(honest);
        uint256[8][] memory cans = _unpackAll(canaries());
        (fitness, honestRefused, lost, drains) = _spar(lo, hi, dec, bench, cans);
        (uint256 cLo, uint256 cHi,,) = firewall.exportGenome();
        (championFitness,,,) = _spar(cLo, cHi, dec, bench, cans);
    }

    /// @dev The first SIM_ATTACKS attack genomes of the Arena's pool, then its archive, decoded.
    function _attackGenomes() internal view returns (uint256[32][] memory dec) {
        uint64[] memory ids = arena.getAttackPool();
        uint256 n = ids.length < SIM_ATTACKS ? ids.length : SIM_ATTACKS;
        uint256[] memory al = new uint256[](n);
        uint256[] memory ah = new uint256[](n);
        for (uint256 k = 0; k < n; k++) {
            ICrucibleArena.AttackGenome memory a = arena.getAttack(ids[k]);
            (al[k], ah[k]) = (a.lo, a.hi);
        }
        (uint256[] memory xl, uint256[] memory xh) = getArchive();
        (uint256[] memory sl, uint256[] memory sh) = _withArchive(al, ah, n, xl, xh);
        dec = new uint256[32][](sl.length);
        for (uint256 k = 0; k < sl.length; k++) dec[k] = _decode(sl[k], sh[k]);
    }

    /// @dev The first `na` attack plans followed by the archived plans (at most SIM_ARCHIVE) that are not already
    ///      among them, so a plan is never sparred twice.
    function _withArchive(uint256[] memory al, uint256[] memory ah, uint256 na, uint256[] memory xl, uint256[] memory xh)
        internal
        pure
        returns (uint256[] memory sl, uint256[] memory sh)
    {
        uint256 nx = xl.length < SIM_ARCHIVE ? xl.length : SIM_ARCHIVE;
        bool[] memory dup = new bool[](nx);
        uint256 m = na;
        for (uint256 x = 0; x < nx; x++) {
            for (uint256 k = 0; k < na; k++) {
                if (al[k] == xl[x] && ah[k] == xh[x]) {
                    dup[x] = true;
                    break;
                }
            }
            if (!dup[x]) m++;
        }
        sl = new uint256[](m);
        sh = new uint256[](m);
        for (uint256 k = 0; k < na; k++) (sl[k], sh[k]) = (al[k], ah[k]);
        m = na;
        for (uint256 x = 0; x < nx; x++) {
            if (!dup[x]) {
                (sl[m], sh[m]) = (xl[x], xh[x]);
                m++;
            }
        }
    }

    function honestBench() external view returns (uint256[] memory) {
        return honest;
    }

    // ------------------------------------------------------------------ internals

    function _abs(int16 x) internal pure returns (uint256) {
        return x < 0 ? uint256(-int256(x)) : uint256(int256(x));
    }

}
