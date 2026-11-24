// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IVaultSpend {
    function spend(address payable to, uint256 amount, uint8 kind, bytes32 labelCommit) external returns (bool);
}

/// @title AgentProxy — a minimal "AI agent" contract wallet.
/// @notice Used by the scripted attackers for the contract-recipient hop (f6) and the
///         delegate-then-drain pattern (f5 call depth), and by anyone who wants an agent that
///         spends from the vault on their behalf. Only the owner can drive it.
contract AgentProxy {
    address public immutable owner;

    error NotOwner();
    error SweepFailed();

    constructor(address owner_) {
        owner = owner_;
    }

    receive() external payable {}

    function act(address vault, address payable to, uint256 amount, uint8 kind, bytes32 labelCommit)
        external
        returns (bool)
    {
        if (msg.sender != owner) revert NotOwner();
        return IVaultSpend(vault).spend(to, amount, kind, labelCommit);
    }

    function sweep(address payable to) external {
        if (msg.sender != owner) revert NotOwner();
        (bool ok,) = to.call{value: address(this).balance}("");
        if (!ok) revert SweepFailed();
    }
}
