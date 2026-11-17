// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {SignalRegistry} from "../../src/SignalRegistry.sol";
import {ReceiptsVault} from "../../src/ReceiptsVault.sol";
import {VaultFactory} from "../../src/VaultFactory.sol";
import {ISignalRegistry} from "../../src/interfaces/ISignalRegistry.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockFeed} from "../mocks/MockFeed.sol";
import {MockRouter} from "../mocks/MockRouter.sol";

/// @dev Random sequences of owner / operator / signer / attacker / admin / time / oracle actions.
///      Every per-call property from CONTRACTS.md §5 is checked inside the action; violations set a ghost flag
///      that the invariant contract asserts after each step.
contract VaultHandler is Test {
    SignalRegistry public registry;
    VaultFactory public factory;
    ReceiptsVault public vault;
    MockRouter public router;
    MockERC20[] public tokens; // [0] = base
    MockFeed[] public feeds;
    uint256 public strategyId;

    address public owner;
    address public operator;
    address public signer;
    address public creator;
    address public treasury;
    address public attacker = address(0xA77AC);
    address public admin;

    // ghosts
    string public violation; // empty = no violation
    uint256 public calls;
    uint256 public successfulSwaps;
    uint256 public breakerTrips;
    uint256 public feeSettlements;
    uint256 public withdrawals;
    address public expectedOperator;
    address public expectedTreasury;

    struct Pending {
        uint64 nonce;
        ISignalRegistry.Signal signal;
        bytes32 salt;
    }

    Pending[] internal pending;

    constructor(
        SignalRegistry registry_,
        VaultFactory factory_,
        ReceiptsVault vault_,
        MockRouter router_,
        MockERC20[] memory tokens_,
        MockFeed[] memory feeds_,
        uint256 strategyId_,
        address[6] memory actors // owner, operator, signer, creator, treasury, admin
    ) {
        registry = registry_;
        factory = factory_;
        vault = vault_;
        router = router_;
        for (uint256 i; i < tokens_.length; ++i) {
            tokens.push(tokens_[i]);
            feeds.push(feeds_[i]);
        }
        strategyId = strategyId_;
        (owner, operator, signer, creator, treasury, admin) =
        (actors[0], actors[1], actors[2], actors[3], actors[4], actors[5]);
        expectedOperator = operator;
        expectedTreasury = treasury;
    }

    function _flag(string memory why) internal {
        if (bytes(violation).length == 0) violation = why;
    }

    function _token(uint256 seed) internal view returns (MockERC20) {
        return tokens[seed % tokens.length];
    }

    function _nonBase(uint256 seed) internal view returns (MockERC20) {
        return tokens[1 + (seed % (tokens.length - 1))];
    }

    // ------------------------------------------------------------------ owner

    function deposit(uint256 amount) external {
        calls++;
        amount = bound(amount, 1e6, 5000e6);
        tokens[0].mint(owner, amount);
        vm.startPrank(owner);
        tokens[0].approve(address(vault), amount);
        try vault.deposit(amount) {} catch {}
        vm.stopPrank();
    }

    /// Invariant 12: withdraw by the owner always succeeds (paused, revoked, stale or broken feeds).
    function withdraw(uint256 seed, uint256 amount) external {
        calls++;
        MockERC20 t = _token(seed);
        uint256 bal = t.balanceOf(address(vault));
        if (bal == 0) return;
        amount = bound(amount, 1, amount % 5 == 0 ? bal : (bal + 1) / 2);
        uint256 ownerBefore = t.balanceOf(owner);
        uint256 feesBefore = tokens[0].balanceOf(creator) + tokens[0].balanceOf(treasury);
        uint256 bound_ = _feeBound();
        vm.prank(owner);
        try vault.withdraw(address(t), amount, owner) {
            withdrawals++;
            if (t.balanceOf(owner) != ownerBefore + amount) _flag("withdraw amount");
            uint256 paid = tokens[0].balanceOf(creator) + tokens[0].balanceOf(treasury) - feesBefore;
            if (paid * _baseScale() > bound_ + 1e12) _flag("withdraw fee above bound");
        } catch {
            _flag("withdraw reverted");
        }
    }

    function setLimits(uint16 slip, uint256 daily, uint16 dd) external {
        calls++;
        slip = uint16(bound(slip, 0, 500));
        daily = bound(daily, 0, vault.maxDailyLimitUsd());
        dd = uint16(bound(dd, 500, 5000));
        vm.prank(owner);
        vault.setLimits(slip, daily, dd);
    }

    function setPaused(uint256 seed) external {
        calls++;
        vm.prank(owner);
        vault.setPaused(seed % 4 == 0); // mostly unpause so trading resumes
    }

    function setOperator(uint256 seed) external {
        calls++;
        address next = seed % 4 == 0 ? address(0) : operator; // mostly restore the bot
        vm.prank(owner);
        vault.setOperator(next);
        expectedOperator = next;
    }

    function setAllocation(uint256 usd) external {
        calls++;
        vm.prank(owner);
        vault.setAllocation(bound(usd, 0, 20_000e18));
    }

    function setTokenEnabled(uint256 seed, bool on) external {
        calls++;
        vm.prank(owner);
        try vault.setTokenEnabled(address(_nonBase(seed)), on) {} catch {}
    }

    function follow(uint256 alloc) external {
        calls++;
        uint256 feesBefore = tokens[0].balanceOf(creator) + tokens[0].balanceOf(treasury);
        uint256 bound_ = _feeBound();
        vm.prank(owner);
        try vault.follow(strategyId, bound(alloc, 0, 20_000e18)) {
            uint256 paid = tokens[0].balanceOf(creator) + tokens[0].balanceOf(treasury) - feesBefore;
            if (paid * _baseScale() > bound_ + 1e12) _flag("follow fee above bound");
        } catch {}
    }

    function unfollow() external {
        calls++;
        vm.prank(owner);
        try vault.unfollow() {} catch {}
    }

    function resetPeak() external {
        calls++;
        vm.prank(owner);
        try vault.resetPeak() {} catch {}
    }

    function resetMarks() external {
        calls++;
        vm.prank(owner);
        try vault.resetMarks() {} catch {}
    }

    // ------------------------------------------------------------------ signer

    function commit(uint256 seed, uint16 size) external {
        _commitAction(seed, size);
    }

    /// @dev Commit, move to the next L2 block, execute: the normal pipeline, so most runs exercise real swaps.
    function commitAndExecute(uint256 seed, uint16 size, uint256 amountSeed, uint256 modeSeed) external {
        _commitAction(seed, size);
        _executeAction(type(uint256).max, amountSeed | 1, modeSeed | 1, 1);
    }

    function _commitAction(uint256 seed, uint16 size) internal {
        calls++;
        MockERC20 nb = _nonBase(seed);
        bool buy = seed % 2 == 0 || nb.balanceOf(address(vault)) == 0;
        ISignalRegistry.Signal memory s = ISignalRegistry.Signal({
            tokenIn: buy ? address(tokens[0]) : address(nb),
            tokenOut: buy ? address(nb) : address(tokens[0]),
            sizeBps: uint16(bound(size, 1, 10_000)),
            promptHash: bytes32(0)
        });
        bytes32 salt = keccak256(abi.encode(seed, calls));
        uint64 next = registry.strategyOf(strategyId).commitCount;
        bytes32 h = registry.hashSignal(strategyId, next, s, salt); // compute first: vm.prank applies to the next call
        vm.prank(signer);
        try registry.commit(strategyId, h) returns (uint64 n) {
            if (n != next) _flag("nonce not sequential");
            pending.push(Pending({nonce: n, signal: s, salt: salt}));
        } catch {}
    }

    function reveal(uint256 idx) external {
        calls++;
        if (pending.length == 0) return;
        Pending memory p = pending[idx % pending.length];
        try registry.reveal(strategyId, p.nonce, p.signal, p.salt) {
            if (registry.isExecutable(strategyId, p.nonce)) _flag("executable after reveal");
        } catch {}
    }

    // ------------------------------------------------------------------ operator

    struct ExecCtx {
        bool wasExecutable;
        bool wasExecuted;
        uint256 expectedOut;
        uint256 slip;
        uint256 usedBefore;
        uint256 windowStartBefore;
    }

    function execute(uint256 idx, uint256 amountSeed, uint256 modeSeed, uint256 minOutSeed) external {
        _executeAction(idx, amountSeed, modeSeed, minOutSeed);
    }

    function _executeAction(uint256 idx, uint256 amountSeed, uint256 modeSeed, uint256 minOutSeed) internal {
        calls++;
        if (pending.length == 0) return;
        // favour recent commits (most are still live), sometimes pick old ones (expired / revealed / executed)
        uint256 pick = idx == type(uint256).max
            ? pending.length - 1
            : idx % 4 == 0 ? idx % pending.length : pending.length - 1 - (idx % _min(pending.length, 3));
        Pending memory p = pending[pick];
        MockERC20 tin = MockERC20(p.signal.tokenIn);
        MockERC20 tout = MockERC20(p.signal.tokenOut);
        uint256 bal = tin.balanceOf(address(vault));
        if (bal == 0) return;
        bool isBuy = address(tin) == address(tokens[0]);
        uint256 amountIn = bound(amountSeed, 1, isBuy ? (bal + 3) / 4 : bal);
        if (amountSeed % 5 != 0) vm.roll(vm.getBlockNumber() + 1); // usually a later L2 block than the commit
        if (modeSeed % 6 != 0) _refresh(address(tin), address(tout)); // usually fresh feeds

        router.setMode(modeSeed % 3 == 0 ? MockRouter.Mode((modeSeed >> 4) % 7) : MockRouter.Mode.Honest);
        router.setSlipBps(bound(modeSeed >> 8, 0, 300));

        ExecCtx memory c;
        c.wasExecutable = registry.isExecutable(strategyId, p.nonce);
        c.wasExecuted = vault.isExecuted(strategyId, p.nonce);
        c.slip = vault.maxSlippageBps();
        c.expectedOut = _oracleOut(tin, tout, amountIn);
        uint256 minOutOp = minOutSeed % 4 == 0 ? (c.expectedOut * (10_000 - (minOutSeed % 500))) / 10_000 : 0;
        uint256 outBefore = tout.balanceOf(address(vault));

        vm.prank(operator);
        try vault.executeSignal(p.nonce, address(tin), address(tout), amountIn, minOutOp) returns (uint256 out) {
            if (out == 0) {
                // breaker pre-check trip: no swap, no execution recorded
                if (!vault.paused()) _flag("returned 0 without pause");
                if (vault.isExecuted(strategyId, p.nonce) != c.wasExecuted) _flag("0-return marked executed");
                breakerTrips++;
                return;
            }
            successfulSwaps++;
            if (expectedOperator != operator) _flag("revoked operator executed");
            if (!c.wasExecutable || c.wasExecuted) _flag("executed non-live or twice"); // inv 6
            if (tout.balanceOf(address(vault)) - outBefore != out) _flag("output not in vault"); // inv 5
            if (out < (c.expectedOut * (10_000 - c.slip)) / 10_000) _flag("below oracle minimum"); // inv 7
            if (vault.usedInWindowUsd() > vault.dailyLimitUsd()) _flag("daily limit exceeded"); // inv 8
            if (address(tout) != address(tokens[0])) {
                try vault.exposureUsd() returns (uint256 e) {
                    if (e > vault.allocationUsd()) _flag("allocation exceeded"); // inv 9
                } catch {}
            }
            _checkBreachPaused(); // inv 11
        } catch {}
        router.setMode(MockRouter.Mode.Honest);
    }

    // ------------------------------------------------------------------ anyone / attacker

    function checkBreaker() external {
        calls++;
        vm.prank(attacker);
        try vault.checkBreaker() returns (bool t) {
            if (t) breakerTrips++;
            _checkBreachPaused();
        } catch {}
    }

    function settleFees() external {
        calls++;
        uint256 last = vault.lastFeeSettle();
        uint256 feesBefore = tokens[0].balanceOf(creator) + tokens[0].balanceOf(treasury);
        uint256 bound_ = _feeBound();
        vm.prank(attacker);
        try vault.settleFees() {
            feeSettlements++;
            if (block.timestamp < last + 7 days) _flag("fees settled twice within 7 days");
            uint256 paid = tokens[0].balanceOf(creator) + tokens[0].balanceOf(treasury) - feesBefore;
            if (paid * _baseScale() > bound_ + 1e12) _flag("fee above bound");
        } catch {}
    }

    /// Invariant 5: nobody but the owner can call owner functions (operator included).
    function attackOwnerFunctions(uint256 which, bool asOperator) external {
        calls++;
        address who = asOperator ? operator : attacker;
        vm.startPrank(who);
        bool ok;
        uint256 w = which % 9;
        if (w == 0) (ok,) = address(vault).call(abi.encodeCall(vault.withdraw, (address(tokens[0]), 1, who)));
        else if (w == 1) (ok,) = address(vault).call(abi.encodeCall(vault.setOperator, (who)));
        else if (w == 2) (ok,) = address(vault).call(abi.encodeCall(vault.setLimits, (500, 1, 5000)));
        else if (w == 3) (ok,) = address(vault).call(abi.encodeCall(vault.follow, (strategyId, type(uint256).max)));
        else if (w == 4) (ok,) = address(vault).call(abi.encodeCall(vault.setAllocation, (type(uint256).max)));
        else if (w == 5) (ok,) = address(vault).call(abi.encodeCall(vault.setPaused, (false)));
        else if (w == 6) (ok,) = address(vault).call(abi.encodeCall(vault.settleFeesForWithdraw, ()));
        else if (w == 7) (ok,) = address(vault).call(abi.encodeCall(vault.resetPeak, ()));
        else (ok,) = address(vault).call(abi.encodeCall(vault.setTokenEnabled, (address(tokens[1]), true)));
        vm.stopPrank();
        if (ok) _flag("non-owner called owner function");
    }

    /// Invariant 14: admin actions never change an existing vault.
    function adminRotate(uint256 seed) external {
        calls++;
        vm.startPrank(admin);
        factory.setDefaultOperator(address(uint160(seed | 1)));
        factory.setTreasury(address(uint160((seed >> 1) | 1)));
        vm.stopPrank();
        if (vault.operator() != expectedOperator) _flag("admin changed vault operator");
        if (vault.treasury() != expectedTreasury) _flag("admin changed vault treasury");
    }

    // ------------------------------------------------------------------ time / oracle

    function warp(uint256 secs) external {
        calls++;
        vm.warp(block.timestamp + bound(secs, 1, 3 days));
        vm.roll(block.number + 1 + (secs % 5));
    }

    function movePrice(uint256 seed, uint256 bps, bool up) external {
        calls++;
        MockFeed f = feeds[1 + (seed % (feeds.length - 1))];
        (, int256 a,,,) = f.latestRoundData();
        int256 delta = (a * int256(bound(bps, 0, 3000))) / 10_000;
        int256 next = up ? a + delta : a - delta;
        if (next <= 0) next = 1e6;
        f.setAnswer(next);
    }

    function refreshFeeds() external {
        calls++;
        for (uint256 i; i < feeds.length; ++i) {
            (, int256 a,,,) = feeds[i].latestRoundData();
            feeds[i].setAnswer(a);
        }
    }

    function breakFeed(uint256 seed, uint256 mode) external {
        calls++;
        MockFeed f = feeds[seed % feeds.length];
        uint256 m = mode % 4;
        if (m == 0) f.setUpdatedAt(block.timestamp > 30 days ? block.timestamp - 30 days : 0);
        else if (m == 1) f.setReverts(true);
        else if (m == 2) f.setReverts(false);
        else f.setUpdatedAt(block.timestamp);
    }

    // ------------------------------------------------------------------ helpers

    function _oracleOut(MockERC20 tin, MockERC20 tout, uint256 amountIn) internal view returns (uint256) {
        (bool okIn, uint256 pin) = _p(tin);
        (bool okOut, uint256 pout) = _p(tout);
        if (!okIn || !okOut) return 0;
        // same integer math as the vault: floor(floor(amountIn × pIn / 10^dIn) × 10^dOut / pOut)
        uint256 value = (amountIn * pin) / (10 ** tin.decimals());
        return (value * (10 ** tout.decimals())) / pout;
    }

    function _p(MockERC20 t) internal view returns (bool, uint256) {
        for (uint256 i; i < tokens.length; ++i) {
            if (address(tokens[i]) == address(t)) {
                try feeds[i].latestRoundData() returns (uint80, int256 a, uint256, uint256, uint80) {
                    return (a > 0, uint256(a) * 1e10);
                } catch {
                    return (false, 0);
                }
            }
        }
        return (false, 0);
    }

    /// @dev Upper bound for any fee settlement right now: (navStrict − hwm) × snapshot / 10000 (0 if unavailable).
    function _feeBound() internal view returns (uint256) {
        try vault.navStrict() returns (uint256 nav) {
            uint256 hwm = vault.hwmNav();
            return nav > hwm ? ((nav - hwm) * vault.creatorShareSnapshot()) / 10_000 : 0;
        } catch {
            return 0;
        }
    }

    function _baseScale() internal view returns (uint256) {
        (, uint256 p) = _p(tokens[0]);
        return p == 0 ? 1e12 : (p * 1e12) / 1e18;
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    function _refresh(address, address) internal {
        for (uint256 i; i < tokens.length; ++i) {
            if (feeds[i].reverts()) continue;
            (, int256 ans,,,) = feeds[i].latestRoundData();
            feeds[i].setAnswer(ans);
        }
    }

    function _checkBreachPaused() internal {
        try vault.navLenient() returns (uint256 nav) {
            uint256 peak = vault.peakNav();
            if (nav * 10_000 < peak * (10_000 - vault.drawdownBps()) && !vault.paused()) _flag("breach not paused");
        } catch {}
    }

    function pendingCount() external view returns (uint256) {
        return pending.length;
    }
}
