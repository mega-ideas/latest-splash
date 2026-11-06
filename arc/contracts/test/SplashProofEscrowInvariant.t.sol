// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {SplashProofEscrow} from "../SplashProofEscrow.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @dev The only surface the invariant fuzzer drives. No direct donations to the escrow.
contract EscrowHandler is Test {
    address internal constant ROUTER = 0xdE4E7FED43FAC37EB21aA0643d9852f75332eab8;
    uint64 internal constant SRC = 16015286601757825753;

    SplashProofEscrow public immutable escrow;
    MockUSDC public immutable usdc;
    address public immutable vasp;
    address public immutable ackSender;
    address public immutable feeRecipient;

    address[] public recipients;
    bytes32[] public refs;
    uint256 public ghostOpenSum;
    mapping(uint256 => SplashProofEscrow.Status) public seenTerminal;
    bool public terminalViolated;

    constructor(
        SplashProofEscrow e,
        MockUSDC u,
        address vasp_,
        address ackSender_,
        address feeRecipient_,
        address[] memory recipients_
    ) {
        escrow = e;
        usdc = u;
        vasp = vasp_;
        ackSender = ackSender_;
        feeRecipient = feeRecipient_;
        recipients = recipients_;
        usdc.approve(address(e), type(uint256).max);
    }

    function refCount() external view returns (uint256) {
        return refs.length;
    }

    function recipientCount() external view returns (uint256) {
        return recipients.length;
    }

    function _status(bytes32 ref) internal view returns (SplashProofEscrow.Status s) {
        (,,,,,,,, s) = escrow.payments(ref);
    }

    function _commit(bytes32 ref) internal pure returns (bytes32) {
        return keccak256(abi.encode(ref, "commit"));
    }

    function _pick(uint256 seed) internal view returns (bool ok, uint256 idx, bytes32 ref) {
        if (refs.length == 0) return (false, 0, bytes32(0));
        idx = seed % refs.length;
        return (true, idx, refs[idx]);
    }

    /// @dev Records terminal states and flags any terminal -> other transition. Maintains the ghost sum.
    function _afterAction(uint256 idx, uint256 amountIfLeftOpen) internal {
        // idx's status after the action
        bytes32 ref = refs[idx];
        SplashProofEscrow.Status s = _status(ref);
        SplashProofEscrow.Status prev = seenTerminal[idx];
        if (prev != SplashProofEscrow.Status.None && s != prev) terminalViolated = true;
        if (s == SplashProofEscrow.Status.Released || s == SplashProofEscrow.Status.Refunded) {
            if (prev == SplashProofEscrow.Status.None) ghostOpenSum -= amountIfLeftOpen;
            seenTerminal[idx] = s;
        }
    }

    function _amount(bytes32 ref) internal view returns (uint256 a) {
        (,,, a,,,,,) = escrow.payments(ref);
    }

    function open(uint256 amountSeed, uint256 maxFeeSeed, uint256 recipientSeed, uint256 expirySeed, bool remote)
        external
    {
        uint256 amount = bound(amountSeed, 1, 1e12);
        uint256 maxFee = bound(maxFeeSeed, 0, amount);
        address rec = recipients[recipientSeed % recipients.length];
        uint64 exp = uint64(block.timestamp + bound(expirySeed, 1, 3 days));
        bytes32 ref = keccak256(abi.encode("ref", refs.length));

        usdc.mint(address(this), amount);
        try escrow.open(ref, rec, vasp, amount, maxFee, _commit(ref), exp, remote) {
            refs.push(ref);
            ghostOpenSum += amount;
        } catch {
            // handler may be blocklisted -> open reverts; mint stays with handler (not the escrow)
        }
    }

    function ackRemote(uint256 refSeed, uint8 mutate) external {
        (bool ok, uint256 idx, bytes32 ref) = _pick(refSeed);
        if (!ok) return;
        address v = vasp;
        bytes32 c = _commit(ref);
        if (mutate % 8 == 1) v = address(0xBEEF);
        if (mutate % 8 == 2) c = bytes32(uint256(1));
        uint256 amount = _amount(ref);
        Client.Any2EVMMessage memory m = Client.Any2EVMMessage({
            messageId: keccak256(abi.encode("msg", refSeed, block.timestamp)),
            sourceChainSelector: SRC,
            sender: abi.encode(ackSender),
            data: abi.encode(ref, v, c, keccak256("ack")),
            destTokenAmounts: new Client.EVMTokenAmount[](0)
        });
        vm.prank(ROUTER);
        escrow.ccipReceive(m); // must never revert for authenticated messages
        _afterAction(idx, amount);
    }

    function ackLocal(uint256 refSeed) external {
        (bool ok, uint256 idx, bytes32 ref) = _pick(refSeed);
        if (!ok) return;
        uint256 amount = _amount(ref);
        vm.prank(vasp);
        try escrow.ackLocal(ref, _commit(ref), keccak256("ack")) {} catch {}
        _afterAction(idx, amount);
    }

    function refund(uint256 refSeed) external {
        (bool ok, uint256 idx, bytes32 ref) = _pick(refSeed);
        if (!ok) return;
        uint256 amount = _amount(ref);
        try escrow.refund(ref) {} catch {}
        _afterAction(idx, amount);
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 0, 2 days));
    }

    /// @dev Blocklist toggling on recipients, the fee recipient and the handler (the payer).
    function blocklist(uint256 targetSeed, bool blocked) external {
        uint256 n = recipients.length + 2;
        uint256 i = targetSeed % n;
        address target = i < recipients.length ? recipients[i] : (i == recipients.length ? feeRecipient : address(this));
        usdc.setBlocked(target, blocked);
    }

    /// @dev Sum of amounts of payments currently Open, read from contract state.
    function openSumFromState() external view returns (uint256 sum) {
        for (uint256 i; i < refs.length; ++i) {
            (,,, uint256 a,,,,, SplashProofEscrow.Status s) = escrow.payments(refs[i]);
            if (s == SplashProofEscrow.Status.Open) sum += a;
        }
    }

    function allHoldersBalance() external view returns (uint256 sum) {
        sum = usdc.balanceOf(address(escrow)) + usdc.balanceOf(address(this)) + usdc.balanceOf(feeRecipient);
        for (uint256 i; i < recipients.length; ++i) sum += usdc.balanceOf(recipients[i]);
    }
}

contract SplashProofEscrowInvariantTest is Test {
    address internal constant USDC_ADDR = 0x3600000000000000000000000000000000000000;
    address internal constant ROUTER = 0xdE4E7FED43FAC37EB21aA0643d9852f75332eab8;
    uint64 internal constant SRC = 16015286601757825753;

    MockUSDC internal usdc;
    SplashProofEscrow internal escrow;
    EscrowHandler internal handler;

    function setUp() public {
        vm.warp(1_700_000_000);
        MockUSDC impl = new MockUSDC();
        vm.etch(USDC_ADDR, address(impl).code);
        usdc = MockUSDC(USDC_ADDR);

        address owner = makeAddr("owner");
        address feeRecipient = makeAddr("feeRecipient");
        address vasp = makeAddr("vasp");
        address ackSender = makeAddr("ackSender");

        escrow = new SplashProofEscrow(owner, ROUTER, feeRecipient, 100);
        vm.prank(owner);
        escrow.setAckSender(SRC, ackSender);

        address[] memory recipients = new address[](3);
        recipients[0] = makeAddr("r0");
        recipients[1] = makeAddr("r1");
        recipients[2] = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;

        handler = new EscrowHandler(escrow, usdc, vasp, ackSender, feeRecipient, recipients);
        targetContract(address(handler));

        bytes4[] memory selectors = new bytes4[](6);
        selectors[0] = EscrowHandler.open.selector;
        selectors[1] = EscrowHandler.ackRemote.selector;
        selectors[2] = EscrowHandler.ackLocal.selector;
        selectors[3] = EscrowHandler.refund.selector;
        selectors[4] = EscrowHandler.warp.selector;
        selectors[5] = EscrowHandler.blocklist.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// USDC.balanceOf(escrow) == sum of Open payment amounts (no donations in the handler).
    function invariant_escrowBalanceEqualsOpenAmounts() public view {
        assertEq(usdc.balanceOf(address(escrow)), handler.openSumFromState());
    }

    /// Handler's independent ledger agrees with the contract's state and the token balance.
    function invariant_ghostLedgerMatches() public view {
        assertEq(handler.ghostOpenSum(), handler.openSumFromState());
        assertEq(usdc.balanceOf(address(escrow)), handler.ghostOpenSum());
    }

    /// Released / Refunded payments never go back to Open (or change at all).
    function invariant_terminalStatesAreFinal() public view {
        assertFalse(handler.terminalViolated());
        uint256 n = handler.refCount();
        for (uint256 i; i < n; ++i) {
            SplashProofEscrow.Status seen = handler.seenTerminal(i);
            if (seen != SplashProofEscrow.Status.None) {
                (,,,,,,,, SplashProofEscrow.Status now_) = escrow.payments(handler.refs(i));
                assertEq(uint8(now_), uint8(seen));
            }
        }
    }

    /// Conservation: all minted USDC sits with known holders (nothing created or lost).
    function invariant_supplyConserved() public view {
        assertEq(usdc.totalSupply(), handler.allHoldersBalance());
    }
}
