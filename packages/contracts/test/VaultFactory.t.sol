// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Base} from "./utils/Base.t.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {ReceiptsVault} from "../src/ReceiptsVault.sol";
import {IVaultFactory} from "../src/interfaces/IVaultFactory.sol";
import {MockFeed} from "./mocks/MockFeed.sol";

contract VaultFactoryTest is Base {
    function test_wiring() public view {
        assertEq(factory.router(), address(router));
        assertEq(factory.registry(), address(registry));
        assertEq(factory.base(), address(usdg));
        assertEq(factory.protocolCutBps(), PROTOCOL_CUT);
        assertEq(factory.MAX_DAILY_LIMIT_USD(), MAX_DAILY);
        assertEq(factory.admin(), admin);
        assertEq(factory.pendingAdmin(), address(0));
        assertEq(factory.defaultOperator(), operator);
        assertEq(factory.treasury(), treasury);
        (address op, address[] memory t, address[] memory f, uint32[] memory s, uint24[] memory tiers) =
            factory.getDefaults();
        assertEq(op, operator);
        assertEq(t.length, 4);
        assertEq(f[1], address(wethFeed));
        assertEq(s[0], USDG_STALENESS);
        assertEq(tiers[3], 3000);
    }

    function test_createVault_onePerWallet() public {
        assertEq(factory.vaultOf(owner), address(vault));
        assertEq(factory.vaultCount(), 1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IVaultFactory.VaultExists.selector, address(vault)));
        factory.createVault(100, 1, 2000);
        ReceiptsVault v2 = _createVault(attacker);
        assertEq(v2.owner(), attacker);
        assertEq(factory.vaultCount(), 2);
    }

    function test_vaults_paging() public {
        for (uint256 i; i < 5; ++i) {
            _createVault(address(uint160(0x1000 + i)));
        }
        assertEq(factory.vaultCount(), 6);
        address[] memory p = factory.vaults(0, 2);
        assertEq(p.length, 2);
        assertEq(p[0], address(vault));
        p = factory.vaults(4, 10);
        assertEq(p.length, 2);
        p = factory.vaults(6, 1);
        assertEq(p.length, 0);
        p = factory.vaults(1, type(uint256).max);
        assertEq(p.length, 5);
    }

    /// Invariant 14: admin actions never change an existing vault.
    function test_adminActions_newVaultsOnly() public {
        address newOp = makeAddr("newOp");
        address newTreasury = makeAddr("newTreasury");
        vm.startPrank(admin);
        factory.setDefaultOperator(newOp);
        factory.setTreasury(newTreasury);
        vm.stopPrank();
        assertEq(vault.operator(), operator);
        assertEq(vault.treasury(), treasury);
        ReceiptsVault v2 = _createVault(attacker);
        assertEq(v2.operator(), newOp);
        assertEq(v2.treasury(), newTreasury);
        vm.prank(admin);
        factory.setDefaultOperator(address(0)); // allowed: new vaults start without a bot
        ReceiptsVault v3 = _createVault(creator);
        assertEq(v3.operator(), address(0));
    }

    function test_admin_onlyAdmin() public {
        vm.startPrank(attacker);
        vm.expectRevert(IVaultFactory.NotAdmin.selector);
        factory.setDefaultOperator(attacker);
        vm.expectRevert(IVaultFactory.NotAdmin.selector);
        factory.setTreasury(attacker);
        vm.expectRevert(IVaultFactory.NotAdmin.selector);
        factory.transferAdmin(attacker);
        vm.expectRevert(IVaultFactory.NotAdmin.selector);
        factory.acceptAdmin();
        vm.stopPrank();
        vm.prank(admin);
        vm.expectRevert(IVaultFactory.ZeroAddress.selector);
        factory.setTreasury(address(0));
    }

    function test_admin_twoStepTransfer() public {
        vm.prank(admin);
        factory.transferAdmin(creator);
        assertEq(factory.pendingAdmin(), creator);
        assertEq(factory.admin(), admin);
        vm.prank(attacker);
        vm.expectRevert(IVaultFactory.NotAdmin.selector);
        factory.acceptAdmin();
        vm.prank(creator);
        factory.acceptAdmin();
        assertEq(factory.admin(), creator);
        assertEq(factory.pendingAdmin(), address(0));
    }

    // ------------------------------------------------------------------ constructor validation

    function _arrays(uint256 n)
        internal
        view
        returns (address[] memory t, address[] memory f, uint32[] memory s, uint24[] memory tiers)
    {
        t = new address[](n);
        f = new address[](n);
        s = new uint32[](n);
        tiers = new uint24[](n);
        t[0] = address(usdg);
        f[0] = address(usdgFeed);
        s[0] = 1;
        if (n > 1) {
            t[1] = address(weth);
            f[1] = address(wethFeed);
            s[1] = 1;
            tiers[1] = 500;
        }
    }

    function _deploy(address[] memory t, address[] memory f, uint32[] memory s, uint24[] memory tiers, uint16 cut)
        internal
        returns (VaultFactory)
    {
        return new VaultFactory(
            address(router), address(registry), address(usdg), treasury, cut, MAX_DAILY, operator, t, f, s, tiers
        );
    }

    function test_constructor_validation() public {
        (address[] memory t, address[] memory f, uint32[] memory s, uint24[] memory tiers) = _arrays(2);
        _deploy(t, f, s, tiers, 3000); // ok

        vm.expectRevert(abi.encodeWithSelector(VaultFactory.BadConfig.selector, "protocol cut"));
        _deploy(t, f, s, tiers, 3001);

        vm.expectRevert(IVaultFactory.ZeroAddress.selector);
        new VaultFactory(address(0), address(registry), address(usdg), treasury, 0, MAX_DAILY, operator, t, f, s, tiers);
        vm.expectRevert(IVaultFactory.ZeroAddress.selector);
        new VaultFactory(
            address(router), address(registry), address(usdg), address(0), 0, MAX_DAILY, operator, t, f, s, tiers
        );
        vm.expectRevert(abi.encodeWithSelector(VaultFactory.BadConfig.selector, "daily cap"));
        new VaultFactory(address(router), address(registry), address(usdg), treasury, 0, 0, operator, t, f, s, tiers);

        tiers[1] = 123;
        vm.expectRevert(abi.encodeWithSelector(VaultFactory.BadConfig.selector, "fee tier"));
        _deploy(t, f, s, tiers, 0);
        tiers[1] = 0;
        vm.expectRevert(abi.encodeWithSelector(VaultFactory.BadConfig.selector, "fee tier"));
        _deploy(t, f, s, tiers, 0);
        tiers[1] = 500;
        tiers[0] = 500;
        vm.expectRevert(abi.encodeWithSelector(VaultFactory.BadConfig.selector, "base tier"));
        _deploy(t, f, s, tiers, 0);
        tiers[0] = 0;

        t[1] = address(usdg);
        vm.expectRevert(abi.encodeWithSelector(VaultFactory.BadConfig.selector, "duplicate token"));
        _deploy(t, f, s, tiers, 0);
        t[1] = address(weth);

        s[1] = 0;
        vm.expectRevert(abi.encodeWithSelector(VaultFactory.BadConfig.selector, "staleness"));
        _deploy(t, f, s, tiers, 0);
        s[1] = 1;

        f[1] = address(0);
        vm.expectRevert(IVaultFactory.ZeroAddress.selector);
        _deploy(t, f, s, tiers, 0);
        MockFeed dead = new MockFeed(8, 0);
        f[1] = address(dead);
        vm.expectRevert(abi.encodeWithSelector(VaultFactory.BadConfig.selector, "feed"));
        _deploy(t, f, s, tiers, 0);
        MockFeed wide = new MockFeed(37, 1);
        f[1] = address(wide);
        vm.expectRevert(abi.encodeWithSelector(VaultFactory.BadConfig.selector, "feed"));
        _deploy(t, f, s, tiers, 0);
        f[1] = address(wethFeed);

        // base missing
        t[0] = address(wbtc);
        f[0] = address(wbtcFeed);
        tiers[0] = 500;
        vm.expectRevert(abi.encodeWithSelector(VaultFactory.BadConfig.selector, "base not listed"));
        _deploy(t, f, s, tiers, 0);
    }

    function test_constructor_lengthsAndCount() public {
        (address[] memory t, address[] memory f, uint32[] memory s,) = _arrays(2);
        uint24[] memory tiers1 = new uint24[](1);
        vm.expectRevert(abi.encodeWithSelector(VaultFactory.BadConfig.selector, "length mismatch"));
        _deploy(t, f, s, tiers1, 0);
        (address[] memory t0, address[] memory f0, uint32[] memory s0, uint24[] memory tr0) =
            (new address[](0), new address[](0), new uint32[](0), new uint24[](0));
        vm.expectRevert(abi.encodeWithSelector(VaultFactory.BadConfig.selector, "token count"));
        _deploy(t0, f0, s0, tr0, 0);
        (address[] memory t21, address[] memory f21, uint32[] memory s21, uint24[] memory tr21) =
            (new address[](21), new address[](21), new uint32[](21), new uint24[](21));
        vm.expectRevert(abi.encodeWithSelector(VaultFactory.BadConfig.selector, "token count"));
        _deploy(t21, f21, s21, tr21, 0);
    }
}
