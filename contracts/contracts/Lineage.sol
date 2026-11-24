// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title Lineage — append-only genealogy of every policy ever born and every install of the live slot.
/// @notice Births are needed so `ancestors()` can walk through policies that were never installed.
///         Nothing here can be edited or deleted; only the Arena (writer) can append.
contract Lineage is Ownable {
    struct Birth {
        uint64 parentA;
        uint64 parentB;
        uint64 root;
        uint32 generation;
        uint32 epoch;
        address submitter;
        uint256 lo;
        uint256 hi;
        bool exists;
    }

    struct Install {
        uint64 id;
        uint64 parentA;
        uint64 parentB;
        uint32 generation;
        uint32 epoch;
        uint64 blockNumber;
        int256 fitness;
    }

    address public writer;
    mapping(uint64 => Birth) internal births;
    uint64[] internal birthOrder;
    Install[] internal installs;

    event WriterSet(address writer);
    event Born(uint64 indexed id, uint64 parentA, uint64 parentB, uint64 root, uint32 generation, uint32 epoch);
    event Recorded(uint64 indexed id, uint32 indexed epoch, uint32 generation, int256 fitness, uint256 index);

    error WriterAlreadySet();
    error NotWriter();
    error AlreadyBorn(uint64 id);
    error Unknown(uint64 id);
    error ZeroAddress();

    constructor() Ownable(msg.sender) {}

    modifier onlyWriter() {
        if (msg.sender != writer) revert NotWriter();
        _;
    }

    function setWriter(address w) external onlyOwner {
        if (writer != address(0)) revert WriterAlreadySet();
        if (w == address(0)) revert ZeroAddress();
        writer = w;
        emit WriterSet(w);
    }

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
    ) external onlyWriter {
        if (births[id].exists) revert AlreadyBorn(id);
        births[id] = Birth(parentA, parentB, root, generation, epoch, submitter, lo, hi, true);
        birthOrder.push(id);
        emit Born(id, parentA, parentB, root, generation, epoch);
    }

    /// @notice Append an install of the live slot.
    function record(uint64 id, uint64 parentA, uint64 parentB, uint32 generation, int256 fitness, uint32 epoch)
        external
        onlyWriter
    {
        if (!births[id].exists) revert Unknown(id);
        installs.push(Install(id, parentA, parentB, generation, epoch, uint64(block.number), fitness));
        emit Recorded(id, epoch, generation, fitness, installs.length - 1);
    }

    // ------------------------------------------------------------------ reads

    function birthCount() external view returns (uint256) {
        return birthOrder.length;
    }

    function birthAt(uint256 i) external view returns (uint64) {
        return birthOrder[i];
    }

    function getBirth(uint64 id) external view returns (Birth memory) {
        return births[id];
    }

    function installCount() external view returns (uint256) {
        return installs.length;
    }

    function installAt(uint256 i) external view returns (Install memory) {
        return installs[i];
    }

    function installRange(uint256 from, uint256 to) external view returns (Install[] memory out) {
        if (to > installs.length) to = installs.length;
        if (from >= to) return out;
        out = new Install[](to - from);
        for (uint256 i = from; i < to; i++) out[i - from] = installs[i];
    }

    /// @notice Every distinct ancestor of `id` (breadth-first, nearest first), capped at `max`.
    function ancestorsCapped(uint64 id, uint256 max) public view returns (uint64[] memory out) {
        if (!births[id].exists) revert Unknown(id);
        uint64[] memory queue = new uint64[](max * 2 + 2);
        uint64[] memory found = new uint64[](max);
        uint256 head;
        uint256 tail;
        uint256 n;
        queue[tail++] = id;
        while (head < tail && n < max) {
            Birth storage b = births[queue[head++]];
            uint64[2] memory ps = [b.parentA, b.parentB];
            for (uint256 k = 0; k < 2 && n < max; k++) {
                uint64 p = ps[k];
                if (p == 0) continue;
                bool seen;
                for (uint256 s = 0; s < n; s++) {
                    if (found[s] == p) {
                        seen = true;
                        break;
                    }
                }
                if (seen) continue;
                found[n++] = p;
                if (tail < queue.length) queue[tail++] = p;
            }
        }
        out = new uint64[](n);
        for (uint256 i = 0; i < n; i++) out[i] = found[i];
    }

    /// @notice Ancestors with a default cap of 64.
    function ancestors(uint64 id) external view returns (uint64[] memory) {
        return ancestorsCapped(id, 64);
    }
}
