// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {SignalRegistry} from "../src/SignalRegistry.sol";
import {ReceiptsVault} from "../src/ReceiptsVault.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {ISignalRegistry} from "../src/interfaces/ISignalRegistry.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockFeed} from "./mocks/MockFeed.sol";
import {MockRouter} from "./mocks/MockRouter.sol";

/// @dev Worst-case gas for executeSignal: 13 listed tokens, all enabled and all held (every NAV loop prices all 13).
contract GasTest is Test {
    uint256 internal constant N = 13;
    SignalRegistry internal registry;
    VaultFactory internal factory;
    ReceiptsVault internal vault;
    MockRouter internal router;
    MockERC20[] internal toks;
    address internal owner = makeAddr("owner");
    address internal operator = makeAddr("operator");
    address internal signer = makeAddr("signer");
    uint256 internal sid;

    function setUp() public {
        vm.warp(1_800_000_000);
        vm.roll(1000);
        registry = new SignalRegistry();
        router = new MockRouter();
        address[] memory t = new address[](N);
        address[] memory f = new address[](N);
        uint32[] memory s = new uint32[](N);
        uint24[] memory tiers = new uint24[](N);
        for (uint256 i; i < N; ++i) {
            MockERC20 tok = new MockERC20("T", "T", i == 0 ? 6 : 18);
            MockFeed feed = new MockFeed(8, i == 0 ? int256(1e8) : int256(100e8));
            toks.push(tok);
            router.setFeed(address(tok), feed);
            (t[i], f[i], s[i], tiers[i]) = (address(tok), address(feed), 90_000, i == 0 ? 0 : 500);
        }
        factory = new VaultFactory(
            address(router), address(registry), t[0], makeAddr("treasury"), 1000, 2000e18, operator, t, f, s, tiers
        );
        vm.prank(owner);
        vault = ReceiptsVault(factory.createVault(100, 2000e18, 2000));
        sid = registry.registerStrategy(signer, 2000, 1 hours, 0, "gas");
        // hold every token
        toks[0].mint(owner, 10_000e6);
        vm.startPrank(owner);
        toks[0].approve(address(vault), 10_000e6);
        vault.deposit(10_000e6);
        vault.follow(sid, 1_000_000e18);
        vm.stopPrank();
        for (uint256 i = 1; i < N; ++i) {
            toks[i].mint(address(vault), 1e18);
        }
    }

    /// @dev Gas bounds only hold for the optimized build; coverage builds are unoptimized and instrumented.
    function _bound(uint256 g, uint256 maxGas, string memory what) internal view {
        if (keccak256(bytes(vm.envOr("FOUNDRY_PROFILE", string("default")))) == keccak256("coverage")) return;
        assertLt(g, maxGas, what);
    }

    function _commit(address tin, address tout) internal returns (uint64 n) {
        ISignalRegistry.Signal memory sig = ISignalRegistry.Signal(tin, tout, 1000, bytes32(0));
        bytes32 h = registry.hashSignal(sid, registry.strategyOf(sid).commitCount, sig, bytes32(0));
        vm.prank(signer);
        n = registry.commit(sid, h);
        vm.roll(vm.getBlockNumber() + 1);
    }

    function test_gas_executeSignal_13tokens_buy() public {
        uint64 n = _commit(address(toks[0]), address(toks[5]));
        vm.prank(operator);
        uint256 g = gasleft();
        vault.executeSignal(n, address(toks[0]), address(toks[5]), 100e6, 0);
        g -= gasleft();
        console2.log("executeSignal buy, 13 tokens held:", g);
        _bound(g, 1_500_000, "must stay well under block gas");
    }

    function test_gas_executeSignal_13tokens_sell() public {
        uint64 n = _commit(address(toks[7]), address(toks[0]));
        vm.prank(operator);
        uint256 g = gasleft();
        vault.executeSignal(n, address(toks[7]), address(toks[0]), 5e17, 0);
        g -= gasleft();
        console2.log("executeSignal sell, 13 tokens held:", g);
        _bound(g, 1_500_000, "sell");
    }

    function test_gas_createVault_13tokens() public {
        uint256 g = gasleft();
        vm.prank(makeAddr("someone"));
        factory.createVault(100, 2000e18, 2000);
        g -= gasleft();
        console2.log("createVault, 13 tokens:", g);
        _bound(g, 5_000_000, "createVault");
    }

    function test_gas_withdraw_13tokens() public {
        vm.prank(owner);
        uint256 g = gasleft();
        vault.withdraw(address(toks[0]), 100e6, owner);
        g -= gasleft();
        console2.log("withdraw (fee settle attempt + marks), 13 tokens:", g);
    }
}
