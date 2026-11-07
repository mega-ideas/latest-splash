// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @dev The official Whitechain USDT at 0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7
///      is "Tether USD", 6 decimals, and supports EIP-3009. The bridged
///      USDT.e at 0xaa79…8f46 is a different token and is not accepted here.
interface IUSDT3009 {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
    function transfer(address to, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title SplashInvoice
/// @notice A USDT invoice the customer can pay without holding the chain's gas
///         token, where the merchant is paid immediately and Splash's fee waits
///         for the proof.
///
/// @dev Two ideas, both the same rule as the Arc escrow.
///
///      First, the customer signs an EIP-3009 authorisation rather than sending
///      a transaction. A relayer submits it, so the customer needs no WBT. The
///      signature names this contract and a single-use nonce, so the relayer can
///      neither redirect it nor replay it.
///
///      Second, the split. The merchant's net amount moves on payment and is
///      never held hostage to anything Splash does. Only Splash's fee is held,
///      and only until the proof is recorded. If the proof never comes, the fee
///      goes to the merchant, not back to Splash. Splash's incentive to produce
///      the proof is that it is the only way Splash is paid.
///
///      Trust, stated exactly: a Splash attestor records the proof. That is an
///      attestation, not a consensus guarantee. The customer's and merchant's
///      money is never at risk from it: the worst a dishonest attestor can do is
///      take a fee it did not earn, capped at the fee.
contract SplashInvoice {
    enum Status {
        None,
        Open,
        Paid,
        Settled,
        Expired
    }

    struct Invoice {
        address merchant;
        uint256 amount;
        uint256 feeAmount;
        uint64 dueAt;
        /// @dev After payment, how long Splash has to record the proof.
        uint64 proofDeadline;
        bytes32 travelRuleCommitment;
        Status status;
        address payer;
    }

    event InvoiceCreated(
        bytes32 indexed invoiceId,
        address indexed merchant,
        uint256 amount,
        uint256 feeAmount,
        uint64 dueAt,
        bytes32 travelRuleCommitment
    );
    event InvoicePaid(bytes32 indexed invoiceId, address indexed payer, uint256 netToMerchant, uint256 feeHeld);
    event ProofRecorded(bytes32 indexed invoiceId, bytes32 travelRuleCommitment, uint256 feeToSplash);
    event FeeForfeited(bytes32 indexed invoiceId, address indexed merchant, uint256 feeAmount);
    event AttestorSet(address indexed attestor, bool allowed);
    event FeeRecipientSet(address indexed feeRecipient);

    error NotAdmin();
    error NotAttestor();
    error NotMerchant();
    error InvoiceExists();
    error NoSuchInvoice();
    error WrongStatus();
    error PastDue();
    error ZeroAddress();
    error ZeroAmount();
    error FeeTooHigh();
    error ProofWindowOpen();
    error TransferFailed();
    error Underfunded(uint256 expected, uint256 received);

    /// @dev One percent, the same ceiling splash_core enforces on Sui.
    uint16 public constant MAX_FEE_BPS = 100;

    IUSDT3009 public immutable USDT;
    address public admin;
    address public feeRecipient;
    uint16 public feeBps;
    /// @dev How long after payment Splash has to record the proof.
    uint64 public proofWindow = 7 days;

    mapping(bytes32 invoiceId => Invoice) public invoices;
    mapping(address attestor => bool allowed) public attestors;

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(address usdt, address _admin, address _feeRecipient, uint16 _feeBps) {
        if (usdt == address(0) || _admin == address(0) || _feeRecipient == address(0)) revert ZeroAddress();
        if (_feeBps > MAX_FEE_BPS) revert FeeTooHigh();
        USDT = IUSDT3009(usdt);
        admin = _admin;
        feeRecipient = _feeRecipient;
        feeBps = _feeBps;
        emit FeeRecipientSet(_feeRecipient);
    }

    // ─── Admin ──────────────────────────────────────────────────────────────

    function setAttestor(address attestor, bool allowed) external onlyAdmin {
        if (attestor == address(0)) revert ZeroAddress();
        attestors[attestor] = allowed;
        emit AttestorSet(attestor, allowed);
    }

    function setFeeRecipient(address to) external onlyAdmin {
        if (to == address(0)) revert ZeroAddress();
        feeRecipient = to;
        emit FeeRecipientSet(to);
    }

    function setProofWindow(uint64 seconds_) external onlyAdmin {
        proofWindow = seconds_;
    }

    // ─── The invoice ────────────────────────────────────────────────────────

    /// @notice A merchant raises an invoice. The fee is fixed here and can never
    ///         grow afterwards.
    function createInvoice(bytes32 invoiceId, uint256 amount, uint64 dueAt, bytes32 travelRuleCommitment) external {
        if (invoices[invoiceId].status != Status.None) revert InvoiceExists();
        if (amount == 0) revert ZeroAmount();
        if (dueAt <= block.timestamp) revert PastDue();

        uint256 fee = (amount * feeBps) / 10_000;
        invoices[invoiceId] = Invoice({
            merchant: msg.sender,
            amount: amount,
            feeAmount: fee,
            dueAt: dueAt,
            proofDeadline: 0,
            travelRuleCommitment: travelRuleCommitment,
            status: Status.Open,
            payer: address(0)
        });
        emit InvoiceCreated(invoiceId, msg.sender, amount, fee, dueAt, travelRuleCommitment);
    }

    /// @notice Pay an invoice with an EIP-3009 authorisation, so the customer
    ///         needs no WBT. Anyone may relay it; the signature decides who pays.
    /// @dev The authorisation must name this contract as `to` and the invoice's
    ///      full amount as `value`. The merchant is paid its net immediately;
    ///      only the fee stays here.
    function payWithAuthorization(
        bytes32 invoiceId,
        address from,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        Invoice storage inv = invoices[invoiceId];
        if (inv.status == Status.None) revert NoSuchInvoice();
        if (inv.status != Status.Open) revert WrongStatus();
        if (block.timestamp > inv.dueAt) revert PastDue();

        uint256 before = USDT.balanceOf(address(this));
        USDT.transferWithAuthorization(from, address(this), inv.amount, validAfter, validBefore, nonce, v, r, s);
        uint256 received = USDT.balanceOf(address(this)) - before;
        // A fee-on-transfer or partially honoured authorisation must not leave
        // the merchant short.
        if (received < inv.amount) revert Underfunded(inv.amount, received);

        inv.status = Status.Paid;
        inv.payer = from;
        inv.proofDeadline = uint64(block.timestamp) + proofWindow;

        uint256 net = inv.amount - inv.feeAmount;
        if (!USDT.transfer(inv.merchant, net)) revert TransferFailed();
        emit InvoicePaid(invoiceId, from, net, inv.feeAmount);
    }

    /// @notice Pay an invoice from an ordinary ERC-20 approval.
    /// @dev EIP-3009 is the better customer experience and the reason this rail
    ///      exists, but not every token has it. Where it is missing the customer
    ///      approves and pays a transaction itself; the split, the hold and the
    ///      proof rule are identical, so a merchant's terms do not change with
    ///      the token. `from` is `msg.sender`, never a parameter: an allowance
    ///      left lying around must not let anyone else spend it.
    function payWithApproval(bytes32 invoiceId) external {
        Invoice storage inv = invoices[invoiceId];
        if (inv.status == Status.None) revert NoSuchInvoice();
        if (inv.status != Status.Open) revert WrongStatus();
        if (block.timestamp > inv.dueAt) revert PastDue();

        uint256 before = USDT.balanceOf(address(this));
        if (!USDT.transferFrom(msg.sender, address(this), inv.amount)) revert TransferFailed();
        uint256 received = USDT.balanceOf(address(this)) - before;
        if (received < inv.amount) revert Underfunded(inv.amount, received);

        inv.status = Status.Paid;
        inv.payer = msg.sender;
        inv.proofDeadline = uint64(block.timestamp) + proofWindow;

        uint256 net = inv.amount - inv.feeAmount;
        if (!USDT.transfer(inv.merchant, net)) revert TransferFailed();
        emit InvoicePaid(invoiceId, msg.sender, net, inv.feeAmount);
    }

    /// @notice Splash records the proof and is paid. The only path that pays Splash.
    function recordProof(bytes32 invoiceId, bytes32 travelRuleCommitment) external {
        if (!attestors[msg.sender]) revert NotAttestor();
        Invoice storage inv = invoices[invoiceId];
        if (inv.status == Status.None) revert NoSuchInvoice();
        if (inv.status != Status.Paid) revert WrongStatus();
        if (travelRuleCommitment != inv.travelRuleCommitment) revert NoSuchInvoice();

        inv.status = Status.Settled;
        uint256 fee = inv.feeAmount;
        if (fee > 0 && !USDT.transfer(feeRecipient, fee)) revert TransferFailed();
        emit ProofRecorded(invoiceId, travelRuleCommitment, fee);
    }

    /// @notice No proof inside the window: the held fee goes to the merchant.
    ///         Splash earns nothing. Callable by anyone, so the merchant never
    ///         depends on Splash to collect it.
    function forfeitFee(bytes32 invoiceId) external {
        Invoice storage inv = invoices[invoiceId];
        if (inv.status == Status.None) revert NoSuchInvoice();
        if (inv.status != Status.Paid) revert WrongStatus();
        if (block.timestamp <= inv.proofDeadline) revert ProofWindowOpen();

        inv.status = Status.Expired;
        uint256 fee = inv.feeAmount;
        if (fee > 0 && !USDT.transfer(inv.merchant, fee)) revert TransferFailed();
        emit FeeForfeited(invoiceId, inv.merchant, fee);
    }

    function getInvoice(bytes32 invoiceId) external view returns (Invoice memory) {
        return invoices[invoiceId];
    }
}
