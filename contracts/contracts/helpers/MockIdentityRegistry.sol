// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MockIdentityRegistry — the slice of an ERC-8004 Identity Registry the Vault reads.
/// @notice ERC-8004's Identity Registry is an ERC-721 where each token is an agent identity.
///         The Vault only calls `balanceOf`, so any real ERC-8004 registry can be plugged in instead.
contract MockIdentityRegistry {
    uint256 public nextId = 1;
    mapping(address => uint256) public balanceOf;
    mapping(uint256 => address) public ownerOf;
    mapping(uint256 => string) public tokenURI;

    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);

    function register(string calldata agentURI) external returns (uint256 agentId) {
        agentId = nextId++;
        ownerOf[agentId] = msg.sender;
        tokenURI[agentId] = agentURI;
        balanceOf[msg.sender] += 1;
        emit Registered(agentId, agentURI, msg.sender);
    }
}
