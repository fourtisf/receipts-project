// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Base} from "./utils/Base.t.sol";
import {ReceiptsVault} from "../src/ReceiptsVault.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {IReceiptsVault} from "../src/interfaces/IReceiptsVault.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockFeed} from "./mocks/MockFeed.sol";
import {EvilToken, MutableDecimalsToken} from "./mocks/EvilToken.sol";

/// @notice Regression tests for the independent adversarial review (findings F-1 … F-7). Each test asserts the FIXED
///         behaviour; the original proof tests demonstrated the issues against the previous code.
contract ReviewRegressionTest is Base {
    EvilToken internal evil;
    MockFeed internal evilFeed;
    VaultFactory internal factory2;
    ReceiptsVault internal vault2;
    address internal owner2 = makeAddr("owner2");

    function setUp() public override {
        super.setUp();
        evil = new EvilToken();
        evilFeed = new MockFeed(8, 150e8);
        router.setFeed(address(evil), evilFeed);
        factory2 = _factoryWith(address(evil), address(evilFeed));
        vm.prank(owner2);
        vault2 = ReceiptsVault(factory2.createVault(100, MAX_DAILY, 2000));
    }

    function _factoryWith(address extra, address extraFeed) internal returns (VaultFactory f) {
        address[] memory tokens = new address[](3);
        address[] memory feeds = new address[](3);
        uint32[] memory stale = new uint32[](3);
        uint24[] memory tiers = new uint24[](3);
        (tokens[0], feeds[0], stale[0], tiers[0]) = (address(usdg), address(usdgFeed), USDG_STALENESS, 0);
        (tokens[1], feeds[1], stale[1], tiers[1]) = (address(weth), address(wethFeed), STALENESS, 100);
        (tokens[2], feeds[2], stale[2], tiers[2]) = (extra, extraFeed, STALENESS, 3000);
        vm.prank(admin);
        f = new VaultFactory(
            address(router),
            address(registry),
            address(usdg),
            treasury,
            PROTOCOL_CUT,
            MAX_DAILY,
            operator,
            tokens,
            feeds,
            stale,
            tiers
        );
    }

    function _setup2(uint256 depositUsd, uint256 buyUsd) internal {
        usdg.mint(owner2, depositUsd * 1e6);
        vm.startPrank(owner2);
        usdg.approve(address(vault2), depositUsd * 1e6);
        vault2.deposit(depositUsd * 1e6);
        vault2.follow(strategyId, 1_000_000e18);
        vm.stopPrank();
        uint64 n = _commitBuy(address(weth));
        vm.prank(operator);
        vault2.executeSignal(n, address(usdg), address(weth), buyUsd * 1e6, 0);
    }

    function _feesPaid() internal view returns (uint256) {
        return usdg.balanceOf(creator) + usdg.balanceOf(treasury);
    }

    // ---------------------------------------------------------------- F-1: NAV overflow can no longer brick withdraw

    function test_F1_hugeBalanceOf_withdrawStillWorks_following() public {
        _setup2(5000, 1000);
        evil.setMode(EvilToken.Mode.HugeBalance);
        uint256 wethBal = weth.balanceOf(address(vault2));
        vm.startPrank(owner2);
        vault2.withdraw(address(usdg), 1000e6, owner2);
        vault2.withdraw(address(weth), wethBal, owner2);
        vm.stopPrank();
        assertTrue(vault2.marksFrozen(), "NAV unreadable -> marks frozen, not a revert");
        assertEq(usdg.balanceOf(owner2), 1000e6);
        assertEq(weth.balanceOf(owner2), wethBal);
        vm.expectRevert(abi.encodeWithSelector(IReceiptsVault.BadOraclePrice.selector, address(evil)));
        vault2.navLenient(); // the views still report the precise problem
    }

    function test_F1_hugeBalanceOf_withdrawStillWorks_notFollowing() public {
        usdg.mint(owner2, 100e6);
        vm.startPrank(owner2);
        usdg.approve(address(vault2), 100e6);
        vault2.deposit(100e6);
        vm.stopPrank();
        evil.setMode(EvilToken.Mode.HugeBalance);
        vm.prank(owner2);
        vault2.withdraw(address(usdg), 100e6, owner2);
        assertEq(usdg.balanceOf(owner2), 100e6);
    }

    function test_F1_tokenDecimalsAbove36_rejectedAtVaultCreation() public {
        MutableDecimalsToken mut = new MutableDecimalsToken();
        MockFeed f = new MockFeed(8, 1e8);
        VaultFactory fac = _factoryWith(address(mut), address(f)); // 18 decimals at factory deploy
        mut.setDecimals(78); // later upgrade
        vm.prank(owner2);
        vm.expectRevert(ReceiptsVault.BadConfig.selector);
        fac.createVault(100, MAX_DAILY, 2000);
    }

    function test_F1_absurdFeedAnswer_isBadPrice_notOverflow() public {
        _setup2(1000, 100);
        wethFeed.setAnswer(type(int256).max);
        vm.expectRevert(abi.encodeWithSelector(IReceiptsVault.BadOraclePrice.selector, address(weth)));
        vault2.navLenient();
        vm.prank(owner2);
        vault2.withdraw(address(usdg), 10e6, owner2);
    }

    // ---------------------------------------------------------------- F-5: gas-bomb token cannot starve withdraw

    function test_F5_gasBombBalanceOf_withdrawWithNormalGas() public {
        _setup2(5000, 1000);
        wethFeed.setAnswer(3000e8); // profit, so the fee self-call runs a full NAV too
        evil.setMode(EvilToken.Mode.GasBomb);
        vm.prank(owner2);
        vault2.withdraw{gas: 3_000_000}(address(usdg), 100e6, owner2);
        assertEq(usdg.balanceOf(owner2), 100e6);
    }

    // ---------------------------------------------------------------- F-2: token switch cannot dodge or fake fees

    function test_F2_cannotDisableHeldTokenWhileFollowing() public {
        _setupWithWeth(5000, 2000);
        wethFeed.setAnswer(4000e8);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ReceiptsVault.TokenHeld.selector, address(weth)));
        vault.setTokenEnabled(address(weth), false);
        // the honest exit settles the fee first
        uint256 bal = weth.balanceOf(address(vault));
        vm.prank(owner);
        vault.withdraw(address(weth), bal, owner);
        assertGt(_feesPaid(), 390e6, "creator + treasury paid on the profit before the token left");
    }

    function test_F2_unheldTokenCanStillBeDisabledWhileFollowing() public {
        _deposit(1000e6);
        _follow(_usd(1000));
        vm.prank(owner);
        vault.setTokenEnabled(address(nvda), false);
        assertEq(vault.allowedTokens().length, 3);
    }

    // ---------------------------------------------------------------- F-3: switching strategies cannot erase a fee

    function test_F3_unfollowRevertsWhileFeeUnpaid_thenPaysAfterTopUp() public {
        _setupWithWeth(2000, 1900); // ~100 USDG left
        wethFeed.setAnswer(4000e8);
        vm.prank(owner);
        vm.expectRevert(); // FeeUnpaid(needed, balance)
        vault.unfollow();
        vm.prank(creator);
        uint256 id2 = registry.registerStrategy(signer, 0, REVEAL_WINDOW, 0, "s2");
        vm.prank(owner);
        vm.expectRevert();
        vault.follow(id2, 1);
        // top up with USDG, then the fee is paid and unfollow works
        _deposit(2000e6);
        vm.prank(owner);
        vault.unfollow();
        assertGt(usdg.balanceOf(creator), 0);
        assertEq(vault.followingId(), 0);
    }

    function test_F3_settleFeesStillDefersWithoutReverting() public {
        _setupWithWeth(2000, 1900);
        wethFeed.setAnswer(4000e8);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        wethFeed.setAnswer(4000e8);
        usdgFeed.setAnswer(1e8);
        vault.settleFees(); // FeeDeferred, no revert
        assertEq(_feesPaid(), 0);
    }

    // ---------------------------------------------------------------- F-4: dead-feed dust (documented) — recovery path

    function test_F4_deadFeedDust_ownerRecoversByWithdrawingIt() public {
        MockERC20 dead = new MockERC20("Dead", "DEAD", 18);
        MockFeed deadFeed = new MockFeed(8, 10e8);
        VaultFactory fac = _factoryWith(address(dead), address(deadFeed));
        vm.prank(owner2);
        ReceiptsVault v = ReceiptsVault(fac.createVault(100, MAX_DAILY, 2000));
        usdg.mint(owner2, 1000e6);
        vm.startPrank(owner2);
        usdg.approve(address(v), 1000e6);
        v.deposit(1000e6);
        v.follow(strategyId, 1_000_000e18);
        vm.stopPrank();
        deadFeed.setUpdatedAt(block.timestamp - 8 days); // feed deprecated
        dead.mint(address(v), 1); // griefing donation
        uint64 n = _commitBuy(address(weth));
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IReceiptsVault.StaleOraclePrice.selector, address(dead)));
        v.executeSignal(n, address(usdg), address(weth), 10e6, 0);
        // recovery: withdraw the dust (always possible), re-arm marks, trading resumes
        vm.startPrank(owner2);
        v.withdraw(address(dead), 1, owner2);
        v.resetMarks();
        vm.stopPrank();
        vm.prank(operator);
        assertGt(v.executeSignal(n, address(usdg), address(weth), 10e6, 0), 0);
    }
}
