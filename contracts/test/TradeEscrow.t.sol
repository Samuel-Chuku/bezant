// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {TradeEscrow} from "../src/TradeEscrow.sol";
import {TradePassport} from "../src/TradePassport.sol";
import {FinancingPool} from "../src/FinancingPool.sol";
import {AccruingYieldVault} from "../src/AccruingYieldVault.sol";
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
        pool.deposit(100_000 * USD); // this contract is the seed LP

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

    // ── LP vault: shares, yield, loss, liquidity ─────────────────────────────

    uint256 constant SEED = 100_000 * USD;
    uint256 constant GROSS = 8_000 * USD; // tier0 deposit=AMT, financeBps 80%
    uint256 constant FEE = (GROSS * 300) / 10000; // tier0 3%
    uint256 constant NET = GROSS - FEE;

    function test_Vault_DepositMintsSharesOneToOne() public {
        // setUp seeded 100k from this contract.
        assertEq(pool.shares(address(this)), SEED, "first deposit mints 1:1");
        assertEq(pool.totalAssets(), SEED, "assets = seed");
        assertEq(pool.convertToAssets(pool.shares(address(this))), SEED, "value = seed");
    }

    function test_Vault_FeeAccruesAsYield() public {
        uint256 id = _agreeAndFund(AMT);
        vm.prank(seller);
        escrow.requestFinancing(id);
        vm.prank(agent);
        escrow.attest(id, keccak256("BoL"), true); // repays pool gross, keeps fee

        assertEq(pool.outstanding(), 0, "advance cleared");
        assertEq(pool.totalAssets(), SEED + FEE, "NAV grew by the fee");
        assertEq(pool.convertToAssets(pool.shares(address(this))), SEED + FEE, "LP share value up by fee");
    }

    function test_Vault_DisputeToBuyer_SocializesLoss() public {
        uint256 id = _agreeAndFund(AMT);
        vm.prank(seller);
        escrow.requestFinancing(id);
        uint256 buyerBefore = usdc.balanceOf(buyer);

        vm.prank(buyer);
        escrow.raiseDispute(id);
        escrow.resolveDispute(id, false); // arbitrator (owner) refunds buyer

        assertEq(usdc.balanceOf(buyer) - buyerBefore, AMT, "buyer made whole");
        assertEq(pool.outstanding(), 0, "written off");
        assertEq(pool.totalAssets(), SEED - NET, "LPs ate the net advance");
    }

    function test_Vault_DisputeToSeller_RepaysPoolNoDoublePay() public {
        uint256 id = _agreeAndFund(AMT);
        vm.prank(seller);
        escrow.requestFinancing(id);

        vm.prank(seller);
        escrow.raiseDispute(id);
        escrow.resolveDispute(id, true); // release to seller

        assertEq(usdc.balanceOf(seller), AMT - FEE, "seller total = invoice - fee (not double)");
        assertEq(pool.totalAssets(), SEED + FEE, "pool repaid + fee");
    }

    function test_Vault_WithdrawCappedAtIdle() public {
        uint256 id = _agreeAndFund(AMT);
        vm.prank(seller);
        escrow.requestFinancing(id); // deploys NET, idle = SEED - NET

        vm.expectRevert(FinancingPool.InsufficientLiquidity.selector);
        pool.redeem(SEED); // would need full NAV in cash; capital is deployed

        uint256 assets = pool.redeem(SEED - NET); // up to idle is fine
        assertEq(assets, SEED - NET, "redeemed up to idle at 1:1 (no yield yet)");
    }

    // ── LP vault: idle parked in a yield vault (USYC-on-idle) ────────────────

    // Parking idle in the vault doesn't change NAV; subsequent vault accrual
    // (simulated by minting USDC into the vault) lifts NAV for LPs, and
    // withdrawals divest from the vault to pay out.
    function test_Vault_IdleEarnsYieldAndWithdrawDivests() public {
        MockYieldVault pv = new MockYieldVault(address(usdc));
        pool.setYieldVault(address(pv)); // sweeps SEED into the vault

        assertEq(pool.totalAssets(), SEED, "parking idle doesn't move NAV");
        assertEq(usdc.balanceOf(address(pool)), 0, "buffer swept into vault");
        assertEq(pool.vaultShares(), SEED, "pool holds vault shares 1:1");

        uint256 yield_ = 1_000 * USD;
        usdc.mint(address(pv), yield_); // simulate USYC accrual on idle

        assertEq(pool.totalAssets(), SEED + yield_, "vault yield lifts NAV");
        assertEq(pool.convertToAssets(pool.shares(address(this))), SEED + yield_, "LP value up by yield");

        uint256 half = SEED / 2;
        uint256 got = pool.redeem(half); // divests from the vault
        assertEq(got, (SEED + yield_) / 2, "redeem pays NAV out of the vault");
    }

    // An advance frees USDC from the vault to pay the seller (NAV flat), and a
    // clean settle repays the gross back into the vault (NAV up by the fee) —
    // all on top of the idle being vault-backed.
    function test_Vault_AdvanceDivestsThenRepayReinvests() public {
        MockYieldVault pv = new MockYieldVault(address(usdc));
        pool.setYieldVault(address(pv));

        uint256 id = _agreeAndFund(AMT);
        vm.prank(seller);
        escrow.requestFinancing(id); // advance NET — divests from the vault
        assertEq(pool.outstanding(), NET, "principal deployed");
        assertEq(pool.totalAssets(), SEED, "NAV flat across the advance");

        vm.prank(agent);
        escrow.attest(id, keccak256("BoL"), true); // repays gross into the vault
        assertEq(pool.outstanding(), 0, "advance cleared");
        assertEq(pool.totalAssets(), SEED + FEE, "fee accrued, gross re-parked");
    }

    // ── accruing (USYC-faithful) vault: NAV grows by time, hands-off ─────────

    // Standalone: NAV appreciates at the set APY with no manual top-ups; the
    // accrued portion is paid out of the vault's reserve on redemption.
    function test_AccruingVault_NavGrowsAtApy() public {
        AccruingYieldVault v = new AccruingYieldVault(address(usdc), 400); // 4%
        uint256 amt = 1_000 * USD;
        usdc.mint(address(this), amt);
        usdc.approve(address(v), amt);
        uint256 sh = v.deposit(amt);

        assertEq(v.previewRedeem(sh), amt, "no time => principal only");
        vm.warp(block.timestamp + 365 days);
        assertEq(v.previewRedeem(sh), amt + 40 * USD, "1y @ 4% => +40, no top-up");

        usdc.mint(address(v), 40 * USD); // reserve covers the accrued yield
        assertEq(v.redeem(sh), amt + 40 * USD, "redeem pays principal + yield");
    }

    // Pool integration: point the pool at an accruing vault and its NAV climbs
    // on its own — no per-LP action, future deposits earn the same rate.
    function test_AccruingVault_PoolEarnsHandsOff() public {
        AccruingYieldVault v = new AccruingYieldVault(address(usdc), 400);
        pool.setYieldVault(address(v)); // parks SEED into the accruing vault
        assertEq(pool.totalAssets(), SEED, "no time => NAV flat");

        usdc.mint(address(v), 4_000 * USD); // reserve for a year of 4% on 100k
        vm.warp(block.timestamp + 365 days);

        assertEq(pool.totalAssets(), SEED + 4_000 * USD, "pool NAV grew 4% hands-off");
        assertEq(pool.convertToAssets(pool.shares(address(this))), SEED + 4_000 * USD, "LP value up 4%");

        uint256 got = pool.redeem(SEED / 2); // divest pulls principal+yield from vault
        assertEq(got, (SEED + 4_000 * USD) / 2, "redeem at the grown NAV");
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
