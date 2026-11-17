// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IVaultFactory
/// @notice One ReceiptsVault per wallet. The token / feed / staleness / pool-tier list is fixed at deployment.
///         The admin can only change the default operator and treasury for vaults created afterwards.
///         Forked from NOUNY AgentVaultFactory (MIT, (c) 2026 NOUNY) — keep that notice in the implementation.
interface IVaultFactory {
    event VaultCreated(address indexed owner, address vault);
    event DefaultOperatorChanged(address indexed previous, address indexed current);
    event TreasuryChanged(address indexed previous, address indexed current);
    event AdminTransferStarted(address indexed pendingAdmin);
    event AdminTransferred(address indexed admin);

    error NotAdmin();
    error VaultExists(address vault);
    error ZeroAddress();

    function router() external view returns (address);
    function registry() external view returns (address);
    function base() external view returns (address);
    function protocolCutBps() external view returns (uint16);
    function MAX_DAILY_LIMIT_USD() external view returns (uint256);

    function admin() external view returns (address);
    function pendingAdmin() external view returns (address);
    function defaultOperator() external view returns (address);
    function treasury() external view returns (address);

    function createVault(uint16 maxSlippageBps, uint256 dailyLimitUsd, uint16 drawdownBps)
        external
        returns (address vault);
    function vaultOf(address owner) external view returns (address);
    function vaultCount() external view returns (uint256);
    function vaults(uint256 start, uint256 count) external view returns (address[] memory);

    function getDefaults()
        external
        view
        returns (
            address operator,
            address[] memory tokens,
            address[] memory feeds,
            uint32[] memory staleness,
            uint24[] memory feeTiers
        );

    function setDefaultOperator(address operator) external;
    function setTreasury(address treasury) external;
    function transferAdmin(address next) external;
    function acceptAdmin() external;
}
