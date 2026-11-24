// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title GenomeLib — the 32-gene policy/attack genome and its deterministic scoring + breeding.
/// @notice A genome is `int16[32]` packed into two uint256 words: genes 0..15 live in `lo`
///         (gene i at bits [16*i, 16*i+16)), genes 16..31 live in `hi`.
///
///         Policy layout
///           genes  0..7   w_i   linear weight on feature f_i
///           genes  8..15  v_k   interaction weight on the feature pair PAIR(k)
///           genes 16..23  t_i   step threshold for feature f_i
///                               t >= 0  : step fires when f_i >= t
///                               t <  0  : step fires when f_i <  |t|  (inverted gate, lets evolution flip direction)
///           genes 24..31  reserved (inherited and crossed over, never scored, never mutated)
///
///         score = sum_i w_i * f_i  +  sum_k v_k * 1000 * step(f_a, t_a) * step(f_b, t_b)
///         refuse  iff  score > GLOBAL_THRESHOLD
///
///         Every feature is a uint in 0..1000. All math is integer and deterministic.
///         Interaction pairs PAIR(k) = (a, b):
///           k0 (f0 amount,   f1 novelty)     big payment to a stranger
///           k1 (f0 amount,   f7 outflow)     big payment late in a draining epoch
///           k2 (f1 novelty,  f2 velocity)    new-recipient burst
///           k3 (f2 velocity, f7 outflow)     salami slicing
///           k4 (f5 depth,    f6 contract)    contract hop through an agent
///           k5 (f0 amount,   f5 depth)       delegated drain
///           k6 (f2 velocity, f3 gap)         rapid repeat
///           k7 (f6 contract, f7 outflow)     contract sink under outflow pressure
library GenomeLib {
    uint256 internal constant GENES = 32;
    uint256 internal constant FEATURES = 8;
    uint256 internal constant FEATURE_MAX = 1000;
    int256 internal constant GLOBAL_THRESHOLD = 500_000;
    /// @dev A score above this (and not above GLOBAL_THRESHOLD) holds the payment for a delay the owner or a
    ///      guardian can veto, instead of paying it. Fixed, not evolved.
    int256 internal constant HOLD_THRESHOLD = 350_000;
    uint8 internal constant PAY = 0;
    uint8 internal constant HOLD = 1;
    uint8 internal constant REFUSE = 2;
    int256 internal constant INTERACTION_SCALE = 1000;
    /// @dev byte k = (a << 4) | b for interaction pair k.
    uint256 internal constant PAIRS = 0x6723055627120701;
    /// @dev Policies only mutate the 24 scored genes; attack genomes mutate all 32.
    uint256 internal constant POLICY_ACTIVE_GENES = 24;
    uint256 internal constant ATTACK_ACTIVE_GENES = 32;

    function gene(uint256 lo, uint256 hi, uint256 i) internal pure returns (int16) {
        uint256 word = i < 16 ? lo : hi;
        return int16(uint16(word >> ((i & 15) * 16)));
    }

    function withGene(uint256 lo, uint256 hi, uint256 i, int16 v) internal pure returns (uint256, uint256) {
        uint256 shift = (i & 15) * 16;
        uint256 mask = ~(uint256(0xFFFF) << shift);
        uint256 bits = uint256(uint16(v)) << shift;
        if (i < 16) lo = (lo & mask) | bits;
        else hi = (hi & mask) | bits;
        return (lo, hi);
    }

    function pack(int16[32] memory g) internal pure returns (uint256 lo, uint256 hi) {
        for (uint256 i = 0; i < 16; i++) {
            lo |= uint256(uint16(g[i])) << (i * 16);
            hi |= uint256(uint16(g[i + 16])) << (i * 16);
        }
    }

    function unpack(uint256 lo, uint256 hi) internal pure returns (int16[32] memory g) {
        for (uint256 i = 0; i < 32; i++) g[i] = gene(lo, hi, i);
    }

    function pairOf(uint256 k) internal pure returns (uint256 a, uint256 b) {
        uint256 by = (PAIRS >> (k * 8)) & 0xFF;
        a = by >> 4;
        b = by & 0x0F;
    }

    /// @notice Full evaluation with per-term breakdown.
    /// @return refused  score > GLOBAL_THRESHOLD
    /// @return reason   bitmask: bit i (0..7) = linear term of f_i was a significant positive contributor,
    ///                  bit 8+k = interaction k fired with positive weight. Zero when paid; set on a hold too,
    ///                  as `verdict` and Firewall.judge do.
    /// @return score    max(raw, 0)
    /// @return raw      signed raw score
    /// @return terms    the 16 signed contributions (8 linear, 8 interaction)
    function explain(uint256 lo, uint256 hi, uint256[8] memory f)
        internal
        pure
        returns (bool refused, uint256 reason, uint256 score, int256 raw, int256[16] memory terms)
    {
        uint256 fired;
        for (uint256 i = 0; i < 8; i++) {
            uint256 fu = f[i] > FEATURE_MAX ? FEATURE_MAX : f[i];
            int256 fi = int256(fu);
            terms[i] = int256(gene(lo, hi, i)) * fi;
            raw += terms[i];
            int256 t = int256(gene(lo, hi, 16 + i));
            bool on = t >= 0 ? fi >= t : fi < -t;
            if (on) fired |= (uint256(1) << i);
        }
        for (uint256 k = 0; k < 8; k++) {
            (uint256 a, uint256 b) = pairOf(k);
            if ((fired >> a) & 1 == 1 && (fired >> b) & 1 == 1) {
                terms[8 + k] = int256(gene(lo, hi, 8 + k)) * INTERACTION_SCALE;
                raw += terms[8 + k];
            }
        }
        refused = raw > GLOBAL_THRESHOLD;
        score = raw > 0 ? uint256(raw) : 0;
        if (raw > HOLD_THRESHOLD) {
            int256 cut = raw / 8;
            for (uint256 j = 0; j < 16; j++) {
                if (terms[j] > 0 && terms[j] >= cut) reason |= (uint256(1) << j);
            }
        }
    }

    function evaluate(uint256 lo, uint256 hi, uint256[8] memory f)
        internal
        pure
        returns (bool refused, uint256 reason, uint256 score)
    {
        (refused, reason, score,,) = explain(lo, hi, f);
    }

    /// @notice Cheap refuse-only check used for shadow scoring (no reason decode).
    /// @dev Unchecked is safe: |gene * feature| <= 32768 * 1000 and at most 16 such terms are summed.
    ///      Weights are lanes 0..7 of `lo`, interaction weights lanes 8..15 of `lo`, thresholds lanes 0..7 of `hi`.
    function refusesFast(uint256 lo, uint256 hi, uint256[8] memory f) internal pure returns (bool) {
        return scoreFast(lo, hi, f) > GLOBAL_THRESHOLD;
    }

    /// @notice The three verdicts. PAY when score <= HOLD_THRESHOLD, HOLD when HOLD_THRESHOLD < score <=
    ///         GLOBAL_THRESHOLD, REFUSE above. On a hold the reason bits are worked out as on a refusal.
    function verdict(uint256 lo, uint256 hi, uint256[8] memory f) internal pure returns (uint8 v, uint256 reason, uint256 score) {
        (, , , int256 raw, int256[16] memory terms) = explain(lo, hi, f);
        score = raw > 0 ? uint256(raw) : 0;
        if (raw > GLOBAL_THRESHOLD) v = REFUSE;
        else if (raw > HOLD_THRESHOLD) v = HOLD;
        else return (PAY, 0, score);
        int256 cut = raw / 8;
        for (uint256 j = 0; j < 16; j++) {
            if (terms[j] > 0 && terms[j] >= cut) reason |= (uint256(1) << j);
        }
    }

    /// @notice The raw score (the cheap scorer used for shadow verdicts).
    function scoreFast(uint256 lo, uint256 hi, uint256[8] memory f) internal pure returns (int256) {
        unchecked {
            int256 raw;
            uint256 fired;
            for (uint256 i = 0; i < 8; ++i) {
                uint256 fu = f[i];
                if (fu > FEATURE_MAX) fu = FEATURE_MAX;
                int256 fi = int256(fu);
                raw += int256(int16(uint16(lo >> (i * 16)))) * fi;
                int256 t = int256(int16(uint16(hi >> (i * 16))));
                if (t >= 0 ? fi >= t : fi < -t) fired |= (uint256(1) << i);
            }
            if (fired != 0) {
                for (uint256 k = 0; k < 8; ++k) {
                    uint256 by = (PAIRS >> (k * 8)) & 0xFF;
                    if ((fired >> (by >> 4)) & 1 == 1 && (fired >> (by & 0x0F)) & 1 == 1) {
                        raw += int256(int16(uint16(lo >> ((8 + k) * 16)))) * INTERACTION_SCALE;
                    }
                }
            }
            return raw;
        }
    }

    // ------------------------------------------------------------------ monotone in amount and outflow

    /// @notice Whether a policy's score can never fall when f0 (the payment's share of the vault) or f7 (the
    ///         round's outflow) rises, everything else equal: a bigger payment, or one later in a draining round, is
    ///         never judged more leniently. That holds exactly when
    ///           w0 >= 0 and w7 >= 0, and
    ///           every interaction on f0 (k0, k1, k5) or f7 (k1, k3, k7) has the sign of that feature's gate: a gate that
    ///           opens as the feature rises (0 < t <= 1000) needs v >= 0; one that closes as it rises (-1000 <= t < 0,
    ///           fires below |t|) needs v <= 0 (a discount for small payments stays legal, one for big payments does
    ///           not). A gate that never changes over 0..1000 (t = 0, t > 1000 or t < -1000) puts no condition on v.
    ///           k1 uses both features, so both of its gates must agree, or v1 must be 0.
    ///         A genome that breaks it can pass a 21-23% payment where a 20% one is refused. The scoring itself is not
    ///         changed by this rule.
    ///         The same rule applies to f5 (sent through a contract) and f6 (paid to a contract): a hop
    ///         through a contract must never make a payment look safer. So w5 >= 0 and w6 >= 0, and k4 (f5, f6), k5
    ///         (f0, f5) and k7 (f6, f7) also take the sign of their f5 / f6 gates (a negative w5 would let a
    ///         large payment through a fresh agent contract).
    /// @return clampedLo `lo` with every weight that breaks the rule set to 0 (thresholds and the rest untouched)
    /// @return changed   whether any weight was (i.e. the genome was not monotone)
    function monotone(uint256 lo, uint256 hi) internal pure returns (uint256 clampedLo, bool changed) {
        int256 d0 = _direction(gene(lo, hi, 16));
        int256 d5 = _direction(gene(lo, hi, 21));
        int256 d6 = _direction(gene(lo, hi, 22));
        int256 d7 = _direction(gene(lo, hi, 23));
        clampedLo = lo;
        if (gene(lo, hi, 0) < 0) clampedLo = _zeroLane(clampedLo, 0);
        if (gene(lo, hi, 5) < 0) clampedLo = _zeroLane(clampedLo, 5);
        if (gene(lo, hi, 6) < 0) clampedLo = _zeroLane(clampedLo, 6);
        if (gene(lo, hi, 7) < 0) clampedLo = _zeroLane(clampedLo, 7);
        // interaction k at lane 8 + k, with the directions of its f0 / f5 / f6 / f7 gates (0 for any other feature)
        clampedLo = _clampInteraction(clampedLo, lo, 8, d0, 0); // k0 (f0, f1)
        clampedLo = _clampInteraction(clampedLo, lo, 9, d0, d7); // k1 (f0, f7)
        clampedLo = _clampInteraction(clampedLo, lo, 11, d7, 0); // k3 (f2, f7)
        clampedLo = _clampInteraction(clampedLo, lo, 12, d5, d6); // k4 (f5, f6)
        clampedLo = _clampInteraction(clampedLo, lo, 13, d0, d5); // k5 (f0, f5)
        clampedLo = _clampInteraction(clampedLo, lo, 15, d6, d7); // k7 (f6, f7)
        changed = clampedLo != lo;
    }

    function isMonotone(uint256 lo, uint256 hi) internal pure returns (bool) {
        (, bool changed) = monotone(lo, hi);
        return !changed;
    }

    /// @dev +1 if a gate with threshold t switches on as its feature rises within 0..1000, -1 if it switches off,
    ///      0 if it is constant there.
    function _direction(int16 t) private pure returns (int256) {
        if (t >= 1 && t <= 1000) return 1;
        if (t <= -1 && t >= -1000) return -1;
        return 0;
    }

    function _clampInteraction(uint256 out, uint256 lo, uint256 lane, int256 da, int256 db) private pure returns (uint256) {
        int16 v = int16(uint16(lo >> (lane * 16)));
        if ((v < 0 && (da > 0 || db > 0)) || (v > 0 && (da < 0 || db < 0))) return _zeroLane(out, lane);
        return out;
    }

    function _zeroLane(uint256 w, uint256 lane) private pure returns (uint256) {
        return w & ~(uint256(0xFFFF) << (lane * 16));
    }

    /// @notice Uniform crossover: gene i comes from B when bit i of `rand` is set, else from A.
    function crossover(uint256 aLo, uint256 aHi, uint256 bLo, uint256 bHi, uint256 rand)
        internal
        pure
        returns (uint256 lo, uint256 hi)
    {
        uint256 maskLo;
        uint256 maskHi;
        for (uint256 i = 0; i < 16; i++) {
            if ((rand >> i) & 1 == 1) maskLo |= uint256(0xFFFF) << (i * 16);
            if ((rand >> (16 + i)) & 1 == 1) maskHi |= uint256(0xFFFF) << (i * 16);
        }
        lo = (aLo & ~maskLo) | (bLo & maskLo);
        hi = (aHi & ~maskHi) | (bHi & maskHi);
    }

    /// @notice Mutate 2 random genes (among the first `active`) by ±(1..64), saturating at int16 bounds.
    /// @return idx    the two mutated gene indices
    /// @return delta  the two signed deltas actually applied
    function mutate(uint256 lo, uint256 hi, uint256 rand, uint256 active)
        internal
        pure
        returns (uint256, uint256, uint8[2] memory idx, int16[2] memory delta)
    {
        return mutateScaled(lo, hi, rand, active, 64);
    }

    /// @notice `mutate` with a chosen magnitude: each of the 2 mutations moves a gene by ±(1..scale).
    ///         scale = 64 is exactly `mutate`.
    function mutateScaled(uint256 lo, uint256 hi, uint256 rand, uint256 active, uint256 scale)
        internal
        pure
        returns (uint256, uint256, uint8[2] memory idx, int16[2] memory delta)
    {
        for (uint256 m = 0; m < 2; m++) {
            (lo, hi, idx[m], delta[m]) = _mutateOne(lo, hi, uint256(keccak256(abi.encode(rand, m))), active, scale);
        }
        return (lo, hi, idx, delta);
    }

    function _mutateOne(uint256 lo, uint256 hi, uint256 r, uint256 active, uint256 scale)
        private
        pure
        returns (uint256, uint256, uint8, int16)
    {
        uint256 gi = r % active;
        int256 mag = int256(1 + ((r >> 16) % scale));
        if ((r >> 32) & 1 == 1) mag = -mag;
        int256 nv = int256(gene(lo, hi, gi)) + mag;
        if (nv > type(int16).max) nv = type(int16).max;
        if (nv < type(int16).min) nv = type(int16).min;
        int16 applied = int16(nv) - gene(lo, hi, gi);
        (lo, hi) = withGene(lo, hi, gi, int16(nv));
        return (lo, hi, uint8(gi), applied);
    }
}
