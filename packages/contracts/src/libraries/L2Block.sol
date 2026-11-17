// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title L2Block
/// @notice Current L2 block number on Arbitrum-based chains (Robinhood Chain).
/// @dev On Arbitrum `block.number` is the L1 block. The L2 block comes from the ArbSys precompile at address(100),
///      `arbBlockNumber()`. ArbSys holds placeholder code (0xfe), so an `extcodesize` gate would wrongly skip it
///      (NOUNY review L-3): always call it. The call is capped at a fixed gas stipend so that on chains without the
///      precompile (anvil, local tests) the invalid opcode burns only the stipend, then we fall back to
///      `block.number`.
library L2Block {
    address internal constant ARB_SYS = address(100);
    uint256 internal constant ARB_SYS_GAS = 30_000;

    function current() internal view returns (uint64) {
        (bool ok, bytes memory data) = ARB_SYS.staticcall{gas: ARB_SYS_GAS}(abi.encodeWithSignature("arbBlockNumber()"));
        if (ok && data.length >= 32) {
            uint256 n = abi.decode(data, (uint256));
            if (n != 0 && n <= type(uint64).max) return uint64(n);
        }
        return uint64(block.number);
    }
}
