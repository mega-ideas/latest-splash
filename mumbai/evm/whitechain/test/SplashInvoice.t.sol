// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SplashInvoice} from "../src/SplashInvoice.sol";

/// A USDT stand-in with EIP-3009, matching the official Whitechain token's
/// 6 decimals. The real token is 0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7.
contract MockUSDT {
    mapping(address => uint256) public balanceOf;
    mapping(bytes32 => bool) public usedNonce;
    bool public honourPartially;

    function mint(address to, uint256 v) external {
        balanceOf[to] += v;
    }

    function setHonourPartially(bool on) external {
        honourPartially = on;
    }

    function transfer(address to, uint256 v) external returns (bool) {
        require(balanceOf[msg.sender] >= v, "balance");
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
        return true;
    }

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256,
        uint256 validBefore,
        bytes32 nonce,
        uint8,
        bytes32,
        bytes32
    ) external {
        require(block.timestamp <= validBefore, "expired");
        require(!usedNonce[nonce], "nonce");
        usedNonce[nonce] = true;
        uint256 moved = honourPartially ? value / 2 : value;
        require(balanceOf[from] >= moved, "balance");
        balanceOf[from] -= moved;
        balanceOf[to] += moved;
    }
}

contract SplashInvoiceTest is Test {
    MockUSDT internal usdt;
    SplashInvoice internal inv;

    address internal admin = address(0xA11CE);
    address internal merchant = address(0x3E12);
    address internal customer = address(0xC057);
    address internal splashFees = address(0x5915);
    address internal attestor = address(0xA77E);
    address internal relayer = address(0xDEAD);

    bytes32 internal constant ID = keccak256("INV-MUM-0001");
    bytes32 internal constant COMMITMENT = 0x511e7db0bc7c2eb83461ff5733b5954bf8ac22bfcb6c4816193bb4f7594430c4;
    uint256 internal constant AMOUNT = 100_000_000; // 100.000000 USDT

    function setUp() public {
        usdt = new MockUSDT();
        inv = new SplashInvoice(address(usdt), admin, splashFees, 15); // 15 bps
        vm.prank(admin);
        inv.setAttestor(attestor, true);
        usdt.mint(customer, 1_000_000_000);
    }

    function _create() internal {
        vm.prank(merchant);
        inv.createInvoice(ID, AMOUNT, uint64(block.timestamp + 1 days), COMMITMENT);
    }

    function _pay() internal {
        vm.prank(relayer);
        inv.payWithAuthorization(ID, customer, 0, block.timestamp + 1 hours, keccak256("n1"), 0, 0, 0);
    }

    /// The merchant is paid at once; only the fee waits.
    function test_merchantPaidImmediatelyFeeHeld() public {
        _create();
        _pay();
        uint256 fee = (AMOUNT * 15) / 10_000;
        assertEq(usdt.balanceOf(merchant), AMOUNT - fee, "merchant has its net at once");
        assertEq(usdt.balanceOf(address(inv)), fee, "only the fee is held");
        assertEq(usdt.balanceOf(splashFees), 0, "splash is not paid yet");
    }

    /// The customer never needs the chain's gas token: a relayer submits it.
    function test_relayerSubmitsAndCustomerNeedsNoGasToken() public {
        _create();
        assertEq(relayer.balance, 0, "the relayer is the only account that spends gas");
        _pay();
        assertEq(usdt.balanceOf(customer), 1_000_000_000 - AMOUNT, "the customer paid in USDT only");
    }

    /// The only path that pays Splash.
    function test_proofReleasesTheFee() public {
        _create();
        _pay();
        uint256 fee = (AMOUNT * 15) / 10_000;
        vm.prank(attestor);
        inv.recordProof(ID, COMMITMENT);
        assertEq(usdt.balanceOf(splashFees), fee, "fee paid on proof");
        assertEq(usdt.balanceOf(address(inv)), 0, "nothing left held");
    }

    /// No proof: the fee goes to the merchant, never back to Splash.
    function test_noProofMeansTheMerchantKeepsTheFee() public {
        _create();
        _pay();
        uint256 fee = (AMOUNT * 15) / 10_000;
        vm.warp(block.timestamp + 8 days);
        inv.forfeitFee(ID); // anyone may call it
        assertEq(usdt.balanceOf(merchant), AMOUNT, "merchant ends up with the whole amount");
        assertEq(usdt.balanceOf(splashFees), 0, "splash earned nothing");
    }

    function test_feeCannotBeTakenBeforeTheWindowCloses() public {
        _create();
        _pay();
        vm.expectRevert(SplashInvoice.ProofWindowOpen.selector);
        inv.forfeitFee(ID);
    }

    function test_onlyAttestorRecordsProof() public {
        _create();
        _pay();
        vm.prank(relayer);
        vm.expectRevert(SplashInvoice.NotAttestor.selector);
        inv.recordProof(ID, COMMITMENT);
    }

    function test_wrongCommitmentIsRefused() public {
        _create();
        _pay();
        vm.prank(attestor);
        vm.expectRevert(SplashInvoice.NoSuchInvoice.selector);
        inv.recordProof(ID, keccak256("not the commitment"));
    }

    function test_doublePaymentRefused() public {
        _create();
        _pay();
        vm.prank(relayer);
        vm.expectRevert(SplashInvoice.WrongStatus.selector);
        inv.payWithAuthorization(ID, customer, 0, block.timestamp + 1 hours, keccak256("n2"), 0, 0, 0);
    }

    /// A partially honoured authorisation must not leave the merchant short.
    function test_underfundedAuthorisationReverts() public {
        _create();
        usdt.setHonourPartially(true);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(SplashInvoice.Underfunded.selector, AMOUNT, AMOUNT / 2));
        inv.payWithAuthorization(ID, customer, 0, block.timestamp + 1 hours, keccak256("n3"), 0, 0, 0);
    }

    function test_feeCapIsOnePercent() public {
        vm.expectRevert(SplashInvoice.FeeTooHigh.selector);
        new SplashInvoice(address(usdt), admin, splashFees, 101);
    }

    /// However the amount falls, the fee never exceeds the cap and the merchant
    /// plus Splash always receive exactly the amount.
    function testFuzz_feeNeverExceedsCapAndNothingIsLost(uint96 amount) public {
        amount = uint96(bound(amount, 1, 1e12));
        bytes32 id = keccak256(abi.encode("fuzz", amount));
        vm.prank(merchant);
        inv.createInvoice(id, amount, uint64(block.timestamp + 1 days), COMMITMENT);
        usdt.mint(customer, amount);

        vm.prank(relayer);
        inv.payWithAuthorization(id, customer, 0, block.timestamp + 1 hours, keccak256(abi.encode(amount)), 0, 0, 0);

        SplashInvoice.Invoice memory got = inv.getInvoice(id);
        assertLe(got.feeAmount * 10_000, uint256(amount) * 100, "fee within the 1% ceiling");
        assertEq(got.amount - got.feeAmount + got.feeAmount, amount, "nothing is lost in the split");
    }
}
