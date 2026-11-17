// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title ISignalRegistry
/// @notice Strategies commit a hash of each trade decision before it executes and reveal it afterwards.
///         A commit that is not revealed before its deadline can be marked missed by anyone, permanently.
interface ISignalRegistry {
    enum Status {
        None,
        Committed,
        Revealed,
        Missed
    }

    struct Strategy {
        address creator;
        address signer;
        uint16 creatorShareBps;
        uint32 revealWindow;
        bool active;
        bytes32 modelHash;
        uint64 commitCount;
        uint64 revealCount;
        uint64 missedCount;
        string metadataURI;
    }

    struct Commit {
        bytes32 hash;
        uint64 committedAt;
        uint64 committedL2Block;
        uint64 revealDeadline;
        Status status;
    }

    struct Signal {
        address tokenIn;
        address tokenOut;
        uint16 sizeBps;
        bytes32 promptHash;
    }

    event StrategyRegistered(
        uint256 indexed id,
        address indexed creator,
        address signer,
        uint16 creatorShareBps,
        uint32 revealWindow,
        bytes32 modelHash,
        string metadataURI
    );
    event SignerChanged(uint256 indexed id, address signer);
    event ActiveChanged(uint256 indexed id, bool active);
    event MetadataChanged(uint256 indexed id, string metadataURI);
    event CreatorShareLowered(uint256 indexed id, uint16 creatorShareBps);
    event Committed(uint256 indexed id, uint64 indexed nonce, bytes32 hash, uint64 revealDeadline, uint64 l2Block);
    event Revealed(
        uint256 indexed id,
        uint64 indexed nonce,
        address tokenIn,
        address tokenOut,
        uint16 sizeBps,
        bytes32 promptHash,
        bytes32 salt
    );
    event Missed(uint256 indexed id, uint64 indexed nonce);

    error NotCreator();
    error NotSigner();
    error Inactive();
    error BadShare();
    error BadWindow();
    error ZeroAddress();
    error NotCommitted();
    error DeadlinePassed();
    error DeadlineNotPassed();
    error HashMismatch();
    error UnknownStrategy();

    function MAX_CREATOR_SHARE_BPS() external view returns (uint16); // 3000
    function MIN_REVEAL_WINDOW() external view returns (uint32); // 10 minutes
    function MAX_REVEAL_WINDOW() external view returns (uint32); // 24 hours

    function registerStrategy(
        address signer,
        uint16 creatorShareBps,
        uint32 revealWindow,
        bytes32 modelHash,
        string calldata metadataURI
    ) external returns (uint256 id);

    function setSigner(uint256 id, address signer) external;
    function setActive(uint256 id, bool active) external;
    function setMetadataURI(uint256 id, string calldata metadataURI) external;
    function lowerCreatorShare(uint256 id, uint16 newBps) external;

    function commit(uint256 id, bytes32 hash) external returns (uint64 nonce);
    function reveal(uint256 id, uint64 nonce, Signal calldata signal, bytes32 salt) external;
    function markMissed(uint256 id, uint64 nonce) external;

    function hashSignal(uint256 id, uint64 nonce, Signal calldata signal, bytes32 salt) external view returns (bytes32);
    function isExecutable(uint256 id, uint64 nonce) external view returns (bool);
    function strategyOf(uint256 id) external view returns (Strategy memory);
    function commitOf(uint256 id, uint64 nonce) external view returns (Commit memory);
    function creatorOf(uint256 id) external view returns (address);
    function creatorShareOf(uint256 id) external view returns (uint16);
    function isActive(uint256 id) external view returns (bool);
    function strategyCount() external view returns (uint256);
}
