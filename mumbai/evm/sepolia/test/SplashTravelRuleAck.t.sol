// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {SplashTravelRuleAck} from "../src/SplashTravelRuleAck.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {ExtraArgsCodec} from "@chainlink/contracts-ccip/contracts/libraries/ExtraArgsCodec.sol";

/// Unit tests run against a stub router, so they need no network.
contract StubRouter {
    uint256 public fee = 0.0001 ether;
    bytes32 public constant MESSAGE_ID = keccak256("stub-message");
    uint64 public lastSelector;
    bytes public lastExtraArgs;
    bytes public lastData;
    bytes public lastReceiver;
    uint256 public lastValue;

    function setFee(uint256 f) external {
        fee = f;
    }

    function getFee(uint64, Client.EVM2AnyMessage memory) external view returns (uint256) {
        return fee;
    }

    function ccipSend(uint64 selector, Client.EVM2AnyMessage memory message) external payable returns (bytes32) {
        lastSelector = selector;
        lastExtraArgs = message.extraArgs;
        lastData = message.data;
        lastReceiver = message.receiver;
        lastValue = msg.value;
        return MESSAGE_ID;
    }
}

contract SplashTravelRuleAckTest is Test {
    StubRouter internal router;
    SplashTravelRuleAck internal ack;

    address internal admin = address(0xA11CE);
    address internal vasp = address(0xBEEF);
    address internal escrow = address(0xE5C0);
    uint64 internal constant ARC_SELECTOR = 3034092155422581607;

    bytes32 internal constant PAYMENT_REF = keccak256("SPL-MUM-A-0001");
    bytes32 internal constant COMMITMENT = 0x511e7db0bc7c2eb83461ff5733b5954bf8ac22bfcb6c4816193bb4f7594430c4;
    bytes32 internal constant ACK_HASH = keccak256("vasp-ack-1");

    function setUp() public {
        router = new StubRouter();
        ack = new SplashTravelRuleAck(address(router), ARC_SELECTOR, escrow, admin);
        vm.prank(admin);
        ack.setVasp(vasp, true);
        vm.deal(vasp, 10 ether);
    }

    function test_onlyAllowlistedVaspMayAcknowledge() public {
        address stranger = address(0xDEAD);
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SplashTravelRuleAck.NotAllowlistedVasp.selector, stranger));
        ack.acknowledge{value: 1 ether}(PAYMENT_REF, COMMITMENT, ACK_HASH);
    }

    function test_rejectsEmptyRefAndCommitment() public {
        vm.startPrank(vasp);
        vm.expectRevert(SplashTravelRuleAck.ZeroPaymentRef.selector);
        ack.acknowledge{value: 1 ether}(bytes32(0), COMMITMENT, ACK_HASH);
        vm.expectRevert(SplashTravelRuleAck.ZeroCommitment.selector);
        ack.acknowledge{value: 1 ether}(PAYMENT_REF, bytes32(0), ACK_HASH);
        vm.stopPrank();
    }

    function test_rejectsUnderpayment() public {
        router.setFee(1 ether);
        vm.prank(vasp);
        vm.expectRevert(abi.encodeWithSelector(SplashTravelRuleAck.InsufficientFee.selector, 1 ether, 0.5 ether));
        ack.acknowledge{value: 0.5 ether}(PAYMENT_REF, COMMITMENT, ACK_HASH);
    }

    /// The message must carry exactly what the escrow decodes, or the release
    /// is rejected on the far side for a mismatch nobody can debug from Arc.
    function test_messageCarriesRefVaspCommitmentAndAckHash() public {
        vm.prank(vasp);
        ack.acknowledge{value: 1 ether}(PAYMENT_REF, COMMITMENT, ACK_HASH);

        (bytes32 ref, address sender, bytes32 commitment, bytes32 ackHash) =
            abi.decode(router.lastData(), (bytes32, address, bytes32, bytes32));
        assertEq(ref, PAYMENT_REF, "payment ref");
        assertEq(sender, vasp, "vasp is the caller, never the body");
        assertEq(commitment, COMMITMENT, "commitment");
        assertEq(ackHash, ACK_HASH, "ack hash");

        assertEq(abi.decode(router.lastReceiver(), (address)), escrow, "receiver is the escrow");
        assertEq(router.lastSelector(), ARC_SELECTOR, "destination is Arc");
    }

    /// CCIP 2.0: the acknowledgement carries no value, so it asks for a block
    /// depth rather than waiting for full finality.
    function test_extraArgsAreV3WithBlockDepth() public {
        vm.prank(vasp);
        ack.acknowledge{value: 1 ether}(PAYMENT_REF, COMMITMENT, ACK_HASH);

        bytes memory args = router.lastExtraArgs();
        bytes4 tag;
        assembly {
            tag := mload(add(args, 32))
        }
        assertEq(tag, ExtraArgsCodec.GENERIC_EXTRA_ARGS_V3_TAG, "GenericExtraArgsV3 tag");
        assertEq(args, ExtraArgsCodec._getBasicEncodedExtraArgsV3BlockDepth(1_200_000, 5), "gas limit and depth 5");
    }

    function test_blockDepthZeroWaitsForFinality() public {
        vm.prank(admin);
        ack.setExecutionPolicy(1_200_000, 0);
        vm.prank(vasp);
        ack.acknowledge{value: 1 ether}(PAYMENT_REF, COMMITMENT, ACK_HASH);
        assertEq(
            router.lastExtraArgs(),
            ExtraArgsCodec._getBasicEncodedExtraArgsV3(1_200_000, bytes4(0)),
            "finality config zero"
        );
    }

    /// Overpaying must not strand ETH in the sender.
    function test_excessIsRefunded() public {
        router.setFee(0.01 ether);
        uint256 before = vasp.balance;
        vm.prank(vasp);
        ack.acknowledge{value: 1 ether}(PAYMENT_REF, COMMITMENT, ACK_HASH);
        assertEq(router.lastValue(), 0.01 ether, "router paid exactly the fee");
        assertEq(vasp.balance, before - 0.01 ether, "the rest came back");
        assertEq(address(ack).balance, 0, "sender holds nothing");
    }

    function test_onlyAdminMayConfigure() public {
        vm.prank(vasp);
        vm.expectRevert(SplashTravelRuleAck.NotAdmin.selector);
        ack.setVasp(address(0x1234), true);

        vm.prank(vasp);
        vm.expectRevert(SplashTravelRuleAck.NotAdmin.selector);
        ack.setDestination(ARC_SELECTOR, address(0x1234));
    }

    function testFuzz_anyAllowlistedVaspCanAcknowledge(address who, bytes32 ref, bytes32 commitment) public {
        vm.assume(who != address(0) && who.code.length == 0 && ref != bytes32(0) && commitment != bytes32(0));
        vm.assume(who != address(router) && who != address(ack));
        vm.prank(admin);
        ack.setVasp(who, true);
        vm.deal(who, 1 ether);
        vm.prank(who);
        bytes32 id = ack.acknowledge{value: 1 ether}(ref, commitment, ACK_HASH);
        assertEq(id, router.MESSAGE_ID());
    }
}

/// Fork test: quote a real fee from the live Sepolia router for the exact
/// message we would send. Run with SEPOLIA_RPC set.
contract SplashTravelRuleAckForkTest is Test {
    address internal constant SEPOLIA_ROUTER = 0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59;
    uint64 internal constant ARC_SELECTOR = 3034092155422581607;

    function test_fork_getFeeFromLiveRouter() public {
        string memory rpc = vm.envOr("SEPOLIA_RPC", string(""));
        if (bytes(rpc).length == 0) {
            console.log("SEPOLIA_RPC not set, skipping fork test");
            return;
        }
        // Public Sepolia nodes prune, so a pinned, settled block is far more
        // reliable than "latest" for reading the router's state.
        uint256 pinned = vm.envOr("SEPOLIA_FORK_BLOCK", uint256(0));
        if (pinned == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, pinned);

        SplashTravelRuleAck ack =
            new SplashTravelRuleAck(SEPOLIA_ROUTER, ARC_SELECTOR, address(0xE5C0), address(this));

        uint256 fee = ack.getFee(
            keccak256("SPL-MUM-A-0001"),
            address(0xBEEF),
            0x511e7db0bc7c2eb83461ff5733b5954bf8ac22bfcb6c4816193bb4f7594430c4,
            keccak256("vasp-ack-1")
        );
        console.log("live CCIP fee for the acknowledgement (wei):", fee);
        assertGt(fee, 0, "the lane quotes a fee, so it is open");
    }
}
