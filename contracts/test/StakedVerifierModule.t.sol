// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {StakedVerifierModule} from "../src/StakedVerifierModule.sol";
import {MockUSDC} from "./helpers/MockUSDC.sol";

// Minimal escrow stub implementing the slice the module reads/calls.
contract MockEscrow {
    struct T {
        address buyer;
        address attester;
        uint256 amount;
        uint8 status;
    }

    mapping(uint256 => T) internal t;
    bool public attested;
    uint256 public attestedId;
    bytes32 public lastProof;
    bool public lastPassed;

    function setTrade(uint256 id, address buyer, address attester, uint256 amount, uint8 status) external {
        t[id] = T(buyer, attester, amount, status);
    }

    function trades(uint256 id)
        external
        view
        returns (address, address, address, address, uint256, uint256, uint256, uint256, bytes32, uint48, bool, uint8)
    {
        T memory x = t[id];
        return (x.buyer, address(0), x.attester, address(0), x.amount, 0, 0, 0, bytes32(0), 0, false, x.status);
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
    uint256 constant BOND = 5 * USD;
    uint256 constant STAKE = 20 * USD;
    uint256 constant AMOUNT = 100 * USD;
    uint8 constant FUNDED = 3;

    address buyer = makeAddr("buyer");
    address v1 = makeAddr("v1");
    address v2 = makeAddr("v2");
    address v3 = makeAddr("v3");
    bytes32 constant PROOF = keccak256("delivery");

    function setUp() public {
        usdc = new MockUSDC();
        escrow = new MockEscrow();
        // This test contract is owner + operator.
        mod = new StakedVerifierModule(address(usdc), address(escrow), MIN_STAKE, BOND);
        mod.setParams(3, MIN_STAKE, BOND, 5000, 100, 1 hours); // 50% slash, 1% fee

        _stake(v1);
        _stake(v2);
        _stake(v3);

        // Trade #1: attester = module, Funded, amount 100.
        escrow.setTrade(1, buyer, address(mod), AMOUNT, FUNDED);
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

    // Happy path: buyer funds fee → panel assigned → 2 pass / 1 fail → settles
    // pass, minority slashed, honest rewarded, reputation updated.
    function test_panelVote_majorityPass_settlesAndPays() public {
        vm.prank(buyer);
        mod.fundVerification(1);
        assertEq(mod.feePrepaid(1), 1 * USD, "fee = 1% of 100");

        mod.assignPanel(1, PROOF);
        assertEq(mod.panelOf(1).length, 3, "panel of 3");
        assertEq(mod.lockedOf(v1), BOND, "v1 bonded");

        // v1 pass, v2 fail, v3 pass → majority pass reached at v3.
        vm.prank(v1);
        mod.vote(1, true);
        vm.prank(v2);
        mod.vote(1, false);
        vm.prank(v3);
        mod.vote(1, true);

        // Escrow attested pass with the right proof.
        assertTrue(escrow.attested(), "attested");
        assertEq(escrow.attestedId(), 1);
        assertTrue(escrow.lastPassed(), "passed");
        assertEq(escrow.lastProof(), PROOF);

        // Economics: minority (v2) slashed 50% of bond = 2.5; pool = fee 1 + 2.5 = 3.5;
        // split between v1, v3 → 1.75 each. Bonds unlocked.
        uint256 slash = (BOND * 5000) / 10000; // 2.5
        uint256 share = (1 * USD + slash) / 2; // 1.75
        assertEq(mod.stakeOf(v2), STAKE - slash, "v2 slashed");
        assertEq(mod.stakeOf(v1), STAKE + share, "v1 rewarded");
        assertEq(mod.stakeOf(v3), STAKE + share, "v3 rewarded");
        assertEq(mod.lockedOf(v1), 0, "v1 unlocked");
        assertEq(mod.lockedOf(v2), 0, "v2 unlocked");

        // Reputation.
        assertEq(mod.correctVotes(v1), 1);
        assertEq(mod.totalVotes(v1), 1);
        assertEq(mod.correctVotes(v2), 0);
        assertEq(mod.totalVotes(v2), 1);

        // Ledger conservation: module USDC == sum of stakes (60 + fee 1 = 61).
        assertEq(usdc.balanceOf(address(mod)), mod.stakeOf(v1) + mod.stakeOf(v2) + mod.stakeOf(v3));
    }

    function test_assignPanel_requiresPrepaidFee() public {
        vm.expectRevert(bytes("fee not prepaid"));
        mod.assignPanel(1, PROOF);
    }

    function test_unstake_blockedWhileBonded() public {
        vm.prank(buyer);
        mod.fundVerification(1);
        mod.assignPanel(1, PROOF);
        // v1 is bonded; only free stake (STAKE - BOND) is withdrawable.
        vm.prank(v1);
        vm.expectRevert(bytes("locked/insufficient"));
        mod.unstake(STAKE);
        vm.prank(v1);
        mod.unstake(STAKE - BOND); // free portion ok
    }

    function test_timeout_noVotes_voidsAndRefunds() public {
        vm.prank(buyer);
        mod.fundVerification(1);
        mod.assignPanel(1, PROOF);
        uint256 buyerBefore = usdc.balanceOf(buyer);

        vm.warp(block.timestamp + 2 hours);
        mod.resolveTimeout(1);

        assertFalse(escrow.attested(), "not attested on void");
        assertEq(usdc.balanceOf(buyer), buyerBefore + 1 * USD, "fee refunded");
        assertEq(mod.lockedOf(v1), 0, "bond unlocked");
    }
}
