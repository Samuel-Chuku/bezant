// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {StakedVerifierModule} from "../src/StakedVerifierModule.sol";
import {MockUSDC} from "./helpers/MockUSDC.sol";

// Minimal escrow stub implementing the slice the module reads/calls.
contract MockEscrow {
    struct T {
        address buyer;
        address seller;
        address attester;
        uint256 amount;
        uint8 status;
    }

    mapping(uint256 => T) internal t;
    bool public attested;
    uint256 public attestedId;
    bytes32 public lastProof;
    bool public lastPassed;

    function setTrade(uint256 id, address buyer, address seller, address attester, uint256 amount, uint8 status) external {
        t[id] = T(buyer, seller, attester, amount, status);
    }

    function trades(uint256 id)
        external
        view
        returns (address, address, address, address, uint256, uint256, uint256, uint256, bytes32, uint48, bool, uint8)
    {
        T memory x = t[id];
        return (x.buyer, x.seller, x.attester, address(0), x.amount, 0, 0, 0, bytes32(0), 0, false, x.status);
    }

    function attest(uint256 id, bytes32 proof, bool passed) external {
        attested = true;
        attestedId = id;
        lastProof = proof;
        lastPassed = passed;
    }
}

contract StakedVerifierModuleTest is Test {
    MockUSDC usdc;
    MockEscrow escrow;
    StakedVerifierModule mod;

    uint256 constant USD = 1e6;
    uint256 constant MIN_STAKE = 10 * USD;
    uint16 constant BOND_BPS = 5000; // bond = 50% of stake
    uint256 constant STAKE = 20 * USD;
    uint256 constant EXPECTED_BOND = (STAKE * BOND_BPS) / 10000; // 10 USDC
    uint256 constant SLASH = (EXPECTED_BOND * 5000) / 10000; // 50% of bond = 5 USDC
    uint256 constant AMOUNT = 100 * USD;
    uint8 constant FUNDED = 3;

    address buyer = makeAddr("buyer");
    address seller = makeAddr("seller");
    address[6] vs;
    bytes32 constant PROOF = keccak256("delivery");

    function setUp() public {
        usdc = new MockUSDC();
        escrow = new MockEscrow();
        // This test contract is owner + operator.
        mod = new StakedVerifierModule(address(usdc), address(escrow), MIN_STAKE, BOND_BPS);
        mod.setParams(4, MIN_STAKE, BOND_BPS, 5000, 100, 1 hours); // panel 4, 50% slash, 1% fee

        for (uint256 i; i < 6; i++) {
            vs[i] = makeAddr(string(abi.encodePacked("v", vm.toString(i))));
            _stake(vs[i]);
        }

        // Trade #1: attester = module, Funded, amount 100.
        escrow.setTrade(1, buyer, seller, address(mod), AMOUNT, FUNDED);
        usdc.mint(buyer, 10 * USD);
        vm.prank(buyer);
        usdc.approve(address(mod), type(uint256).max);
    }

    function _stake(address v) internal {
        usdc.mint(v, STAKE);
        vm.startPrank(v);
        usdc.approve(address(mod), type(uint256).max);
        mod.stake(STAKE);
        vm.stopPrank();
    }

    function _vote(address v, bool pass) internal {
        vm.prank(v);
        mod.vote(1, pass);
    }

    function _stakeOn(StakedVerifierModule m, address v, uint256 amount) internal {
        usdc.mint(v, amount);
        vm.startPrank(v);
        usdc.approve(address(m), type(uint256).max);
        m.stake(amount);
        vm.stopPrank();
    }

    function _resolvedFlag(uint256 id) internal view returns (bool resolved) {
        (, resolved,,,,,) = mod.verificationOf(id);
    }

    function _assignedFlag(uint256 id) internal view returns (bool assigned) {
        (assigned,,,,,,) = mod.verificationOf(id);
    }

    // All four vote → resolves early (before timeout); 3 pass / 1 fail settles
    // pass, minority slashed, three honest split fee + slash.
    function test_allVoted_resolvesEarly() public {
        vm.prank(buyer);
        mod.fundVerification(1);
        mod.assignPanel(1, PROOF);
        address[] memory p = mod.panelOf(1);
        assertEq(p.length, 4, "panel of 4");

        _vote(p[0], true);
        _vote(p[1], true);
        _vote(p[2], true);
        assertFalse(_resolvedFlag(1), "not resolved at 3/4 - must wait for all or timeout");
        _vote(p[3], false); // all voted → resolve

        assertTrue(escrow.attested(), "attested");
        assertTrue(escrow.lastPassed(), "passed");
        // pool = fee 1 + minority slash 5 = 6; split across 3 honest → 2 each.
        uint256 share = (1 * USD + SLASH) / 3;
        assertEq(mod.stakeOf(p[3]), STAKE - SLASH, "minority slashed");
        assertEq(mod.stakeOf(p[0]), STAKE + share, "honest rewarded");
    }

    // 3 of 4 vote, 1 no-show, window elapses → resolves on the 3; both the
    // minority voter AND the no-show are slashed (they had the full window).
    function test_timeoutQuorum_resolvesAndSlashesNoShow() public {
        vm.prank(buyer);
        mod.fundVerification(1);
        mod.assignPanel(1, PROOF);
        address[] memory p = mod.panelOf(1);

        _vote(p[0], true);
        _vote(p[1], true);
        _vote(p[2], false); // p[3] never votes
        vm.warp(block.timestamp + 2 hours);
        mod.resolveTimeout(1);

        assertTrue(escrow.attested(), "attested");
        assertTrue(escrow.lastPassed(), "2 pass > 1 fail");
        assertEq(mod.stakeOf(p[2]), STAKE - SLASH, "minority slashed");
        assertEq(mod.stakeOf(p[3]), STAKE - SLASH, "no-show slashed");
        // No-show takes a reputation hit (drawn but didn't vote on a quorum round).
        assertEq(mod.totalVotes(p[3]), 1);
        assertEq(mod.correctVotes(p[3]), 0);
    }

    // A bare majority (2/4, or even 3/4) must NOT resolve early.
    function test_noEarlyResolveOnMajority() public {
        vm.prank(buyer);
        mod.fundVerification(1);
        mod.assignPanel(1, PROOF);
        address[] memory p = mod.panelOf(1);

        _vote(p[0], true);
        _vote(p[1], true);
        assertFalse(_resolvedFlag(1), "no resolve on bare majority");
        assertFalse(escrow.attested());
        vm.expectRevert(bytes("not expired"));
        mod.resolveTimeout(1);
    }

    // Below quorum at timeout → void + retry: fee kept, no-shows slashed + barred,
    // the two who showed split the slashed stake, and the redraw excludes the no-shows.
    function test_belowQuorum_voidsAndRetriesExcludingNoShows() public {
        vm.prank(buyer);
        mod.fundVerification(1);
        assertEq(mod.feePrepaid(1), 1 * USD);
        mod.assignPanel(1, PROOF);
        address[] memory p = mod.panelOf(1);

        _vote(p[0], true);
        _vote(p[1], false); // only 2 of 4 — p[2], p[3] no-show
        vm.warp(block.timestamp + 2 hours);
        mod.resolveTimeout(1);

        assertFalse(escrow.attested(), "no attest on void");
        assertEq(mod.feePrepaid(1), 1 * USD, "fee kept for retry");
        assertFalse(_assignedFlag(1), "reset for a fresh panel");
        assertFalse(_resolvedFlag(1), "not resolved");

        assertEq(mod.stakeOf(p[2]), STAKE - SLASH, "no-show slashed");
        assertEq(mod.stakeOf(p[3]), STAKE - SLASH, "no-show slashed");
        // Showers split the slashed pool (2 * 5 = 10) → 5 each.
        assertEq(mod.stakeOf(p[0]), STAKE + 5 * USD, "shower rewarded");
        assertEq(mod.stakeOf(p[1]), STAKE + 5 * USD, "shower rewarded");

        // Retry: seller resubmits → new panel excludes the barred no-shows.
        mod.assignPanel(1, PROOF);
        address[] memory p2 = mod.panelOf(1);
        for (uint256 i; i < p2.length; i++) {
            assertTrue(p2[i] != p[2] && p2[i] != p[3], "barred no-show was redrawn");
        }
    }

    function test_assignPanel_requiresPrepaidFee() public {
        vm.expectRevert(bytes("fee not prepaid"));
        mod.assignPanel(1, PROOF);
    }

    function test_unstake_blockedWhileBonded() public {
        vm.prank(buyer);
        mod.fundVerification(1);
        mod.assignPanel(1, PROOF);
        address m = mod.panelOf(1)[0]; // a bonded panelist
        vm.prank(m);
        vm.expectRevert(bytes("locked/insufficient"));
        mod.unstake(STAKE);
        vm.prank(m);
        mod.unstake(STAKE - EXPECTED_BOND); // free portion ok
    }

    // Conflict of interest: a staked verifier who is the trade's seller is never
    // drawn onto its panel.
    function test_select_excludesTradeParties() public {
        escrow.setTrade(2, buyer, vs[0], address(mod), AMOUNT, FUNDED); // vs[0] = seller
        vm.prank(buyer);
        mod.fundVerification(2);
        mod.assignPanel(2, PROOF);
        address[] memory p = mod.panelOf(2);
        for (uint256 i; i < p.length; i++) {
            assertTrue(p[i] != vs[0], "trade party on its own panel");
        }
    }

    // A sub-minimum stake is rejected on-chain (not just in the UI).
    function test_stake_belowMinReverts() public {
        address x = makeAddr("staker_x");
        usdc.mint(x, 100 * USD);
        vm.startPrank(x);
        usdc.approve(address(mod), type(uint256).max);
        vm.expectRevert(bytes("below minStake"));
        mod.stake(9 * USD); // below the 10 USDC floor
        mod.stake(10 * USD); // exactly the minimum is fine
        vm.stopPrank();
        assertEq(mod.stakeOf(x), 10 * USD);
    }

    // Reward is proportional to bond (= stake): the 2x-staked honest voter earns
    // twice the share of an equal-staked one. Fresh module with exactly 4 verifiers
    // so the panel is deterministically all four.
    function test_rewards_proportionalToBond() public {
        StakedVerifierModule m = new StakedVerifierModule(address(usdc), address(escrow), MIN_STAKE, BOND_BPS);
        m.setParams(4, MIN_STAKE, BOND_BPS, 5000, 100, 1 hours);
        address a = makeAddr("ra");
        address b = makeAddr("rb");
        address c = makeAddr("rc");
        address d = makeAddr("rd");
        _stakeOn(m, a, 40 * USD); // bond 20
        _stakeOn(m, b, 20 * USD); // bond 10
        _stakeOn(m, c, 20 * USD); // bond 10
        _stakeOn(m, d, 20 * USD); // bond 10

        escrow.setTrade(9, buyer, seller, address(m), AMOUNT, FUNDED);
        usdc.mint(buyer, 10 * USD);
        vm.prank(buyer);
        usdc.approve(address(m), type(uint256).max);
        vm.prank(buyer);
        m.fundVerification(9);
        m.assignPanel(9, PROOF);

        vm.prank(a);
        m.vote(9, true);
        vm.prank(b);
        m.vote(9, true);
        vm.prank(c);
        m.vote(9, true);
        vm.prank(d);
        m.vote(9, false); // all voted → resolve, pass wins

        // d (minority) slashed 50% of bond 10 = 5. pool = fee 1 + 5 = 6.
        // honest bonds: a 20 + b 10 + c 10 = 40 → a gets 6*20/40 = 3, b/c get 1.5 each.
        assertEq(m.stakeOf(a), 40 * USD + 3 * USD, "2x bond -> 2x share");
        assertEq(m.stakeOf(b), 20 * USD + 1_500_000, "proportional share");
        assertEq(m.stakeOf(d), 20 * USD - 5 * USD, "minority slashed");
    }
}
