// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {SignalRegistry} from "../../src/SignalRegistry.sol";
import {ISignalRegistry} from "../../src/interfaces/ISignalRegistry.sol";

contract RegistryHandler is Test {
    SignalRegistry public reg;
    uint256 public id;
    address public signer = address(0x5161);
    string public violation;

    struct C {
        uint64 nonce;
        bytes32 salt;
        ISignalRegistry.Signal s;
        bytes32 hash;
    }

    C[] internal commits;
    mapping(uint64 => uint8) public lastStatus;
    uint64 public lastMissedCount;

    constructor(SignalRegistry r, uint256 id_) {
        reg = r;
        id = id_;
    }

    function _flag(string memory w) internal {
        if (bytes(violation).length == 0) violation = w;
    }

    function commit(bytes32 salt, uint16 size) external {
        ISignalRegistry.Signal memory s = ISignalRegistry.Signal(address(0x1), address(0x2), size, bytes32(0));
        uint64 next = reg.strategyOf(id).commitCount;
        bytes32 h = reg.hashSignal(id, next, s, salt);
        vm.prank(signer);
        uint64 n = reg.commit(id, h);
        if (n != next) _flag("nonce");
        if (reg.isExecutable(id, n)) _flag("executable in commit block"); // inv 3
        commits.push(C(n, salt, s, h));
        lastStatus[n] = uint8(ISignalRegistry.Status.Committed);
    }

    function reveal(uint256 i, bool tamper) external {
        if (commits.length == 0) return;
        C memory c = commits[i % commits.length];
        bytes32 salt = tamper ? bytes32(uint256(c.salt) ^ 1) : c.salt;
        ISignalRegistry.Commit memory before = reg.commitOf(id, c.nonce);
        try reg.reveal(id, c.nonce, c.s, salt) {
            // inv 1: only exact preimage, only before the deadline, only from Committed
            if (tamper) _flag("revealed with wrong preimage");
            if (block.timestamp > before.revealDeadline) _flag("revealed after deadline");
            if (before.status != ISignalRegistry.Status.Committed) _flag("revealed terminal commit");
            if (reg.isExecutable(id, c.nonce)) _flag("executable after reveal");
        } catch {}
    }

    function markMissed(uint256 i) external {
        if (commits.length == 0) return;
        C memory c = commits[i % commits.length];
        try reg.markMissed(id, c.nonce) {
            if (reg.isExecutable(id, c.nonce)) _flag("executable after missed");
        } catch {}
    }

    function warp(uint256 s) external {
        vm.warp(block.timestamp + bound(s, 1, 3 hours));
        vm.roll(vm.getBlockNumber() + 1);
    }

    /// @dev Checks terminal statuses and monotonic counters across steps.
    function sweep() external {
        for (uint256 k; k < commits.length; ++k) {
            ISignalRegistry.Commit memory c = reg.commitOf(id, commits[k].nonce);
            uint8 prev = lastStatus[commits[k].nonce];
            uint8 now_ = uint8(c.status);
            if (c.hash != commits[k].hash) _flag("commit hash changed / deleted"); // inv 2
            if (prev >= uint8(ISignalRegistry.Status.Revealed) && now_ != prev) _flag("terminal status changed");
            if (now_ == uint8(ISignalRegistry.Status.None)) _flag("commit deleted");
            lastStatus[commits[k].nonce] = now_;
            if (block.timestamp > c.revealDeadline && reg.isExecutable(id, commits[k].nonce)) {
                _flag("executable after deadline");
            }
        }
        uint64 missed = reg.strategyOf(id).missedCount;
        if (missed < lastMissedCount) _flag("missedCount decreased");
        lastMissedCount = missed;
    }

    function commitCount() external view returns (uint256) {
        return commits.length;
    }
}

/// @dev CONTRACTS.md §5 registry invariants 1–3.
contract RegistryInvariantTest is Test {
    SignalRegistry internal reg;
    RegistryHandler internal handler;

    function setUp() public {
        vm.warp(1_800_000_000);
        vm.roll(10);
        reg = new SignalRegistry();
        handler = new RegistryHandler(reg, 0);
        uint256 id = reg.registerStrategy(handler.signer(), 1000, 10 minutes, bytes32(0), "s");
        handler = new RegistryHandler(reg, id);
        targetContract(address(handler));
    }

    function invariant_registry() public view {
        assertEq(handler.violation(), "", handler.violation());
    }

    function invariant_countsConsistent() public view {
        ISignalRegistry.Strategy memory s = reg.strategyOf(1);
        assertEq(s.commitCount, handler.commitCount());
        assertLe(uint256(s.revealCount) + s.missedCount, s.commitCount);
    }
}
