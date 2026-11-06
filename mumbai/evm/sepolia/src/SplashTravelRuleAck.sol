// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {ExtraArgsCodec} from "@chainlink/contracts-ccip/contracts/libraries/ExtraArgsCodec.sol";

/// @title SplashTravelRuleAck
/// @notice The beneficiary institution's travel-rule acknowledgement, sent as a
///         CCIP message to Splash's escrow on Arc.
///
/// @dev The compliance acknowledgement IS the cross-chain message that moves the
///      money. The beneficiary holds the travel-rule record and its salt offchain,
///      recomputes
///
///          blake2b256( "splash:travel-rule:v1" || bcs(record) || salt )
///
///      and calls `acknowledge` with the value it derived. Only that 32-byte
///      commitment travels. The escrow releases the principal and takes Splash's
///      fee only when a message carrying a matching commitment arrives from an
///      allowlisted beneficiary on this chain.
///
///      Trust, stated exactly: the acknowledgement comes from the beneficiary's
///      own key and its delivery is verified by Chainlink's committee. The admin
///      decides which beneficiary addresses may acknowledge; it holds no power
///      over escrowed principal, which lives on the destination chain.
contract SplashTravelRuleAck {
    /// @notice Fired once the router has accepted the acknowledgement.
    event AckSent(
        bytes32 indexed messageId,
        bytes32 indexed paymentRef,
        address indexed vasp,
        bytes32 travelRuleCommitment,
        bytes32 ackHash,
        uint256 fee
    );
    event VaspSet(address indexed vasp, bool allowed);
    event DestinationSet(uint64 chainSelector, address escrow);
    event ExecutionPolicySet(uint32 gasLimit, uint16 blockDepth);
    event AdminTransferred(address indexed from, address indexed to);

    error NotAdmin();
    error NotAllowlistedVasp(address caller);
    error ZeroAddress();
    error ZeroPaymentRef();
    error ZeroCommitment();
    error DestinationNotSet();
    error InsufficientFee(uint256 required, uint256 supplied);
    error RefundFailed();

    IRouterClient public immutable ROUTER;

    address public admin;
    uint64 public destChainSelector;
    address public escrow;

    /// @dev Which beneficiary institutions may acknowledge. An acknowledgement
    ///      from anyone else is not a travel-rule acknowledgement at all.
    mapping(address vasp => bool allowed) public allowedVasp;

    /// @dev Gas for `_ccipReceive` on Arc. The known-good lane message used
    ///      1,200,000; the escrow's settle path is well under that, and headroom
    ///      is cheap compared with a receiver-side failure.
    uint32 public gasLimit = 1_200_000;

    /// @dev CCIP 2.0 requested finality, as a block depth. A travel-rule
    ///      acknowledgement carries no value, so it does not need to wait for
    ///      full finality; the money it releases is already escrowed on Arc and
    ///      cannot move anywhere else. Five blocks matches the fastest observed
    ///      delivery on this lane. Set to 0 to wait for finality instead.
    uint16 public blockDepth = 5;

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(address router, uint64 _destChainSelector, address _escrow, address _admin) {
        if (router == address(0) || _admin == address(0)) revert ZeroAddress();
        ROUTER = IRouterClient(router);
        destChainSelector = _destChainSelector;
        escrow = _escrow;
        admin = _admin;
        emit DestinationSet(_destChainSelector, _escrow);
        emit AdminTransferred(address(0), _admin);
    }

    // ─── Admin ──────────────────────────────────────────────────────────────

    function setVasp(address vasp, bool allowed) external onlyAdmin {
        if (vasp == address(0)) revert ZeroAddress();
        allowedVasp[vasp] = allowed;
        emit VaspSet(vasp, allowed);
    }

    /// @dev The escrow's address is only known after it is deployed on Arc, so
    ///      the sender is deployed first and pointed at it afterwards.
    function setDestination(uint64 _destChainSelector, address _escrow) external onlyAdmin {
        if (_escrow == address(0)) revert ZeroAddress();
        destChainSelector = _destChainSelector;
        escrow = _escrow;
        emit DestinationSet(_destChainSelector, _escrow);
    }

    function setExecutionPolicy(uint32 _gasLimit, uint16 _blockDepth) external onlyAdmin {
        gasLimit = _gasLimit;
        blockDepth = _blockDepth;
        emit ExecutionPolicySet(_gasLimit, _blockDepth);
    }

    function transferAdmin(address to) external onlyAdmin {
        if (to == address(0)) revert ZeroAddress();
        emit AdminTransferred(admin, to);
        admin = to;
    }

    // ─── The acknowledgement ────────────────────────────────────────────────

    /// @notice What the message looks like before it is sent. Quote with `getFee`.
    function buildMessage(bytes32 paymentRef, address vasp, bytes32 travelRuleCommitment, bytes32 ackHash)
        public
        view
        returns (Client.EVM2AnyMessage memory)
    {
        return Client.EVM2AnyMessage({
            receiver: abi.encode(escrow),
            data: abi.encode(paymentRef, vasp, travelRuleCommitment, ackHash),
            tokenAmounts: new Client.EVMTokenAmount[](0),
            // Native ETH on Sepolia, so no LINK faucet stands between a
            // beneficiary and its compliance duty.
            feeToken: address(0),
            extraArgs: blockDepth == 0
                ? ExtraArgsCodec._getBasicEncodedExtraArgsV3(gasLimit, bytes4(0))
                : ExtraArgsCodec._getBasicEncodedExtraArgsV3BlockDepth(gasLimit, blockDepth)
        });
    }

    /// @notice What this acknowledgement costs in native ETH.
    function getFee(bytes32 paymentRef, address vasp, bytes32 travelRuleCommitment, bytes32 ackHash)
        public
        view
        returns (uint256)
    {
        if (escrow == address(0)) revert DestinationNotSet();
        return ROUTER.getFee(destChainSelector, buildMessage(paymentRef, vasp, travelRuleCommitment, ackHash));
    }

    /// @notice The beneficiary institution acknowledges the travel-rule record.
    /// @param paymentRef Splash's own payment reference. Never a CCIP message id:
    ///        that value exists only after this send.
    /// @param travelRuleCommitment The value the beneficiary recomputed from the
    ///        record and salt it holds.
    /// @param ackHash The beneficiary's own reference for this acknowledgement,
    ///        carried through to the release event for its audit trail.
    /// @dev Any excess ETH is returned, so a caller may overpay rather than race
    ///      the fee between quoting and sending.
    function acknowledge(bytes32 paymentRef, bytes32 travelRuleCommitment, bytes32 ackHash)
        external
        payable
        returns (bytes32 messageId)
    {
        if (!allowedVasp[msg.sender]) revert NotAllowlistedVasp(msg.sender);
        if (paymentRef == bytes32(0)) revert ZeroPaymentRef();
        if (travelRuleCommitment == bytes32(0)) revert ZeroCommitment();
        if (escrow == address(0)) revert DestinationNotSet();

        Client.EVM2AnyMessage memory message = buildMessage(paymentRef, msg.sender, travelRuleCommitment, ackHash);
        uint256 fee = ROUTER.getFee(destChainSelector, message);
        if (msg.value < fee) revert InsufficientFee(fee, msg.value);

        messageId = ROUTER.ccipSend{value: fee}(destChainSelector, message);
        emit AckSent(messageId, paymentRef, msg.sender, travelRuleCommitment, ackHash, fee);

        uint256 excess = msg.value - fee;
        if (excess > 0) {
            (bool ok,) = msg.sender.call{value: excess}("");
            if (!ok) revert RefundFailed();
        }
    }
}
