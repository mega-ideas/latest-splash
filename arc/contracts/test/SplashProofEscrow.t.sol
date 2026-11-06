// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {CCIPReceiver} from "@chainlink/contracts-ccip/contracts/applications/CCIPReceiver.sol";
import {IAny2EVMMessageReceiver} from "@chainlink/contracts-ccip/contracts/interfaces/IAny2EVMMessageReceiver.sol";
import {SplashProofEscrow} from "../SplashProofEscrow.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {SplashProofEscrowBase} from "./SplashProofEscrow.Base.t.sol";

contract SplashProofEscrowTest is SplashProofEscrowBase {
    SplashProofEscrow.Status internal constant OPEN = SplashProofEscrow.Status.Open;
    SplashProofEscrow.Status internal constant RELEASED = SplashProofEscrow.Status.Released;
    SplashProofEscrow.Status internal constant REFUNDED = SplashProofEscrow.Status.Refunded;

    // ------------------------------------------------------------ constructor
    function test_constructor_setsState() public view {
        assertEq(escrow.owner(), owner);
        assertEq(escrow.feeRecipient(), feeRecipient);
        assertEq(escrow.feeBps(), FEE_BPS);
        assertEq(escrow.getRouter(), ROUTER);
        assertEq(address(escrow.USDC()), USDC_ADDR);
        assertEq(escrow.ackSenders(SRC), ackSender);
    }

    function test_Revert_constructor_feeBpsAbove100() public {
        vm.expectRevert(abi.encodeWithSelector(SplashProofEscrow.InvalidFeeBps.selector, uint16(101)));
        new SplashProofEscrow(owner, ROUTER, feeRecipient, 101);
    }

    function test_constructor_feeBps100And0Allowed() public {
        assertEq(new SplashProofEscrow(owner, ROUTER, feeRecipient, 100).feeBps(), 100);
        assertEq(new SplashProofEscrow(owner, ROUTER, feeRecipient, 0).feeBps(), 0);
    }

    function test_Revert_constructor_zeroFeeRecipient() public {
        vm.expectRevert(SplashProofEscrow.ZeroAddress.selector);
        new SplashProofEscrow(owner, ROUTER, address(0), FEE_BPS);
    }

    function test_Revert_constructor_zeroRouterAndZeroAdmin() public {
        vm.expectRevert(abi.encodeWithSelector(CCIPReceiver.InvalidRouter.selector, address(0)));
        new SplashProofEscrow(owner, address(0), feeRecipient, FEE_BPS);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new SplashProofEscrow(address(0), ROUTER, feeRecipient, FEE_BPS);
    }

    // ------------------------------------------------------------ open()
    function test_open_escrowsFullAmount_noFee_emitsEvent() public {
        uint256 payerBefore = usdc.balanceOf(payer);
        vm.expectEmit(true, true, true, true, address(escrow));
        emit SplashProofEscrow.PaymentOpened(REF, payer, recipient, vasp, AMOUNT, MAX_FEE, COMMIT, expiry, true);
        _open(REF, true);

        assertEq(usdc.balanceOf(address(escrow)), AMOUNT);
        assertEq(usdc.balanceOf(payer), payerBefore - AMOUNT);
        assertEq(usdc.balanceOf(feeRecipient), 0, "fee must not be charged on open");
        (address p, address r, address v, uint256 a, uint256 mf, bytes32 c, uint64 e, bool ra, SplashProofEscrow.Status s) =
            escrow.payments(REF);
        assertEq(p, payer);
        assertEq(r, recipient);
        assertEq(v, vasp);
        assertEq(a, AMOUNT);
        assertEq(mf, MAX_FEE);
        assertEq(c, COMMIT);
        assertEq(e, expiry);
        assertTrue(ra);
        assertEq(uint8(s), uint8(OPEN));
    }

    function test_Revert_open_duplicateRef() public {
        _open(REF, true);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(SplashProofEscrow.PaymentRefUsed.selector, REF));
        escrow.open(REF, recipient, vasp, AMOUNT, MAX_FEE, COMMIT, expiry, true);
    }

    function test_Revert_open_refStaysUsedAfterReleaseAndRefund() public {
        bytes32 ref2 = keccak256("ref2");
        _open(REF, false);
        _open(ref2, false);
        vm.prank(vasp);
        escrow.ackLocal(REF, COMMIT, ACK_HASH);
        vm.warp(expiry);
        escrow.refund(ref2);
        uint64 later = uint64(block.timestamp + 1 days);
        vm.startPrank(payer);
        vm.expectRevert(abi.encodeWithSelector(SplashProofEscrow.PaymentRefUsed.selector, REF));
        escrow.open(REF, recipient, vasp, AMOUNT, MAX_FEE, COMMIT, later, false);
        vm.expectRevert(abi.encodeWithSelector(SplashProofEscrow.PaymentRefUsed.selector, ref2));
        escrow.open(ref2, recipient, vasp, AMOUNT, MAX_FEE, COMMIT, later, false);
        vm.stopPrank();
    }

    function test_Revert_open_pastOrCurrentExpiry() public {
        vm.startPrank(payer);
        vm.expectRevert(abi.encodeWithSelector(SplashProofEscrow.InvalidExpiry.selector, uint64(block.timestamp)));
        escrow.open(REF, recipient, vasp, AMOUNT, MAX_FEE, COMMIT, uint64(block.timestamp), true);
        vm.expectRevert(abi.encodeWithSelector(SplashProofEscrow.InvalidExpiry.selector, uint64(1)));
        escrow.open(REF, recipient, vasp, AMOUNT, MAX_FEE, COMMIT, 1, true);
        vm.stopPrank();
        // one second in the future is accepted
        vm.prank(payer);
        escrow.open(REF, recipient, vasp, AMOUNT, MAX_FEE, COMMIT, uint64(block.timestamp + 1), true);
    }

    function test_Revert_open_zeroAmount() public {
        vm.prank(payer);
        vm.expectRevert(SplashProofEscrow.InvalidAmount.selector);
        escrow.open(REF, recipient, vasp, 0, 0, COMMIT, expiry, true);
    }

    function test_Revert_open_zeroRecipientOrVasp() public {
        vm.startPrank(payer);
        vm.expectRevert(SplashProofEscrow.ZeroAddress.selector);
        escrow.open(REF, address(0), vasp, AMOUNT, MAX_FEE, COMMIT, expiry, true);
        vm.expectRevert(SplashProofEscrow.ZeroAddress.selector);
        escrow.open(REF, recipient, address(0), AMOUNT, MAX_FEE, COMMIT, expiry, true);
        vm.stopPrank();
    }

    function test_Revert_open_maxFeeAboveAmount() public {
        vm.prank(payer);
        vm.expectRevert(SplashProofEscrow.MaxFeeExceedsAmount.selector);
        escrow.open(REF, recipient, vasp, AMOUNT, AMOUNT + 1, COMMIT, expiry, true);
        // maxFee == amount is allowed
        vm.prank(payer);
        escrow.open(REF, recipient, vasp, AMOUNT, AMOUNT, COMMIT, expiry, true);
    }

    function test_Revert_open_zeroCommitment() public {
        vm.prank(payer);
        vm.expectRevert(SplashProofEscrow.ZeroCommitment.selector);
        escrow.open(REF, recipient, vasp, AMOUNT, MAX_FEE, bytes32(0), expiry, true);
    }

    function test_Revert_open_insufficientAllowance_leavesNoPayment() public {
        vm.prank(payer);
        usdc.approve(address(escrow), AMOUNT - 1);
        vm.prank(payer);
        vm.expectRevert(MockUSDC.InsufficientAllowance.selector);
        escrow.open(REF, recipient, vasp, AMOUNT, MAX_FEE, COMMIT, expiry, true);
        assertEq(uint8(_status(REF)), uint8(SplashProofEscrow.Status.None));
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    function test_Revert_open_insufficientBalance() public {
        vm.prank(alice);
        usdc.approve(address(escrow), type(uint256).max);
        vm.prank(alice);
        vm.expectRevert(MockUSDC.InsufficientBalance.selector);
        escrow.open(REF, recipient, vasp, AMOUNT, MAX_FEE, COMMIT, expiry, true);
    }

    // ------------------------------------------------------------ ackLocal (6)
    function test_ackLocal_vaspSettles_messageIdZero() public {
        _open(REF, false);
        vm.expectEmit(true, true, true, true, address(escrow));
        emit SplashProofEscrow.Released(REF, bytes32(0), recipient, NET, FEE, ACK_HASH, COMMIT);
        vm.prank(vasp);
        escrow.ackLocal(REF, COMMIT, ACK_HASH);
        assertEq(uint8(_status(REF)), uint8(RELEASED));
        assertEq(usdc.balanceOf(recipient), NET);
        assertEq(usdc.balanceOf(feeRecipient), FEE);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    function test_Revert_ackLocal_wrongCaller() public {
        _open(REF, false);
        address[4] memory callers = [payer, recipient, owner, alice];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(SplashProofEscrow.UnauthorizedVasp.selector, callers[i]));
            escrow.ackLocal(REF, COMMIT, ACK_HASH);
        }
        assertEq(uint8(_status(REF)), uint8(OPEN));
    }

    function test_Revert_ackLocal_remoteAckPayment() public {
        _open(REF, true);
        vm.prank(vasp);
        vm.expectRevert(abi.encodeWithSelector(SplashProofEscrow.LocalAckRequired.selector, REF));
        escrow.ackLocal(REF, COMMIT, ACK_HASH);
    }

    function test_Revert_ackLocal_expired() public {
        _open(REF, false);
        vm.warp(expiry);
        vm.prank(vasp);
        vm.expectRevert(abi.encodeWithSelector(SplashProofEscrow.PaymentExpired.selector, REF));
        escrow.ackLocal(REF, COMMIT, ACK_HASH);
    }

    function test_Revert_ackLocal_commitmentMismatch() public {
        _open(REF, false);
        vm.prank(vasp);
        vm.expectRevert(SplashProofEscrow.CommitmentMismatch.selector);
        escrow.ackLocal(REF, keccak256("nope"), ACK_HASH);
    }

    function test_Revert_ackLocal_alreadyReleasedOrRefundedOrUnknown() public {
        bytes32 ref2 = keccak256("ref2");
        _open(REF, false);
        _open(ref2, false);
        vm.prank(vasp);
        escrow.ackLocal(REF, COMMIT, ACK_HASH);
        vm.prank(vasp);
        vm.expectRevert(abi.encodeWithSelector(SplashProofEscrow.PaymentNotOpen.selector, REF));
        escrow.ackLocal(REF, COMMIT, ACK_HASH);

        vm.warp(expiry);
        escrow.refund(ref2);
        vm.prank(vasp);
        vm.expectRevert(abi.encodeWithSelector(SplashProofEscrow.PaymentNotOpen.selector, ref2));
        escrow.ackLocal(ref2, COMMIT, ACK_HASH);

        bytes32 unknown = keccak256("unknown");
        vm.prank(vasp);
        vm.expectRevert(abi.encodeWithSelector(SplashProofEscrow.PaymentNotOpen.selector, unknown));
        escrow.ackLocal(unknown, COMMIT, ACK_HASH);
    }

    // ------------------------------------------------------------ refund
    function test_refund_afterExpiry_fullAmount_anyCaller_noFee() public {
        _open(REF, true);
        uint256 payerBefore = usdc.balanceOf(payer);
        vm.warp(expiry);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit SplashProofEscrow.Refunded(REF, payer, AMOUNT);
        vm.prank(alice);
        escrow.refund(REF);
        assertEq(usdc.balanceOf(payer), payerBefore + AMOUNT);
        assertEq(usdc.balanceOf(feeRecipient), 0);
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(uint8(_status(REF)), uint8(REFUNDED));
    }

    function test_Revert_refund_beforeExpiry() public {
        _open(REF, true);
        vm.warp(expiry - 1);
        vm.expectRevert(abi.encodeWithSelector(SplashProofEscrow.PaymentNotExpired.selector, REF));
        escrow.refund(REF);
    }

    function test_Revert_refund_twiceReleasedOrUnknown() public {
        _open(REF, true);
        vm.warp(expiry);
        escrow.refund(REF);
        vm.expectRevert(abi.encodeWithSelector(SplashProofEscrow.PaymentNotOpen.selector, REF));
        escrow.refund(REF);

        bytes32 ref2 = keccak256("ref2");
        vm.warp(block.timestamp + 1);
        _openWith(escrow, ref2, recipient, AMOUNT, MAX_FEE, uint64(block.timestamp + 100), false);
        vm.prank(vasp);
        escrow.ackLocal(ref2, COMMIT, ACK_HASH);
        vm.warp(block.timestamp + 200);
        vm.expectRevert(abi.encodeWithSelector(SplashProofEscrow.PaymentNotOpen.selector, ref2));
        escrow.refund(ref2);

        vm.expectRevert(abi.encodeWithSelector(SplashProofEscrow.PaymentNotOpen.selector, keccak256("u")));
        escrow.refund(keccak256("u"));
    }

    // ------------------------------------------------------------ fee (7)
    function testFuzz_fee(uint256 amount, uint256 maxFee, uint16 bps, bool remote) public {
        amount = bound(amount, 1, 1e30);
        maxFee = bound(maxFee, 0, amount);
        bps = uint16(bound(bps, 0, 100));

        SplashProofEscrow e = new SplashProofEscrow(owner, ROUTER, feeRecipient, bps);
        vm.prank(owner);
        e.setAckSender(SRC, ackSender);
        vm.prank(payer);
        usdc.approve(address(e), type(uint256).max);
        usdc.mint(payer, amount);

        uint256 expected = (amount * bps) / 10_000;
        if (maxFee < expected) expected = maxFee;

        _openWith(e, REF, recipient, amount, maxFee, expiry, remote);
        assertEq(usdc.balanceOf(address(e)), amount);

        if (remote) {
            _deliverTo(e, _stdMsg(REF, vasp, COMMIT));
        } else {
            vm.prank(vasp);
            e.ackLocal(REF, COMMIT, ACK_HASH);
        }

        uint256 fee = usdc.balanceOf(feeRecipient);
        uint256 net = usdc.balanceOf(recipient);
        assertLe(fee, maxFee, "fee <= maxFee");
        assertLe(fee, (amount * bps) / 10_000, "fee <= amount*bps/10000");
        assertEq(net + fee, amount, "net + fee == amount");
        assertEq(fee, expected);
        assertEq(usdc.balanceOf(address(e)), 0);
        (,,,,,,,, SplashProofEscrow.Status s) = e.payments(REF);
        assertEq(uint8(s), uint8(RELEASED));
    }

    function test_fee_zeroBpsChargesNothing() public {
        SplashProofEscrow e = new SplashProofEscrow(owner, ROUTER, feeRecipient, 0);
        vm.prank(payer);
        usdc.approve(address(e), type(uint256).max);
        _openWith(e, REF, recipient, AMOUNT, MAX_FEE, expiry, false);
        vm.prank(vasp);
        e.ackLocal(REF, COMMIT, ACK_HASH);
        assertEq(usdc.balanceOf(feeRecipient), 0);
        assertEq(usdc.balanceOf(recipient), AMOUNT);
    }

    function test_fee_rounding_roundsDownInPayersFavor() public {
        // 199 * 50 / 10000 = 0.995 -> 0
        _openWith(escrow, REF, recipient, 199, 199, expiry, false);
        vm.prank(vasp);
        escrow.ackLocal(REF, COMMIT, ACK_HASH);
        assertEq(usdc.balanceOf(feeRecipient), 0);
        assertEq(usdc.balanceOf(recipient), 199);
    }

    // ------------------------------------------------------------ admin
    function test_setAckSender_ownerEmitsAndStores() public {
        address s = makeAddr("newSender");
        vm.expectEmit(true, true, false, false, address(escrow));
        emit SplashProofEscrow.AckSenderSet(OTHER_SRC, s);
        vm.prank(owner);
        escrow.setAckSender(OTHER_SRC, s);
        assertEq(escrow.ackSenders(OTHER_SRC), s);
    }

    function test_Revert_setAckSender_nonOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        escrow.setAckSender(OTHER_SRC, alice);
    }

    function test_setFeeRecipient_ownerEmitsAndStores_noFundMovement() public {
        _open(REF, true);
        address n = makeAddr("newFeeRecipient");
        vm.expectEmit(true, true, false, false, address(escrow));
        emit SplashProofEscrow.FeeRecipientSet(feeRecipient, n);
        vm.prank(owner);
        escrow.setFeeRecipient(n);
        assertEq(escrow.feeRecipient(), n);
        assertEq(usdc.balanceOf(address(escrow)), AMOUNT);
        _ackOk();
        assertEq(usdc.balanceOf(n), FEE, "fee goes to the recipient current at settlement");
        assertEq(usdc.balanceOf(feeRecipient), 0);
    }

    function test_Revert_setFeeRecipient_nonOwnerAndZero() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        escrow.setFeeRecipient(alice);
        vm.prank(owner);
        vm.expectRevert(SplashProofEscrow.ZeroAddress.selector);
        escrow.setFeeRecipient(address(0));
    }

    function test_disablingAckSender_makesCcipRevert() public {
        vm.prank(owner);
        escrow.setAckSender(SRC, address(0));
        _open(REF, true);
        vm.expectRevert(abi.encodeWithSelector(SplashProofEscrow.AckSenderNotConfigured.selector, SRC));
        _ackOk();
    }

    function test_Revert_renounceOwnership() public {
        vm.prank(owner);
        vm.expectRevert(SplashProofEscrow.OwnershipRenunciationDisabled.selector);
        escrow.renounceOwnership();
        vm.prank(alice);
        vm.expectRevert(SplashProofEscrow.OwnershipRenunciationDisabled.selector);
        escrow.renounceOwnership();
        assertEq(escrow.owner(), owner);
    }

    function test_twoStepOwnership() public {
        vm.prank(owner);
        escrow.transferOwnership(alice);
        assertEq(escrow.owner(), owner);
        assertEq(escrow.pendingOwner(), alice);

        address mallory = makeAddr("mallory");
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, mallory));
        escrow.acceptOwnership();

        vm.prank(alice);
        escrow.acceptOwnership();
        assertEq(escrow.owner(), alice);
        assertEq(escrow.pendingOwner(), address(0));

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        escrow.setFeeRecipient(owner);
    }

    function test_Revert_settleRemote_nonSelf() public {
        _open(REF, true);
        address[4] memory callers = [alice, owner, ROUTER, vasp];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(SplashProofEscrow.OnlySelf.selector);
            escrow.settleRemote(REF, MSG_ID, ACK_HASH, COMMIT);
        }
        assertEq(uint8(_status(REF)), uint8(OPEN));
    }

    function test_supportsInterface() public view {
        assertTrue(escrow.supportsInterface(type(IAny2EVMMessageReceiver).interfaceId));
        assertTrue(escrow.supportsInterface(type(IERC165).interfaceId));
        assertFalse(escrow.supportsInterface(0xdeadbeef));
        assertFalse(escrow.supportsInterface(0xffffffff));
    }

    // ------------------------------------------------------------ reference squatting
    /// @dev Demonstration (passes): refs are first-come-first-served and global, not bound to payer,
    ///      so any address can consume a ref an honest payer intends to use (cheap griefing).
    function test_refSquatting_documented() public {
        address attacker = makeAddr("attacker");
        usdc.mint(attacker, 1);
        vm.startPrank(attacker);
        usdc.approve(address(escrow), 1);
        // 1 base unit (1e-6 USDC) locked; attacker can refund it after expiry, so cost ~ 0.
        escrow.open(REF, attacker, vasp, 1, 0, keccak256("junk"), expiry, true);
        vm.stopPrank();

        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(SplashProofEscrow.PaymentRefUsed.selector, REF));
        escrow.open(REF, recipient, vasp, AMOUNT, MAX_FEE, COMMIT, expiry, true);

        // Honest payer's remote ack for the squatted ref can never match the real commitment.
        _deliver(_stdMsg(REF, vasp, COMMIT));
        assertEq(uint8(_status(REF)), uint8(OPEN)); // rejected: CommitmentMismatch on attacker's payment
        assertEq(usdc.balanceOf(attacker), 0);
    }
}
