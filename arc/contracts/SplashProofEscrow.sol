// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {CCIPReceiver} from "@chainlink/contracts-ccip/contracts/applications/CCIPReceiver.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";

/// @title SplashProofEscrow
/// @notice Arc Testnet USDC escrow released by a local VASP or authenticated CCIP acknowledgment.
/// @dev Amounts use USDC's six-decimal base units. No native currency is used for payments.
contract SplashProofEscrow is Ownable2Step, CCIPReceiver, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status { None, Open, Released, Refunded }
    enum RejectReason { NotOpen, Expired, NotRemoteAck, VaspMismatch, CommitmentMismatch, Malformed, TransferFailed }

    struct Payment {
        address payer;
        address recipient;
        address beneficiaryVasp;
        uint256 amount;
        uint256 maxFee;
        bytes32 travelRuleCommitment;
        uint64 expiry;
        bool remoteAck;
        Status status;
    }

    /// @notice Canonical six-decimal USDC ERC-20 on Arc Testnet (chain ID 5042002).
    IERC20 public constant USDC = IERC20(0x3600000000000000000000000000000000000000);
    /// @notice Immutable settlement fee rate, capped at 100 basis points.
    uint16 public immutable feeBps;
    /// @notice Current destination for settlement fees only.
    address public feeRecipient;
    /// @notice Payment references are permanently unique, including after settlement or refund.
    mapping(bytes32 paymentRef => Payment payment) public payments;
    /// @notice Authorized source sender per chain; zero disables that source chain.
    mapping(uint64 sourceChainSelector => address sender) public ackSenders;

    error ZeroAddress();
    error InvalidFeeBps(uint16 feeBps);
    error OwnershipRenunciationDisabled();
    error PaymentRefUsed(bytes32 paymentRef);
    error InvalidExpiry(uint64 expiry);
    error InvalidAmount();
    error MaxFeeExceedsAmount();
    error ZeroCommitment();
    error PaymentNotOpen(bytes32 paymentRef);
    error PaymentExpired(bytes32 paymentRef);
    error PaymentNotExpired(bytes32 paymentRef);
    error RemoteAckRequired(bytes32 paymentRef);
    error LocalAckRequired(bytes32 paymentRef);
    error UnauthorizedVasp(address caller);
    error CommitmentMismatch();
    error AckSenderNotConfigured(uint64 sourceChainSelector);
    error MalformedAckSender();
    error UnauthorizedAckSender(address sender);
    error OnlySelf();

    event AckSenderSet(uint64 indexed sourceChainSelector, address indexed sender);
    event FeeRecipientSet(address indexed previousRecipient, address indexed newRecipient);
    event PaymentOpened(
        bytes32 indexed paymentRef,
        address indexed payer,
        address indexed recipient,
        address beneficiaryVasp,
        uint256 amount,
        uint256 maxFee,
        bytes32 travelRuleCommitment,
        uint64 expiry,
        bool remoteAck
    );
    event AckRejected(bytes32 indexed paymentRef, bytes32 indexed messageId, RejectReason reason);
    event Released(
        bytes32 indexed paymentRef,
        bytes32 indexed messageId,
        address indexed recipient,
        uint256 net,
        uint256 fee,
        bytes32 ackHash,
        bytes32 commitment
    );
    event Refunded(bytes32 indexed paymentRef, address indexed payer, uint256 amount);

    /// @notice Initialize the two-step owner, CCIP router, fee recipient, and immutable fee rate.
    /// @dev Ownable and CCIPReceiver reject zero admin and router respectively.
    constructor(address admin, address router, address feeRecipient_, uint16 feeBps_)
        Ownable(admin)
        CCIPReceiver(router)
    {
        if (feeRecipient_ == address(0)) revert ZeroAddress();
        if (feeBps_ > 100) revert InvalidFeeBps(feeBps_);
        feeRecipient = feeRecipient_;
        feeBps = feeBps_;
    }

    /// @notice Ownership cannot be renounced; use the inherited two-step handover instead.
    function renounceOwnership() public pure override {
        revert OwnershipRenunciationDisabled();
    }

    /// @notice Authorize a source-chain acknowledgment sender, or disable it with address zero.
    function setAckSender(uint64 sourceChainSelector, address sender) external onlyOwner {
        ackSenders[sourceChainSelector] = sender;
        emit AckSenderSet(sourceChainSelector, sender);
    }

    /// @notice Change only the fee destination; this does not transfer any funds.
    function setFeeRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(0)) revert ZeroAddress();
        address previousRecipient = feeRecipient;
        feeRecipient = newRecipient;
        emit FeeRecipientSet(previousRecipient, newRecipient);
    }

    /// @notice Lock USDC with a unique reference and a future refund deadline.
    /// @dev Writes the payment before pulling exactly amount via SafeERC20; charges no fee.
    function open(
        bytes32 paymentRef,
        address recipient,
        address beneficiaryVasp,
        uint256 amount,
        uint256 maxFee,
        bytes32 travelRuleCommitment,
        uint64 expiry,
        bool remoteAck
    ) external nonReentrant {
        if (payments[paymentRef].status != Status.None) revert PaymentRefUsed(paymentRef);
        if (expiry <= block.timestamp) revert InvalidExpiry(expiry);
        if (amount == 0) revert InvalidAmount();
        if (recipient == address(0) || beneficiaryVasp == address(0)) revert ZeroAddress();
        if (maxFee > amount) revert MaxFeeExceedsAmount();
        if (travelRuleCommitment == bytes32(0)) revert ZeroCommitment();

        payments[paymentRef] = Payment({
            payer: msg.sender,
            recipient: recipient,
            beneficiaryVasp: beneficiaryVasp,
            amount: amount,
            maxFee: maxFee,
            travelRuleCommitment: travelRuleCommitment,
            expiry: expiry,
            remoteAck: remoteAck,
            status: Status.Open
        });
        USDC.safeTransferFrom(msg.sender, address(this), amount);
        emit PaymentOpened(
            paymentRef, msg.sender, recipient, beneficiaryVasp, amount, maxFee,
            travelRuleCommitment, expiry, remoteAck
        );
    }

    /// @notice Router-only CCIP entry point with the reentrancy lock held through settlement.
    /// @dev CCIPReceiver.ccipReceive is external, so it cannot be called via super.
    ///      Retains its exact onlyRouter -> _ccipReceive dispatch, adding nonReentrant.
    function ccipReceive(Client.Any2EVMMessage calldata message)
        external override nonReentrant onlyRouter
    {
        _ccipReceive(message);
    }

    /// @dev Authenticate first; after authentication reject invalid acknowledgments by event.
    ///      destTokenAmounts is intentionally ignored. Dirty address words are handled explicitly.
    function _ccipReceive(Client.Any2EVMMessage memory message) internal override {
        address configuredSender = ackSenders[message.sourceChainSelector];
        if (configuredSender == address(0)) revert AckSenderNotConfigured(message.sourceChainSelector);
        if (message.sender.length != 32) revert MalformedAckSender();
        uint256 senderWord = abi.decode(message.sender, (uint256));
        if (senderWord > type(uint160).max) revert MalformedAckSender();
        address sender = address(uint160(senderWord));
        if (sender != configuredSender) revert UnauthorizedAckSender(sender);

        if (message.data.length != 128) {
            emit AckRejected(bytes32(0), message.messageId, RejectReason.Malformed);
            return;
        }
        // Decode the address as a full word so malformed high bits cannot cause an ABI revert.
        (bytes32 paymentRef, uint256 vaspWord, bytes32 commitment, bytes32 ackHash) =
            abi.decode(message.data, (bytes32, uint256, bytes32, bytes32));
        if (vaspWord > type(uint160).max) {
            emit AckRejected(paymentRef, message.messageId, RejectReason.Malformed);
            return;
        }
        Payment storage payment = payments[paymentRef];
        if (payment.status != Status.Open) {
            emit AckRejected(paymentRef, message.messageId, RejectReason.NotOpen);
            return;
        }
        if (block.timestamp >= payment.expiry) {
            emit AckRejected(paymentRef, message.messageId, RejectReason.Expired);
            return;
        }
        if (!payment.remoteAck) {
            emit AckRejected(paymentRef, message.messageId, RejectReason.NotRemoteAck);
            return;
        }
        if (address(uint160(vaspWord)) != payment.beneficiaryVasp) {
            emit AckRejected(paymentRef, message.messageId, RejectReason.VaspMismatch);
            return;
        }
        if (commitment != payment.travelRuleCommitment) {
            emit AckRejected(paymentRef, message.messageId, RejectReason.CommitmentMismatch);
            return;
        }

        try this.settleRemote(paymentRef, message.messageId, ackHash, commitment) {
            // The status, both transfers, and Released event committed atomically.
        } catch {
            emit AckRejected(paymentRef, message.messageId, RejectReason.TransferFailed);
        }
    }

    /// @notice Atomic settlement boundary used exclusively by the authenticated CCIP handler.
    /// @dev Deliberately not nonReentrant: the outer ccipReceive already holds the lock.
    function settleRemote(bytes32 paymentRef, bytes32 messageId, bytes32 ackHash, bytes32 commitment)
        external
    {
        if (msg.sender != address(this)) revert OnlySelf();
        _settle(paymentRef, messageId, ackHash, commitment);
    }

    /// @notice Release an unexpired local payment; only its beneficiary VASP may acknowledge it.
    function ackLocal(bytes32 paymentRef, bytes32 commitment, bytes32 ackHash) external nonReentrant {
        Payment storage payment = payments[paymentRef];
        if (payment.status != Status.Open) revert PaymentNotOpen(paymentRef);
        if (msg.sender != payment.beneficiaryVasp) revert UnauthorizedVasp(msg.sender);
        if (payment.remoteAck) revert LocalAckRequired(paymentRef);
        if (block.timestamp >= payment.expiry) revert PaymentExpired(paymentRef);
        if (commitment != payment.travelRuleCommitment) revert CommitmentMismatch();
        _settle(paymentRef, bytes32(0), ackHash, commitment);
    }

    /// @notice Return the full principal to the payer after expiry; anyone may trigger it.
    function refund(bytes32 paymentRef) external nonReentrant {
        Payment storage payment = payments[paymentRef];
        if (payment.status != Status.Open) revert PaymentNotOpen(paymentRef);
        if (block.timestamp < payment.expiry) revert PaymentNotExpired(paymentRef);
        payment.status = Status.Refunded;
        USDC.safeTransfer(payment.payer, payment.amount);
        emit Refunded(paymentRef, payment.payer, payment.amount);
    }

    /// @dev Sole fee-charging path. Full-precision mulDiv avoids intermediate multiplication overflow.
    function _settle(bytes32 paymentRef, bytes32 messageId, bytes32 ackHash, bytes32 commitment) internal {
        Payment storage payment = payments[paymentRef];
        if (payment.status != Status.Open) revert PaymentNotOpen(paymentRef);
        if (block.timestamp >= payment.expiry) revert PaymentExpired(paymentRef);
        uint256 fee = Math.min(payment.maxFee, Math.mulDiv(payment.amount, feeBps, 10_000));
        uint256 net = payment.amount - fee;
        address feeDestination = feeRecipient;
        payment.status = Status.Released;
        USDC.safeTransfer(payment.recipient, net);
        if (fee != 0) USDC.safeTransfer(feeDestination, fee);
        emit Released(paymentRef, messageId, payment.recipient, net, fee, ackHash, commitment);
    }
}
