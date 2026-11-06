// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {SplashProofEscrow} from "../SplashProofEscrow.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @dev Shared fixtures. Contains no test_/invariant_ functions (every category inherits it).
abstract contract SplashProofEscrowBase is Test {
    address internal constant USDC_ADDR = 0x3600000000000000000000000000000000000000;
    address internal constant ROUTER = 0xdE4E7FED43FAC37EB21aA0643d9852f75332eab8;
    address internal constant BLOCKED_RECIPIENT = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    uint64 internal constant SRC = 16015286601757825753; // Ethereum Sepolia selector
    uint64 internal constant OTHER_SRC = 3478487238524512106; // Arbitrum Sepolia selector

    uint16 internal constant FEE_BPS = 50;
    uint256 internal constant AMOUNT = 1_000e6;
    uint256 internal constant MAX_FEE = 10e6;
    uint256 internal constant FEE = 5e6; // 1000e6 * 50 / 10000
    uint256 internal constant NET = AMOUNT - FEE;

    bytes32 internal constant REF = keccak256("payment-ref-1");
    bytes32 internal constant COMMIT = keccak256("travel-rule-commitment");
    bytes32 internal constant ACK_HASH = keccak256("ack-hash");
    bytes32 internal constant MSG_ID = keccak256("ccip-message-id");

    MockUSDC internal usdc;
    SplashProofEscrow internal escrow;

    address internal owner = makeAddr("owner");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal payer = makeAddr("payer");
    address internal recipient = makeAddr("recipient");
    address internal vasp = makeAddr("vasp");
    address internal ackSender = makeAddr("ackSender");
    address internal alice = makeAddr("alice");

    uint64 internal expiry;

    function setUp() public virtual {
        vm.warp(1_700_000_000);
        expiry = uint64(block.timestamp + 1 days);

        // Put mock USDC runtime code at the hardcoded USDC address (storage starts empty).
        MockUSDC impl = new MockUSDC();
        vm.etch(USDC_ADDR, address(impl).code);
        usdc = MockUSDC(USDC_ADDR);

        escrow = new SplashProofEscrow(owner, ROUTER, feeRecipient, FEE_BPS);
        vm.prank(owner);
        escrow.setAckSender(SRC, ackSender);

        usdc.mint(payer, 1_000_000e6);
        vm.prank(payer);
        usdc.approve(address(escrow), type(uint256).max);
    }

    // ---------------------------------------------------------------- helpers
    function _openWith(
        SplashProofEscrow e,
        bytes32 ref,
        address rec,
        uint256 amount,
        uint256 maxFee,
        uint64 exp,
        bool remote
    ) internal {
        vm.prank(payer);
        e.open(ref, rec, vasp, amount, maxFee, COMMIT, exp, remote);
    }

    function _open(bytes32 ref, bool remote) internal {
        _openWith(escrow, ref, recipient, AMOUNT, MAX_FEE, expiry, remote);
    }

    function _status(bytes32 ref) internal view returns (SplashProofEscrow.Status s) {
        (,,,,,,,, s) = escrow.payments(ref);
    }

    function _data(bytes32 ref, address v, bytes32 commitment, bytes32 ackHash) internal pure returns (bytes memory) {
        return abi.encode(ref, v, commitment, ackHash);
    }

    function _msg(bytes32 id, uint64 src, bytes memory sender, bytes memory data)
        internal
        pure
        returns (Client.Any2EVMMessage memory m)
    {
        m = Client.Any2EVMMessage({
            messageId: id,
            sourceChainSelector: src,
            sender: sender,
            data: data,
            destTokenAmounts: new Client.EVMTokenAmount[](0)
        });
    }

    function _stdMsg(bytes32 ref, address v, bytes32 commitment) internal view returns (Client.Any2EVMMessage memory) {
        return _msg(MSG_ID, SRC, abi.encode(ackSender), _data(ref, v, commitment, ACK_HASH));
    }

    function _deliverTo(SplashProofEscrow e, Client.Any2EVMMessage memory m) internal {
        vm.prank(ROUTER);
        e.ccipReceive(m);
    }

    function _deliver(Client.Any2EVMMessage memory m) internal {
        _deliverTo(escrow, m);
    }

    /// @dev Standard, correctly-authenticated remote ack for REF.
    function _ackOk() internal {
        _deliver(_stdMsg(REF, vasp, COMMIT));
    }
}
