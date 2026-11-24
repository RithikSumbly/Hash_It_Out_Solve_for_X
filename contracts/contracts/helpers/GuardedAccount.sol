// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IPolicyGuard {
    function enforce(address to, uint256 value) external;
    function importLive() external;
}

/// @title GuardedAccount — a minimal smart account that imports the Red Queen genome as its validation module.
/// @notice Stands in for an ERC-4337 account: `execute` is what `validateUserOp` + `execute` would run.
contract GuardedAccount {
    address public immutable owner;
    IPolicyGuard public immutable guard;

    error NotOwner();
    error CallFailed();

    constructor(address owner_, address guard_) {
        owner = owner_;
        guard = IPolicyGuard(guard_);
    }

    receive() external payable {}

    function importPolicy() external {
        if (msg.sender != owner) revert NotOwner();
        guard.importLive();
    }

    function execute(address to, uint256 value, bytes calldata data) external {
        if (msg.sender != owner) revert NotOwner();
        guard.enforce(to, value);
        (bool ok,) = to.call{value: value}(data);
        if (!ok) revert CallFailed();
    }
}
