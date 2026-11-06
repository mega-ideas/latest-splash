// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/Test.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {CCIPReceiver} from "@chainlink/contracts-ccip/contracts/applications/CCIPReceiver.sol";
import {SplashProofEscrow} from "../SplashProofEscrow.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {SplashProofEscrowBase} from "./SplashProofEscrow.Base.t.sol";

contract SplashProofEscrowCcipTest is SplashProofEscrowBase {
    SplashProofEscrow.Status internal constant OPEN = SplashProofEscrow.Status.Open;
    SplashProofEscrow.Status internal constant RELEASED = SplashProofEscrow.Status.Released;
    SplashProofEscrow.Status internal constant REFUNDED = SplashProofEscrow.Status.Refunded;

    function _expectReject(bytes32 ref, SplashProofEscrow.RejectReason r) internal {
        vm.expectEmit(true, true, false, true, address(escrow));
        emit SplashProofEscrow.AckRejected(ref, MSG_ID, r);
    }

    // ------------------------------------------------------------ (1) happy path
    function test_ccipHappyPath_releasesNetAndFee() public {
        _open(REF, true);
        assertEq(usdc.balanceOf(address(escrow)), AMOUNT);

        vm.expectEmit(true, true, true, true, address(escrow));
        emit SplashProofEscrow.Released(REF, MSG_ID, recipient, NET, FEE, ACK_HASH, COMMIT);
        _ackOk();

        assertEq(uint8(_status(REF)), uint8(RELEASED));
        assertEq(usdc.balanceOf(recipient), NET);
        assertEq(usdc.balanceOf(feeRecipient), FEE);
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(NET + FEE, AMOUNT);
    }

    function test_ccipHappyPath_feeCappedByMaxFee() public {
        _openWith(escrow, REF, recipient, AMOUNT, 1e6, expiry, true);
        _ackOk();
        assertEq(usdc.balanceOf(feeRecipient), 1e6);
        assertEq(usdc.balanceOf(recipient), AMOUNT - 1e6);
    }

    function test_ccipHappyPath_zeroMaxFeeMeansNoFee() public {
        _openWith(escrow, REF, recipient, AMOUNT, 0, expiry, true);
        _ackOk();
        assertEq(usdc.balanceOf(feeRecipient), 0);
        assertEq(usdc.balanceOf(recipient), AMOUNT);
    }

    function test_ccipIgnoresDestTokenAmounts() public {
        _open(REF, true);
        Client.Any2EVMMessage memory m = _stdMsg(REF, vasp, COMMIT);
        m.destTokenAmounts = new Client.EVMTokenAmount[](1);
        m.destTokenAmounts[0] = Client.EVMTokenAmount({token: USDC_ADDR, amount: 123});
        _deliver(m);
        assertEq(uint8(_status(REF)), uint8(RELEASED));
        assertEq(usdc.balanceOf(recipient), NET);
    }

    function test_ccipSettleGasFigures() public {
        _open(REF, true);
        Client.Any2EVMMessage memory m = _stdMsg(REF, vasp, COMMIT);
        vm.prank(ROUTER);
        uint256 g = gasleft();
        escrow.ccipReceive(m);
        g -= gasleft();
        console2.log("ccipReceive settle (fee>0, 2 transfers) gas:", g);

        bytes32 ref2 = keccak256("ref2");
        _openWith(escrow, ref2, recipient, AMOUNT, 0, expiry, true);
        m = _stdMsg(ref2, vasp, COMMIT);
        vm.prank(ROUTER);
        g = gasleft();
        escrow.ccipReceive(m);
        g -= gasleft();
        console2.log("ccipReceive settle (fee==0, 1 transfer) gas:", g);

        // Rejection and failed-transfer paths for reference.
        bytes32 ref3 = keccak256("ref3");
        _open(ref3, true);
        usdc.setBlocked(recipient, true);
        m = _stdMsg(ref3, vasp, COMMIT);
        vm.prank(ROUTER);
        g = gasleft();
        escrow.ccipReceive(m);
        g -= gasleft();
        console2.log("ccipReceive TransferFailed path gas:", g);
        assertEq(uint8(_status(ref3)), uint8(OPEN));
    }

    // ------------------------------------------------------------ (2) authentication
    function test_Revert_wrongSourceChain() public {
        _open(REF, true);
        Client.Any2EVMMessage memory m = _msg(MSG_ID, OTHER_SRC, abi.encode(ackSender), _data(REF, vasp, COMMIT, ACK_HASH));
        vm.expectRevert(abi.encodeWithSelector(SplashProofEscrow.AckSenderNotConfigured.selector, OTHER_SRC));
        _deliver(m);
        assertEq(uint8(_status(REF)), uint8(OPEN));
    }

    function test_Revert_sameSenderOnOtherChainConfiguredToDifferentSender() public {
        address other = makeAddr("otherSender");
        vm.prank(owner);
        escrow.setAckSender(OTHER_SRC, other);
        Client.Any2EVMMessage memory m = _msg(MSG_ID, OTHER_SRC, abi.encode(ackSender), _data(REF, vasp, COMMIT, ACK_HASH));
        vm.expectRevert(abi.encodeWithSelector(SplashProofEscrow.UnauthorizedAckSender.selector, ackSender));
        _deliver(m);
    }

    function test_Revert_wrongSender() public {
        _open(REF, true);
        address bad = makeAddr("attacker");
        Client.Any2EVMMessage memory m = _msg(MSG_ID, SRC, abi.encode(bad), _data(REF, vasp, COMMIT, ACK_HASH));
        vm.expectRevert(abi.encodeWithSelector(SplashProofEscrow.UnauthorizedAckSender.selector, bad));
        _deliver(m);
        assertEq(uint8(_status(REF)), uint8(OPEN));
    }

    function test_Revert_zeroSenderNeverMatchesUnset() public {
        // Sender configured then disabled with address(0): chain is treated as unconfigured.
        vm.prank(owner);
        escrow.setAckSender(SRC, address(0));
        Client.Any2EVMMessage memory m = _msg(MSG_ID, SRC, abi.encode(address(0)), _data(REF, vasp, COMMIT, ACK_HASH));
        vm.expectRevert(abi.encodeWithSelector(SplashProofEscrow.AckSenderNotConfigured.selector, SRC));
        _deliver(m);
    }

    function test_Revert_unsetChainWithNoConfig() public {
        Client.Any2EVMMessage memory m = _msg(MSG_ID, 12345, abi.encode(ackSender), _data(REF, vasp, COMMIT, ACK_HASH));
        vm.expectRevert(abi.encodeWithSelector(SplashProofEscrow.AckSenderNotConfigured.selector, uint64(12345)));
        _deliver(m);
    }

    function test_Revert_nonRouterCaller() public {
        _open(REF, true);
        Client.Any2EVMMessage memory m = _stdMsg(REF, vasp, COMMIT);
        address[3] memory callers = [alice, owner, ackSender];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(CCIPReceiver.InvalidRouter.selector, callers[i]));
            escrow.ccipReceive(m);
        }
        assertEq(uint8(_status(REF)), uint8(OPEN));
    }

    function test_Revert_malformedSenderBytes() public {
        bytes memory data = _data(REF, vasp, COMMIT, ACK_HASH);
        // 20-byte packed address
        vm.expectRevert(SplashProofEscrow.MalformedAckSender.selector);
        _deliver(_msg(MSG_ID, SRC, abi.encodePacked(ackSender), data));
        // empty
        vm.expectRevert(SplashProofEscrow.MalformedAckSender.selector);
        _deliver(_msg(MSG_ID, SRC, "", data));
        // 64 bytes
        vm.expectRevert(SplashProofEscrow.MalformedAckSender.selector);
        _deliver(_msg(MSG_ID, SRC, abi.encode(ackSender, ackSender), data));
        // 31 bytes
        vm.expectRevert(SplashProofEscrow.MalformedAckSender.selector);
        _deliver(_msg(MSG_ID, SRC, new bytes(31), data));
        // dirty high bits: valid low 160 bits, extra bit 160 set
        uint256 dirty = uint256(uint160(ackSender)) | (uint256(1) << 160);
        vm.expectRevert(SplashProofEscrow.MalformedAckSender.selector);
        _deliver(_msg(MSG_ID, SRC, abi.encode(dirty), data));
    }

    // ------------------------------------------------------------ (3) late ack / expiry
    function test_lateAck_doesNotRevert_rejectsExpired_refundStillFull() public {
        _open(REF, true);
        vm.warp(expiry); // block.timestamp >= expiry
        _expectReject(REF, SplashProofEscrow.RejectReason.Expired);
        _ackOk();

        assertEq(uint8(_status(REF)), uint8(OPEN));
        assertEq(usdc.balanceOf(address(escrow)), AMOUNT);
        assertEq(usdc.balanceOf(recipient), 0);
        assertEq(usdc.balanceOf(feeRecipient), 0);

        uint256 payerBefore = usdc.balanceOf(payer);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit SplashProofEscrow.Refunded(REF, payer, AMOUNT);
        escrow.refund(REF);
        assertEq(usdc.balanceOf(payer), payerBefore + AMOUNT);
        assertEq(usdc.balanceOf(feeRecipient), 0, "no fee on refund");
        assertEq(uint8(_status(REF)), uint8(REFUNDED));
    }

    function test_ackOneSecondBeforeExpirySettles() public {
        _open(REF, true);
        vm.warp(expiry - 1);
        _ackOk();
        assertEq(uint8(_status(REF)), uint8(RELEASED));
        vm.expectRevert(abi.encodeWithSelector(SplashProofEscrow.PaymentNotOpen.selector, REF));
        escrow.refund(REF);
    }

    // ------------------------------------------------------------ (4) duplicate delivery
    function test_duplicateDelivery_isNoOp() public {
        _open(REF, true);
        _ackOk();
        uint256 rBal = usdc.balanceOf(recipient);
        uint256 fBal = usdc.balanceOf(feeRecipient);
        uint256 eBal = usdc.balanceOf(address(escrow));

        _expectReject(REF, SplashProofEscrow.RejectReason.NotOpen);
        _ackOk();

        assertEq(usdc.balanceOf(recipient), rBal);
        assertEq(usdc.balanceOf(feeRecipient), fBal);
        assertEq(usdc.balanceOf(address(escrow)), eBal);
        assertEq(uint8(_status(REF)), uint8(RELEASED));
    }

    function test_unknownRefAndRefundedRef_areNotOpen() public {
        _expectReject(keccak256("unknown"), SplashProofEscrow.RejectReason.NotOpen);
        _deliver(_stdMsg(keccak256("unknown"), vasp, COMMIT));

        _open(REF, true);
        vm.warp(expiry);
        escrow.refund(REF);
        _expectReject(REF, SplashProofEscrow.RejectReason.NotOpen);
        _ackOk();
        assertEq(uint8(_status(REF)), uint8(REFUNDED));
    }

    // ------------------------------------------------------------ (5) rejections keep payment open
    function test_vaspMismatch_rejects_staysOpen() public {
        _open(REF, true);
        _expectReject(REF, SplashProofEscrow.RejectReason.VaspMismatch);
        _deliver(_stdMsg(REF, alice, COMMIT));
        assertEq(uint8(_status(REF)), uint8(OPEN));
        assertEq(usdc.balanceOf(address(escrow)), AMOUNT);
        // correct ack still works afterwards
        _ackOk();
        assertEq(uint8(_status(REF)), uint8(RELEASED));
    }

    function test_commitmentMismatch_rejects_staysOpen() public {
        _open(REF, true);
        _expectReject(REF, SplashProofEscrow.RejectReason.CommitmentMismatch);
        _deliver(_stdMsg(REF, vasp, keccak256("wrong")));
        assertEq(uint8(_status(REF)), uint8(OPEN));
        assertEq(usdc.balanceOf(address(escrow)), AMOUNT);
    }

    function test_notRemoteAck_rejects_staysOpen() public {
        _open(REF, false);
        _expectReject(REF, SplashProofEscrow.RejectReason.NotRemoteAck);
        _ackOk();
        assertEq(uint8(_status(REF)), uint8(OPEN));
        assertEq(usdc.balanceOf(address(escrow)), AMOUNT);
    }

    function test_malformedData_wrongLength_rejects() public {
        _open(REF, true);
        bytes[3] memory bad = [bytes(""), abi.encode(REF, vasp, COMMIT), abi.encodePacked(abi.encode(REF, vasp, COMMIT, ACK_HASH), uint8(1))];
        for (uint256 i; i < bad.length; ++i) {
            vm.expectEmit(true, true, false, true, address(escrow));
            emit SplashProofEscrow.AckRejected(bytes32(0), MSG_ID, SplashProofEscrow.RejectReason.Malformed);
            _deliver(_msg(MSG_ID, SRC, abi.encode(ackSender), bad[i]));
        }
        assertEq(uint8(_status(REF)), uint8(OPEN));
    }

    function test_malformedData_dirtyVaspWord_rejects() public {
        _open(REF, true);
        uint256 dirty = uint256(uint160(vasp)) | (uint256(1) << 200);
        bytes memory data = abi.encode(REF, dirty, COMMIT, ACK_HASH);
        _expectReject(REF, SplashProofEscrow.RejectReason.Malformed);
        _deliver(_msg(MSG_ID, SRC, abi.encode(ackSender), data));
        assertEq(uint8(_status(REF)), uint8(OPEN));
    }

    // ------------------------------------------------------------ (8) blocklist
    function _logsFrom(Vm.Log[] memory logs, address who) internal pure returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == who) ++n;
        }
    }

    function test_blockedRecipient_ccip_rejectsTransferFailed_refundWorks() public {
        _openWith(escrow, REF, BLOCKED_RECIPIENT, AMOUNT, MAX_FEE, expiry, true);
        usdc.setBlocked(BLOCKED_RECIPIENT, true);

        vm.recordLogs();
        _expectReject(REF, SplashProofEscrow.RejectReason.TransferFailed);
        _ackOk();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        // The AckRejected is the only log from escrow; no Released and no token Transfer logs.
        assertEq(_logsFrom(logs, address(escrow)), 1);
        assertEq(_logsFrom(logs, USDC_ADDR), 0, "no token transfer logs survive");

        assertEq(uint8(_status(REF)), uint8(OPEN));
        assertEq(usdc.balanceOf(address(escrow)), AMOUNT);
        assertEq(usdc.balanceOf(BLOCKED_RECIPIENT), 0);
        assertEq(usdc.balanceOf(feeRecipient), 0);

        vm.warp(expiry);
        uint256 payerBefore = usdc.balanceOf(payer);
        escrow.refund(REF);
        assertEq(usdc.balanceOf(payer), payerBefore + AMOUNT);
        assertEq(uint8(_status(REF)), uint8(REFUNDED));
    }

    function test_blockedRecipient_ackLocal_reverts() public {
        _openWith(escrow, REF, BLOCKED_RECIPIENT, AMOUNT, MAX_FEE, expiry, false);
        usdc.setBlocked(BLOCKED_RECIPIENT, true);
        vm.prank(vasp);
        vm.expectRevert(abi.encodeWithSelector(MockUSDC.Blocked.selector, BLOCKED_RECIPIENT));
        escrow.ackLocal(REF, COMMIT, ACK_HASH);
        assertEq(uint8(_status(REF)), uint8(OPEN));
        assertEq(usdc.balanceOf(address(escrow)), AMOUNT);
    }

    function test_blockedFeeRecipient_ccip_rejects_noPartialTransfer() public {
        _open(REF, true);
        usdc.setBlocked(feeRecipient, true);
        _expectReject(REF, SplashProofEscrow.RejectReason.TransferFailed);
        _ackOk();
        assertEq(uint8(_status(REF)), uint8(OPEN));
        // net transfer to recipient was rolled back together with the failed fee transfer
        assertEq(usdc.balanceOf(recipient), 0);
        assertEq(usdc.balanceOf(feeRecipient), 0);
        assertEq(usdc.balanceOf(address(escrow)), AMOUNT);

        vm.warp(expiry);
        escrow.refund(REF);
        assertEq(uint8(_status(REF)), uint8(REFUNDED));
    }

    function test_blockedFeeRecipient_ackLocal_reverts() public {
        _open(REF, false);
        usdc.setBlocked(feeRecipient, true);
        vm.prank(vasp);
        vm.expectRevert(abi.encodeWithSelector(MockUSDC.Blocked.selector, feeRecipient));
        escrow.ackLocal(REF, COMMIT, ACK_HASH);
        assertEq(uint8(_status(REF)), uint8(OPEN));
    }

    function test_blockedFeeRecipient_withZeroFee_stillSettles() public {
        _openWith(escrow, REF, recipient, AMOUNT, 0, expiry, true);
        usdc.setBlocked(feeRecipient, true);
        _ackOk();
        assertEq(uint8(_status(REF)), uint8(RELEASED));
        assertEq(usdc.balanceOf(recipient), AMOUNT);
    }

    function test_blockedRecipient_redeliveryAfterUnblockSettles() public {
        _open(REF, true);
        usdc.setBlocked(recipient, true);
        _expectReject(REF, SplashProofEscrow.RejectReason.TransferFailed);
        _ackOk();
        usdc.setBlocked(recipient, false);
        _ackOk();
        assertEq(uint8(_status(REF)), uint8(RELEASED));
        assertEq(usdc.balanceOf(recipient), NET);
    }

    function test_blockedPayer_refundReverts_untilUnblocked() public {
        _open(REF, true);
        usdc.setBlocked(payer, true);
        vm.warp(expiry);
        vm.expectRevert(abi.encodeWithSelector(MockUSDC.Blocked.selector, payer));
        escrow.refund(REF);
        assertEq(uint8(_status(REF)), uint8(OPEN));
        usdc.setBlocked(payer, false);
        escrow.refund(REF);
        assertEq(uint8(_status(REF)), uint8(REFUNDED));
    }
}
