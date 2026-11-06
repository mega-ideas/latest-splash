// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title SplashProofRegistry
/// @notice One place where every Splash travel-rule proof lands, whichever rail
///         carried the payment.
///
/// @dev Splash's payments settle on more than one rail: USDC through an escrow
///      on Arc, USDT through an invoice on Whitechain, and receipts anchored on
///      Sui. Each rail enforces its own rule locally, which is right — a rail
///      should not have to trust another rail to protect its own money. But it
///      leaves an auditor with three places to look and no single answer to
///      "show me every proof this business has produced".
///
///      This is that single answer. A recorder writes one entry per proof, and
///      the entry names the rail, the chain and the transaction it came from,
///      so each row points back at the settlement that produced it.
///
///      In production this role belongs to Walrus, which is where Splash's
///      evidence is designed to live. This contract is the hackathon stand-in:
///      the same shape, on a chain, so the claim can be checked today.
///
///      What it is not: it is a record, not a gate. Nothing here can release or
///      withhold anyone's money, and no rail reads it to decide anything. A
///      dishonest recorder can write a row that never happened, which is why
///      every row carries the source chain and transaction for anyone to check
///      against. It is evidence to audit, not a thing to trust blindly.
contract SplashProofRegistry {
    enum Rail {
        Unknown,
        ArcEscrow,
        WhitechainInvoice,
        SuiAnchor
    }

    struct Entry {
        bytes32 travelRuleCommitment;
        bytes32 paymentRef;
        Rail rail;
        uint64 sourceChainId;
        bytes32 sourceTx;
        uint256 amount;
        uint256 feeCharged;
        uint64 recordedAt;
        address recorder;
    }

    event ProofRecorded(
        bytes32 indexed travelRuleCommitment,
        bytes32 indexed paymentRef,
        Rail indexed rail,
        uint64 sourceChainId,
        bytes32 sourceTx,
        uint256 amount,
        uint256 feeCharged,
        address recorder
    );
    event RecorderSet(address indexed recorder, bool allowed);
    event AdminTransferred(address indexed from, address indexed to);

    error NotAdmin();
    error NotRecorder(address caller);
    error ZeroAddress();
    error ZeroCommitment();
    error AlreadyRecorded(bytes32 travelRuleCommitment);
    error UnknownRail();

    address public admin;
    mapping(address recorder => bool allowed) public recorders;

    /// @dev One entry per commitment. A commitment is unique per payment by
    ///      construction (it is salted), so this also makes each payment
    ///      recordable exactly once.
    mapping(bytes32 commitment => Entry) private _entries;
    bytes32[] private _commitments;

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(address admin_) {
        if (admin_ == address(0)) revert ZeroAddress();
        admin = admin_;
        emit AdminTransferred(address(0), admin_);
    }

    function setRecorder(address recorder, bool allowed) external onlyAdmin {
        if (recorder == address(0)) revert ZeroAddress();
        recorders[recorder] = allowed;
        emit RecorderSet(recorder, allowed);
    }

    function transferAdmin(address to) external onlyAdmin {
        if (to == address(0)) revert ZeroAddress();
        emit AdminTransferred(admin, to);
        admin = to;
    }

    /// @notice Record one proof. Refuses a second entry for the same
    ///         commitment, so the count of entries is the count of distinct
    ///         payments proven and cannot be inflated by replay.
    function record(
        bytes32 travelRuleCommitment,
        bytes32 paymentRef,
        Rail rail,
        uint64 sourceChainId,
        bytes32 sourceTx,
        uint256 amount,
        uint256 feeCharged
    ) external {
        if (!recorders[msg.sender]) revert NotRecorder(msg.sender);
        if (travelRuleCommitment == bytes32(0)) revert ZeroCommitment();
        if (rail == Rail.Unknown) revert UnknownRail();
        if (_entries[travelRuleCommitment].travelRuleCommitment != bytes32(0)) {
            revert AlreadyRecorded(travelRuleCommitment);
        }

        _entries[travelRuleCommitment] = Entry({
            travelRuleCommitment: travelRuleCommitment,
            paymentRef: paymentRef,
            rail: rail,
            sourceChainId: sourceChainId,
            sourceTx: sourceTx,
            amount: amount,
            feeCharged: feeCharged,
            recordedAt: uint64(block.timestamp),
            recorder: msg.sender
        });
        _commitments.push(travelRuleCommitment);

        emit ProofRecorded(
            travelRuleCommitment, paymentRef, rail, sourceChainId, sourceTx, amount, feeCharged, msg.sender
        );
    }

    function entry(bytes32 travelRuleCommitment) external view returns (Entry memory) {
        return _entries[travelRuleCommitment];
    }

    function isRecorded(bytes32 travelRuleCommitment) external view returns (bool) {
        return _entries[travelRuleCommitment].travelRuleCommitment != bytes32(0);
    }

    function total() external view returns (uint256) {
        return _commitments.length;
    }

    /// @notice A page of commitments, newest last. For an auditor pulling the
    ///         whole set without an indexer.
    function page(uint256 offset, uint256 limit) external view returns (bytes32[] memory out) {
        uint256 n = _commitments.length;
        if (offset >= n) return new bytes32[](0);
        uint256 end = offset + limit;
        if (end > n) end = n;
        out = new bytes32[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            out[i - offset] = _commitments[i];
        }
    }

    /// @notice What Splash earned across every recorded proof. The fee total an
    ///         auditor can check against the rails themselves.
    function totalFeesRecorded() external view returns (uint256 sum) {
        for (uint256 i = 0; i < _commitments.length; i++) {
            sum += _entries[_commitments[i]].feeCharged;
        }
    }
}
