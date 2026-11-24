// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IFirewall {
    function arena() external view returns (address);
    function evaluate(uint256[8] calldata f) external view returns (bool refused, uint256 reason, uint256 score);
    /// @notice 0 pay, 1 hold, 2 refuse (reason bits set on a hold too).
    function judge(uint256[8] calldata f) external view returns (uint8 verdict, uint256 reason, uint256 score);
    function install(uint64 policyId, uint256 lo, uint256 hi) external;
    function exportGenome() external view returns (uint256 lo, uint256 hi, uint64 policyId, uint256 installCount);
    function shadowMask(uint256[] calldata los, uint256[] calldata his, uint256[8] calldata f)
        external
        pure
        returns (uint16 mask);
    function shadowMasks(uint256[] calldata los, uint256[] calldata his, uint256[8] calldata f)
        external
        pure
        returns (uint16 refuse, uint16 hold);
    function breed(uint256 aLo, uint256 aHi, uint256 bLo, uint256 bHi, uint256 rand, uint256 active)
        external
        pure
        returns (uint256 lo, uint256 hi, uint8[2] memory mutGenes, int16[2] memory mutDeltas);
    function breedScaled(uint256 aLo, uint256 aHi, uint256 bLo, uint256 bHi, uint256 rand, uint256 active, uint256 scale)
        external
        pure
        returns (uint256 lo, uint256 hi, uint8[2] memory mutGenes, int16[2] memory mutDeltas);
    /// @notice breedScaled over the 24 scored genes, then clamped monotone in f0 and f7 (GenomeLib.monotone).
    function breedPolicy(uint256 aLo, uint256 aHi, uint256 bLo, uint256 bHi, uint256 rand, uint256 scale)
        external
        pure
        returns (uint256 lo, uint256 hi, uint8[2] memory mutGenes, int16[2] memory mutDeltas);
}

interface IArena {
    function started() external view returns (bool);
    function currentEpoch() external view returns (uint256);
    function epochStartBalance() external view returns (uint256);
    function revealOpensAt() external view returns (uint256);
    function hasAttack(address who) external view returns (bool);
    /// @notice Which pool candidates would refuse, and which would hold, this feature vector (bit j = pool[j]).
    function shadowMask(uint256[8] calldata f) external view returns (uint16 refuse, uint16 hold);
    function recordExtraction(address caller, address origin, uint256 amount) external;
    /// @notice Self-driving rounds: close the current epoch first if it is overdue (see Arena.poke).
    function poke(address caller) external;
}

/// @notice The sparring ring the Arena consults at every close. Fitness units are wei of the vault.
interface ICrucible {
    function grade(
        uint256 epoch,
        uint256 startBalance,
        uint64[] calldata policyIds,
        uint256[] calldata policyLo,
        uint256[] calldata policyHi,
        uint64[] calldata attackIds,
        uint256[] calldata attackLo,
        uint256[] calldata attackHi
    ) external returns (int256[] memory policyFitness, uint256[] memory attackTake);

    /// @notice The screen's verdict (0 OK, 1 refuses an honest payment, 2 weaker than the champion, 5 lets a
    ///         drain canary through, 6 not monotone in amount and outflow), asked before a staked policy may enter.
    function screenVerdict(uint256 lo, uint256 hi) external view returns (uint8);
}

interface IVault {
    function isHonest(address who) external view returns (bool);
}

/// @notice The Vault records outcomes (the per-epoch tx log with shadow verdicts and revealed labels);
///         the Arena reads the tally at epoch close.
interface IVaultLog {
    function isHonest(address who) external view returns (bool);
    /// @notice What the vault can pay: its balance minus the payments it holds.
    function balance() external view returns (uint256);
    function epochTxCount(uint256 epoch) external view returns (uint256);
    /// @notice retained and honestCost are in wei, priced by payment (holds at a fraction); `startBalance` is
    ///         the round's starting balance (it sets the floor of a wrong refusal's price).
    function tally(uint256 epoch, uint256 n, uint256 startBalance)
        external
        view
        returns (
            uint256[] memory retained,
            uint256[] memory honestCost,
            address[] memory users,
            uint256[] memory wrong,
            uint256 userCount,
            uint256 totalWrong,
            uint256 txCount
        );
}

interface ILineage {
    function writer() external view returns (address);
    function recordBirth(
        uint64 id,
        uint64 parentA,
        uint64 parentB,
        uint64 root,
        uint32 generation,
        uint32 epoch,
        uint256 lo,
        uint256 hi,
        address submitter
    ) external;
    function record(uint64 id, uint64 parentA, uint64 parentB, uint32 generation, int256 fitness, uint32 epoch) external;
}

/// @notice ERC-8004 Identity Registry is ERC-721 based; holding an identity token means a registered agent.
interface IIdentityRegistry {
    function balanceOf(address owner) external view returns (uint256);
}
