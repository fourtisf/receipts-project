// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {SignalRegistry} from "../src/SignalRegistry.sol";
import {ISignalRegistry} from "../src/interfaces/ISignalRegistry.sol";
import {MockArbSys} from "./mocks/MockArbSys.sol";

contract SignalRegistryTest is Test {
    SignalRegistry internal reg;
    address internal creator = makeAddr("creator");
    address internal signer = makeAddr("signer");
    address internal other = makeAddr("other");
    uint256 internal id;

    event StrategyRegistered(
        uint256 indexed id,
        address indexed creator,
        address signer,
        uint16 creatorShareBps,
        uint32 revealWindow,
        bytes32 modelHash,
        string metadataURI
    );
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

    function setUp() public {
        vm.warp(1_800_000_000);
        vm.roll(100);
        reg = new SignalRegistry();
        vm.prank(creator);
        id = reg.registerStrategy(signer, 2000, 1 hours, bytes32(0), "ipfs://s1");
    }

    function _sig() internal pure returns (ISignalRegistry.Signal memory) {
        return ISignalRegistry.Signal({
            tokenIn: address(0x1111), tokenOut: address(0x2222), sizeBps: 5000, promptHash: keccak256("prompt")
        });
    }

    function _commit(bytes32 salt) internal returns (uint64 nonce, bytes32 h) {
        uint64 next = reg.strategyOf(id).commitCount;
        h = reg.hashSignal(id, next, _sig(), salt);
        vm.prank(signer);
        nonce = reg.commit(id, h);
    }

    // ------------------------------------------------------------------ constants

    function test_constants() public view {
        assertEq(reg.MAX_CREATOR_SHARE_BPS(), 3000);
        assertEq(reg.MIN_REVEAL_WINDOW(), 10 minutes);
        assertEq(reg.MAX_REVEAL_WINDOW(), 24 hours);
    }

    // ------------------------------------------------------------------ register

    function test_register_storesStrategy() public view {
        ISignalRegistry.Strategy memory s = reg.strategyOf(id);
        assertEq(id, 1);
        assertEq(s.creator, creator);
        assertEq(s.signer, signer);
        assertEq(s.creatorShareBps, 2000);
        assertEq(s.revealWindow, 1 hours);
        assertTrue(s.active);
        assertEq(s.modelHash, bytes32(0));
        assertEq(s.commitCount, 0);
        assertEq(s.metadataURI, "ipfs://s1");
        assertEq(reg.strategyCount(), 1);
        assertEq(reg.creatorOf(id), creator);
        assertEq(reg.creatorShareOf(id), 2000);
        assertTrue(reg.isActive(id));
    }

    function test_register_emits_andIdsIncrement() public {
        vm.expectEmit(true, true, false, true);
        emit StrategyRegistered(2, other, signer, 3000, 24 hours, keccak256("gpt"), "u");
        vm.prank(other);
        uint256 id2 = reg.registerStrategy(signer, 3000, 24 hours, keccak256("gpt"), "u");
        assertEq(id2, 2);
        assertEq(reg.strategyCount(), 2);
    }

    function test_register_reverts() public {
        vm.expectRevert(ISignalRegistry.ZeroAddress.selector);
        reg.registerStrategy(address(0), 0, 1 hours, 0, "");
        vm.expectRevert(ISignalRegistry.BadShare.selector);
        reg.registerStrategy(signer, 3001, 1 hours, 0, "");
        vm.expectRevert(ISignalRegistry.BadWindow.selector);
        reg.registerStrategy(signer, 0, 10 minutes - 1, 0, "");
        vm.expectRevert(ISignalRegistry.BadWindow.selector);
        reg.registerStrategy(signer, 0, 24 hours + 1, 0, "");
    }

    function testFuzz_register_bounds(uint16 share, uint32 window) public {
        bool ok = share <= 3000 && window >= 10 minutes && window <= 24 hours;
        if (!ok) vm.expectRevert();
        reg.registerStrategy(signer, share, window, 0, "");
    }

    // ------------------------------------------------------------------ creator admin

    function test_setSigner() public {
        vm.prank(creator);
        reg.setSigner(id, other);
        assertEq(reg.strategyOf(id).signer, other);
        vm.prank(creator);
        vm.expectRevert(ISignalRegistry.ZeroAddress.selector);
        reg.setSigner(id, address(0));
        vm.prank(other);
        vm.expectRevert(ISignalRegistry.NotCreator.selector);
        reg.setSigner(id, other);
        vm.prank(creator);
        vm.expectRevert(ISignalRegistry.UnknownStrategy.selector);
        reg.setSigner(99, other);
        vm.expectRevert(ISignalRegistry.UnknownStrategy.selector);
        reg.setSigner(0, other);
    }

    function test_setActive_blocksCommit() public {
        vm.prank(creator);
        reg.setActive(id, false);
        assertFalse(reg.isActive(id));
        vm.prank(signer);
        vm.expectRevert(ISignalRegistry.Inactive.selector);
        reg.commit(id, bytes32(uint256(1)));
        vm.prank(creator);
        reg.setActive(id, true);
        vm.prank(signer);
        reg.commit(id, bytes32(uint256(1)));
        vm.prank(other);
        vm.expectRevert(ISignalRegistry.NotCreator.selector);
        reg.setActive(id, false);
    }

    function test_setMetadataURI() public {
        vm.prank(creator);
        reg.setMetadataURI(id, "ipfs://new");
        assertEq(reg.strategyOf(id).metadataURI, "ipfs://new");
        vm.prank(other);
        vm.expectRevert(ISignalRegistry.NotCreator.selector);
        reg.setMetadataURI(id, "x");
    }

    function test_lowerCreatorShare_onlyDown() public {
        vm.prank(creator);
        reg.lowerCreatorShare(id, 1500);
        assertEq(reg.creatorShareOf(id), 1500);
        vm.prank(creator);
        vm.expectRevert(ISignalRegistry.BadShare.selector);
        reg.lowerCreatorShare(id, 1500);
        vm.prank(creator);
        vm.expectRevert(ISignalRegistry.BadShare.selector);
        reg.lowerCreatorShare(id, 2500);
        vm.prank(other);
        vm.expectRevert(ISignalRegistry.NotCreator.selector);
        reg.lowerCreatorShare(id, 0);
    }

    function testFuzz_lowerCreatorShare(uint16 a, uint16 b) public {
        a = uint16(bound(a, 0, 1999));
        vm.prank(creator);
        reg.lowerCreatorShare(id, a);
        vm.prank(creator);
        if (b >= a) vm.expectRevert(ISignalRegistry.BadShare.selector);
        reg.lowerCreatorShare(id, b);
        assertLe(reg.creatorShareOf(id), a);
    }

    // ------------------------------------------------------------------ commit

    function test_commit_storesAndIncrements() public {
        bytes32 h = keccak256("h0");
        vm.expectEmit(true, true, false, true);
        emit Committed(id, 0, h, uint64(block.timestamp + 1 hours), uint64(block.number));
        vm.prank(signer);
        uint64 n0 = reg.commit(id, h);
        vm.prank(signer);
        uint64 n1 = reg.commit(id, keccak256("h1"));
        assertEq(n0, 0);
        assertEq(n1, 1);
        ISignalRegistry.Commit memory c = reg.commitOf(id, 0);
        assertEq(c.hash, h);
        assertEq(c.committedAt, block.timestamp);
        assertEq(c.committedL2Block, block.number);
        assertEq(c.revealDeadline, block.timestamp + 1 hours);
        assertEq(uint8(c.status), uint8(ISignalRegistry.Status.Committed));
        assertEq(reg.strategyOf(id).commitCount, 2);
    }

    function test_commit_reverts() public {
        vm.prank(other);
        vm.expectRevert(ISignalRegistry.NotSigner.selector);
        reg.commit(id, bytes32(0));
        vm.prank(creator); // creator is not the signer
        vm.expectRevert(ISignalRegistry.NotSigner.selector);
        reg.commit(id, bytes32(0));
        vm.prank(signer);
        vm.expectRevert(ISignalRegistry.UnknownStrategy.selector);
        reg.commit(7, bytes32(0));
        vm.prank(signer);
        vm.expectRevert(ISignalRegistry.UnknownStrategy.selector);
        reg.commit(0, bytes32(0));
    }

    function test_commit_rotatedSignerOnly() public {
        vm.prank(creator);
        reg.setSigner(id, other);
        vm.prank(signer);
        vm.expectRevert(ISignalRegistry.NotSigner.selector);
        reg.commit(id, bytes32(0));
        vm.prank(other);
        reg.commit(id, bytes32(0));
    }

    // ------------------------------------------------------------------ reveal

    function test_reveal_exactPreimage() public {
        (uint64 n,) = _commit(bytes32(uint256(42)));
        ISignalRegistry.Signal memory s = _sig();
        vm.expectEmit(true, true, false, true);
        emit Revealed(id, n, s.tokenIn, s.tokenOut, s.sizeBps, s.promptHash, bytes32(uint256(42)));
        vm.prank(other); // anyone with the preimage
        reg.reveal(id, n, s, bytes32(uint256(42)));
        assertEq(uint8(reg.commitOf(id, n).status), uint8(ISignalRegistry.Status.Revealed));
        assertEq(reg.strategyOf(id).revealCount, 1);
    }

    function test_reveal_wrongPreimageReverts() public {
        (uint64 n,) = _commit(bytes32(uint256(42)));
        ISignalRegistry.Signal memory s = _sig();
        vm.expectRevert(ISignalRegistry.HashMismatch.selector);
        reg.reveal(id, n, s, bytes32(uint256(43)));
        s.sizeBps = 5001;
        vm.expectRevert(ISignalRegistry.HashMismatch.selector);
        reg.reveal(id, n, s, bytes32(uint256(42)));
        s = _sig();
        s.tokenOut = address(0x3333);
        vm.expectRevert(ISignalRegistry.HashMismatch.selector);
        reg.reveal(id, n, s, bytes32(uint256(42)));
        s = _sig();
        s.promptHash = bytes32(0);
        vm.expectRevert(ISignalRegistry.HashMismatch.selector);
        reg.reveal(id, n, s, bytes32(uint256(42)));
    }

    function test_reveal_afterDeadlineReverts() public {
        (uint64 n,) = _commit(bytes32(uint256(1)));
        vm.warp(block.timestamp + 1 hours); // exactly at deadline: allowed
        reg.reveal(id, n, _sig(), bytes32(uint256(1)));
        (uint64 n2,) = _commit(bytes32(uint256(2)));
        vm.warp(block.timestamp + 1 hours + 1);
        vm.expectRevert(ISignalRegistry.DeadlinePassed.selector);
        reg.reveal(id, n2, _sig(), bytes32(uint256(2)));
    }

    function test_reveal_terminal() public {
        (uint64 n,) = _commit(bytes32(uint256(1)));
        reg.reveal(id, n, _sig(), bytes32(uint256(1)));
        vm.expectRevert(ISignalRegistry.NotCommitted.selector);
        reg.reveal(id, n, _sig(), bytes32(uint256(1)));
        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert(ISignalRegistry.NotCommitted.selector);
        reg.markMissed(id, n);
        // unknown nonce
        vm.expectRevert(ISignalRegistry.NotCommitted.selector);
        reg.reveal(id, 99, _sig(), bytes32(uint256(1)));
    }

    function test_hashSignal_bindsChainAndRegistry() public {
        bytes32 h1 = reg.hashSignal(id, 0, _sig(), bytes32(uint256(7)));
        bytes32 expected =
            keccak256(abi.encode(block.chainid, address(reg), id, uint64(0), _sig(), bytes32(uint256(7))));
        assertEq(h1, expected);
        SignalRegistry reg2 = new SignalRegistry();
        assertTrue(reg2.hashSignal(id, 0, _sig(), bytes32(uint256(7))) != h1);
        vm.chainId(1);
        assertTrue(reg.hashSignal(id, 0, _sig(), bytes32(uint256(7))) != h1);
        assertTrue(reg.hashSignal(id, 1, _sig(), bytes32(uint256(7))) != h1);
        assertTrue(reg.hashSignal(id + 1, 0, _sig(), bytes32(uint256(7))) != h1);
    }

    /// @dev Matches the TypeScript mirror in packages/shared (hashSignal): fixed vector shared with vitest.
    function test_hashSignal_vector() public {
        vm.chainId(4663);
        SignalRegistry r = SignalRegistry(address(0x000000000000000000000000000000000000dEaD));
        vm.etch(address(r), address(reg).code);
        ISignalRegistry.Signal memory s = ISignalRegistry.Signal({
            tokenIn: 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168,
            tokenOut: 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73,
            sizeBps: 2500,
            promptHash: bytes32(0)
        });
        bytes32 h = r.hashSignal(3, 17, s, bytes32(uint256(0xabc)));
        assertEq(
            h, keccak256(abi.encode(uint256(4663), address(r), uint256(3), uint64(17), s, bytes32(uint256(0xabc))))
        );
        emit log_named_bytes32("vector", h);
    }

    function testFuzz_reveal_onlyExactPreimage(bytes32 salt, bytes32 wrongSalt, uint16 size, address tIn) public {
        vm.assume(salt != wrongSalt);
        ISignalRegistry.Signal memory s =
            ISignalRegistry.Signal({tokenIn: tIn, tokenOut: address(0x2222), sizeBps: size, promptHash: 0});
        bytes32 h = reg.hashSignal(id, 0, s, salt);
        vm.prank(signer);
        reg.commit(id, h);
        vm.expectRevert(ISignalRegistry.HashMismatch.selector);
        reg.reveal(id, 0, s, wrongSalt);
        reg.reveal(id, 0, s, salt);
        assertEq(uint8(reg.commitOf(id, 0).status), uint8(ISignalRegistry.Status.Revealed));
    }

    // ------------------------------------------------------------------ missed

    function test_markMissed() public {
        (uint64 n,) = _commit(bytes32(uint256(1)));
        vm.expectRevert(ISignalRegistry.DeadlineNotPassed.selector);
        reg.markMissed(id, n);
        vm.warp(block.timestamp + 1 hours);
        vm.expectRevert(ISignalRegistry.DeadlineNotPassed.selector);
        reg.markMissed(id, n);
        vm.warp(block.timestamp + 1);
        vm.expectEmit(true, true, false, false);
        emit Missed(id, n);
        vm.prank(other);
        reg.markMissed(id, n);
        assertEq(uint8(reg.commitOf(id, n).status), uint8(ISignalRegistry.Status.Missed));
        assertEq(reg.strategyOf(id).missedCount, 1);
        // terminal
        vm.expectRevert(ISignalRegistry.NotCommitted.selector);
        reg.markMissed(id, n);
        vm.expectRevert(ISignalRegistry.NotCommitted.selector);
        reg.reveal(id, n, _sig(), bytes32(uint256(1)));
        vm.expectRevert(ISignalRegistry.NotCommitted.selector);
        reg.markMissed(id, 50);
    }

    // ------------------------------------------------------------------ isExecutable

    function test_isExecutable_lifecycle() public {
        (uint64 n,) = _commit(bytes32(uint256(1)));
        assertFalse(reg.isExecutable(id, n), "same L2 block");
        vm.roll(vm.getBlockNumber() + 1);
        assertTrue(reg.isExecutable(id, n), "next block");
        vm.warp(block.timestamp + 1 hours);
        assertTrue(reg.isExecutable(id, n), "at deadline");
        vm.warp(block.timestamp + 1);
        assertFalse(reg.isExecutable(id, n), "after deadline");
        reg.markMissed(id, n);
        assertFalse(reg.isExecutable(id, n), "missed");
        assertFalse(reg.isExecutable(id, 999), "unknown");
    }

    function test_isExecutable_falseAfterReveal() public {
        (uint64 n,) = _commit(bytes32(uint256(1)));
        vm.roll(vm.getBlockNumber() + 1);
        reg.reveal(id, n, _sig(), bytes32(uint256(1)));
        assertFalse(reg.isExecutable(id, n));
    }

    function test_l2Block_usesArbSysWhenPresent() public {
        MockArbSys impl = new MockArbSys();
        vm.etch(address(100), address(impl).code);
        MockArbSys(address(100)).setL2Block(5_000_000);
        (uint64 n,) = _commit(bytes32(uint256(1)));
        assertEq(reg.commitOf(id, n).committedL2Block, 5_000_000);
        vm.roll(block.number + 10); // L1 block moves, L2 does not
        assertFalse(reg.isExecutable(id, n));
        MockArbSys(address(100)).setL2Block(5_000_001);
        assertTrue(reg.isExecutable(id, n));
    }

    function test_l2Block_fallsBackOnInvalidOpcode() public {
        vm.etch(address(100), hex"fe"); // ArbSys placeholder code without the precompile (anvil)
        (uint64 n,) = _commit(bytes32(uint256(1)));
        assertEq(reg.commitOf(id, n).committedL2Block, block.number);
        vm.roll(vm.getBlockNumber() + 1);
        assertTrue(reg.isExecutable(id, n));
    }

    function test_l2Block_fallsBackOnZero() public {
        MockArbSys impl = new MockArbSys();
        vm.etch(address(100), address(impl).code); // returns 0
        (uint64 n,) = _commit(bytes32(uint256(1)));
        assertEq(reg.commitOf(id, n).committedL2Block, block.number);
    }

    // ------------------------------------------------------------------ views on unknown ids

    function test_unknownViews() public {
        vm.expectRevert(ISignalRegistry.UnknownStrategy.selector);
        reg.strategyOf(5);
        vm.expectRevert(ISignalRegistry.UnknownStrategy.selector);
        reg.creatorOf(5);
        vm.expectRevert(ISignalRegistry.UnknownStrategy.selector);
        reg.creatorShareOf(5);
        assertFalse(reg.isActive(5));
        assertEq(uint8(reg.commitOf(5, 0).status), 0);
    }

    function testFuzz_noncesSequential(uint8 count) public {
        count = uint8(bound(count, 1, 40));
        for (uint256 i; i < count; ++i) {
            vm.prank(signer);
            assertEq(reg.commit(id, bytes32(i)), i);
        }
        assertEq(reg.strategyOf(id).commitCount, count);
    }
}
