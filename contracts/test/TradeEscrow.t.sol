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
    address agent = makeAddr("agent"); // Trade Officer = whitelisted attester

    uint256 constant USD = 1e6;
    uint256 constant AMT = 10_000 * USD;

    function setUp() public {
        usdc = new MockUSDC();
        passport = new TradePassport();
        pool = new FinancingPool(address(usdc));
        escrow = new TradeEscrow(address(usdc), address(passport));

        passport.setWriter(address(escrow), true);
        pool.setEscrow(address(escrow));
        escrow.setFinancingPool(address(pool));
        escrow.setAttester(agent, true);

        usdc.mint(buyer, 1_000_000 * USD);
        usdc.mint(address(this), 1_000_000 * USD);
        usdc.approve(address(pool), type(uint256).max);
        pool.fund(100_000 * USD);

        vm.prank(buyer);
        usdc.approve(address(escrow), type(uint256).max);
    }

    function _propose(uint256 amount) internal returns (uint256 id) {
        vm.prank(buyer);
        id = escrow.createTrade(seller, amount, keccak256("textiles"), uint48(block.timestamp + 7 days), agent);
    }

    // seller accepts the buyer's opening offer, then buyer funds
    function _agreeAndFund(uint256 amount) internal returns (uint256 id) {
        id = _propose(amount);
        vm.prank(seller);
        escrow.accept(id);
        vm.prank(buyer);
        escrow.fund(id);
    }

    // ── negotiation ─────────────────────────────────────────────────────────

    function test_Negotiation_MultiStepCounterThenAccept() public {
        uint256 id = _propose(AMT); // buyer proposes 10k, lastProposer = buyer
        vm.prank(seller);
        escrow.counter(id, 8_000 * USD); // seller counters down
        vm.prank(buyer);
        escrow.counter(id, 9_000 * USD); // buyer counters up
        vm.prank(seller);
        escrow.accept(id); // seller accepts buyer's standing 9k offer

        assertEq(escrow.amountOf(id), 9_000 * USD, "agreed at countered amount");
        assertEq(uint8(escrow.statusOf(id)), uint8(TradeEscrow.Status.Agreed), "status Agreed");
    }

    function test_CannotAcceptYourOwnOffer() public {
        uint256 id = _propose(AMT); // buyer is lastProposer
        vm.prank(buyer);
        vm.expectRevert(TradeEscrow.NotYourTurn.selector);
        escrow.accept(id);
    }

    function test_CannotCounterYourOwnOffer() public {
        uint256 id = _propose(AMT);
        vm.prank(buyer);
        vm.expectRevert(TradeEscrow.NotYourTurn.selector);
        escrow.counter(id, 1 * USD);
    }

    function test_CannotFundBeforeAgreed() public {
        uint256 id = _propose(AMT);
        vm.prank(buyer);
        vm.expectRevert(TradeEscrow.BadStatus.selector);
        escrow.fund(id);
    }

    function test_Cancel_BeforeFunding() public {
        uint256 id = _propose(AMT);
        vm.prank(seller);
        escrow.cancel(id);
        assertEq(uint8(escrow.statusOf(id)), uint8(TradeEscrow.Status.Cancelled), "cancelled");
    }

    // ── settlement ──────────────────────────────────────────────────────────

    // Headline: attest auto-settles (no release step) and the passport drops the next deposit.
    function test_AttestAutoSettles_AndPassportRecords() public {
        uint256 id = _agreeAndFund(AMT);
        assertEq(escrow.depositOf(id), AMT, "first trade = 100% deposit");

        vm.prank(agent);
        escrow.attest(id, keccak256("BoL"), true); // single call settles

        assertEq(uint8(escrow.statusOf(id)), uint8(TradeEscrow.Status.Released), "auto-released on attest");
        assertEq(usdc.balanceOf(seller), AMT, "seller paid in full");
        assertEq(passport.completed(buyer), 1, "passport recorded completion");

        // probation: 2nd trade still 100% (curve unchanged)
        uint256 id2 = _propose(AMT);
        assertEq(escrow.estimatedDeposit(id2), AMT, "trade 2 still 100% (probation)");
    }

    function test_Attest_OnlyAssignedAttester() public {
        uint256 id = _agreeAndFund(AMT);
        vm.prank(seller);
        vm.expectRevert(TradeEscrow.NotAttester.selector);
        escrow.attest(id, keccak256("x"), true);
    }

    function test_Refund_AfterDeadline() public {
        uint256 id = _agreeAndFund(AMT);
        uint256 before = usdc.balanceOf(buyer);
        vm.warp(block.timestamp + 8 days);
        escrow.refund(id);
        assertEq(usdc.balanceOf(buyer), before + AMT, "buyer refunded");
    }

    // Financing drawn during Funded, repaid when attest auto-settles.
    function test_Financing_DuringFunded_RepaidOnSettle() public {
        uint256 id = _agreeAndFund(AMT);
        uint256 poolBefore = usdc.balanceOf(address(pool));

        vm.prank(seller);
        escrow.requestFinancing(id);

        uint256 gross = 8_000 * USD;
        uint256 fee = (gross * 300) / 10000; // tier 0 => 3%
        assertEq(usdc.balanceOf(seller), gross - fee, "seller got advance net of fee");

        vm.prank(agent);
        escrow.attest(id, keccak256("BoL"), true);

        assertEq(usdc.balanceOf(address(pool)), poolBefore + fee, "pool made its fee margin");
        assertEq(usdc.balanceOf(seller), AMT - fee, "seller total = invoice minus fee");
    }

    function test_Dispute_ArbitratorRefundsBuyer() public {
        uint256 id = _agreeAndFund(AMT);
        vm.prank(buyer);
        escrow.raiseDispute(id);
        uint256 before = usdc.balanceOf(buyer);
        escrow.resolveDispute(id, false); // this test contract = arbitrator (owner)
        assertEq(usdc.balanceOf(buyer), before + AMT, "buyer made whole");
        assertEq(passport.failed(buyer), 1, "failure recorded");
    }

    // USYC yield accrues while locked; split buyer/seller/pool at auto-settle.
    function test_USYC_YieldSplitOnSettle() public {
        MockYieldVault vault = new MockYieldVault(address(usdc));
        escrow.setYieldVault(address(vault));

        uint256 id = _agreeAndFund(AMT);
        uint256 yield_ = 100 * USD;
        usdc.mint(address(vault), yield_); // simulate accrual while locked

        uint256 buyerBefore = usdc.balanceOf(buyer);
        uint256 poolBefore = usdc.balanceOf(address(pool));

        vm.prank(agent);
        escrow.attest(id, keccak256("BoL"), true);

        uint256 buyerCut = (yield_ * 4000) / 10000;
        uint256 poolCut = (yield_ * 3000) / 10000;
        uint256 sellerCut = yield_ - buyerCut - poolCut;
        assertEq(usdc.balanceOf(buyer) - buyerBefore, buyerCut, "buyer yield slice");
        assertEq(usdc.balanceOf(address(pool)) - poolBefore, poolCut, "pool yield slice");
        assertEq(usdc.balanceOf(seller), AMT + sellerCut, "seller principal + yield slice");
    }

    // ── passport curve (unchanged) ───────────────────────────────────────────

    function test_Passport_CurveSchedule() public {
        passport.setWriter(address(this), true);
        address b = makeAddr("curveBuyer");

        uint16[31] memory exp;
        for (uint256 i = 0; i < 3; i++) exp[i] = 10000;
        for (uint256 i = 3; i < 6; i++) exp[i] = 9000;
        for (uint256 i = 6; i < 11; i++) exp[i] = 8000;
        for (uint256 i = 11; i < 17; i++) exp[i] = 7000;
        for (uint256 i = 17; i < 23; i++) exp[i] = 6000;
        for (uint256 i = 23; i < 30; i++) exp[i] = 5000;
        exp[30] = 4000;

        for (uint256 c = 0; c < 31; c++) {
            assertEq(passport.depositBps(b), exp[c], "tier mismatch");
            passport.recordTrade(b, address(0), true);
        }
        assertEq(passport.depositBps(b), 4000, "floor holds beyond 30 trades");
    }
}
