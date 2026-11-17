// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ISignalRegistry} from "./interfaces/ISignalRegistry.sol";
import {L2Block} from "./libraries/L2Block.sol";

/// @title SignalRegistry
/// @notice Public, immutable record of trade decisions. A strategy's signer commits a hash of each decision
///         before it executes; anyone holding the preimage reveals it afterwards. A commit that is not revealed
///         before its deadline can be marked missed by anyone, permanently.
/// @dev No owner, no admin, no upgradeability. Commits are never deleted. Revealed and Missed are terminal.
contract SignalRegistry is ISignalRegistry {
    uint16 public constant MAX_CREATOR_SHARE_BPS = 3000;
    uint32 public constant MIN_REVEAL_WINDOW = 10 minutes;
    uint32 public constant MAX_REVEAL_WINDOW = 24 hours;

    uint256 private _strategyCount;
    mapping(uint256 id => Strategy) private _strategies;
    mapping(uint256 id => mapping(uint64 nonce => Commit)) private _commits;

    modifier onlyCreator(uint256 id) {
        if (id == 0 || id > _strategyCount) revert UnknownStrategy();
        if (msg.sender != _strategies[id].creator) revert NotCreator();
        _;
    }

    // ------------------------------------------------------------------ creator

    /// @inheritdoc ISignalRegistry
    function registerStrategy(
        address signer,
        uint16 creatorShareBps,
        uint32 revealWindow,
        bytes32 modelHash,
        string calldata metadataURI
    ) external returns (uint256 id) {
        if (signer == address(0)) revert ZeroAddress();
        if (creatorShareBps > MAX_CREATOR_SHARE_BPS) revert BadShare();
        if (revealWindow < MIN_REVEAL_WINDOW || revealWindow > MAX_REVEAL_WINDOW) revert BadWindow();

        id = ++_strategyCount;
        Strategy storage s = _strategies[id];
        s.creator = msg.sender;
        s.signer = signer;
        s.creatorShareBps = creatorShareBps;
        s.revealWindow = revealWindow;
        s.active = true;
        s.modelHash = modelHash;
        s.metadataURI = metadataURI;

        emit StrategyRegistered(id, msg.sender, signer, creatorShareBps, revealWindow, modelHash, metadataURI);
    }

    /// @inheritdoc ISignalRegistry
    function setSigner(uint256 id, address signer) external onlyCreator(id) {
        if (signer == address(0)) revert ZeroAddress();
        _strategies[id].signer = signer;
        emit SignerChanged(id, signer);
    }

    /// @inheritdoc ISignalRegistry
    function setActive(uint256 id, bool active) external onlyCreator(id) {
        _strategies[id].active = active;
        emit ActiveChanged(id, active);
    }

    /// @inheritdoc ISignalRegistry
    function setMetadataURI(uint256 id, string calldata metadataURI) external onlyCreator(id) {
        _strategies[id].metadataURI = metadataURI;
        emit MetadataChanged(id, metadataURI);
    }

    /// @inheritdoc ISignalRegistry
    /// @dev The share can only go down, so followers' fees never rise after they follow.
    function lowerCreatorShare(uint256 id, uint16 newBps) external onlyCreator(id) {
        if (newBps >= _strategies[id].creatorShareBps) revert BadShare();
        _strategies[id].creatorShareBps = newBps;
        emit CreatorShareLowered(id, newBps);
    }

    // ------------------------------------------------------------------ commit / reveal

    /// @inheritdoc ISignalRegistry
    /// @dev nonce = commitCount at call time; nonces are sequential per strategy and never reused.
    function commit(uint256 id, bytes32 hash) external returns (uint64 nonce) {
        if (id == 0 || id > _strategyCount) revert UnknownStrategy();
        Strategy storage s = _strategies[id];
        if (msg.sender != s.signer) revert NotSigner();
        if (!s.active) revert Inactive();

        nonce = s.commitCount;
        uint64 l2Block = L2Block.current();
        uint64 deadline = uint64(block.timestamp) + s.revealWindow;
        _commits[id][nonce] = Commit({
            hash: hash,
            committedAt: uint64(block.timestamp),
            committedL2Block: l2Block,
            revealDeadline: deadline,
            status: Status.Committed
        });
        s.commitCount = nonce + 1;

        emit Committed(id, nonce, hash, deadline, l2Block);
    }

    /// @inheritdoc ISignalRegistry
    /// @dev Anyone holding the exact preimage may reveal (the signer normally does). Revealing closes execution
    ///      for this nonce because isExecutable requires status Committed: commit → execute → reveal.
    function reveal(uint256 id, uint64 nonce, Signal calldata signal, bytes32 salt) external {
        Commit storage c = _commits[id][nonce];
        if (c.status != Status.Committed) revert NotCommitted();
        if (block.timestamp > c.revealDeadline) revert DeadlinePassed();
        if (hashSignal(id, nonce, signal, salt) != c.hash) revert HashMismatch();

        c.status = Status.Revealed;
        _strategies[id].revealCount += 1;

        emit Revealed(id, nonce, signal.tokenIn, signal.tokenOut, signal.sizeBps, signal.promptHash, salt);
    }

    /// @inheritdoc ISignalRegistry
    function markMissed(uint256 id, uint64 nonce) external {
        Commit storage c = _commits[id][nonce];
        if (c.status != Status.Committed) revert NotCommitted();
        if (block.timestamp <= c.revealDeadline) revert DeadlineNotPassed();

        c.status = Status.Missed;
        _strategies[id].missedCount += 1;

        emit Missed(id, nonce);
    }

    // ------------------------------------------------------------------ views

    /// @inheritdoc ISignalRegistry
    function hashSignal(uint256 id, uint64 nonce, Signal calldata signal, bytes32 salt) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), id, nonce, signal, salt));
    }

    /// @inheritdoc ISignalRegistry
    /// @dev False in the commit's own L2 block, after reveal, after the deadline, and for Missed/None.
    function isExecutable(uint256 id, uint64 nonce) external view returns (bool) {
        Commit storage c = _commits[id][nonce];
        return
            c.status == Status.Committed && block.timestamp <= c.revealDeadline
                && L2Block.current() > c.committedL2Block;
    }

    /// @inheritdoc ISignalRegistry
    function strategyOf(uint256 id) external view returns (Strategy memory) {
        if (id == 0 || id > _strategyCount) revert UnknownStrategy();
        return _strategies[id];
    }

    /// @inheritdoc ISignalRegistry
    function commitOf(uint256 id, uint64 nonce) external view returns (Commit memory) {
        return _commits[id][nonce];
    }

    /// @inheritdoc ISignalRegistry
    function creatorOf(uint256 id) external view returns (address) {
        if (id == 0 || id > _strategyCount) revert UnknownStrategy();
        return _strategies[id].creator;
    }

    /// @inheritdoc ISignalRegistry
    function creatorShareOf(uint256 id) external view returns (uint16) {
        if (id == 0 || id > _strategyCount) revert UnknownStrategy();
        return _strategies[id].creatorShareBps;
    }

    /// @inheritdoc ISignalRegistry
    /// @dev Unknown ids are simply not active (no revert), so vaults get a clean "inactive" answer.
    function isActive(uint256 id) external view returns (bool) {
        return _strategies[id].active;
    }

    /// @inheritdoc ISignalRegistry
    function strategyCount() external view returns (uint256) {
        return _strategyCount;
    }
}
