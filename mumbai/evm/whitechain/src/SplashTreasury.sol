// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

interface IERC20Min {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
    function approve(address spender, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// Uniswap V3 SwapRouter02's single-hop entry point.
interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @title SplashTreasury
/// @notice Sweeps proof-earned fees into one reserve asset through Uniswap,
///         without losing the link to the proof that earned them.
///
/// @dev Splash charges a fee only when a travel-rule proof is recorded. Those
///      fees arrive in whatever the rail settled in — USDT on Whitechain, USDC
///      on Arc — while the treasury holds one reserve asset, so something has to
///      convert them. That something is Uniswap, and this is the only path by
///      which a fee leaves the fee wallet.
///
///      The point is the event. A swap on its own is just a swap; `FeeSwept`
///      carries the `travelRuleCommitment` that earned the fee, so one 32-byte
///      value can be followed from the payment, to the proof that released it,
///      to the treasury position it became. An auditor asking "where did this
///      revenue come from" gets an answer that terminates in a proof rather
///      than in a balance.
///
///      `minOut` is required and never defaulted. A sweep that would accept any
///      price is a sweep that can be sandwiched, and the caller — not this
///      contract — is the one who knows what the fee was worth.
///
///      What it cannot do: it holds no customer money and never touches an
///      escrow or an invoice. It moves fees Splash has already earned. The
///      worst a compromised treasurer can do is swap Splash's own revenue at a
///      bad price.
contract SplashTreasury {
    event FeeSwept(
        bytes32 indexed travelRuleCommitment,
        address indexed tokenIn,
        uint256 amountIn,
        address indexed reserve,
        uint256 amountOut,
        uint24 poolFee
    );
    event TreasurerSet(address indexed treasurer, bool allowed);
    event ReserveSet(address indexed reserve);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);

    error NotAdmin();
    error NotTreasurer(address caller);
    error ZeroAddress();
    error ZeroAmount();
    error ZeroCommitment();
    error NoMinimumOut();
    error AlreadySwept(bytes32 travelRuleCommitment);
    error PullFailed();
    error LengthMismatch();

    address public admin;
    /// @dev The asset the treasury holds. USDY in production — Splash's ledger
    ///      already prices a yield-bearing reserve — and a plain asset wherever
    ///      no USDY exists, which is why it is settable rather than constant.
    address public reserve;
    ISwapRouter02 public immutable ROUTER;

    mapping(address treasurer => bool allowed) public treasurers;
    /// @dev One sweep per proof. A fee is earned once, so it is swept once, and
    ///      the sum of FeeSwept equals revenue rather than revenue plus retries.
    mapping(bytes32 commitment => bool) public swept;

    uint256 public totalSwept;

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(address admin_, address router_, address reserve_) {
        if (admin_ == address(0) || router_ == address(0) || reserve_ == address(0)) revert ZeroAddress();
        admin = admin_;
        ROUTER = ISwapRouter02(router_);
        reserve = reserve_;
        emit ReserveSet(reserve_);
    }

    function setTreasurer(address treasurer, bool allowed) external onlyAdmin {
        if (treasurer == address(0)) revert ZeroAddress();
        treasurers[treasurer] = allowed;
        emit TreasurerSet(treasurer, allowed);
    }

    function setReserve(address reserve_) external onlyAdmin {
        if (reserve_ == address(0)) revert ZeroAddress();
        reserve = reserve_;
        emit ReserveSet(reserve_);
    }

    /// @notice Sweep one proof's fee into the reserve.
    /// @param travelRuleCommitment The proof that earned this fee.
    /// @param amountIn Pulled from the caller, who holds the fee.
    /// @param minOut The least reserve the caller will accept. Required.
    function sweep(
        bytes32 travelRuleCommitment,
        address tokenIn,
        uint24 poolFee,
        uint256 amountIn,
        uint256 minOut
    ) external returns (uint256 amountOut) {
        return _sweep(travelRuleCommitment, tokenIn, poolFee, amountIn, minOut);
    }

    function _sweep(
        bytes32 travelRuleCommitment,
        address tokenIn,
        uint24 poolFee,
        uint256 amountIn,
        uint256 minOut
    ) internal returns (uint256 amountOut) {
        if (!treasurers[msg.sender]) revert NotTreasurer(msg.sender);
        if (travelRuleCommitment == bytes32(0)) revert ZeroCommitment();
        if (tokenIn == address(0)) revert ZeroAddress();
        if (amountIn == 0) revert ZeroAmount();
        if (minOut == 0) revert NoMinimumOut();
        if (swept[travelRuleCommitment]) revert AlreadySwept(travelRuleCommitment);

        swept[travelRuleCommitment] = true;

        if (!IERC20Min(tokenIn).transferFrom(msg.sender, address(this), amountIn)) revert PullFailed();
        IERC20Min(tokenIn).approve(address(ROUTER), amountIn);

        address reserve_ = reserve;
        amountOut = ROUTER.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: reserve_,
                fee: poolFee,
                recipient: address(this),
                amountIn: amountIn,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );

        totalSwept += amountOut;
        emit FeeSwept(travelRuleCommitment, tokenIn, amountIn, reserve_, amountOut, poolFee);
    }

    /// @notice Sweep several proofs' fees in one transaction.
    /// @dev Fees accrue one proof at a time but are swept in batches, because a
    ///      treasury that must send one transaction per fee is a treasury that
    ///      quietly stops sweeping. Each proof still gets its own `FeeSwept`, so
    ///      batching changes the gas and nothing else: the audit trail is
    ///      identical to sweeping them one by one.
    ///
    ///      `minOut` stays per-proof rather than per-batch. A single total would
    ///      let a good price on one fee hide a bad one on another.
    function sweepMany(
        bytes32[] calldata commitments,
        address[] calldata tokensIn,
        uint24[] calldata poolFees,
        uint256[] calldata amountsIn,
        uint256[] calldata minOuts
    ) external returns (uint256 totalOut) {
        uint256 n = commitments.length;
        if (
            tokensIn.length != n || poolFees.length != n || amountsIn.length != n || minOuts.length != n || n == 0
        ) revert LengthMismatch();
        for (uint256 i = 0; i < n; i++) {
            totalOut += _sweep(commitments[i], tokensIn[i], poolFees[i], amountsIn[i], minOuts[i]);
        }
    }

    /// @notice Move reserve out of the treasury. Admin only, and it can never
    ///         reach an escrow or an invoice: this contract holds only revenue.
    function withdraw(address token, address to, uint256 amount) external onlyAdmin {
        if (to == address(0)) revert ZeroAddress();
        if (!IERC20Min(token).transfer(to, amount)) revert PullFailed();
        emit Withdrawn(token, to, amount);
    }

    function reserveBalance() external view returns (uint256) {
        return IERC20Min(reserve).balanceOf(address(this));
    }
}
