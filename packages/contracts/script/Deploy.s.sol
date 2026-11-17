// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {SignalRegistry} from "../src/SignalRegistry.sol";
import {VaultFactory} from "../src/VaultFactory.sol";

/// @notice Deploys SignalRegistry + VaultFactory with the token list from config/robinhood.json.
///
///   Required env:
///     TREASURY_ADDRESS        receives the protocol cut of creator fees
///     EXECUTOR_ADDRESS        default operator installed into new vaults (the worker's EXECUTOR key address)
///   Optional env:
///     PROTOCOL_CUT_BPS        share of the creator fee kept by the protocol (default 1000 = 10%, max 3000)
///     MAX_DAILY_LIMIT_USD     beta cap per vault per day in whole USD (default 2000)
///     FACTORY_ADMIN           if set, starts a two-step admin transfer to this address (e.g. a multisig)
///
///   Dry run (fork):   forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545
///   Broadcast:        forge script script/Deploy.s.sol --rpc-url $RPC_URL --private-key $DEPLOYER_PRIVATE_KEY --broadcast
///
///   Writes deployments/<chainId>.json (addresses, start block, constructor args) for the app and verify.sh.
///   Set DEPLOYMENT_NAME=fork when deploying to a local anvil fork (writes deployments/fork.json instead).
contract Deploy is Script {
    struct Cfg {
        address router;
        address base;
        address[] tokens;
        address[] feeds;
        uint32[] staleness;
        uint24[] tiers;
    }

    function run() external returns (SignalRegistry registry, VaultFactory factory) {
        require(block.chainid == 4663 || block.chainid == 31337, "Deploy: unexpected chain");
        Cfg memory c = _loadConfig();
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        address executor = vm.envAddress("EXECUTOR_ADDRESS");
        uint16 cut = uint16(vm.envOr("PROTOCOL_CUT_BPS", uint256(1000)));
        uint256 maxDaily = vm.envOr("MAX_DAILY_LIMIT_USD", uint256(2000)) * 1e18;
        address newAdmin = vm.envOr("FACTORY_ADMIN", address(0));

        uint256 startBlock = block.number;
        vm.startBroadcast();
        registry = new SignalRegistry();
        factory = new VaultFactory(
            c.router,
            address(registry),
            c.base,
            treasury,
            cut,
            maxDaily,
            executor,
            c.tokens,
            c.feeds,
            c.staleness,
            c.tiers
        );
        if (newAdmin != address(0)) factory.transferAdmin(newAdmin);
        vm.stopBroadcast();

        console2.log("SignalRegistry", address(registry));
        console2.log("VaultFactory  ", address(factory));
        console2.log("start block   ", startBlock);
        _write(registry, factory, startBlock, c, treasury, executor, cut, maxDaily);
    }

    function _loadConfig() internal view returns (Cfg memory c) {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/../../config/robinhood.json"));
        c.router = vm.parseJsonAddress(json, ".router");
        uint256 n;
        while (vm.keyExistsJson(json, string.concat(".tokens[", vm.toString(n), "]"))) n++;
        c.tokens = new address[](n);
        c.feeds = new address[](n);
        c.staleness = new uint32[](n);
        c.tiers = new uint24[](n);
        for (uint256 i; i < n; ++i) {
            string memory k = string.concat(".tokens[", vm.toString(i), "]");
            c.tokens[i] = vm.parseJsonAddress(json, string.concat(k, ".address"));
            c.feeds[i] = vm.parseJsonAddress(json, string.concat(k, ".feed"));
            c.staleness[i] = uint32(vm.parseJsonUint(json, string.concat(k, ".maxStaleness")));
            if (vm.keyExistsJson(json, string.concat(k, ".feeTier"))) {
                c.tiers[i] = uint24(vm.parseJsonUint(json, string.concat(k, ".feeTier")));
            } else {
                c.base = c.tokens[i];
            }
        }
        require(c.base != address(0), "Deploy: base token (no feeTier) missing");
    }

    function _write(
        SignalRegistry registry,
        VaultFactory factory,
        uint256 startBlock,
        Cfg memory c,
        address treasury,
        address executor,
        uint16 cut,
        uint256 maxDaily
    ) internal {
        string memory o = "deployment";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeAddress(o, "registry", address(registry));
        vm.serializeAddress(o, "factory", address(factory));
        vm.serializeUint(o, "startBlock", startBlock);
        vm.serializeAddress(o, "router", c.router);
        vm.serializeAddress(o, "base", c.base);
        vm.serializeAddress(o, "treasury", treasury);
        vm.serializeAddress(o, "defaultOperator", executor);
        vm.serializeUint(o, "protocolCutBps", cut);
        vm.serializeUint(o, "maxDailyLimitUsd", maxDaily);
        vm.serializeAddress(o, "tokens", c.tokens);
        vm.serializeAddress(o, "feeds", c.feeds);
        uint256[] memory st = new uint256[](c.staleness.length);
        uint256[] memory tr = new uint256[](c.tiers.length);
        for (uint256 i; i < st.length; ++i) {
            st[i] = c.staleness[i];
            tr[i] = c.tiers[i];
        }
        vm.serializeUint(o, "staleness", st);
        string memory out = vm.serializeUint(o, "feeTiers", tr);
        // DEPLOYMENT_NAME=fork for local anvil forks (they also report chain id 4663) so they never look like mainnet.
        string memory name = vm.envOr("DEPLOYMENT_NAME", vm.toString(block.chainid));
        string memory path = string.concat(vm.projectRoot(), "/deployments/", name, ".json");
        vm.writeJson(out, path);
        console2.log("wrote", path);
    }
}
