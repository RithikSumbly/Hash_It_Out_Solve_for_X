// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GenomeLib} from "../lib/GenomeLib.sol";

interface IFirewallExport {
    function exportGenome() external view returns (uint256 lo, uint256 hi, uint64 policyId, uint256 installCount);
}

/// @title PolicyGuard — policy export: run the Red Queen genome inside any wallet or ERC-4337 account.
/// @notice An account calls `enforce(to, value)` from its execute / validateUserOp path (or any wallet
///         wraps its sends with it). Features are computed for the calling account from its own history,
///         then scored with either the live champion genome (follow mode) or a genome the account pinned
///         with `importLive()` / `pin()`. A refusal reverts with the reason bitmask.
contract PolicyGuard {
    struct AccountState {
        uint256 pinnedLo;
        uint256 pinnedHi;
        bool pinned;
        uint64 lastBlock;
        uint64 windowStart;
        uint32 windowCount;
        uint256 periodStart;
        uint256 periodStartBalance;
        uint256 periodOutflow;
    }

    uint256 public constant PERIOD = 25;
    IFirewallExport public immutable firewall;
    mapping(address => AccountState) public accounts;
    mapping(address => mapping(address => uint256)) public paidCount;

    event Imported(address indexed account, uint256 lo, uint256 hi, uint64 policyId);
    event Unpinned(address indexed account);
    event Checked(address indexed account, address indexed to, uint256 value, bool refused, uint256 reason, uint256 score);

    error PolicyRefused(uint256 reason, uint256 score);

    constructor(address firewall_) {
        firewall = IFirewallExport(firewall_);
    }

    /// @notice Copy the current champion genome into this account's validation module.
    function importLive() external {
        (uint256 lo, uint256 hi, uint64 id,) = firewall.exportGenome();
        AccountState storage s = accounts[msg.sender];
        (s.pinnedLo, s.pinnedHi, s.pinned) = (lo, hi, true);
        emit Imported(msg.sender, lo, hi, id);
    }

    function pin(uint256 lo, uint256 hi) external {
        AccountState storage s = accounts[msg.sender];
        (s.pinnedLo, s.pinnedHi, s.pinned) = (lo, hi, true);
        emit Imported(msg.sender, lo, hi, 0);
    }

    function unpin() external {
        accounts[msg.sender].pinned = false;
        emit Unpinned(msg.sender);
    }

    function genomeOf(address account) public view returns (uint256 lo, uint256 hi) {
        AccountState storage s = accounts[account];
        if (s.pinned) return (s.pinnedLo, s.pinnedHi);
        (lo, hi,,) = firewall.exportGenome();
    }

    function featuresFor(address account, address to, uint256 value) public view returns (uint256[8] memory f) {
        AccountState storage s = accounts[account];
        uint256 bal = account.balance; // enforce() runs before the transfer, so value is still in the account
        f[0] = bal == 0 ? 1000 : _cap((value * 1000) / bal);
        f[1] = 1000 / (1 + paidCount[account][to]);
        f[2] = block.number >= uint256(s.windowStart) + 20 ? 0 : _cap(uint256(s.windowCount) * 200);
        f[3] = s.lastBlock == 0 ? 1000 : _cap(((block.number - s.lastBlock > 100 ? 100 : block.number - s.lastBlock) * 1000) / 100);
        f[4] = 0;
        f[5] = tx.origin != account ? 1000 : 0;
        f[6] = to.code.length > 0 ? 1000 : 0;
        bool fresh = block.number >= s.periodStart + PERIOD;
        uint256 startBal = fresh || s.periodStartBalance == 0 ? bal : s.periodStartBalance;
        uint256 out = fresh ? 0 : s.periodOutflow;
        f[7] = startBal == 0 ? 1000 : _cap(((out + value) * 1000) / startBal);
    }

    function check(address account, address to, uint256 value)
        public
        view
        returns (bool refused, uint256 reason, uint256 score)
    {
        (uint256 lo, uint256 hi) = genomeOf(account);
        return GenomeLib.evaluate(lo, hi, featuresFor(account, to, value));
    }

    /// @notice Called by the account itself before it sends `value` to `to`. Reverts if refused.
    function enforce(address to, uint256 value) external {
        (bool refused, uint256 reason, uint256 score) = check(msg.sender, to, value);
        emit Checked(msg.sender, to, value, refused, reason, score);
        if (refused) revert PolicyRefused(reason, score);
        AccountState storage s = accounts[msg.sender];
        if (block.number >= uint256(s.windowStart) + 20) {
            s.windowStart = uint64(block.number);
            s.windowCount = 1;
        } else {
            s.windowCount += 1;
        }
        if (block.number >= s.periodStart + PERIOD) {
            s.periodStart = block.number;
            s.periodStartBalance = msg.sender.balance;
            s.periodOutflow = 0;
        }
        s.periodOutflow += value;
        s.lastBlock = uint64(block.number);
        paidCount[msg.sender][to] += 1;
    }

    function _cap(uint256 x) internal pure returns (uint256) {
        return x > 1000 ? 1000 : x;
    }
}
