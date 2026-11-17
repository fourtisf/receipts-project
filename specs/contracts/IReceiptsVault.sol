// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IReceiptsVault
/// @notice Non-custodial vault owned by one wallet. The operator (executor bot) may only call executeSignal,
///         for a live commit of the strategy the owner follows, within the owner's limits. Only the owner can withdraw.
///         Forked from NOUNY AgentVault (MIT, (c) 2026 NOUNY) — keep that notice in the implementation.
interface IReceiptsVault {
    event Deposited(address indexed from, uint256 amount, uint256 valueUsd);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event Followed(uint256 indexed strategyId, uint256 allocationUsd, uint16 creatorShareSnapshot);
    event Unfollowed(uint256 indexed strategyId);
    event AllocationChanged(uint256 allocationUsd);
    event LimitsChanged(uint16 maxSlippageBps, uint256 dailyLimitUsd, uint16 drawdownBps);
    event PausedChanged(bool paused);
    event OperatorChanged(address indexed previous, address indexed current);
    event TokenEnabled(address indexed token, bool enabled);
    event Executed(
        uint256 indexed strategyId,
        uint64 indexed nonce,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 valueUsd,
        uint256 minOutEnforced
    );
    event BreakerTripped(uint256 navUsd, uint256 peakNavUsd);
    event PeakReset(uint256 peakNavUsd);
    event MarksFrozen();
    event MarksReset(uint256 navUsd);
    event FeesSettled(
        uint256 indexed strategyId,
        uint256 profitUsd,
        uint256 creatorAmount,
        uint256 protocolAmount,
        uint256 navUsd,
        uint256 hwmNavUsd
    );
    event FeeDeferred(uint256 profitUsd, uint256 neededBase, uint256 baseBalance);

    error NotOwner();
    error NotOperator();
    error Paused();
    error NotFollowing();
    error NotExecutable();
    error AlreadyExecuted();
    error TokenNotAllowed(address token);
    error PairNotAllowed();
    error BadFeeTier();
    error SlippageTooHigh();
    error DailyLimitTooHigh();
    error BadDrawdown();
    error DailyLimitExceeded(uint256 requestedUsd, uint256 remainingUsd);
    error AllocationExceeded(uint256 exposureUsd, uint256 allocationUsd);
    error BadOraclePrice(address token);
    error StaleOraclePrice(address token);
    error InsufficientOutput(uint256 received, uint256 minimum);
    error PricesStale();
    error TooSoon();
    error MarksNotFrozen();
    error ZeroAddress();
    error ZeroAmount();

    // immutables
    function owner() external view returns (address);
    function factory() external view returns (address);
    function registry() external view returns (address);
    function router() external view returns (address);
    function base() external view returns (address);
    function treasury() external view returns (address);
    function protocolCutBps() external view returns (uint16);
    function maxDailyLimitUsd() external view returns (uint256);

    // owner
    function deposit(uint256 amount) external;
    function withdraw(address token, uint256 amount, address to) external;
    function follow(uint256 strategyId, uint256 allocationUsd) external;
    function unfollow() external;
    function setAllocation(uint256 allocationUsd) external;
    function setLimits(uint16 maxSlippageBps, uint256 dailyLimitUsd, uint16 drawdownBps) external;
    function setPaused(bool paused) external;
    function setOperator(address operator) external;
    function setTokenEnabled(address token, bool enabled) external;
    function resetPeak() external;
    function resetMarks() external;

    // operator
    function executeSignal(uint64 nonce, address tokenIn, address tokenOut, uint256 amountIn, uint256 minOutFromOperator)
        external
        returns (uint256 amountOut);

    // anyone
    function checkBreaker() external returns (bool tripped);
    function settleFees() external;

    // views
    function operator() external view returns (address);
    function paused() external view returns (bool);
    function followingId() external view returns (uint256);
    function creatorShareSnapshot() external view returns (uint16);
    function allocationUsd() external view returns (uint256);
    function maxSlippageBps() external view returns (uint16);
    function dailyLimitUsd() external view returns (uint256);
    function drawdownBps() external view returns (uint16);
    function remainingDailyUsd() external view returns (uint256);
    function peakNav() external view returns (uint256);
    function hwmNav() external view returns (uint256);
    function lastFeeSettle() external view returns (uint256);
    function marksFrozen() external view returns (bool);
    function navStrict() external view returns (uint256);
    function navLenient() external view returns (uint256);
    function exposureUsd() external view returns (uint256);
    function priceUsd(address token) external view returns (uint256);
    function allowedTokens() external view returns (address[] memory);
    function isExecuted(uint256 strategyId, uint64 nonce) external view returns (bool);
}
