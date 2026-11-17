// SPDX-License-Identifier: MIT
//
// Derived from NOUNY AgentVault — https://github.com/nounyagent/nouny-agent
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
// Modifications for Receipts (commit-gated execution, drawdown breaker, allocation cap,
// high-water-mark fees, fixed factory token list) are also released under the MIT License.
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IReceiptsVault} from "./interfaces/IReceiptsVault.sol";
import {ISignalRegistry} from "./interfaces/ISignalRegistry.sol";
import {IVaultFactory} from "./interfaces/IVaultFactory.sol";
import {ISwapRouter02, AggregatorV3Interface} from "./interfaces/IExternal.sol";

/// @title ReceiptsVault
/// @notice Non-custodial vault owned by one wallet, created by VaultFactory.
///
/// Guarantees for the owner:
///  - Tokens leave only via `withdraw` (owner) or `settleFees` (USDG to the strategy creator + treasury, bounded
///    by profit above the high-water mark × the creator share snapshot).
///  - The operator can only call `executeSignal`: one swap per live, publicly committed signal of the strategy the
///    owner follows, in a later L2 block than the commit, against USDG in the pinned pool, with an oracle-computed
///    minimum output, within the owner's daily limit and allocation cap. Output always lands in the vault.
///  - A drawdown breaker pauses the vault when NAV falls too far below its peak.
///  - `withdraw` works while paused, with the operator revoked, and with stale or broken oracles.
contract ReceiptsVault is IReceiptsVault, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct TokenConfig {
        bool listed; // in the factory list (fixed forever)
        bool enabled; // owner switch: tradable + counted in NAV
        uint8 decimals;
        uint24 feeTier; // pinned Uniswap V3 fee tier of the <token>/base pool; 0 for the base token
        uint32 maxStaleness; // strict staleness limit (swaps, fees, follow)
        AggregatorV3Interface feed; // TOKEN / USD
    }

    uint16 public constant MAX_SLIPPAGE_CAP_BPS = 500;
    uint16 public constant MIN_DRAWDOWN_BPS = 500;
    uint16 public constant MAX_DRAWDOWN_BPS = 5000;
    uint16 public constant MAX_PROTOCOL_CUT_BPS = 3000;
    uint256 public constant WINDOW = 1 days;
    uint256 public constant FEE_PERIOD = 7 days;
    uint256 public constant LENIENT_STALENESS = 7 days;
    uint256 private constant BPS = 10_000;

    uint8 private constant PRICE_OK = 0;
    uint8 private constant PRICE_BAD = 1;
    uint8 private constant PRICE_STALE = 2;

    // ------------------------------------------------------------------ immutables
    address public immutable owner;
    address public immutable factory;
    address public immutable registry;
    address public immutable router;
    address public immutable base;
    address public immutable treasury;
    uint16 public immutable protocolCutBps;
    uint256 public immutable maxDailyLimitUsd;

    // ------------------------------------------------------------------ state
    address public operator;
    bool public paused;
    bool public marksFrozen;
    uint16 public maxSlippageBps;
    uint16 public drawdownBps;
    uint16 public creatorShareSnapshot;
    uint256 public dailyLimitUsd; // USD, 18 decimals
    uint256 public windowStart;
    uint256 public usedInWindowUsd; // USD, 18 decimals
    uint256 public followingId;
    uint256 public allocationUsd; // cap on non-base exposure, USD 18 decimals
    uint256 public peakNav; // drawdown breaker reference
    uint256 public hwmNav; // fee high-water mark
    uint256 public lastFeeSettle;

    mapping(address token => TokenConfig) public tokenConfig;
    address[] private _tokenList;
    mapping(bytes32 key => bool) private _executed;

    error StrategyInactive(uint256 strategyId);
    error MarksAreFrozen();
    error SameToken();
    error BadConfig();
    error OnlySelf();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @dev Deployed by VaultFactory; every other parameter is read from the factory, so a vault can only ever be
    ///      configured with the factory's fixed token / feed / pool list.
    constructor(address owner_, uint16 maxSlippageBps_, uint256 dailyLimitUsd_, uint16 drawdownBps_) {
        if (owner_ == address(0)) revert ZeroAddress();
        IVaultFactory f = IVaultFactory(msg.sender);
        address registry_ = f.registry();
        address router_ = f.router();
        address base_ = f.base();
        address treasury_ = f.treasury();
        uint16 cut = f.protocolCutBps();
        if (registry_ == address(0) || router_ == address(0) || base_ == address(0) || treasury_ == address(0)) {
            revert ZeroAddress();
        }
        if (cut > MAX_PROTOCOL_CUT_BPS) revert BadConfig();

        owner = owner_;
        factory = msg.sender;
        registry = registry_;
        router = router_;
        base = base_;
        treasury = treasury_;
        protocolCutBps = cut;
        maxDailyLimitUsd = f.MAX_DAILY_LIMIT_USD();

        address op = _initTokens(f, base_);
        _setLimits(maxSlippageBps_, dailyLimitUsd_, drawdownBps_);
        operator = op;
        emit OperatorChanged(address(0), op);
    }

    function _initTokens(IVaultFactory f, address base_) private returns (address op) {
        address[] memory tokens;
        address[] memory feeds;
        uint32[] memory staleness;
        uint24[] memory tiers;
        (op, tokens, feeds, staleness, tiers) = f.getDefaults();
        bool baseListed = false;
        for (uint256 i; i < tokens.length; ++i) {
            if (_listToken(tokens[i], feeds[i], staleness[i], tiers[i], base_)) baseListed = true;
        }
        if (!baseListed) revert BadConfig();
    }

    function _listToken(address t, address feed, uint32 maxStaleness, uint24 tier, address base_)
        private
        returns (bool isBase)
    {
        if (tokenConfig[t].listed) revert BadConfig();
        isBase = t == base_;
        if (isBase != (tier == 0)) revert BadConfig(); // only the base token has tier 0
        tokenConfig[t] = TokenConfig({
            listed: true,
            enabled: true,
            decimals: IERC20Metadata(t).decimals(),
            feeTier: tier,
            maxStaleness: maxStaleness,
            feed: AggregatorV3Interface(feed)
        });
        _tokenList.push(t);
    }

    // ================================================================== owner

    /// @inheritdoc IReceiptsVault
    /// @dev Raises both marks by the deposited value so a deposit is never charged as profit nor trips the breaker.
    function deposit(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert ZeroAmount();
        IERC20 b = IERC20(base);
        uint256 balBefore = b.balanceOf(address(this));
        b.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = b.balanceOf(address(this)) - balBefore;

        TokenConfig memory c = tokenConfig[base];
        uint256 price = _priceOrRevert(base, c, _lenientAge(c));
        uint256 value = Math.mulDiv(received, price, 10 ** c.decimals);
        peakNav += value;
        hwmNav += value;
        emit Deposited(msg.sender, received, value);
    }

    /// @inheritdoc IReceiptsVault
    /// @dev Never reverts because of oracles, pause or operator state. Fees are settled best-effort first; marks are
    ///      scaled by navAfter / navBefore (lenient NAV). If NAV cannot be computed the marks are frozen instead.
    function withdraw(address token, uint256 amount, address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        if (followingId != 0 && !marksFrozen) {
            // Self-call so any revert inside (stale feed, USDG transfer failure, ...) is caught. Re-entry from
            // outside is impossible: every state-changing function is nonReentrant (SECURITY.md, Slither notes).
            // slither-disable-next-line reentrancy-no-eth
            try this.settleFeesForWithdraw() {} catch {}
        }

        // Effects before the transfer: predict navAfter from the withdrawn token's lenient value.
        if (!marksFrozen) {
            (uint8 st,, uint256 navBefore,) = _nav(true);
            uint256 valueOut = 0;
            bool ok = st == PRICE_OK;
            TokenConfig memory c = tokenConfig[token];
            if (ok && c.enabled) {
                (uint8 ps, uint256 p) = _readPrice(c, _lenientAge(c));
                ok = ps == PRICE_OK;
                if (ok) valueOut = Math.mulDiv(amount, p, 10 ** c.decimals);
            }
            if (ok) {
                if (navBefore > 0) {
                    uint256 navAfter = valueOut >= navBefore ? 0 : navBefore - valueOut;
                    peakNav = Math.mulDiv(peakNav, navAfter, navBefore);
                    hwmNav = Math.mulDiv(hwmNav, navAfter, navBefore);
                }
            } else {
                marksFrozen = true;
                emit MarksFrozen();
            }
        }

        IERC20(token).safeTransfer(to, amount);
        emit Withdrawn(token, to, amount);
    }

    /// @notice Internal entry point for best-effort fee settlement inside `withdraw`. Only callable by the vault.
    function settleFeesForWithdraw() external {
        if (msg.sender != address(this)) revert OnlySelf();
        _settleFees();
    }

    /// @inheritdoc IReceiptsVault
    function follow(uint256 strategyId, uint256 allocationUsd_) external onlyOwner nonReentrant {
        ISignalRegistry reg = ISignalRegistry(registry);
        if (!reg.isActive(strategyId)) revert StrategyInactive(strategyId);

        uint256 previous = followingId;
        if (previous != 0 && !marksFrozen) _settleFees(); // strict: reverts PricesStale (owner can retry or withdraw)

        (uint8 st,, uint256 nav,) = _nav(false);
        if (st != PRICE_OK) revert PricesStale();
        uint16 share = reg.creatorShareOf(strategyId);

        followingId = strategyId;
        allocationUsd = allocationUsd_;
        creatorShareSnapshot = share;
        hwmNav = nav;
        lastFeeSettle = block.timestamp;
        if (marksFrozen) {
            // Re-arm frozen marks from a strict NAV (fees accrued before the freeze are forgone; documented).
            marksFrozen = false;
            peakNav = nav;
            emit MarksReset(nav);
        }
        if (previous != 0 && previous != strategyId) emit Unfollowed(previous);
        emit Followed(strategyId, allocationUsd_, share);
    }

    /// @inheritdoc IReceiptsVault
    function unfollow() external onlyOwner nonReentrant {
        uint256 id = followingId;
        if (id == 0) revert NotFollowing();
        if (!marksFrozen) _settleFees(); // strict: reverts PricesStale (owner can pause / revoke and retry later)
        followingId = 0;
        creatorShareSnapshot = 0;
        emit Unfollowed(id);
    }

    /// @inheritdoc IReceiptsVault
    function setAllocation(uint256 allocationUsd_) external onlyOwner nonReentrant {
        allocationUsd = allocationUsd_;
        emit AllocationChanged(allocationUsd_);
    }

    /// @inheritdoc IReceiptsVault
    function setLimits(uint16 maxSlippageBps_, uint256 dailyLimitUsd_, uint16 drawdownBps_)
        external
        onlyOwner
        nonReentrant
    {
        _setLimits(maxSlippageBps_, dailyLimitUsd_, drawdownBps_);
    }

    /// @inheritdoc IReceiptsVault
    function setPaused(bool paused_) external onlyOwner nonReentrant {
        paused = paused_;
        emit PausedChanged(paused_);
    }

    /// @inheritdoc IReceiptsVault
    /// @dev `address(0)` revokes the bot completely.
    function setOperator(address operator_) external onlyOwner nonReentrant {
        emit OperatorChanged(operator, operator_);
        operator = operator_;
    }

    /// @inheritdoc IReceiptsVault
    /// @dev Only factory-listed tokens; the base token cannot be disabled. A token's balance enters / leaves NAV with
    ///      the switch, so the marks move like a deposit / withdrawal of that value (no fee games via the switch).
    function setTokenEnabled(address token, bool enabled) external onlyOwner nonReentrant {
        TokenConfig storage c = tokenConfig[token];
        if (!c.listed || (token == base && !enabled)) revert TokenNotAllowed(token);
        if (c.enabled != enabled) {
            (bool bok, uint256 bal) = _balanceOf(token);
            if (bok && bal > 0) {
                TokenConfig memory cm = c;
                if (enabled) {
                    uint256 value = Math.mulDiv(bal, _priceOrRevert(token, cm, _lenientAge(cm)), 10 ** cm.decimals);
                    peakNav += value;
                    hwmNav += value;
                } else if (!marksFrozen) {
                    (uint8 st,, uint256 navBefore,) = _nav(true);
                    (uint8 ps, uint256 p) = _readPrice(cm, _lenientAge(cm));
                    if (st == PRICE_OK && ps == PRICE_OK) {
                        if (navBefore > 0) {
                            uint256 value = Math.mulDiv(bal, p, 10 ** cm.decimals);
                            uint256 navAfter = value >= navBefore ? 0 : navBefore - value;
                            peakNav = Math.mulDiv(peakNav, navAfter, navBefore);
                            hwmNav = Math.mulDiv(hwmNav, navAfter, navBefore);
                        }
                    } else {
                        marksFrozen = true;
                        emit MarksFrozen();
                    }
                }
            }
            c.enabled = enabled;
        }
        emit TokenEnabled(token, enabled);
    }

    /// @inheritdoc IReceiptsVault
    /// @dev Re-arms the breaker at the current lenient NAV (owner's choice after a trip). Does not unpause.
    function resetPeak() external onlyOwner nonReentrant {
        (uint8 st,, uint256 nav,) = _nav(true);
        if (st != PRICE_OK) revert PricesStale();
        peakNav = nav;
        emit PeakReset(nav);
    }

    /// @inheritdoc IReceiptsVault
    /// @dev Only when frozen. The creator loses fees accrued before the freeze (documented in SECURITY.md).
    function resetMarks() external onlyOwner nonReentrant {
        if (!marksFrozen) revert MarksNotFrozen();
        (uint8 st,, uint256 nav,) = _nav(false);
        if (st != PRICE_OK) revert PricesStale();
        peakNav = nav;
        hwmNav = nav;
        marksFrozen = false;
        lastFeeSettle = block.timestamp;
        emit MarksReset(nav);
    }

    // ================================================================== operator

    /// @inheritdoc IReceiptsVault
    function executeSignal(
        uint64 nonce,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOutFromOperator
    ) external nonReentrant returns (uint256 amountOut) {
        // 1. caller + state
        if (msg.sender != operator || msg.sender == address(0)) revert NotOperator();
        if (paused) revert Paused();
        uint256 strategyId = followingId;
        if (strategyId == 0) revert NotFollowing();
        if (amountIn == 0) revert ZeroAmount();

        // 2. breaker pre-check: trip and return without swapping (no revert, so the pause persists)
        if (_breakerPreCheck()) return 0;

        // 3. live public commit of the followed strategy, once per (strategy, nonce)
        _consumeCommit(strategyId, nonce);

        // 4–6. pair rules, strict prices, daily window, oracle minimum output
        (uint24 fee, uint256 valueUsd, uint256 minOut) = _quote(tokenIn, tokenOut, amountIn, minOutFromOperator);

        // 7. swap; output measured as the real balance delta
        amountOut = _swap(tokenIn, tokenOut, fee, amountIn, minOut);

        // 8–9. allocation cap after buys, peak update, post-trade breaker
        // slither-disable-next-line reentrancy-no-eth
        (bool breached, uint256 navPost) = _postTrade(tokenOut);

        // 10.
        emit Executed(strategyId, nonce, tokenIn, tokenOut, amountIn, amountOut, valueUsd, minOut);
        // slither-disable-next-line reentrancy-no-eth
        if (breached) _trip(navPost);
    }

    function _breakerPreCheck() internal returns (bool tripped) {
        (uint8 st, address bad, uint256 nav,) = _nav(true);
        _revertOnPriceStatus(st, bad);
        if (_breached(nav)) {
            _trip(nav);
            return true;
        }
    }

    function _consumeCommit(uint256 strategyId, uint64 nonce) internal {
        if (!ISignalRegistry(registry).isExecutable(strategyId, nonce)) revert NotExecutable();
        bytes32 key = _key(strategyId, nonce);
        if (_executed[key]) revert AlreadyExecuted();
        _executed[key] = true;
    }

    function _quote(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOutFromOperator)
        internal
        returns (uint24 fee, uint256 valueUsd, uint256 minOut)
    {
        // both enabled, exactly one side is base, pinned pool of the non-base token
        if (tokenIn == tokenOut) revert SameToken();
        TokenConfig memory cin = tokenConfig[tokenIn];
        TokenConfig memory cout = tokenConfig[tokenOut];
        if (!cin.enabled) revert TokenNotAllowed(tokenIn);
        if (!cout.enabled) revert TokenNotAllowed(tokenOut);
        if ((tokenIn == base) == (tokenOut == base)) revert PairNotAllowed();
        fee = tokenIn == base ? cout.feeTier : cin.feeTier;
        if (fee == 0) revert BadFeeTier();

        // strict prices, USD value, daily window
        uint256 priceIn = _priceOrRevert(tokenIn, cin, cin.maxStaleness);
        uint256 priceOut = _priceOrRevert(tokenOut, cout, cout.maxStaleness);
        valueUsd = Math.mulDiv(amountIn, priceIn, 10 ** cin.decimals);
        _consumeDaily(valueUsd);

        // oracle minimum; the stricter of oracle and operator minimum wins
        uint256 expectedOut = Math.mulDiv(valueUsd, 10 ** cout.decimals, priceOut);
        minOut = Math.mulDiv(expectedOut, BPS - maxSlippageBps, BPS);
        if (minOutFromOperator > minOut) minOut = minOutFromOperator;
        if (minOut == 0) revert ZeroAmount(); // dust trade: the oracle minimum rounds to nothing
    }

    function _swap(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint256 minOut)
        internal
        returns (uint256 amountOut)
    {
        // The router's return value is ignored on purpose: the output is measured as the real balance delta below,
        // so a cheating router cannot fake the amount. Re-entry is blocked by nonReentrant on every state-changing
        // function (see SECURITY.md, Slither notes).
        // slither-disable-start unused-return,reentrancy-balance
        uint256 balBefore = IERC20(tokenOut).balanceOf(address(this));
        IERC20(tokenIn).forceApprove(router, amountIn);
        ISwapRouter02(router)
            .exactInputSingle(
                ISwapRouter02.ExactInputSingleParams({
                    tokenIn: tokenIn,
                    tokenOut: tokenOut,
                    fee: fee,
                    recipient: address(this),
                    amountIn: amountIn,
                    amountOutMinimum: minOut,
                    sqrtPriceLimitX96: 0
                })
            );
        IERC20(tokenIn).forceApprove(router, 0);
        // check the real balance, not the amount the router reports
        amountOut = IERC20(tokenOut).balanceOf(address(this)) - balBefore;
        if (amountOut < minOut) revert InsufficientOutput(amountOut, minOut);
        // slither-disable-end unused-return,reentrancy-balance
    }

    function _postTrade(address tokenOut) internal returns (bool breached, uint256 navPost) {
        uint8 st;
        address bad;
        uint256 baseValue;
        (st, bad, navPost, baseValue) = _nav(true);
        _revertOnPriceStatus(st, bad);
        if (tokenOut != base) {
            uint256 exposure = navPost - baseValue;
            if (exposure > allocationUsd) revert AllocationExceeded(exposure, allocationUsd);
        }
        if (navPost > peakNav) peakNav = navPost;
        breached = _breached(navPost);
    }

    // ================================================================== anyone

    /// @inheritdoc IReceiptsVault
    function checkBreaker() external nonReentrant returns (bool tripped) {
        (uint8 st,, uint256 nav,) = _nav(true);
        if (st != PRICE_OK) revert PricesStale();
        if (!_breached(nav)) return false;
        if (!paused) _trip(nav);
        return true;
    }

    /// @inheritdoc IReceiptsVault
    function settleFees() external nonReentrant {
        if (followingId == 0) revert NotFollowing();
        if (marksFrozen) revert MarksAreFrozen();
        if (block.timestamp < lastFeeSettle + FEE_PERIOD) revert TooSoon();
        _settleFees();
    }

    // ================================================================== views

    /// @inheritdoc IReceiptsVault
    function remainingDailyUsd() external view returns (uint256) {
        if (block.timestamp >= windowStart + WINDOW) return dailyLimitUsd;
        return dailyLimitUsd > usedInWindowUsd ? dailyLimitUsd - usedInWindowUsd : 0;
    }

    /// @inheritdoc IReceiptsVault
    function navStrict() external view returns (uint256 nav) {
        uint8 st;
        address bad;
        (st, bad, nav,) = _nav(false);
        _revertOnPriceStatus(st, bad);
    }

    /// @inheritdoc IReceiptsVault
    function navLenient() external view returns (uint256 nav) {
        uint8 st;
        address bad;
        (st, bad, nav,) = _nav(true);
        _revertOnPriceStatus(st, bad);
    }

    /// @inheritdoc IReceiptsVault
    function exposureUsd() external view returns (uint256) {
        (uint8 st, address bad, uint256 nav, uint256 baseValue) = _nav(true);
        _revertOnPriceStatus(st, bad);
        return nav - baseValue;
    }

    /// @inheritdoc IReceiptsVault
    /// @dev Strict price (the token's own staleness limit), USD with 18 decimals.
    function priceUsd(address token) external view returns (uint256) {
        TokenConfig memory c = tokenConfig[token];
        if (!c.listed) revert TokenNotAllowed(token);
        return _priceOrRevert(token, c, c.maxStaleness);
    }

    /// @inheritdoc IReceiptsVault
    /// @dev Currently enabled tokens. The full fixed list is `VaultFactory.getDefaults()`.
    function allowedTokens() external view returns (address[] memory list) {
        uint256 n = _tokenList.length;
        list = new address[](n);
        uint256 k;
        for (uint256 i; i < n; ++i) {
            address t = _tokenList[i];
            if (tokenConfig[t].enabled) list[k++] = t;
        }
        assembly ("memory-safe") {
            mstore(list, k)
        }
    }

    /// @inheritdoc IReceiptsVault
    function isExecuted(uint256 strategyId, uint64 nonce) external view returns (bool) {
        return _executed[_key(strategyId, nonce)];
    }

    // ================================================================== internal

    function _setLimits(uint16 maxSlippageBps_, uint256 dailyLimitUsd_, uint16 drawdownBps_) internal {
        if (maxSlippageBps_ > MAX_SLIPPAGE_CAP_BPS) revert SlippageTooHigh();
        if (dailyLimitUsd_ > maxDailyLimitUsd) revert DailyLimitTooHigh();
        if (drawdownBps_ < MIN_DRAWDOWN_BPS || drawdownBps_ > MAX_DRAWDOWN_BPS) revert BadDrawdown();
        maxSlippageBps = maxSlippageBps_;
        dailyLimitUsd = dailyLimitUsd_;
        drawdownBps = drawdownBps_;
        emit LimitsChanged(maxSlippageBps_, dailyLimitUsd_, drawdownBps_);
    }

    function _consumeDaily(uint256 valueUsd) internal {
        if (block.timestamp >= windowStart + WINDOW) {
            windowStart = block.timestamp;
            usedInWindowUsd = 0;
        }
        uint256 remaining = dailyLimitUsd > usedInWindowUsd ? dailyLimitUsd - usedInWindowUsd : 0;
        if (valueUsd > remaining) revert DailyLimitExceeded(valueUsd, remaining);
        usedInWindowUsd += valueUsd;
    }

    /// @dev Strict fee settlement (CONTRACTS.md §3.6). Reverts PricesStale when strict prices are unavailable.
    function _settleFees() internal {
        uint256 id = followingId;
        (uint8 st,, uint256 nav,) = _nav(false);
        if (st != PRICE_OK) revert PricesStale();
        if (nav <= hwmNav) {
            lastFeeSettle = block.timestamp;
            return;
        }
        uint256 profit = nav - hwmNav;
        (uint256 totalBase, uint256 protocolBase, uint256 feeValue) = _feeAmounts(id, profit);

        uint256 bal = IERC20(base).balanceOf(address(this));
        if (totalBase > bal) {
            emit FeeDeferred(profit, totalBase, bal);
            return;
        }

        // effects
        uint256 newHwm = nav - feeValue;
        hwmNav = newHwm;
        peakNav = peakNav > feeValue ? peakNav - feeValue : 0;
        lastFeeSettle = block.timestamp;

        // interactions: USDG only, creator + treasury only
        uint256 creatorBase = totalBase - protocolBase;
        if (creatorBase > 0) IERC20(base).safeTransfer(ISignalRegistry(registry).creatorOf(id), creatorBase);
        if (protocolBase > 0) IERC20(base).safeTransfer(treasury, protocolBase);
        emit FeesSettled(id, profit, creatorBase, protocolBase, nav, newHwm);
    }

    /// @return totalBase creator fee in base units (creator part + protocol part)
    /// @return protocolBase protocol part in base units
    /// @return feeValue USD value of totalBase at the strict base price (≤ creator fee in USD)
    function _feeAmounts(uint256 id, uint256 profit)
        internal
        view
        returns (uint256 totalBase, uint256 protocolBase, uint256 feeValue)
    {
        // Creators can only lower their share; followers always get the lower of snapshot and current.
        uint16 share = creatorShareSnapshot;
        uint16 current = ISignalRegistry(registry).creatorShareOf(id);
        if (current < share) share = current;
        uint256 creatorFeeUsd = (profit * share) / BPS;
        uint256 protocolFeeUsd = (profit * share * protocolCutBps) / (BPS * BPS); // ≤ creatorFeeUsd

        TokenConfig memory bc = tokenConfig[base];
        (uint8 ps, uint256 basePrice) = _readPrice(bc, bc.maxStaleness);
        if (ps != PRICE_OK) revert PricesStale();
        uint256 unit = 10 ** bc.decimals;
        totalBase = Math.mulDiv(creatorFeeUsd, unit, basePrice);
        protocolBase = Math.mulDiv(protocolFeeUsd, unit, basePrice);
        if (protocolBase > totalBase) protocolBase = totalBase;
        feeValue = Math.mulDiv(totalBase, basePrice, unit);
    }

    function _trip(uint256 nav) internal {
        paused = true;
        emit PausedChanged(true);
        emit BreakerTripped(nav, peakNav);
    }

    function _breached(uint256 nav) internal view returns (bool) {
        return nav * BPS < peakNav * (BPS - drawdownBps);
    }

    function _key(uint256 strategyId, uint64 nonce) internal pure returns (bytes32) {
        return keccak256(abi.encode(strategyId, nonce));
    }

    function _lenientAge(TokenConfig memory c) internal pure returns (uint256) {
        return c.maxStaleness > LENIENT_STALENESS ? c.maxStaleness : LENIENT_STALENESS;
    }

    /// @dev NAV over enabled tokens with a non-zero balance. Never reverts: returns a status and the failing token.
    /// @param lenient true → LENIENT_STALENESS (breaker, marks), false → each token's maxStaleness (swaps, fees).
    function _nav(bool lenient) internal view returns (uint8 status, address badToken, uint256 nav, uint256 baseValue) {
        uint256 n = _tokenList.length;
        for (uint256 i; i < n; ++i) {
            address t = _tokenList[i];
            TokenConfig memory c = tokenConfig[t];
            if (!c.enabled) continue;
            (bool bok, uint256 bal) = _balanceOf(t);
            if (!bok) return (PRICE_BAD, t, 0, 0);
            if (bal == 0) continue;
            (uint8 ps, uint256 p) = _readPrice(c, lenient ? _lenientAge(c) : c.maxStaleness);
            if (ps != PRICE_OK) return (ps, t, 0, 0);
            uint256 v = Math.mulDiv(bal, p, 10 ** c.decimals);
            nav += v;
            if (t == base) baseValue = v;
        }
    }

    /// @dev Chainlink read that never reverts. Rejects answer ≤ 0, future-dated and stale rounds.
    function _readPrice(TokenConfig memory c, uint256 maxAge) internal view returns (uint8 status, uint256 price18) {
        // roundId / startedAt / answeredInRound are not needed (answeredInRound is deprecated by Chainlink).
        // slither-disable-next-line unused-return
        try c.feed.latestRoundData() returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80) {
            if (answer <= 0) return (PRICE_BAD, 0);
            if (updatedAt > block.timestamp || block.timestamp - updatedAt > maxAge) return (PRICE_STALE, 0);
            try c.feed.decimals() returns (uint8 d) {
                if (d > 36) return (PRICE_BAD, 0);
                price18 = d <= 18 ? uint256(answer) * 10 ** (18 - d) : uint256(answer) / 10 ** (d - 18);
                if (price18 == 0) return (PRICE_BAD, 0);
                return (PRICE_OK, price18);
            } catch {
                return (PRICE_BAD, 0);
            }
        } catch {
            return (PRICE_BAD, 0);
        }
    }

    function _priceOrRevert(address token, TokenConfig memory c, uint256 maxAge) internal view returns (uint256 p) {
        uint8 st;
        (st, p) = _readPrice(c, maxAge);
        _revertOnPriceStatus(st, token);
    }

    function _revertOnPriceStatus(uint8 st, address token) internal pure {
        if (st == PRICE_BAD) revert BadOraclePrice(token);
        if (st == PRICE_STALE) revert StaleOraclePrice(token);
    }

    /// @dev balanceOf that never reverts (withdraw must work even if one listed token misbehaves).
    function _balanceOf(address token) internal view returns (bool ok, uint256 bal) {
        (bool success, bytes memory data) =
            token.staticcall(abi.encodeWithSelector(IERC20.balanceOf.selector, address(this)));
        if (!success || data.length < 32) return (false, 0);
        return (true, abi.decode(data, (uint256)));
    }
}
