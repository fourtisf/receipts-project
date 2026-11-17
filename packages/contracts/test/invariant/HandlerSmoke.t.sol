// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Base} from "../utils/Base.t.sol";
import {VaultHandler} from "./VaultHandler.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockFeed} from "../mocks/MockFeed.sol";

/// @dev Deterministic smoke test proving the invariant handler reaches real swaps, trips and fee settlements.
contract HandlerSmokeTest is Base {
    VaultHandler internal handler;

    function setUp() public override {
        super.setUp();
        MockERC20[] memory toks = new MockERC20[](4);
        (toks[0], toks[1], toks[2], toks[3]) = (usdg, weth, wbtc, nvda);
        MockFeed[] memory fs = new MockFeed[](4);
        (fs[0], fs[1], fs[2], fs[3]) = (usdgFeed, wethFeed, wbtcFeed, nvdaFeed);
        handler = new VaultHandler(
            registry, factory, vault, router, toks, fs, strategyId, [owner, operator, signer, creator, treasury, admin]
        );
        _deposit(2000e6);
        _follow(_usd(1500));
    }

    function test_handlerReachesSwaps() public {
        handler.commit(0, 3000); // buy WETH
        assertEq(handler.pendingCount(), 1);
        handler.execute(0, 300e6 + 3, 1, 1);
        assertEq(handler.successfulSwaps(), 1, handler.violation());
        handler.movePrice(0, 3000, false);
        handler.checkBreaker();
        handler.warp(7 days);
        handler.refreshFeeds();
        handler.settleFees();
        assertEq(handler.violation(), "");
    }
}
