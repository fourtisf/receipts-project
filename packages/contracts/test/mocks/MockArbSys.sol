// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @dev Etched at address(100) to emulate Arbitrum's ArbSys precompile in tests.
contract MockArbSys {
    uint256 public l2Block;

    function setL2Block(uint256 b) external {
        l2Block = b;
    }

    function arbBlockNumber() external view returns (uint256) {
        return l2Block;
    }
}
