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

/// @dev Shared fixture: registry, factory with 4 tokens (USDG base, WETH, WBTC, NVDA stock), one vault, one strategy.
abstract contract Base is Test {
    uint256 internal constant MAX_DAILY = 2000e18;
    uint16 internal constant PROTOCOL_CUT = 1000; // 10% of the creator fee
    uint16 internal constant CREATOR_SHARE = 2000; // 20% of profit
    uint32 internal constant REVEAL_WINDOW = 1 hours;
    uint32 internal constant STALENESS = 90_000;
    uint32 internal constant USDG_STALENESS = 97_200;

    address internal owner = makeAddr("owner");
    address internal operator = makeAddr("operator");
    address internal creator = makeAddr("creator");
    address internal signer = makeAddr("signer");
    address internal treasury = makeAddr("treasury");
    address internal attacker = makeAddr("attacker");
    address internal admin = makeAddr("admin");

    SignalRegistry internal registry;
    VaultFactory internal factory;
    ReceiptsVault internal vault;
    MockRouter internal router;

    MockERC20 internal usdg;
    MockERC20 internal weth;
    MockERC20 internal wbtc;
    MockERC20 internal nvda;
    MockFeed internal usdgFeed;
    MockFeed internal wethFeed;
    MockFeed internal wbtcFeed;
    MockFeed internal nvdaFeed;

    uint256 internal strategyId;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        vm.roll(1_000);

        usdg = new MockERC20("Global Dollar", "USDG", 6);
        weth = new MockERC20("Wrapped Ether", "WETH", 18);
        wbtc = new MockERC20("Wrapped BTC", "WBTC", 8);
        nvda = new MockERC20("NVIDIA", "NVDA", 18);
        usdgFeed = new MockFeed(8, 1e8);
        wethFeed = new MockFeed(8, 2000e8);
        wbtcFeed = new MockFeed(8, 60_000e8);
        nvdaFeed = new MockFeed(8, 150e8);

        router = new MockRouter();
        router.setFeed(address(usdg), usdgFeed);
        router.setFeed(address(weth), wethFeed);
        router.setFeed(address(wbtc), wbtcFeed);
        router.setFeed(address(nvda), nvdaFeed);

        registry = new SignalRegistry();
        factory = _deployFactory(operator);
        vault = _createVault(owner);

        vm.prank(creator);
        strategyId = registry.registerStrategy(signer, CREATOR_SHARE, REVEAL_WINDOW, bytes32(0), "ipfs://strategy-1");
    }

    function _deployFactory(address op) internal returns (VaultFactory f) {
        address[] memory tokens = new address[](4);
        address[] memory feeds = new address[](4);
        uint32[] memory stale = new uint32[](4);
        uint24[] memory tiers = new uint24[](4);
        (tokens[0], feeds[0], stale[0], tiers[0]) = (address(usdg), address(usdgFeed), USDG_STALENESS, 0);
        (tokens[1], feeds[1], stale[1], tiers[1]) = (address(weth), address(wethFeed), STALENESS, 100);
        (tokens[2], feeds[2], stale[2], tiers[2]) = (address(wbtc), address(wbtcFeed), STALENESS, 500);
        (tokens[3], feeds[3], stale[3], tiers[3]) = (address(nvda), address(nvdaFeed), STALENESS, 3000);
        vm.prank(admin);
        f = new VaultFactory(
            address(router),
            address(registry),
            address(usdg),
            treasury,
            PROTOCOL_CUT,
            MAX_DAILY,
            op,
            tokens,
            feeds,
            stale,
            tiers
        );
    }

    function _createVault(address who) internal returns (ReceiptsVault v) {
        vm.prank(who);
        v = ReceiptsVault(factory.createVault(100, MAX_DAILY, 2000));
    }

    // ------------------------------------------------------------------ helpers

    function _signal(address tokenIn, address tokenOut, uint16 sizeBps)
        internal
        pure
        returns (ISignalRegistry.Signal memory s)
    {
        s = ISignalRegistry.Signal({tokenIn: tokenIn, tokenOut: tokenOut, sizeBps: sizeBps, promptHash: bytes32(0)});
    }

    /// @dev Commits a signal for `strategyId` and moves to the next block so it becomes executable.
    function _commit(ISignalRegistry.Signal memory s, bytes32 salt) internal returns (uint64 nonce) {
        uint64 next = registry.strategyOf(strategyId).commitCount;
        bytes32 h = registry.hashSignal(strategyId, next, s, salt);
        vm.prank(signer);
        nonce = registry.commit(strategyId, h);
        vm.roll(vm.getBlockNumber() + 1);
    }

    function _commitBuy(address token) internal returns (uint64) {
        return _commit(_signal(address(usdg), token, 5000), keccak256(abi.encode("salt", block.number)));
    }

    function _commitSell(address token) internal returns (uint64) {
        return _commit(_signal(token, address(usdg), 10_000), keccak256(abi.encode("salt-sell", block.number)));
    }

    function _deposit(uint256 amount) internal {
        usdg.mint(owner, amount);
        vm.startPrank(owner);
        usdg.approve(address(vault), amount);
        vault.deposit(amount);
        vm.stopPrank();
    }

    function _follow(uint256 allocationUsd) internal {
        vm.prank(owner);
        vault.follow(strategyId, allocationUsd);
    }

    function _exec(uint64 nonce, address tokenIn, address tokenOut, uint256 amountIn) internal returns (uint256) {
        vm.prank(operator);
        return vault.executeSignal(nonce, tokenIn, tokenOut, amountIn, 0);
    }

    /// @dev Deposit `usd` USDG, follow with a large allocation, buy `buyUsd` of WETH.
    function _setupWithWeth(uint256 usd, uint256 buyUsd) internal returns (uint256 wethOut) {
        _deposit(usd * 1e6);
        _follow(1_000_000e18);
        uint64 n = _commitBuy(address(weth));
        wethOut = _exec(n, address(usdg), address(weth), buyUsd * 1e6);
    }

    function _usd(uint256 x) internal pure returns (uint256) {
        return x * 1e18;
    }
}
