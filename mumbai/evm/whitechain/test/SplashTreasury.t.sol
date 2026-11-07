// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SplashTreasury, ISwapRouter02} from "../src/SplashTreasury.sol";

contract Token {
    string public symbol;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory s) { symbol = s; }
    function mint(address to, uint256 v) external { balanceOf[to] += v; }
    function approve(address sp, uint256 v) external returns (bool) { allowance[msg.sender][sp] = v; return true; }
    function transfer(address to, uint256 v) external returns (bool) {
        require(balanceOf[msg.sender] >= v, "bal");
        balanceOf[msg.sender] -= v; balanceOf[to] += v; return true;
    }
    function transferFrom(address f, address t, uint256 v) external returns (bool) {
        require(allowance[f][msg.sender] >= v, "allow");
        allowance[f][msg.sender] -= v;
        require(balanceOf[f] >= v, "bal");
        balanceOf[f] -= v; balanceOf[t] += v; return true;
    }
}

/// A router that honours amountOutMinimum, so the slippage guard is tested
/// rather than assumed.
contract StubRouter {
    Token public immutable OUT;
    uint256 public rateBps = 10_000; // 1:1 by default

    constructor(Token out) { OUT = out; }
    function setRate(uint256 bps) external { rateBps = bps; }

    function exactInputSingle(ISwapRouter02.ExactInputSingleParams calldata p) external returns (uint256) {
        Token(p.tokenIn).transferFrom(msg.sender, address(this), p.amountIn);
        uint256 out = (p.amountIn * rateBps) / 10_000;
        require(out >= p.amountOutMinimum, "Too little received");
        OUT.mint(p.recipient, out);
        return out;
    }
}

contract SplashTreasuryTest is Test {
    Token internal usdt;
    Token internal reserve;
    StubRouter internal router;
    SplashTreasury internal treasury;

    address internal admin = address(0xA11CE);
    address internal treasurer = address(0x7EA5);
    address internal stranger = address(0xDEAD);

    bytes32 internal constant C = 0x9dc8d5d0d1fc026cb5f53bde2d1e759274def1641c67c244649cd7cab3a0cded;
    uint256 internal constant FEE = 37_500; // 0.0375, the fee actually earned

    function setUp() public {
        usdt = new Token("USDT");
        reserve = new Token("USDY");
        router = new StubRouter(reserve);
        treasury = new SplashTreasury(admin, address(router), address(reserve));
        vm.prank(admin);
        treasury.setTreasurer(treasurer, true);
        usdt.mint(treasurer, 1_000_000);
        vm.prank(treasurer);
        usdt.approve(address(treasury), type(uint256).max);
    }

    function test_sweepsTheFeeIntoTheReserve() public {
        vm.prank(treasurer);
        uint256 out = treasury.sweep(C, address(usdt), 3000, FEE, 1);
        assertEq(out, FEE, "1:1 in the stub");
        assertEq(reserve.balanceOf(address(treasury)), FEE, "reserve held by the treasury");
        assertEq(treasury.totalSwept(), FEE);
    }

    /// The event is the point: the proof travels with the money.
    function test_theEventCarriesTheCommitment() public {
        vm.expectEmit(true, true, true, true);
        emit SplashTreasury.FeeSwept(C, address(usdt), FEE, address(reserve), FEE, 3000);
        vm.prank(treasurer);
        treasury.sweep(C, address(usdt), 3000, FEE, 1);
    }

    /// A fee is earned once, so it is swept once. Otherwise the sum of
    /// FeeSwept would be revenue plus retries.
    function test_oneSweepPerProof() public {
        vm.startPrank(treasurer);
        treasury.sweep(C, address(usdt), 3000, FEE, 1);
        vm.expectRevert(abi.encodeWithSelector(SplashTreasury.AlreadySwept.selector, C));
        treasury.sweep(C, address(usdt), 3000, FEE, 1);
        vm.stopPrank();
    }

    /// A sweep that accepts any price can be sandwiched.
    function test_minOutIsRequired() public {
        vm.prank(treasurer);
        vm.expectRevert(SplashTreasury.NoMinimumOut.selector);
        treasury.sweep(C, address(usdt), 3000, FEE, 0);
    }

    function test_slippageGuardBites() public {
        router.setRate(5_000); // price halves
        vm.prank(treasurer);
        vm.expectRevert(bytes("Too little received"));
        treasury.sweep(C, address(usdt), 3000, FEE, FEE); // demanded 1:1
    }

    function test_onlyATreasurerMaySweep() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SplashTreasury.NotTreasurer.selector, stranger));
        treasury.sweep(C, address(usdt), 3000, FEE, 1);
    }

    function test_onlyAdminConfigures() public {
        vm.prank(stranger);
        vm.expectRevert(SplashTreasury.NotAdmin.selector);
        treasury.setReserve(address(usdt));

        vm.prank(admin);
        treasury.setReserve(address(usdt));
        assertEq(treasury.reserve(), address(usdt), "reserve is settable: USDY in production, otherwise what exists");
    }

    function test_onlyAdminWithdraws() public {
        vm.prank(treasurer);
        treasury.sweep(C, address(usdt), 3000, FEE, 1);
        vm.prank(stranger);
        vm.expectRevert(SplashTreasury.NotAdmin.selector);
        treasury.withdraw(address(reserve), stranger, FEE);

        vm.prank(admin);
        treasury.withdraw(address(reserve), admin, FEE);
        assertEq(reserve.balanceOf(admin), FEE);
    }

    /// However many proofs are swept, totalSwept is their sum: the revenue
    /// figure an auditor reconciles against the registry.
    function testFuzz_totalIsTheSumOfSweeps(uint8 n, uint64 each) public {
        n = uint8(bound(n, 1, 20));
        each = uint64(bound(each, 1, 1_000));
        usdt.mint(treasurer, uint256(n) * each);
        for (uint256 i = 1; i <= n; i++) {
            vm.prank(treasurer);
            treasury.sweep(bytes32(i), address(usdt), 3000, each, 1);
        }
        assertEq(treasury.totalSwept(), uint256(n) * each);
    }
}
