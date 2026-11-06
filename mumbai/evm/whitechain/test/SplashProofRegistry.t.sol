// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SplashProofRegistry} from "../src/SplashProofRegistry.sol";

contract SplashProofRegistryTest is Test {
    SplashProofRegistry internal reg;

    address internal admin = address(0xA11CE);
    address internal recorder = address(0xBEEF);
    address internal stranger = address(0xDEAD);

    bytes32 internal constant C_ARC = 0x9dc8d5d0d1fc026cb5f53bde2d1e759274def1641c67c244649cd7cab3a0cded;
    bytes32 internal constant C_WC = 0x2b0f0602b2e293b6904a809853700a0ceb6fb7e72f434d1c7e5978312fba44a5;
    bytes32 internal constant REF = keccak256("SPL-MUM-A-0001");

    function setUp() public {
        reg = new SplashProofRegistry(admin);
        vm.prank(admin);
        reg.setRecorder(recorder, true);
    }

    function _recordArc(bytes32 commitment) internal {
        vm.prank(recorder);
        reg.record(commitment, REF, SplashProofRegistry.Rail.ArcEscrow, 5042002, keccak256("arc-tx"), 10_000_000, 100_000);
    }

    function test_recordsAProofAndReadsItBack() public {
        _recordArc(C_ARC);
        SplashProofRegistry.Entry memory e = reg.entry(C_ARC);
        assertEq(e.travelRuleCommitment, C_ARC);
        assertEq(e.paymentRef, REF);
        assertEq(uint8(e.rail), uint8(SplashProofRegistry.Rail.ArcEscrow));
        assertEq(e.sourceChainId, 5042002);
        assertEq(e.amount, 10_000_000);
        assertEq(e.feeCharged, 100_000);
        assertEq(e.recorder, recorder);
        assertTrue(reg.isRecorded(C_ARC));
        assertEq(reg.total(), 1);
    }

    /// The registry is the whole-business view: rails land side by side.
    function test_holdsProofsFromDifferentRails() public {
        _recordArc(C_ARC);
        vm.prank(recorder);
        reg.record(C_WC, keccak256("INV-1"), SplashProofRegistry.Rail.WhitechainInvoice, 2625, keccak256("wc-tx"), 100_000_000, 150_000);
        assertEq(reg.total(), 2);
        assertEq(uint8(reg.entry(C_WC).rail), uint8(SplashProofRegistry.Rail.WhitechainInvoice));
        assertEq(reg.totalFeesRecorded(), 250_000, "fees across rails add up");
    }

    /// A replayed proof must not inflate the count or the fee total.
    function test_refusesADuplicateCommitment() public {
        _recordArc(C_ARC);
        vm.prank(recorder);
        vm.expectRevert(abi.encodeWithSelector(SplashProofRegistry.AlreadyRecorded.selector, C_ARC));
        reg.record(C_ARC, REF, SplashProofRegistry.Rail.ArcEscrow, 5042002, keccak256("other-tx"), 1, 1);
        assertEq(reg.total(), 1);
    }

    function test_onlyARecorderMayWrite() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SplashProofRegistry.NotRecorder.selector, stranger));
        reg.record(C_ARC, REF, SplashProofRegistry.Rail.ArcEscrow, 5042002, bytes32(0), 1, 0);
    }

    function test_onlyAdminManagesRecorders() public {
        vm.prank(stranger);
        vm.expectRevert(SplashProofRegistry.NotAdmin.selector);
        reg.setRecorder(stranger, true);
    }

    function test_revokedRecorderCannotWrite() public {
        vm.prank(admin);
        reg.setRecorder(recorder, false);
        vm.prank(recorder);
        vm.expectRevert(abi.encodeWithSelector(SplashProofRegistry.NotRecorder.selector, recorder));
        reg.record(C_ARC, REF, SplashProofRegistry.Rail.ArcEscrow, 5042002, bytes32(0), 1, 0);
    }

    function test_refusesEmptyCommitmentAndUnknownRail() public {
        vm.startPrank(recorder);
        vm.expectRevert(SplashProofRegistry.ZeroCommitment.selector);
        reg.record(bytes32(0), REF, SplashProofRegistry.Rail.ArcEscrow, 5042002, bytes32(0), 1, 0);
        vm.expectRevert(SplashProofRegistry.UnknownRail.selector);
        reg.record(C_ARC, REF, SplashProofRegistry.Rail.Unknown, 5042002, bytes32(0), 1, 0);
        vm.stopPrank();
    }

    function test_pagingCoversEverythingAndStopsAtTheEnd() public {
        for (uint256 i = 1; i <= 5; i++) {
            vm.prank(recorder);
            reg.record(bytes32(i), REF, SplashProofRegistry.Rail.SuiAnchor, 101, bytes32(0), i, i);
        }
        assertEq(reg.page(0, 5).length, 5);
        assertEq(reg.page(3, 10).length, 2, "a limit past the end returns what is left");
        assertEq(reg.page(99, 10).length, 0, "an offset past the end returns nothing");
        assertEq(reg.page(0, 5)[0], bytes32(uint256(1)), "oldest first");
    }

    /// However many proofs land, the fee total is the sum of the rows and
    /// nothing else: the number an auditor reconciles against the rails.
    function testFuzz_feeTotalIsTheSumOfRows(uint8 n, uint64 feeEach) public {
        n = uint8(bound(n, 1, 25));
        vm.assume(feeEach > 0);
        for (uint256 i = 1; i <= n; i++) {
            vm.prank(recorder);
            reg.record(bytes32(i), REF, SplashProofRegistry.Rail.ArcEscrow, 5042002, bytes32(0), 1000, feeEach);
        }
        assertEq(reg.total(), n);
        assertEq(reg.totalFeesRecorded(), uint256(n) * feeEach);
    }
}
