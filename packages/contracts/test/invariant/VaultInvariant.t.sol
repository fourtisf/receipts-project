// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Base} from "../utils/Base.t.sol";
import {console2} from "forge-std/console2.sol";
import {VaultHandler} from "./VaultHandler.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockFeed} from "../mocks/MockFeed.sol";

/// @dev CONTRACTS.md §5 vault + factory invariants (4–14) under random action sequences.
contract VaultInvariantTest is Base {
    VaultHandler internal handler;
    MockERC20[] internal toks;

    function setUp() public override {
        super.setUp();
        toks.push(usdg);
        toks.push(weth);
        toks.push(wbtc);
        toks.push(nvda);
        MockFeed[] memory fs = new MockFeed[](4);
        (fs[0], fs[1], fs[2], fs[3]) = (usdgFeed, wethFeed, wbtcFeed, nvdaFeed);
        handler = new VaultHandler(
            registry, factory, vault, router, toks, fs, strategyId, [owner, operator, signer, creator, treasury, admin]
        );
        // start funded and following so swaps happen early in each run
        _deposit(2000e6);
        _follow(_usd(1500));
        targetContract(address(handler));
        excludeSender(address(vault));
    }

    function invariant_noViolation() public view {
        assertEq(handler.violation(), "", handler.violation());
    }

    /// Invariant 4: tokens never reach anyone except the owner (withdraw), creator/treasury (USDG fees) and the
    /// router (swap counterparty). Attacker, operator and the "elsewhere" sink never hold vault tokens.
    function invariant_tokensOnlyLeaveViaWithdrawOrFees() public view {
        for (uint256 i; i < toks.length; ++i) {
            assertEq(toks[i].balanceOf(handler.attacker()), 0, "attacker");
            assertEq(toks[i].balanceOf(operator), 0, "operator");
            assertEq(toks[i].balanceOf(address(0xBEEF)), 0, "elsewhere");
            if (i > 0) {
                assertEq(toks[i].balanceOf(creator), 0, "creator non-base");
                assertEq(toks[i].balanceOf(treasury), 0, "treasury non-base");
            }
        }
    }

    /// Invariant 13: router approval is 0 after every swap.
    function invariant_noLingeringApproval() public view {
        for (uint256 i; i < toks.length; ++i) {
            assertEq(toks[i].allowance(address(vault), address(router)), 0);
        }
    }

    /// Invariant 8: used daily value never exceeds the beta cap.
    function invariant_dailyCap() public view {
        assertLe(vault.usedInWindowUsd(), vault.maxDailyLimitUsd());
        assertLe(vault.dailyLimitUsd(), vault.maxDailyLimitUsd());
    }

    /// Bounds on owner-settable parameters.
    function invariant_paramBounds() public view {
        assertLe(vault.maxSlippageBps(), 500);
        assertGe(vault.drawdownBps(), 500);
        assertLe(vault.drawdownBps(), 5000);
    }

    /// @dev Run with -vv to see how much each run exercised (swaps, breaker trips, fee settlements, withdrawals).
    function afterInvariant() external view {
        console2.log(
            "swaps/trips/fees/withdrawals",
            handler.successfulSwaps(),
            handler.breakerTrips(),
            handler.feeSettlements() * 1e6 + handler.withdrawals()
        );
    }
}
