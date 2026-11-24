// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GenomeLib} from "../lib/GenomeLib.sol";

/// @title SparReference — test only: the Crucible's simulation in its plain form (checked
///        Solidity, a memory struct, GenomeLib.refusesFast). The tests check that the optimised Crucible returns the
///        same result as this on random genomes, and this one is checked step by step against the real Vault.
contract SparReference {
    uint256 internal constant SIM_BALANCE = 1_000_000;
    uint256 internal constant STEPS = 8;
    uint256 internal constant VELOCITY_WINDOW = 20;
    uint256 internal constant VELOCITY_UNIT = 200;
    uint256 internal constant GAP_CAP = 100;

    uint256 public immutable insiderRep;

    struct Sim {
        uint256 bal;
        uint256 outflow;
        uint256 blk;
        uint256 windowStart;
        uint256 windowCount;
        uint256 last;
        uint256 paidSelf;
        uint256 paidContract;
        uint256 paidFresh;
        uint256 prev;
        uint256 held; // the steps the policy held (reserved, counted half as taken)
    }

    constructor(uint256 insiderRep_) {
        insiderRep = insiderRep_ > 1000 ? 1000 : insiderRep_;
    }

    function extracted(uint256 pLo, uint256 pHi, uint256 aLo, uint256 aHi) external view returns (uint256) {
        Sim memory s;
        s.bal = SIM_BALANCE;
        s.blk = 1000;
        uint256[8] memory f;
        for (uint256 st = 0; st < STEPS; st++) {
            uint256 bps = _abs(GenomeLib.gene(aLo, aHi, 4 * st));
            if (bps == 0) continue;
            if (bps > 10_000) bps = 10_000; // the whole range
            uint256 rec = _abs(GenomeLib.gene(aLo, aHi, 4 * st + 1)) % 4;
            s.blk += _abs(GenomeLib.gene(aLo, aHi, 4 * st + 2)) % 101;
            bool viaContract = _abs(GenomeLib.gene(aLo, aHi, 4 * st + 3)) % 3 != 0;
            if (rec == 3) rec = s.prev == 1 ? 3 : (s.prev == 2 ? 2 : 0);
            uint256 amount = (s.bal * bps) / 10_000;

            f[0] = bps / 10;
            if (rec == 0) f[1] = 1000 / (1 + s.paidSelf);
            else if (rec == 1) f[1] = 1000;
            else if (rec == 2) f[1] = 1000 / (1 + s.paidContract);
            else f[1] = 1000 / (1 + s.paidFresh);
            f[2] = s.blk >= s.windowStart + VELOCITY_WINDOW ? 0 : _cap(s.windowCount * VELOCITY_UNIT);
            f[3] = s.last == 0 ? 1000 : _cap(((s.blk - s.last > GAP_CAP ? GAP_CAP : s.blk - s.last) * 1000) / GAP_CAP);
            f[4] = insiderRep;
            f[5] = viaContract ? 1000 : 0;
            f[6] = rec == 2 ? 1000 : 0;
            f[7] = _cap(((s.outflow + amount) * 1000) / SIM_BALANCE);

            int256 raw = GenomeLib.scoreFast(pLo, pHi, f);
            if (raw <= GenomeLib.HOLD_THRESHOLD) {
                s.bal -= amount;
                s.outflow += amount;
                if (rec == 0) s.paidSelf++;
                else if (rec == 1) s.paidFresh = 1;
                else if (rec == 2) s.paidContract++;
                else s.paidFresh++;
            } else if (raw <= GenomeLib.GLOBAL_THRESHOLD) {
                // held: reserved and in the outflow, but not paid (so the recipient is not paid either)
                s.bal -= amount;
                s.outflow += amount;
                s.held += amount;
                if (rec == 1) s.paidFresh = 0;
            } else if (rec == 1) {
                s.paidFresh = 0;
            }
            s.prev = rec == 0 ? 0 : (rec == 2 ? 2 : 1);
            if (s.blk >= s.windowStart + VELOCITY_WINDOW) {
                s.windowStart = s.blk;
                s.windowCount = 1;
            } else {
                s.windowCount += 1;
            }
            s.last = s.blk;
        }
        return SIM_BALANCE - s.bal - s.held / 2;
    }

    function refusesFast(uint256 lo, uint256 hi, uint256[8] memory f) external pure returns (bool) {
        return GenomeLib.refusesFast(lo, hi, f);
    }

    function _abs(int16 x) internal pure returns (uint256) {
        return x < 0 ? uint256(-int256(x)) : uint256(int256(x));
    }

    function _cap(uint256 x) internal pure returns (uint256) {
        return x > 1000 ? 1000 : x;
    }
}
