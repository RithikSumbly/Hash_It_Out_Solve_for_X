// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IVaultReenter {
    function spend(address payable to, uint256 amount, uint8 kind, bytes32 labelCommit) external returns (bool);
}

/// @notice Test helper: a recipient that tries to re-enter Vault.spend when it receives funds.
contract Reenterer {
    IVaultReenter public vault;
    bool public tried;

    function setVault(address v) external {
        vault = IVaultReenter(v);
    }

    function start(uint256 amount) external {
        vault.spend(payable(address(this)), amount, 0, bytes32(0));
    }

    receive() external payable {
        if (!tried) {
            tried = true;
            vault.spend(payable(address(this)), msg.value, 0, bytes32(0));
        }
    }
}
