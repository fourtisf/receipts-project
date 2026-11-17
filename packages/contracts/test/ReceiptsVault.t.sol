// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Base} from "./utils/Base.t.sol";
import {ReceiptsVault} from "../src/ReceiptsVault.sol";
import {IReceiptsVault} from "../src/interfaces/IReceiptsVault.sol";
import {ISignalRegistry} from "../src/interfaces/ISignalRegistry.sol";
import {MockRouter} from "./mocks/MockRouter.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract ReceiptsVaultTest is Base {
    event BreakerTripped(uint256 navUsd, uint256 peakNavUsd);
    event MarksFrozen();
    event FeeDeferred(uint256 profitUsd, uint256 neededBase, uint256 baseBalance);

    // ================================================================== construction

    function test_constructor_wiring() public view {
        assertEq(vault.owner(), owner);
        assertEq(vault.factory(), address(factory));
        assertEq(vault.registry(), address(registry));
        assertEq(vault.router(), address(router));
        assertEq(vault.base(), address(usdg));
        assertEq(vault.treasury(), treasury);
        assertEq(vault.protocolCutBps(), PROTOCOL_CUT);
        assertEq(vault.maxDailyLimitUsd(), MAX_DAILY);
        assertEq(vault.operator(), operator);
        assertEq(vault.maxSlippageBps(), 100);
        assertEq(vault.dailyLimitUsd(), MAX_DAILY);
        assertEq(vault.drawdownBps(), 2000);
        assertFalse(vault.paused());
        assertEq(vault.followingId(), 0);
        assertEq(vault.allowedTokens().length, 4);
        (bool listed, bool enabled, uint8 dec, uint24 tier, uint32 stale,) = vault.tokenConfig(address(wbtc));
        assertTrue(listed && enabled);
        assertEq(dec, 8);
        assertEq(tier, 500);
        assertEq(stale, STALENESS);
    }

    function test_constructor_badLimitsRevert() public {
        vm.prank(attacker);
        vm.expectRevert(IReceiptsVault.SlippageTooHigh.selector);
        factory.createVault(501, 1, 2000);
        vm.prank(attacker);
        vm.expectRevert(IReceiptsVault.DailyLimitTooHigh.selector);
        factory.createVault(100, MAX_DAILY + 1, 2000);
        vm.prank(attacker);
        vm.expectRevert(IReceiptsVault.BadDrawdown.selector);
        factory.createVault(100, 1, 499);
        vm.prank(attacker);
        vm.expectRevert(IReceiptsVault.BadDrawdown.selector);
        factory.createVault(100, 1, 5001);
    }

    function test_constructor_requiresFactory() public {
        // A vault can only be deployed by a factory-like caller; an EOA-deployed vault reverts reading defaults.
        vm.expectRevert();
        new ReceiptsVault(owner, 100, 1, 2000);
    }

    // ================================================================== access control (invariant 5)

    function test_onlyOwner_everything() public {
        address[3] memory callers = [operator, attacker, creator];
        for (uint256 i; i < callers.length; ++i) {
            vm.startPrank(callers[i]);
            vm.expectRevert(IReceiptsVault.NotOwner.selector);
            vault.deposit(1);
            vm.expectRevert(IReceiptsVault.NotOwner.selector);
            vault.withdraw(address(usdg), 1, callers[i]);
            vm.expectRevert(IReceiptsVault.NotOwner.selector);
            vault.follow(strategyId, 1);
            vm.expectRevert(IReceiptsVault.NotOwner.selector);
            vault.unfollow();
            vm.expectRevert(IReceiptsVault.NotOwner.selector);
            vault.setAllocation(1);
            vm.expectRevert(IReceiptsVault.NotOwner.selector);
            vault.setLimits(1, 1, 1000);
            vm.expectRevert(IReceiptsVault.NotOwner.selector);
            vault.setPaused(true);
            vm.expectRevert(IReceiptsVault.NotOwner.selector);
            vault.setOperator(callers[i]);
            vm.expectRevert(IReceiptsVault.NotOwner.selector);
            vault.setTokenEnabled(address(weth), false);
            vm.expectRevert(IReceiptsVault.NotOwner.selector);
            vault.resetPeak();
            vm.expectRevert(IReceiptsVault.NotOwner.selector);
            vault.resetMarks();
            vm.expectRevert(ReceiptsVault.OnlySelf.selector);
            vault.settleFeesForWithdraw();
            vm.stopPrank();
        }
    }

    function test_executeSignal_onlyOperator() public {
        _deposit(1000e6);
        _follow(_usd(1000));
        uint64 n = _commitBuy(address(weth));
        vm.prank(attacker);
        vm.expectRevert(IReceiptsVault.NotOperator.selector);
        vault.executeSignal(n, address(usdg), address(weth), 100e6, 0);
        vm.prank(owner);
        vm.expectRevert(IReceiptsVault.NotOperator.selector);
        vault.executeSignal(n, address(usdg), address(weth), 100e6, 0);
        // revoked operator
        vm.prank(owner);
        vault.setOperator(address(0));
        vm.prank(operator);
        vm.expectRevert(IReceiptsVault.NotOperator.selector);
        vault.executeSignal(n, address(usdg), address(weth), 100e6, 0);
        vm.prank(address(0));
        vm.expectRevert(IReceiptsVault.NotOperator.selector);
        vault.executeSignal(n, address(usdg), address(weth), 100e6, 0);
    }

    // ================================================================== deposit / withdraw

    function test_deposit_raisesMarks() public {
        _deposit(500e6);
        assertEq(usdg.balanceOf(address(vault)), 500e6);
        assertEq(vault.peakNav(), _usd(500));
        assertEq(vault.hwmNav(), _usd(500));
        assertEq(vault.navStrict(), _usd(500));
        assertEq(vault.navLenient(), _usd(500));
    }

    function test_deposit_reverts() public {
        vm.prank(owner);
        vm.expectRevert(IReceiptsVault.ZeroAmount.selector);
        vault.deposit(0);
        usdg.mint(owner, 1e6);
        vm.prank(owner);
        usdg.approve(address(vault), 1e6);
        usdgFeed.setUpdatedAt(block.timestamp - 8 days);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IReceiptsVault.StaleOraclePrice.selector, address(usdg)));
        vault.deposit(1e6);
    }

    function test_withdraw_scalesMarks() public {
        _deposit(1000e6);
        vm.prank(owner);
        vault.withdraw(address(usdg), 400e6, owner);
        assertEq(usdg.balanceOf(owner), 400e6);
        assertEq(vault.peakNav(), _usd(600));
        assertEq(vault.hwmNav(), _usd(600));
        assertFalse(vault.marksFrozen());
    }

    function test_withdraw_reverts() public {
        _deposit(10e6);
        vm.startPrank(owner);
        vm.expectRevert(IReceiptsVault.ZeroAddress.selector);
        vault.withdraw(address(usdg), 1, address(0));
        vm.expectRevert(IReceiptsVault.ZeroAmount.selector);
        vault.withdraw(address(usdg), 0, owner);
        vm.expectRevert(); // insufficient balance
        vault.withdraw(address(usdg), 11e6, owner);
        vm.stopPrank();
    }

    /// Invariant 12: withdraw works while paused, with operator revoked, with stale or broken feeds.
    function test_withdraw_alwaysWorks() public {
        uint256 wethOut = _setupWithWeth(1000, 500);
        vm.startPrank(owner);
        vault.setPaused(true);
        vault.setOperator(address(0));
        vm.stopPrank();
        wethFeed.setUpdatedAt(block.timestamp - 30 days); // stale beyond lenient
        usdgFeed.setReverts(true); // broken
        nvdaFeed.set(-1, block.timestamp); // bad answer
        vm.prank(owner);
        vault.withdraw(address(weth), wethOut / 2, owner);
        assertTrue(vault.marksFrozen());
        vm.prank(owner);
        vault.withdraw(address(usdg), 100e6, owner);
        vm.prank(owner);
        vault.withdraw(address(weth), wethOut - wethOut / 2, owner);
        assertEq(weth.balanceOf(owner), wethOut);
    }

    function test_withdraw_worksWhenBalanceOfOfOtherTokenReverts() public {
        _deposit(100e6);
        nvda.mint(address(vault), 1e18);
        nvda.setBalanceOfReverts(true);
        vm.prank(owner);
        vault.withdraw(address(usdg), 100e6, owner);
        assertTrue(vault.marksFrozen());
        assertEq(usdg.balanceOf(owner), 100e6);
    }

    function test_withdraw_unlistedToken_rescue() public {
        MockERC20 junk = new MockERC20("Junk", "J", 18);
        junk.mint(address(vault), 5e18);
        _deposit(100e6);
        vm.prank(owner);
        vault.withdraw(address(junk), 5e18, owner);
        assertEq(junk.balanceOf(owner), 5e18);
        assertEq(vault.hwmNav(), _usd(100)); // not part of NAV
    }

    function test_withdraw_settlesFeesFirst() public {
        _setupWithWeth(1000, 500);
        wethFeed.setAnswer(3000e8); // +50% on 500 → +~250 profit
        vm.prank(owner);
        vault.withdraw(address(usdg), 10e6, owner);
        assertGt(usdg.balanceOf(creator), 0, "creator paid");
        assertGt(usdg.balanceOf(treasury), 0, "treasury paid");
    }

    function test_withdraw_feeTransferFailureIsSkipped() public {
        _setupWithWeth(1000, 500);
        wethFeed.setAnswer(3000e8);
        usdg.setFrozen(creator, true); // USDG blacklist on the creator
        vm.prank(owner);
        vault.withdraw(address(usdg), 10e6, owner);
        assertEq(usdg.balanceOf(owner), 10e6);
        assertEq(usdg.balanceOf(creator), 0);
    }

    function test_withdraw_whenFrozen_skipsScaling() public {
        _deposit(1000e6);
        usdgFeed.setReverts(true);
        vm.prank(owner);
        vault.withdraw(address(usdg), 100e6, owner);
        assertTrue(vault.marksFrozen());
        uint256 peak = vault.peakNav();
        vm.prank(owner);
        vault.withdraw(address(usdg), 100e6, owner);
        assertEq(vault.peakNav(), peak);
    }

    function test_withdraw_everything_zeroesMarks() public {
        _deposit(1000e6);
        vm.prank(owner);
        vault.withdraw(address(usdg), 1000e6, owner);
        assertEq(vault.peakNav(), 0);
        assertEq(vault.hwmNav(), 0);
    }

    function test_withdraw_disabledToken_noScaling() public {
        _setupWithWeth(1000, 500);
        vm.prank(owner);
        vault.unfollow(); // a held token can only be disabled when not following (TokenHeld otherwise)
        vm.prank(owner);
        vault.setTokenEnabled(address(weth), false);
        uint256 hwm = vault.hwmNav();
        uint256 bal = weth.balanceOf(address(vault));
        vm.prank(owner);
        vault.withdraw(address(weth), bal, owner);
        assertEq(vault.hwmNav(), hwm);
    }

    // ================================================================== follow / unfollow

    function test_follow_setsState() public {
        _deposit(1000e6);
        _follow(_usd(300));
        assertEq(vault.followingId(), strategyId);
        assertEq(vault.allocationUsd(), _usd(300));
        assertEq(vault.creatorShareSnapshot(), CREATOR_SHARE);
        assertEq(vault.hwmNav(), _usd(1000));
        assertEq(vault.lastFeeSettle(), block.timestamp);
    }

    function test_follow_inactiveReverts() public {
        vm.prank(creator);
        registry.setActive(strategyId, false);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ReceiptsVault.StrategyInactive.selector, strategyId));
        vault.follow(strategyId, 1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ReceiptsVault.StrategyInactive.selector, 99));
        vault.follow(99, 1);
    }

    function test_follow_switchSettlesFees() public {
        _setupWithWeth(1000, 500);
        wethFeed.setAnswer(3000e8);
        vm.prank(creator);
        uint256 id2 = registry.registerStrategy(signer, 1000, REVEAL_WINDOW, 0, "s2");
        vm.prank(owner);
        vault.follow(id2, _usd(100));
        assertGt(usdg.balanceOf(creator), 0);
        assertEq(vault.followingId(), id2);
        assertEq(vault.creatorShareSnapshot(), 1000);
    }

    function test_follow_stalePricesReverts() public {
        _setupWithWeth(1000, 500);
        wethFeed.setUpdatedAt(block.timestamp - STALENESS - 1);
        vm.prank(owner);
        vm.expectRevert(IReceiptsVault.PricesStale.selector);
        vault.follow(strategyId, 1);
        vm.prank(owner);
        vm.expectRevert(IReceiptsVault.PricesStale.selector);
        vault.unfollow();
    }

    function test_follow_whenFrozen_resetsMarks() public {
        _deposit(1000e6);
        usdgFeed.setReverts(true);
        vm.prank(owner);
        vault.withdraw(address(usdg), 100e6, owner);
        assertTrue(vault.marksFrozen());
        usdgFeed.setReverts(false);
        usdgFeed.setAnswer(1e8);
        _follow(_usd(10));
        assertFalse(vault.marksFrozen());
        assertEq(vault.peakNav(), _usd(900));
        assertEq(vault.hwmNav(), _usd(900));
    }

    function test_follow_frozenWhileFollowing_skipsFees() public {
        _setupWithWeth(1000, 500);
        usdgFeed.setReverts(true);
        vm.prank(owner);
        vault.withdraw(address(usdg), 10e6, owner);
        assertTrue(vault.marksFrozen());
        usdgFeed.setReverts(false);
        usdgFeed.setAnswer(1e8);
        wethFeed.setAnswer(3000e8);
        vm.prank(owner);
        vault.unfollow(); // frozen → no fee
        assertEq(usdg.balanceOf(creator), 0);
        _follow(_usd(10));
        assertFalse(vault.marksFrozen());
    }

    function test_unfollow() public {
        _deposit(100e6);
        vm.prank(owner);
        vm.expectRevert(IReceiptsVault.NotFollowing.selector);
        vault.unfollow();
        _follow(_usd(10));
        vm.prank(owner);
        vault.unfollow();
        assertEq(vault.followingId(), 0);
        assertEq(vault.creatorShareSnapshot(), 0);
    }

    // ================================================================== owner settings

    function test_setLimits_bounds() public {
        vm.startPrank(owner);
        vault.setLimits(500, MAX_DAILY, 500);
        vault.setLimits(0, 0, 5000);
        vm.expectRevert(IReceiptsVault.SlippageTooHigh.selector);
        vault.setLimits(501, 0, 1000);
        vm.expectRevert(IReceiptsVault.DailyLimitTooHigh.selector);
        vault.setLimits(100, MAX_DAILY + 1, 1000);
        vm.expectRevert(IReceiptsVault.BadDrawdown.selector);
        vault.setLimits(100, 1, 499);
        vm.expectRevert(IReceiptsVault.BadDrawdown.selector);
        vault.setLimits(100, 1, 5001);
        vm.stopPrank();
    }

    function testFuzz_setLimits(uint16 slip, uint256 daily, uint16 dd) public {
        bool ok = slip <= 500 && daily <= MAX_DAILY && dd >= 500 && dd <= 5000;
        vm.prank(owner);
        if (!ok) vm.expectRevert();
        vault.setLimits(slip, daily, dd);
        if (ok) {
            assertEq(vault.maxSlippageBps(), slip);
            assertEq(vault.dailyLimitUsd(), daily);
            assertEq(vault.drawdownBps(), dd);
        }
    }

    function test_setAllocation_setPaused_setOperator() public {
        vm.startPrank(owner);
        vault.setAllocation(123);
        assertEq(vault.allocationUsd(), 123);
        vault.setPaused(true);
        assertTrue(vault.paused());
        vault.setPaused(false);
        assertFalse(vault.paused());
        vault.setOperator(attacker);
        assertEq(vault.operator(), attacker);
        vm.stopPrank();
    }

    function test_setTokenEnabled() public {
        vm.startPrank(owner);
        vault.setTokenEnabled(address(nvda), false);
        assertEq(vault.allowedTokens().length, 3);
        vault.setTokenEnabled(address(nvda), false); // no-op
        vault.setTokenEnabled(address(nvda), true);
        assertEq(vault.allowedTokens().length, 4);
        vm.expectRevert(abi.encodeWithSelector(IReceiptsVault.TokenNotAllowed.selector, address(usdg)));
        vault.setTokenEnabled(address(usdg), false);
        vault.setTokenEnabled(address(usdg), true); // allowed no-op
        vm.expectRevert(abi.encodeWithSelector(IReceiptsVault.TokenNotAllowed.selector, address(0xdead)));
        vault.setTokenEnabled(address(0xdead), true);
        vm.stopPrank();
    }

    function test_setTokenEnabled_movesMarksLikeDepositWithdraw() public {
        _setupWithWeth(1000, 500);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ReceiptsVault.TokenHeld.selector, address(weth)));
        vault.setTokenEnabled(address(weth), false); // while following: withdraw instead (settles fees)
        vm.prank(owner);
        vault.unfollow();
        uint256 hwm0 = vault.hwmNav();
        uint256 nav0 = vault.navLenient();
        vm.prank(owner);
        vault.setTokenEnabled(address(weth), false);
        uint256 nav1 = vault.navLenient();
        assertApproxEqRel(vault.hwmNav(), (hwm0 * nav1) / nav0, 1e12);
        vm.prank(owner);
        vault.setTokenEnabled(address(weth), true);
        // disable scales proportionally, enable adds the value: the round trip lands within the swap cost (0.3%)
        assertApproxEqRel(vault.hwmNav(), hwm0, 0.002e18);
        assertLe(vault.hwmNav(), hwm0);
        assertApproxEqRel(vault.navStrict(), nav0, 1e12);
    }

    function test_setTokenEnabled_disableWithBrokenFeedFreezes() public {
        _deposit(1000e6);
        weth.mint(address(vault), 1e18); // not following
        wethFeed.setReverts(true);
        vm.prank(owner);
        vault.setTokenEnabled(address(weth), false);
        assertTrue(vault.marksFrozen());
    }

    function test_setTokenEnabled_enableNeedsPrice() public {
        vm.prank(owner);
        vault.setTokenEnabled(address(weth), false);
        weth.mint(address(vault), 1e18);
        wethFeed.setReverts(true);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IReceiptsVault.BadOraclePrice.selector, address(weth)));
        vault.setTokenEnabled(address(weth), true);
    }

    function test_resetPeak() public {
        _deposit(1000e6);
        usdgFeed.setAnswer(0.5e8);
        vm.prank(owner);
        vault.resetPeak();
        assertEq(vault.peakNav(), _usd(500));
        usdgFeed.setUpdatedAt(block.timestamp - 8 days);
        vm.prank(owner);
        vm.expectRevert(IReceiptsVault.PricesStale.selector);
        vault.resetPeak();
    }

    function test_resetMarks() public {
        _deposit(1000e6);
        vm.prank(owner);
        vm.expectRevert(IReceiptsVault.MarksNotFrozen.selector);
        vault.resetMarks();
        usdgFeed.setReverts(true);
        vm.prank(owner);
        vault.withdraw(address(usdg), 200e6, owner);
        vm.prank(owner);
        vm.expectRevert(IReceiptsVault.PricesStale.selector);
        vault.resetMarks();
        usdgFeed.setReverts(false);
        usdgFeed.setAnswer(1e8);
        vm.prank(owner);
        vault.resetMarks();
        assertFalse(vault.marksFrozen());
        assertEq(vault.peakNav(), _usd(800));
        assertEq(vault.hwmNav(), _usd(800));
    }

    // ================================================================== executeSignal — happy path

    function test_execute_buyAndSell() public {
        _deposit(1000e6);
        _follow(_usd(1000));
        uint64 n = _commitBuy(address(weth));
        uint256 out = _exec(n, address(usdg), address(weth), 400e6);
        assertEq(weth.balanceOf(address(vault)), out);
        assertEq(router.lastFee(), 100);
        assertTrue(vault.isExecuted(strategyId, n));
        assertEq(usdg.allowance(address(vault), address(router)), 0, "approval reset");
        assertEq(vault.usedInWindowUsd(), _usd(400));
        assertEq(vault.remainingDailyUsd(), MAX_DAILY - _usd(400));

        uint64 n2 = _commitSell(address(weth));
        uint256 back = _exec(n2, address(weth), address(usdg), out);
        assertGt(back, 0);
        assertEq(weth.balanceOf(address(vault)), 0);
        assertEq(weth.allowance(address(vault), address(router)), 0);
    }

    function test_execute_dustRejected() public {
        _deposit(1000e6);
        _follow(_usd(1000));
        uint64 n = _commitBuy(address(wbtc));
        vm.prank(operator);
        vm.expectRevert(IReceiptsVault.ZeroAmount.selector); // 1 wei USDG buys 0 sats at the oracle price
        vault.executeSignal(n, address(usdg), address(wbtc), 1, 0);
    }

    function test_execute_usesStricterOperatorMin() public {
        _deposit(1000e6);
        _follow(_usd(1000));
        uint64 n = _commitBuy(address(weth));
        uint256 fair = router.fairOut(address(usdg), address(weth), 100e6);
        vm.prank(operator);
        vm.expectRevert("Too little received");
        vault.executeSignal(n, address(usdg), address(weth), 100e6, fair); // router fee makes this impossible
    }

    // ================================================================== executeSignal — revert paths

    function test_execute_paused_notFollowing_zero() public {
        _deposit(1000e6);
        uint64 n = _commitBuy(address(weth));
        vm.prank(operator);
        vm.expectRevert(IReceiptsVault.NotFollowing.selector);
        vault.executeSignal(n, address(usdg), address(weth), 1e6, 0);
        _follow(_usd(1000));
        vm.prank(operator);
        vm.expectRevert(IReceiptsVault.ZeroAmount.selector);
        vault.executeSignal(n, address(usdg), address(weth), 0, 0);
        vm.prank(owner);
        vault.setPaused(true);
        vm.prank(operator);
        vm.expectRevert(IReceiptsVault.Paused.selector);
        vault.executeSignal(n, address(usdg), address(weth), 1e6, 0);
    }

    /// Invariant 6: only a live commit of followingId, later L2 block, once per nonce.
    function test_execute_commitRules() public {
        _deposit(1000e6);
        _follow(_usd(1000));
        // same L2 block as the commit
        bytes32 h = registry.hashSignal(strategyId, 0, _signal(address(usdg), address(weth), 1000), bytes32(0));
        vm.prank(signer);
        uint64 n = registry.commit(strategyId, h);
        vm.prank(operator);
        vm.expectRevert(IReceiptsVault.NotExecutable.selector);
        vault.executeSignal(n, address(usdg), address(weth), 1e6, 0);
        vm.roll(vm.getBlockNumber() + 1);
        _exec(n, address(usdg), address(weth), 1e6);
        // once per nonce
        vm.prank(operator);
        vm.expectRevert(IReceiptsVault.AlreadyExecuted.selector);
        vault.executeSignal(n, address(usdg), address(weth), 1e6, 0);
        // non-existent nonce
        vm.prank(operator);
        vm.expectRevert(IReceiptsVault.NotExecutable.selector);
        vault.executeSignal(77, address(usdg), address(weth), 1e6, 0);
        // after reveal
        uint64 n2 = _commitBuy(address(weth));
        registry.reveal(
            strategyId, n2, _signal(address(usdg), address(weth), 5000), keccak256(abi.encode("salt", block.number - 1))
        );
        vm.prank(operator);
        vm.expectRevert(IReceiptsVault.NotExecutable.selector);
        vault.executeSignal(n2, address(usdg), address(weth), 1e6, 0);
        // after deadline
        uint64 n3 = _commitBuy(address(weth));
        vm.warp(block.timestamp + REVEAL_WINDOW + 1);
        vm.prank(operator);
        vm.expectRevert(IReceiptsVault.NotExecutable.selector);
        vault.executeSignal(n3, address(usdg), address(weth), 1e6, 0);
    }

    function test_execute_otherStrategyCommitRejected() public {
        _deposit(1000e6);
        _follow(_usd(1000));
        vm.prank(attacker);
        uint256 evil = registry.registerStrategy(attacker, 0, REVEAL_WINDOW, 0, "evil");
        vm.prank(attacker);
        uint64 n = registry.commit(evil, bytes32("x"));
        vm.roll(vm.getBlockNumber() + 1);
        // nonce 0 of the followed strategy does not exist
        vm.prank(operator);
        vm.expectRevert(IReceiptsVault.NotExecutable.selector);
        vault.executeSignal(n, address(usdg), address(weth), 1e6, 0);
    }

    function test_execute_tokenRules() public {
        _deposit(1000e6);
        _follow(_usd(1000));
        uint64 n = _commitBuy(address(weth));
        vm.startPrank(operator);
        vm.expectRevert(ReceiptsVault.SameToken.selector);
        vault.executeSignal(n, address(usdg), address(usdg), 1e6, 0);
        n = _nextCommit();
        vm.startPrank(operator);
        vm.expectRevert(IReceiptsVault.PairNotAllowed.selector);
        vault.executeSignal(n, address(weth), address(wbtc), 1, 0);
        n = _nextCommit();
        vm.startPrank(operator);
        vm.expectRevert(abi.encodeWithSelector(IReceiptsVault.TokenNotAllowed.selector, address(0xdead)));
        vault.executeSignal(n, address(usdg), address(0xdead), 1e6, 0);
        n = _nextCommit();
        vm.startPrank(operator);
        vm.expectRevert(abi.encodeWithSelector(IReceiptsVault.TokenNotAllowed.selector, address(0xdead)));
        vault.executeSignal(n, address(0xdead), address(usdg), 1e6, 0);
        vm.stopPrank();
        vm.prank(owner);
        vault.setTokenEnabled(address(nvda), false);
        n = _nextCommit();
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IReceiptsVault.TokenNotAllowed.selector, address(nvda)));
        vault.executeSignal(n, address(usdg), address(nvda), 1e6, 0);
    }

    function _nextCommit() internal returns (uint64) {
        vm.stopPrank();
        return _commitBuy(address(weth));
    }

    function test_execute_stalePriceReverts() public {
        _deposit(1000e6);
        _follow(_usd(1000));
        uint64 n = _commitBuy(address(nvda));
        nvdaFeed.setUpdatedAt(block.timestamp - STALENESS - 1); // weekend: stock feed paused
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IReceiptsVault.StaleOraclePrice.selector, address(nvda)));
        vault.executeSignal(n, address(usdg), address(nvda), 1e6, 0);
        nvdaFeed.set(0, block.timestamp);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IReceiptsVault.BadOraclePrice.selector, address(nvda)));
        vault.executeSignal(n, address(usdg), address(nvda), 1e6, 0);
        nvdaFeed.set(150e8, block.timestamp + 1); // future-dated
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IReceiptsVault.StaleOraclePrice.selector, address(nvda)));
        vault.executeSignal(n, address(usdg), address(nvda), 1e6, 0);
        nvdaFeed.set(150e8, block.timestamp);
        nvdaFeed.setDecimalsReverts(true);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IReceiptsVault.BadOraclePrice.selector, address(nvda)));
        vault.executeSignal(n, address(usdg), address(nvda), 1e6, 0);
        nvdaFeed.setDecimalsReverts(false);
        nvdaFeed.setDecimals(37);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IReceiptsVault.BadOraclePrice.selector, address(nvda)));
        vault.executeSignal(n, address(usdg), address(nvda), 1e6, 0);
    }

    function test_execute_feedDecimalsAbove18() public {
        _deposit(1000e6);
        _follow(_usd(1000));
        nvdaFeed.setDecimals(20);
        nvdaFeed.setAnswer(150e20);
        router.setFeed(address(nvda), nvdaFeed);
        uint64 n = _commitBuy(address(nvda));
        uint256 out = _exec(n, address(usdg), address(nvda), 150e6);
        assertApproxEqRel(out, 1e18, 0.01e18);
        assertEq(vault.priceUsd(address(nvda)), 150e18);
    }

    function test_execute_lenientNavFailureReverts() public {
        _setupWithWeth(1000, 100);
        wethFeed.setUpdatedAt(block.timestamp - 8 days);
        uint64 n = _commitBuy(address(wbtc));
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IReceiptsVault.StaleOraclePrice.selector, address(weth)));
        vault.executeSignal(n, address(usdg), address(wbtc), 1e6, 0);
    }

    /// Invariant 8: daily limit.
    function test_execute_dailyLimit() public {
        _deposit(5000e6);
        _follow(_usd(1_000_000));
        vm.prank(owner);
        vault.setLimits(100, _usd(1000), 2000);
        uint64 n = _commitBuy(address(weth));
        _exec(n, address(usdg), address(weth), 700e6);
        n = _commitBuy(address(weth));
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IReceiptsVault.DailyLimitExceeded.selector, _usd(301), _usd(300)));
        vault.executeSignal(n, address(usdg), address(weth), 301e6, 0);
        _exec(n, address(usdg), address(weth), 300e6);
        assertEq(vault.remainingDailyUsd(), 0);
        vm.warp(block.timestamp + 1 days);
        assertEq(vault.remainingDailyUsd(), _usd(1000));
        n = _commitBuy(address(weth));
        _exec(n, address(usdg), address(weth), 1000e6);
        // owner lowers limit below used
        vm.prank(owner);
        vault.setLimits(100, _usd(500), 2000);
        assertEq(vault.remainingDailyUsd(), 0);
    }

    /// Invariant 9: allocation cap after buys.
    function test_execute_allocationCap() public {
        _deposit(2000e6);
        _follow(_usd(500));
        uint64 n = _commitBuy(address(weth));
        vm.prank(operator);
        vm.expectRevert(); // AllocationExceeded(exposure, 500e18)
        vault.executeSignal(n, address(usdg), address(weth), 600e6, 0);
        _exec(n, address(usdg), address(weth), 450e6);
        assertLe(vault.exposureUsd(), _usd(500));
        // sells are always allowed even above the cap
        vm.prank(owner);
        vault.setAllocation(0);
        n = _commitSell(address(weth));
        _exec(n, address(weth), address(usdg), weth.balanceOf(address(vault)) / 2);
    }

    /// Invariant 7: whatever the router reports, delivered output ≥ oracle × (1 − slippage).
    function test_execute_cheatingRouters() public {
        _deposit(1000e6);
        _follow(_usd(1000));
        uint64 n = _commitBuy(address(weth));

        router.setMode(MockRouter.Mode.UnderDeliver);
        vm.prank(operator);
        vm.expectRevert(); // InsufficientOutput
        vault.executeSignal(n, address(usdg), address(weth), 100e6, 0);

        router.setMode(MockRouter.Mode.FakeReport);
        vm.prank(operator);
        vm.expectRevert(); // InsufficientOutput(0, min)
        vault.executeSignal(n, address(usdg), address(weth), 100e6, 0);

        router.setMode(MockRouter.Mode.SendElsewhere);
        vm.prank(operator);
        vm.expectRevert();
        vault.executeSignal(n, address(usdg), address(weth), 100e6, 0);

        router.setMode(MockRouter.Mode.OverPull);
        vm.prank(operator);
        vm.expectRevert(); // allowance is exactly amountIn
        vault.executeSignal(n, address(usdg), address(weth), 100e6, 0);

        // slippage beyond the oracle limit
        router.setMode(MockRouter.Mode.Honest);
        router.setSlipBps(80); // 0.3% fee + 0.8% > 1% limit
        vm.prank(operator);
        vm.expectRevert("Too little received");
        vault.executeSignal(n, address(usdg), address(weth), 100e6, 0);
        router.setSlipBps(60);
        _exec(n, address(usdg), address(weth), 100e6);
    }

    /// Invariant 13: approval is 0 after every swap, even if the router leaves allowance unused.
    function test_execute_allowanceResetWhenRouterPullsLess() public {
        _deposit(1000e6);
        _follow(_usd(1000));
        router.setMode(MockRouter.Mode.KeepAllowance);
        uint64 n = _commitBuy(address(weth));
        _exec(n, address(usdg), address(weth), 100e6);
        assertEq(usdg.allowance(address(vault), address(router)), 0);
    }

    function test_execute_reentrancyBlocked() public {
        _deposit(1000e6);
        _follow(_usd(1000));
        vm.prank(owner);
        vault.setOperator(address(router)); // worst case: router is also the operator
        router.setMode(MockRouter.Mode.Reenter);
        uint64 n = _commitBuy(address(weth));
        vm.prank(address(router));
        vault.executeSignal(n, address(usdg), address(weth), 100e6, 0);
        assertFalse(router.reentrySucceeded());
    }

    // ================================================================== breaker (invariant 11)

    function test_breaker_preCheckTripsWithoutSwap() public {
        _setupWithWeth(1000, 500);
        wethFeed.setAnswer(800e8); // weth -60% → nav ≈ 700 < 80% of peak 1000
        uint64 n = _commitBuy(address(weth));
        uint256 usdgBefore = usdg.balanceOf(address(vault));
        vm.expectEmit(false, false, false, false);
        emit BreakerTripped(0, 0);
        uint256 out = _exec(n, address(usdg), address(weth), 10e6);
        assertEq(out, 0);
        assertTrue(vault.paused());
        assertEq(usdg.balanceOf(address(vault)), usdgBefore, "no swap");
        assertFalse(vault.isExecuted(strategyId, n));
    }

    function test_breaker_postTradeTrip() public {
        _deposit(1000e6);
        _follow(_usd(1_000_000));
        vm.prank(owner);
        vault.setLimits(500, MAX_DAILY, 500); // 5% drawdown, 5% slippage
        uint64 n = _commitBuy(address(weth));
        uint256 out = _exec(n, address(usdg), address(weth), 500e6);
        wethFeed.setAnswer(1860e8); // -7% on the WETH half → NAV ≈ 963.5, still above 95% of peak
        router.setSlipBps(400); // the sell costs 4.3% → NAV ≈ 943 < 950 after the trade
        n = _commitSell(address(weth));
        _exec(n, address(weth), address(usdg), out);
        assertTrue(vault.paused());
    }

    function test_checkBreaker() public {
        _setupWithWeth(1000, 500);
        assertFalse(vault.checkBreaker());
        wethFeed.setAnswer(800e8);
        vm.prank(attacker);
        assertTrue(vault.checkBreaker());
        assertTrue(vault.paused());
        assertTrue(vault.checkBreaker()); // already paused, still reports the breach
        wethFeed.setUpdatedAt(block.timestamp - 8 days);
        vm.expectRevert(IReceiptsVault.PricesStale.selector);
        vault.checkBreaker();
    }

    function test_breaker_resetPeakRearms() public {
        _setupWithWeth(1000, 500);
        wethFeed.setAnswer(800e8);
        vault.checkBreaker();
        vm.startPrank(owner);
        vault.resetPeak();
        vault.setPaused(false);
        vm.stopPrank();
        assertFalse(vault.checkBreaker());
    }

    // ================================================================== fees (invariant 10)

    function test_fees_settleAfterProfit() public {
        _setupWithWeth(1000, 500);
        uint256 hwm0 = vault.hwmNav();
        wethFeed.setAnswer(3000e8);
        uint256 nav = vault.navStrict();
        uint256 profit = nav - hwm0;
        vm.expectRevert(IReceiptsVault.TooSoon.selector);
        vault.settleFees();
        vm.warp(vm.getBlockTimestamp() + 7 days);
        wethFeed.setAnswer(3000e8);
        usdgFeed.setAnswer(1e8);
        vm.prank(attacker); // anyone
        vault.settleFees();
        uint256 creatorFee = (profit * CREATOR_SHARE) / 10_000;
        uint256 protocolFee = (creatorFee * PROTOCOL_CUT) / 10_000;
        assertApproxEqAbs(usdg.balanceOf(creator) * 1e12, creatorFee - protocolFee, 2e12);
        assertApproxEqAbs(usdg.balanceOf(treasury) * 1e12, protocolFee, 2e12);
        assertApproxEqAbs(vault.hwmNav(), nav - creatorFee, 2e12);
        assertEq(vault.lastFeeSettle(), vm.getBlockTimestamp());
        // no double charge
        vm.warp(vm.getBlockTimestamp() + 7 days);
        wethFeed.setAnswer(3000e8);
        usdgFeed.setAnswer(1e8);
        uint256 c = usdg.balanceOf(creator);
        vault.settleFees();
        assertEq(usdg.balanceOf(creator), c);
    }

    function test_fees_zeroWhenLoss() public {
        _setupWithWeth(1000, 500);
        wethFeed.setAnswer(1900e8);
        vm.warp(block.timestamp + 7 days);
        wethFeed.setAnswer(1900e8);
        usdgFeed.setAnswer(1e8);
        vault.settleFees();
        assertEq(usdg.balanceOf(creator), 0);
        assertEq(usdg.balanceOf(treasury), 0);
        assertEq(vault.lastFeeSettle(), block.timestamp);
    }

    function test_fees_deferredWhenNoBase() public {
        _deposit(1000e6);
        _follow(_usd(1_000_000));
        uint64 n = _commitBuy(address(weth));
        _exec(n, address(usdg), address(weth), 1000e6); // all-in WETH, 0 USDG left
        wethFeed.setAnswer(4000e8);
        vm.warp(block.timestamp + 7 days);
        wethFeed.setAnswer(4000e8);
        usdgFeed.setAnswer(1e8);
        uint256 hwm = vault.hwmNav();
        uint256 last = vault.lastFeeSettle();
        vm.expectEmit(false, false, false, false);
        emit FeeDeferred(0, 0, 0);
        vault.settleFees();
        assertEq(vault.hwmNav(), hwm);
        assertEq(vault.lastFeeSettle(), last);
        assertEq(usdg.balanceOf(creator), 0);
    }

    function test_fees_reverts() public {
        vm.expectRevert(IReceiptsVault.NotFollowing.selector);
        vault.settleFees();
        _deposit(100e6);
        _follow(_usd(10));
        usdgFeed.setReverts(true);
        vm.prank(owner);
        vault.withdraw(address(usdg), 1e6, owner);
        vm.expectRevert(ReceiptsVault.MarksAreFrozen.selector);
        vault.settleFees();
    }

    function test_fees_staleRevertsPricesStale() public {
        _setupWithWeth(1000, 500);
        vm.warp(block.timestamp + 7 days);
        vm.expectRevert(IReceiptsVault.PricesStale.selector);
        vault.settleFees(); // feeds not updated for 7 days
    }

    function test_fees_baseStaleRevertsPricesStale() public {
        _deposit(1000e6);
        _follow(_usd(1000));
        nvda.mint(address(vault), 2e18); // direct transfer counts as profit
        vm.warp(block.timestamp + 7 days);
        nvdaFeed.setAnswer(150e8);
        usdgFeed.setAnswer(1e8);
        // strict NAV ok, then base price goes stale only for the payment conversion — simulate via 6-dec rounding:
        usdgFeed.setUpdatedAt(block.timestamp - USDG_STALENESS - 1);
        vm.expectRevert(IReceiptsVault.PricesStale.selector);
        vault.settleFees();
    }

    function test_fees_useLoweredShare() public {
        _setupWithWeth(1000, 500);
        vm.prank(creator);
        registry.lowerCreatorShare(strategyId, 0);
        wethFeed.setAnswer(3000e8);
        vm.warp(block.timestamp + 7 days);
        wethFeed.setAnswer(3000e8);
        usdgFeed.setAnswer(1e8);
        vault.settleFees();
        assertEq(usdg.balanceOf(creator), 0);
        assertEq(usdg.balanceOf(treasury), 0);
    }

    function testFuzz_fees_bounded(uint256 priceMove, uint256 buyUsd) public {
        buyUsd = bound(buyUsd, 1, 1000);
        priceMove = bound(priceMove, 500e8, 20_000e8);
        _setupWithWeth(1000, buyUsd);
        uint256 hwm = vault.hwmNav();
        wethFeed.setAnswer(int256(priceMove));
        vm.warp(block.timestamp + 7 days);
        wethFeed.setAnswer(int256(priceMove));
        usdgFeed.setAnswer(1e8);
        uint256 nav = vault.navStrict();
        vault.settleFees();
        uint256 paid = (usdg.balanceOf(creator) + usdg.balanceOf(treasury)) * 1e12;
        uint256 bound_ = nav > hwm ? ((nav - hwm) * CREATOR_SHARE) / 10_000 : 0;
        assertLe(paid, bound_);
    }

    // ================================================================== views

    function test_views_unlistedPrice() public {
        vm.expectRevert(abi.encodeWithSelector(IReceiptsVault.TokenNotAllowed.selector, address(0xdead)));
        vault.priceUsd(address(0xdead));
        assertEq(vault.priceUsd(address(weth)), 2000e18);
    }

    function test_views_navRevertReasons() public {
        _setupWithWeth(1000, 500);
        wethFeed.setUpdatedAt(block.timestamp - STALENESS - 1);
        vm.expectRevert(abi.encodeWithSelector(IReceiptsVault.StaleOraclePrice.selector, address(weth)));
        vault.navStrict();
        assertGt(vault.navLenient(), 0);
        wethFeed.setReverts(true);
        vm.expectRevert(abi.encodeWithSelector(IReceiptsVault.BadOraclePrice.selector, address(weth)));
        vault.navLenient();
        vm.expectRevert(abi.encodeWithSelector(IReceiptsVault.BadOraclePrice.selector, address(weth)));
        vault.exposureUsd();
        wethFeed.setReverts(false);
        weth.setBalanceOfReverts(true);
        vm.expectRevert(abi.encodeWithSelector(IReceiptsVault.BadOraclePrice.selector, address(weth)));
        vault.navLenient();
    }

    function test_views_isExecuted() public view {
        assertFalse(vault.isExecuted(strategyId, 0));
    }
}
