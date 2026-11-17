// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Base} from "./utils/Base.t.sol";
import {IReceiptsVault} from "../src/interfaces/IReceiptsVault.sol";
import {MockRouter} from "./mocks/MockRouter.sol";

/// @notice "Held up" checks: a stolen operator + stolen signer with a router that delivers exactly the oracle
///         minimum (maximal extraction) cannot lose more than dailyLimit x maxSlippage (oracle terms) per window.
contract OperatorBoundReviewTest is Base {
    function _drain(uint16 slip, uint256 rounds) internal returns (uint256 navStart, uint256 navEnd, uint256 swapped) {
        vm.prank(owner);
        vault.setLimits(slip, MAX_DAILY, 5000);
        _deposit(10_000e6);
        _follow(1_000_000e18);
        router.setMode(MockRouter.Mode.UnderDeliver);
        router.setUnderDeliverBps(10_000 - slip); // deliver ~ exactly the oracle minimum
        navStart = vault.navStrict();

        for (uint256 i; i < rounds; ++i) {
            uint256 rem = vault.remainingDailyUsd();
            if (rem < 1e18) break;
            // alternate buy / sell; operator picks amounts to burn the whole daily budget
            uint256 wethBal = weth.balanceOf(address(vault));
            if (i % 2 == 0 || wethBal == 0) {
                uint256 amt = rem / 1e12; // USDG 6 decimals, price 1
                if (amt > usdg.balanceOf(address(vault))) amt = usdg.balanceOf(address(vault));
                uint64 n = _commitBuy(address(weth));
                vm.prank(operator);
                try vault.executeSignal(n, address(usdg), address(weth), amt, 0) {
                    swapped += amt * 1e12;
                } catch {}
            } else {
                uint256 amt = (rem * 1e18) / 2000e18; // WETH at 2000
                if (amt > wethBal) amt = wethBal;
                uint64 n = _commitSell(address(weth));
                vm.prank(operator);
                try vault.executeSignal(n, address(weth), address(usdg), amt, 0) {
                    swapped += (amt * 2000e18) / 1e18;
                } catch {}
            }
        }
        navEnd = vault.navStrict();
    }

    function test_held_operatorLossBoundedBySlippageTimesDailyLimit_1pct() public {
        (uint256 a, uint256 b, uint256 swapped) = _drain(100, 40);
        assertLe(swapped, MAX_DAILY + 1e18);
        uint256 loss = a - b;
        emit log_named_decimal_uint("loss (USD)", loss, 18);
        assertLe(loss, (MAX_DAILY * 100) / 10_000 + 1e15, "loss <= 1% of the daily limit");
    }

    function test_held_operatorLossBoundedBySlippageTimesDailyLimit_5pct() public {
        (uint256 a, uint256 b,) = _drain(500, 40);
        uint256 loss = a - b;
        emit log_named_decimal_uint("loss (USD)", loss, 18);
        assertLe(loss, (MAX_DAILY * 500) / 10_000 + 1e15, "loss <= 5% of the daily limit");
    }

    /// Operator cannot set its own minimum below the oracle minimum, nor reuse a nonce, nor execute in the commit
    /// L2 block, nor after reveal.
    function test_held_commitGating() public {
        _deposit(1000e6);
        _follow(1_000_000e18);
        // same block as commit
        uint64 next = registry.strategyOf(strategyId).commitCount;
        bytes32 h = registry.hashSignal(strategyId, next, _signal(address(usdg), address(weth), 1), bytes32(0));
        vm.prank(signer);
        uint64 n = registry.commit(strategyId, h);
        vm.prank(operator);
        vm.expectRevert(IReceiptsVault.NotExecutable.selector);
        vault.executeSignal(n, address(usdg), address(weth), 10e6, 0);
        // after reveal
        vm.roll(block.number + 1);
        registry.reveal(strategyId, n, _signal(address(usdg), address(weth), 1), bytes32(0));
        vm.prank(operator);
        vm.expectRevert(IReceiptsVault.NotExecutable.selector);
        vault.executeSignal(n, address(usdg), address(weth), 10e6, 0);
        // reuse
        uint64 n2 = _commitBuy(address(weth));
        _exec(n2, address(usdg), address(weth), 10e6);
        vm.prank(operator);
        vm.expectRevert(IReceiptsVault.AlreadyExecuted.selector);
        vault.executeSignal(n2, address(usdg), address(weth), 10e6, 0);
    }
}
