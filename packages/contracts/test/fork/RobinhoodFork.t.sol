// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SignalRegistry} from "../../src/SignalRegistry.sol";
import {ReceiptsVault} from "../../src/ReceiptsVault.sol";
import {VaultFactory} from "../../src/VaultFactory.sol";
import {ISignalRegistry} from "../../src/interfaces/ISignalRegistry.sol";
import {IReceiptsVault} from "../../src/interfaces/IReceiptsVault.sol";
import {AggregatorV3Interface} from "../../src/interfaces/IExternal.sol";

interface IPeriphery {
    function factory() external view returns (address);
    function WETH9() external view returns (address);
}

interface IUniFactory {
    function getPool(address a, address b, uint24 fee) external view returns (address);
}

interface IUniPool {
    function liquidity() external view returns (uint128);
}

/// @dev Runs against a fork of Robinhood Chain (chain 4663) with the real Uniswap V3 pools and Chainlink feeds:
///        forge test --match-path 'test/fork/*' --fork-url $RPC_URL
///      Skipped automatically when not forked.
contract RobinhoodForkTest is Test {
    struct Tok {
        string symbol;
        address token;
        address feed;
        string description;
        uint32 staleness;
        uint24 tier;
        bool stock;
    }

    Tok[] internal toks;
    address internal router;
    address internal usdg;
    SignalRegistry internal registry;
    VaultFactory internal factory;
    ReceiptsVault internal vault;
    uint256 internal sid;

    address internal owner = makeAddr("fork-owner");
    address internal operator = makeAddr("fork-operator");
    address internal signer = makeAddr("fork-signer");
    address internal treasury = makeAddr("fork-treasury");

    bool internal forked;

    function setUp() public {
        forked = block.chainid == 4663;
        if (!forked) return;
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/../../config/robinhood.json"));
        router = vm.parseJsonAddress(json, ".router");
        uint256 n;
        while (vm.keyExistsJson(json, string.concat(".tokens[", vm.toString(n), "]"))) n++;
        address[] memory t = new address[](n);
        address[] memory f = new address[](n);
        uint32[] memory s = new uint32[](n);
        uint24[] memory tiers = new uint24[](n);
        for (uint256 i; i < n; ++i) {
            string memory k = string.concat(".tokens[", vm.toString(i), "]");
            Tok memory tk;
            tk.symbol = vm.parseJsonString(json, string.concat(k, ".symbol"));
            tk.token = vm.parseJsonAddress(json, string.concat(k, ".address"));
            tk.feed = vm.parseJsonAddress(json, string.concat(k, ".feed"));
            tk.description = vm.parseJsonString(json, string.concat(k, ".feedDescription"));
            tk.staleness = uint32(vm.parseJsonUint(json, string.concat(k, ".maxStaleness")));
            if (vm.keyExistsJson(json, string.concat(k, ".feeTier"))) {
                tk.tier = uint24(vm.parseJsonUint(json, string.concat(k, ".feeTier")));
            }
            tk.stock = vm.keyExistsJson(json, string.concat(k, ".kind"));
            toks.push(tk);
            (t[i], f[i], s[i], tiers[i]) = (tk.token, tk.feed, tk.staleness, tk.tier);
            if (tk.tier == 0) usdg = tk.token;
        }
        registry = new SignalRegistry();
        factory = new VaultFactory(router, address(registry), usdg, treasury, 1000, 2000e18, operator, t, f, s, tiers);
        vm.prank(owner);
        vault = ReceiptsVault(factory.createVault(200, 2000e18, 2000));
        vm.prank(owner);
        sid = registry.registerStrategy(signer, 2000, 1 hours, 0, "fork");
        _fundOwner(1500e6);
        vm.startPrank(owner);
        IERC20(usdg).approve(address(vault), 1500e6);
        vault.deposit(1500e6);
        vault.follow(sid, 1500e18);
        vm.stopPrank();
    }

    modifier onlyFork() {
        if (!forked) {
            vm.skip(true);
        }
        _;
    }

    function _tok(string memory symbol) internal view returns (Tok memory) {
        for (uint256 i; i < toks.length; ++i) {
            if (keccak256(bytes(toks[i].symbol)) == keccak256(bytes(symbol))) return toks[i];
        }
        revert("unknown symbol");
    }

    /// @dev USDG comes from the deepest USDG pool (impersonated): no storage hacks on the Paxos proxy.
    function _fundOwner(uint256 amount) internal {
        Tok memory w = _tok("WETH");
        address pool = IUniFactory(IPeriphery(router).factory()).getPool(w.token, usdg, w.tier);
        vm.prank(pool);
        IERC20(usdg).transfer(owner, amount);
    }

    function _fresh(Tok memory tk) internal view returns (bool) {
        (, int256 a,, uint256 upd,) = AggregatorV3Interface(tk.feed).latestRoundData();
        return a > 0 && upd <= block.timestamp && block.timestamp - upd <= tk.staleness;
    }

    function _commitAndRoll(address tin, address tout, bytes32 salt)
        internal
        returns (uint64 nonce, ISignalRegistry.Signal memory sig)
    {
        sig = ISignalRegistry.Signal(tin, tout, 5000, bytes32(0));
        bytes32 h = registry.hashSignal(sid, registry.strategyOf(sid).commitCount, sig, salt);
        vm.prank(signer);
        nonce = registry.commit(sid, h);
        vm.roll(vm.getBlockNumber() + 1);
    }

    // ------------------------------------------------------------------ config sanity (scripts/check-config.ts does
    // the same before mainnet)

    function test_fork_configMatchesChain() public onlyFork {
        assertEq(IPeriphery(router).WETH9(), _tok("WETH").token, "router WETH9");
        address uniFactory = IPeriphery(router).factory();
        for (uint256 i; i < toks.length; ++i) {
            Tok memory tk = toks[i];
            AggregatorV3Interface feed = AggregatorV3Interface(tk.feed);
            (, int256 a,,,) = feed.latestRoundData();
            assertGt(a, 0, tk.symbol);
            assertEq(feed.decimals(), 8, tk.symbol);
            assertEq(feed.description(), tk.description, tk.symbol);
            if (tk.tier != 0) {
                address pool = IUniFactory(uniFactory).getPool(tk.token, usdg, tk.tier);
                assertTrue(pool != address(0), string.concat(tk.symbol, " pool missing"));
                assertGt(IUniPool(pool).liquidity(), 0, string.concat(tk.symbol, " pool empty"));
                assertGt(IERC20(usdg).balanceOf(pool), 0, string.concat(tk.symbol, " pool has no USDG"));
            }
            console2.log(tk.symbol, uint256(a), tk.stock ? "stock" : "crypto");
        }
    }

    // ------------------------------------------------------------------ full commit → execute → reveal

    function _cycle(string memory symbol, uint256 usdIn) internal {
        Tok memory tk = _tok(symbol);
        if (!_fresh(tk)) {
            // stock feeds pause on weekends: a swap must revert while stale (by design)
            (uint64 n,) = _commitAndRoll(usdg, tk.token, keccak256("stale"));
            vm.prank(operator);
            vm.expectRevert(abi.encodeWithSelector(IReceiptsVault.StaleOraclePrice.selector, tk.token));
            vault.executeSignal(n, usdg, tk.token, usdIn, 0);
            console2.log(symbol, "feed stale at fork block: swap correctly reverted");
            return;
        }
        (uint64 nonce, ISignalRegistry.Signal memory sig) = _commitAndRoll(usdg, tk.token, keccak256(bytes(symbol)));
        assertTrue(registry.isExecutable(sid, nonce));
        uint256 price = vault.priceUsd(tk.token);
        vm.prank(operator);
        uint256 out = vault.executeSignal(nonce, usdg, tk.token, usdIn, 0);
        assertEq(IERC20(tk.token).balanceOf(address(vault)), out);
        assertEq(IERC20(usdg).allowance(address(vault), router), 0);
        // fill vs oracle
        uint256 fillValue = (out * price) / 1e18; // tokens here have 18 decimals except cbBTC (8)
        if (keccak256(bytes(symbol)) == keccak256("cbBTC")) fillValue = (out * price) / 1e8;
        uint256 usdValue = (usdIn * vault.priceUsd(usdg)) / 1e6;
        console2.log(symbol, "fill vs oracle (bps of value kept):", (fillValue * 10_000) / usdValue);
        assertGe(fillValue * 10_000, usdValue * (10_000 - 200));

        registry.reveal(sid, nonce, sig, keccak256(bytes(symbol)));
        assertEq(uint8(registry.commitOf(sid, nonce).status), uint8(ISignalRegistry.Status.Revealed));
        assertFalse(registry.isExecutable(sid, nonce));

        // sell it back
        (uint64 n2,) = _commitAndRoll(tk.token, usdg, keccak256(abi.encode(symbol, "sell")));
        vm.prank(operator);
        uint256 back = vault.executeSignal(n2, tk.token, usdg, out, 0);
        assertGt(back, 0);
        assertEq(IERC20(tk.token).balanceOf(address(vault)), 0);
        assertEq(IERC20(tk.token).allowance(address(vault), router), 0);
    }

    function test_fork_cycle_WETH() public onlyFork {
        _cycle("WETH", 100e6);
    }

    function test_fork_cycle_cbBTC() public onlyFork {
        _cycle("cbBTC", 100e6);
    }

    function test_fork_cycle_NVDA() public onlyFork {
        _cycle("NVDA", 50e6);
    }

    function test_fork_cycle_SPY() public onlyFork {
        _cycle("SPY", 50e6);
    }

    // ------------------------------------------------------------------ weekend: stale stock feed

    function test_fork_weekendStaleStockFeed() public onlyFork {
        Tok memory nvda = _tok("NVDA");
        (uint64 n,) = _commitAndRoll(usdg, nvda.token, keccak256("weekend"));
        (,,, uint256 upd,) = AggregatorV3Interface(nvda.feed).latestRoundData();
        vm.warp(upd + nvda.staleness + 1); // simulate the weekend pause (registry deadline is 1h: recommit)
        // USDG's feed keeps updating 24/7 on weekends: keep it fresh, only the stock feed is paused.
        Tok memory u = _tok("USDG");
        (uint80 rid, int256 ua,,,) = AggregatorV3Interface(u.feed).latestRoundData();
        vm.mockCall(
            u.feed,
            abi.encodeWithSelector(AggregatorV3Interface.latestRoundData.selector),
            abi.encode(rid, ua, block.timestamp, block.timestamp, rid)
        );
        (n,) = _commitAndRoll(usdg, nvda.token, keccak256("weekend-2"));
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IReceiptsVault.StaleOraclePrice.selector, nvda.token));
        vault.executeSignal(n, usdg, nvda.token, 10e6, 0);
        // withdraw still works
        vm.prank(owner);
        vault.withdraw(usdg, 100e6, owner);
        assertEq(IERC20(usdg).balanceOf(owner), 100e6);
    }

    function test_fork_l2BlockAdvances() public onlyFork {
        (uint64 n,) = _commitAndRoll(usdg, _tok("WETH").token, keccak256("l2"));
        ISignalRegistry.Commit memory c = registry.commitOf(sid, n);
        assertGt(c.committedL2Block, 0);
        assertTrue(registry.isExecutable(sid, n));
    }
}
