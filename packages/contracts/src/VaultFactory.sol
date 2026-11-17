// SPDX-License-Identifier: MIT
//
// Derived from NOUNY AgentVaultFactory — https://github.com/nounyagent/nouny-agent
//
// MIT License
//
// Copyright (c) 2026 NOUNY
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
//
// Modifications for Receipts (registry, treasury, protocol cut, beta daily cap, paging) are also released
// under the MIT License.
pragma solidity 0.8.26;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IVaultFactory} from "./interfaces/IVaultFactory.sol";
import {AggregatorV3Interface} from "./interfaces/IExternal.sol";
import {ReceiptsVault} from "./ReceiptsVault.sol";

/// @title VaultFactory
/// @notice Each wallet creates one ReceiptsVault of its own. The token / feed / staleness / pinned-pool list is
///         fixed at deployment and can never change, so the admin cannot point vaults at a malicious oracle or pool.
///         The admin can only rotate the default operator and the treasury, and both affect vaults created
///         afterwards only. Existing vaults are fully controlled by their owners.
contract VaultFactory is IVaultFactory {
    uint256 public constant MAX_TOKENS = 20;
    uint16 public constant MAX_PROTOCOL_CUT_BPS = 3000;

    address public immutable router;
    address public immutable registry;
    address public immutable base;
    uint16 public immutable protocolCutBps;
    /// @notice Beta cap: no vault may set a daily swap limit above this (USD, 18 decimals). Raise only by deploying
    ///         a new factory after an external audit.
    uint256 public immutable MAX_DAILY_LIMIT_USD;

    address public admin;
    address public pendingAdmin;
    address public defaultOperator;
    address public treasury;

    address[] private _tokens;
    address[] private _feeds;
    uint32[] private _staleness;
    uint24[] private _feeTiers;

    mapping(address owner => address vault) public vaultOf;
    address[] private _allVaults;

    error BadConfig(string reason);

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(
        address router_,
        address registry_,
        address base_,
        address treasury_,
        uint16 protocolCutBps_,
        uint256 maxDailyLimitUsd_,
        address defaultOperator_,
        address[] memory tokens_,
        address[] memory feeds_,
        uint32[] memory staleness_,
        uint24[] memory feeTiers_
    ) {
        if (router_ == address(0) || registry_ == address(0) || base_ == address(0) || treasury_ == address(0)) {
            revert ZeroAddress();
        }
        if (protocolCutBps_ > MAX_PROTOCOL_CUT_BPS) revert BadConfig("protocol cut");
        if (maxDailyLimitUsd_ == 0) revert BadConfig("daily cap");
        _validateTokens(base_, tokens_, feeds_, staleness_, feeTiers_);

        router = router_;
        registry = registry_;
        base = base_;
        treasury = treasury_;
        protocolCutBps = protocolCutBps_;
        MAX_DAILY_LIMIT_USD = maxDailyLimitUsd_;
        admin = msg.sender;
        defaultOperator = defaultOperator_;
        _tokens = tokens_;
        _feeds = feeds_;
        _staleness = staleness_;
        _feeTiers = feeTiers_;

        emit AdminTransferred(msg.sender);
        emit DefaultOperatorChanged(address(0), defaultOperator_);
        emit TreasuryChanged(address(0), treasury_);
    }

    function _validateTokens(
        address base_,
        address[] memory tokens_,
        address[] memory feeds_,
        uint32[] memory staleness_,
        uint24[] memory feeTiers_
    ) private view {
        uint256 n = tokens_.length;
        if (n != feeds_.length || n != staleness_.length || n != feeTiers_.length) revert BadConfig("length mismatch");
        if (n == 0 || n > MAX_TOKENS) revert BadConfig("token count");

        bool baseListed = false;
        for (uint256 i; i < n; ++i) {
            address t = tokens_[i];
            if (t == address(0) || feeds_[i] == address(0)) revert ZeroAddress();
            for (uint256 j; j < i; ++j) {
                if (tokens_[j] == t) revert BadConfig("duplicate token");
            }
            uint24 tier = feeTiers_[i];
            if (t == base_) {
                if (tier != 0) revert BadConfig("base tier");
                baseListed = true;
            } else if (tier != 100 && tier != 500 && tier != 3000 && tier != 10000) {
                revert BadConfig("fee tier");
            }
            if (staleness_[i] == 0) revert BadConfig("staleness");
            // The feed must answer at deploy, but need not be fresh (stock feeds pause on weekends; freshness is
            // enforced on every swap — NOUNY review L-1).
            _checkFeed(feeds_[i]);
            if (IERC20Metadata(t).decimals() > 36) revert BadConfig("token decimals");
        }
        if (!baseListed) revert BadConfig("base not listed");
    }

    function _checkFeed(address feed) private view {
        // slither-disable-next-line unused-return
        (, int256 answer,,,) = AggregatorV3Interface(feed).latestRoundData();
        if (answer <= 0 || AggregatorV3Interface(feed).decimals() > 36) revert BadConfig("feed");
    }

    /// @inheritdoc IVaultFactory
    function createVault(uint16 maxSlippageBps, uint256 dailyLimitUsd, uint16 drawdownBps)
        external
        returns (address vault)
    {
        address existing = vaultOf[msg.sender];
        if (existing != address(0)) revert VaultExists(existing);
        vault = address(new ReceiptsVault(msg.sender, maxSlippageBps, dailyLimitUsd, drawdownBps));
        vaultOf[msg.sender] = vault;
        _allVaults.push(vault);
        emit VaultCreated(msg.sender, vault);
    }

    /// @inheritdoc IVaultFactory
    function vaultCount() external view returns (uint256) {
        return _allVaults.length;
    }

    /// @inheritdoc IVaultFactory
    function vaults(uint256 start, uint256 count) external view returns (address[] memory page) {
        uint256 total = _allVaults.length;
        if (start >= total) return new address[](0);
        uint256 end = count > total - start ? total : start + count;
        page = new address[](end - start);
        for (uint256 i = start; i < end; ++i) {
            page[i - start] = _allVaults[i];
        }
    }

    /// @inheritdoc IVaultFactory
    function getDefaults()
        external
        view
        returns (
            address operator,
            address[] memory tokens,
            address[] memory feeds,
            uint32[] memory staleness,
            uint24[] memory feeTiers
        )
    {
        return (defaultOperator, _tokens, _feeds, _staleness, _feeTiers);
    }

    // ------------------------------------------------------------------ admin (new vaults only)

    /// @inheritdoc IVaultFactory
    /// @dev Affects vaults created from now on. Existing vaults' owners control their own operator.
    function setDefaultOperator(address operator) external onlyAdmin {
        emit DefaultOperatorChanged(defaultOperator, operator);
        defaultOperator = operator;
    }

    /// @inheritdoc IVaultFactory
    /// @dev Affects vaults created from now on (treasury is immutable inside each vault).
    function setTreasury(address treasury_) external onlyAdmin {
        if (treasury_ == address(0)) revert ZeroAddress();
        emit TreasuryChanged(treasury, treasury_);
        treasury = treasury_;
    }

    /// @inheritdoc IVaultFactory
    function transferAdmin(address next) external onlyAdmin {
        pendingAdmin = next;
        emit AdminTransferStarted(next);
    }

    /// @inheritdoc IVaultFactory
    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotAdmin();
        admin = msg.sender;
        pendingAdmin = address(0);
        emit AdminTransferred(msg.sender);
    }
}
