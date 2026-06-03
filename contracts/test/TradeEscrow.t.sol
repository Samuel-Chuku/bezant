// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {TradeEscrow} from "../src/TradeEscrow.sol";
import {TradePassport} from "../src/TradePassport.sol";
import {FinancingPool} from "../src/FinancingPool.sol";
import {MockUSDC} from "./helpers/MockUSDC.sol";
import {MockYieldVault} from "./helpers/MockYieldVault.sol";

contract TradeEscrowTest is Test {
    MockUSDC usdc;
    TradePassport passport;
    FinancingPool pool;
    TradeEscrow escrow;

    address buyer = makeAddr("buyer");
    address seller = makeAddr("seller");
    address agent = makeAddr("agent"); // the Trade Officer agent = whitelisted attester

    uint256 constant USD = 1e6; // 6 decimals
    uint256 constant AMT = 10_000 * USD;

    function setUp() public {
        usdc = new MockUSDC();
        passport = new TradePassport();
        pool = new FinancingPool(address(usdc));
        escrow = new TradeEscrow(address(usdc), address(passport));

        // wiring (this test contract is the owner of all three)
        passport.setWriter(address(escrow), true);
        pool.setEscrow(address(escrow));
        escrow.setFinancingPool(address(pool));
        escrow.setAttester(agent, true);

        // fund actors
        usdc.mint(buyer, 1_000_000 * USD);
        usdc.mint(address(this), 1_000_000 * USD); // to seed the pool
        usdc.approve(address(pool), type(uint256).max);
        pool.fund(100_000 * USD);

        vm.prank(buyer);
        usdc.approve(address(escrow), type(uint256).max);
    }

    function _open(uint256 amount) internal returns (uint256 id) {
        vm.prank(buyer);
        id = escrow.createTrade(seller, amount, keccak256("textiles"), uint48(block.timestamp + 7 days), agent);
    }

    // The headline demo: the passport mechanically drops the deposit on trade 2.
    function test_TwoTradeArc_PassportDropsDeposit() public {
        uint256 id1 = _open(AMT);
        assertEq(escrow.depositOf(id1), AMT, "trade 1 = 100% deposit");

        vm.prank(buyer);
        escrow.fund(id1);
        vm.prank(agent);
        escrow.attest(id1, keccak256("BoL"), true);
        escrow.release(id1);

        assertEq(usdc.balanceOf(seller), AMT, "seller paid in full");
        assertEq(passport.completed(buyer), 1, "passport recorded the completion");

        // trade 2: same buyer, deposit now floored to tier 1 (30%)
        uint256 id2 = _open(AMT);
        assertEq(escrow.depositOf(id2), 3_000 * USD, "trade 2 = 30% deposit (passport priced)");
    }

    function test_Attest_OnlyAssignedAttester() public {
        uint256 id = _open(AMT);
        vm.prank(buyer);
        escrow.fund(id);

        vm.prank(seller); // not the attester
        vm.expectRevert(TradeEscrow.NotAttester.selector);
        escrow.attest(id, keccak256("x"), true);
    }

    function test_CreateTrade_RejectsUnauthorizedAttester() public {
        vm.prank(buyer);
        vm.expectRevert(TradeEscrow.BadAttester.selector);
        escrow.createTrade(seller, AMT, keccak256("x"), uint48(block.timestamp + 1 days), seller);
    }

    function test_Refund_AfterDeadline() public {
        uint256 id = _open(AMT);
        vm.prank(buyer);
        escrow.fund(id);

        uint256 balBefore = usdc.balanceOf(buyer);
        vm.warp(block.timestamp + 8 days);
        escrow.refund(id);
        assertEq(usdc.balanceOf(buyer), balBefore + AMT, "buyer refunded deposit");
    }

    // Seller advanced at attestation; pool repaid from escrow on release.
    function test_Financing_AdvanceThenRepaidOnRelease() public {
        uint256 id = _open(AMT);
        vm.prank(buyer);
        escrow.fund(id);
        vm.prank(agent);
        escrow.attest(id, keccak256("BoL"), true);

        uint256 poolBefore = usdc.balanceOf(address(pool));

        vm.prank(seller);
        escrow.requestFinancing(id);

        // tier 0 buyer => 3% fee on an 80% advance (8_000 USDC gross)
        uint256 gross = 8_000 * USD;
        uint256 fee = (gross * 300) / 10000; // 240 USDC
        assertEq(usdc.balanceOf(seller), gross - fee, "seller got advance net of fee");
        assertEq(usdc.balanceOf(address(pool)), poolBefore - (gross - fee), "pool paid out the advance");

        escrow.release(id);

        // pool reclaims the gross (8_000), netting +fee vs its payout; seller ends whole-minus-fee
        assertEq(usdc.balanceOf(address(pool)), poolBefore + fee, "pool made its fee margin");
        assertEq(usdc.balanceOf(seller), AMT - fee, "seller total = invoice minus financing fee");
    }

    // USYC yield on the locked deposit, split buyer/seller/pool on release.
    function test_USYC_YieldSplitOnRelease() public {
        MockYieldVault vault = new MockYieldVault(address(usdc));
        escrow.setYieldVault(address(vault));

        uint256 id = _open(AMT);
        vm.prank(buyer);
        escrow.fund(id); // AMT parked into USYC

        // simulate 1% yield by minting 100 USDC into the vault
        uint256 yield_ = 100 * USD;
        usdc.mint(address(vault), yield_);

        vm.prank(agent);
        escrow.attest(id, keccak256("BoL"), true);

        uint256 buyerBefore = usdc.balanceOf(buyer);
        uint256 poolBefore = usdc.balanceOf(address(pool));
        escrow.release(id);

        uint256 buyerCut = (yield_ * 4000) / 10000;
        uint256 poolCut = (yield_ * 3000) / 10000;
        uint256 sellerCut = yield_ - buyerCut - poolCut;

        assertEq(usdc.balanceOf(buyer) - buyerBefore, buyerCut, "buyer yield slice");
        assertEq(usdc.balanceOf(address(pool)) - poolBefore, poolCut, "pool yield slice");
        assertEq(usdc.balanceOf(seller), AMT + sellerCut, "seller principal + yield slice");
    }

    function test_Dispute_ArbitratorRefundsBuyer() public {
        uint256 id = _open(AMT);
        vm.prank(buyer);
        escrow.fund(id);

        vm.prank(buyer);
        escrow.raiseDispute(id);

        uint256 balBefore = usdc.balanceOf(buyer);
        escrow.resolveDispute(id, false); // arbitrator = this test contract (owner)
        assertEq(usdc.balanceOf(buyer), balBefore + AMT, "buyer made whole on dispute");
        assertEq(passport.failed(buyer), 1, "failure recorded");
    }
}
