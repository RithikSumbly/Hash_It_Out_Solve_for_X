// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {GenomeLib} from "./lib/GenomeLib.sol";

/// @title Firewall — stores the live 32-gene genome and scores transactions against it.
/// @notice Only the Arena can install a genome, and the Arena only installs the winner of
///         `closeEpoch()` selection (a bred child or a staked submission), or the genesis policy.
///         Anyone can read the live genome (`exportGenome`) to run it in their own wallet / ERC-4337 module.
contract Firewall is Ownable {
    int256 public constant GLOBAL_THRESHOLD = GenomeLib.GLOBAL_THRESHOLD;
    /// @notice Scores above this (up to GLOBAL_THRESHOLD) hold a payment instead of paying it.
    int256 public constant HOLD_THRESHOLD = GenomeLib.HOLD_THRESHOLD;

    address public arena;
    uint256 public liveLo;
    uint256 public liveHi;
    uint64 public livePolicyId;
    /// @notice How many installs have happened (the "generation" of the live slot; genesis = 1).
    uint256 public installCount;
    uint256 public installedAtBlock;

    event ArenaSet(address arena);
    event GenomeInstalled(uint64 indexed policyId, uint256 lo, uint256 hi, uint256 installCount);

    error ArenaAlreadySet();
    error NotArena();
    error ZeroAddress();

    constructor() Ownable(msg.sender) {}

    function setArena(address a) external onlyOwner {
        if (arena != address(0)) revert ArenaAlreadySet();
        if (a == address(0)) revert ZeroAddress();
        arena = a;
        emit ArenaSet(a);
    }

    function install(uint64 policyId, uint256 lo, uint256 hi) external {
        if (msg.sender != arena) revert NotArena();
        liveLo = lo;
        liveHi = hi;
        livePolicyId = policyId;
        installCount += 1;
        installedAtBlock = block.number;
        emit GenomeInstalled(policyId, lo, hi, installCount);
    }

    // ------------------------------------------------------------------ scoring

    /// @notice Score of the live policy for a feature vector (0..1000 each).
    function score(uint256[8] calldata f) external view returns (uint256 s) {
        (,, s) = GenomeLib.evaluate(liveLo, liveHi, f);
    }

    /// @notice Whether the live policy refuses, with the machine-readable reason bitmask.
    function refuses(uint256[8] calldata f) external view returns (bool refused, uint256 reason) {
        (refused, reason,) = GenomeLib.evaluate(liveLo, liveHi, f);
    }

    function evaluate(uint256[8] calldata f) external view returns (bool refused, uint256 reason, uint256 s) {
        return GenomeLib.evaluate(liveLo, liveHi, f);
    }

    /// @notice The live policy's verdict, 0 pay, 1 hold (a delay the owner or a guardian can veto), 2 refuse,
    ///         with the reason bits (set on a hold too) and the score.
    function judge(uint256[8] calldata f) external view returns (uint8 verdict, uint256 reason, uint256 s) {
        return GenomeLib.verdict(liveLo, liveHi, f);
    }

    /// @notice Per-term breakdown of the live policy for a feature vector (used by the arena's predictor).
    function explain(uint256[8] calldata f)
        external
        view
        returns (bool refused, uint256 reason, uint256 s, int256 raw, int256[16] memory terms)
    {
        return GenomeLib.explain(liveLo, liveHi, f);
    }

    /// @notice Score any genome (policy inspector, shadow previews, imported modules).
    function explainWith(uint256 lo, uint256 hi, uint256[8] calldata f)
        external
        pure
        returns (bool refused, uint256 reason, uint256 s, int256 raw, int256[16] memory terms)
    {
        return GenomeLib.explain(lo, hi, f);
    }

    // ------------------------------------------------------------------ genome engine (used by the Arena)

    /// @notice Shadow scoring: bit j set when candidate genome j would refuse this feature vector.
    function shadowMask(uint256[] calldata los, uint256[] calldata his, uint256[8] calldata f)
        external
        pure
        returns (uint16 mask)
    {
        uint256[8] memory fm = f;
        for (uint256 j = 0; j < los.length; j++) {
            if (GenomeLib.refusesFast(los[j], his[j], fm)) mask |= uint16(1 << j);
        }
    }

    /// @notice Every candidate's verdict: bit j of `refuse` when genome j would refuse the feature vector, bit j of
    ///         `hold` when it would hold it (never both).
    function shadowMasks(uint256[] calldata los, uint256[] calldata his, uint256[8] calldata f)
        external
        pure
        returns (uint16 refuse, uint16 hold)
    {
        uint256[8] memory fm = f;
        for (uint256 j = 0; j < los.length; j++) {
            int256 raw = GenomeLib.scoreFast(los[j], his[j], fm);
            if (raw > GenomeLib.GLOBAL_THRESHOLD) refuse |= uint16(1 << j);
            else if (raw > GenomeLib.HOLD_THRESHOLD) hold |= uint16(1 << j);
        }
    }

    /// @notice Uniform crossover of A and B by the bits of `rand`, then 2 mutations of ±(1..64)
    ///         among the first `active` genes.
    function breed(uint256 aLo, uint256 aHi, uint256 bLo, uint256 bHi, uint256 rand, uint256 active)
        external
        pure
        returns (uint256 lo, uint256 hi, uint8[2] memory mutGenes, int16[2] memory mutDeltas)
    {
        return breedScaled(aLo, aHi, bLo, bHi, rand, active, 64);
    }

    /// @notice `breed` with a chosen mutation magnitude ±(1..scale); scale = 64 is exactly `breed`.
    function breedScaled(uint256 aLo, uint256 aHi, uint256 bLo, uint256 bHi, uint256 rand, uint256 active, uint256 scale)
        public
        pure
        returns (uint256 lo, uint256 hi, uint8[2] memory mutGenes, int16[2] memory mutDeltas)
    {
        (lo, hi) = GenomeLib.crossover(aLo, aHi, bLo, bHi, rand);
        return GenomeLib.mutateScaled(lo, hi, uint256(keccak256(abi.encode(rand))), active, scale);
    }

    /// @notice Breed a policy child (crossover, then 2 mutations among the 24 scored genes, as breedScaled), then
    ///         clamp it monotone in amount (f0), round outflow (f7), call depth (f5) and contract recipient (f6): any weight that would let a bigger payment, or
    ///         one later in a draining round, score lower is set to 0 (GenomeLib.monotone). mutDeltas are the
    ///         mutations as drawn; lo/hi are the child as born.
    function breedPolicy(uint256 aLo, uint256 aHi, uint256 bLo, uint256 bHi, uint256 rand, uint256 scale)
        external
        pure
        returns (uint256 lo, uint256 hi, uint8[2] memory mutGenes, int16[2] memory mutDeltas)
    {
        (lo, hi, mutGenes, mutDeltas) = breedScaled(aLo, aHi, bLo, bHi, rand, GenomeLib.POLICY_ACTIVE_GENES, scale);
        (lo,) = GenomeLib.monotone(lo, hi);
    }

    /// @notice Whether a policy genome is monotone in amount (f0), round outflow (f7), call depth (f5) and contract recipient (f6), and its clamped `lo`
    ///         (every weight that breaks the rule set to 0). The Crucible refuses a proposal or a staked policy that
    ///         is not; bred children are clamped at birth.
    function monotoneGenome(uint256 lo, uint256 hi) external pure returns (bool isMonotone, uint256 clampedLo) {
        bool changed;
        (clampedLo, changed) = GenomeLib.monotone(lo, hi);
        isMonotone = !changed;
    }

    // ------------------------------------------------------------------ policy export

    function exportGenome() external view returns (uint256 lo, uint256 hi, uint64 policyId, uint256 count) {
        return (liveLo, liveHi, livePolicyId, installCount);
    }

    function liveGenes() external view returns (int16[32] memory) {
        return GenomeLib.unpack(liveLo, liveHi);
    }

    function packGenes(int16[32] calldata g) external pure returns (uint256 lo, uint256 hi) {
        return GenomeLib.pack(g);
    }

    function unpackGenes(uint256 lo, uint256 hi) external pure returns (int16[32] memory) {
        return GenomeLib.unpack(lo, hi);
    }
}
