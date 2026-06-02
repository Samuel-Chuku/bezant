// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {PactWrapperFixture} from "./helpers/PactWrapperFixture.t.sol";
import {PactWrapper} from "../src/PactWrapper.sol";

// Admin setters + treasury withdrawal + fee accrual sweep across bps configs.
contract PactWrapperFeesTest is PactWrapperFixture {

    // ──────────────────────────────────────────────────────────────────────
    //                       setPlatformFeeBps
    // ──────────────────────────────────────────────────────────────────────

    function test_setPlatformFeeBps_happy() public {
        vm.expectEmit(true, true, true, true, address(wrapper));
        emit PactWrapper.PlatformFeeUpdated(PLATFORM_FEE_BPS_DEFAULT, 70);
        vm.prank(owner);
        wrapper.setPlatformFeeBps(70);
        assertEq(wrapper.platformFeeBps(), 70);
    }

    function test_setPlatformFeeBps_atMaxAllowed() public {
        vm.prank(owner);
        wrapper.setPlatformFeeBps(1_000);
        assertEq(wrapper.platformFeeBps(), 1_000);
    }

    function test_setPlatformFeeBps_revertsAboveMax() public {
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(PactWrapper.PlatformFeeAboveMax.selector, 1_001, 1_000)
        );
        wrapper.setPlatformFeeBps(1_001);
    }

    function test_setPlatformFeeBps_revertsForNonOwner() public {
        vm.prank(client);
        vm.expectRevert(PactWrapper.NotOwner.selector);
        wrapper.setPlatformFeeBps(70);
    }

    // ──────────────────────────────────────────────────────────────────────
    //                      setPlatformTreasury
    // ──────────────────────────────────────────────────────────────────────

    function test_setPlatformTreasury_happy() public {
        address newTreasury = makeAddr("newTreasury");
        vm.expectEmit(true, true, true, true, address(wrapper));
        emit PactWrapper.PlatformTreasuryUpdated(treasury, newTreasury);
        vm.prank(owner);
        wrapper.setPlatformTreasury(newTreasury);
        assertEq(wrapper.platformTreasury(), newTreasury);
    }

    function test_setPlatformTreasury_revertsOnZero() public {
        vm.prank(owner);
        vm.expectRevert(PactWrapper.ZeroAddress.selector);
        wrapper.setPlatformTreasury(address(0));
    }

    function test_setPlatformTreasury_revertsForNonOwner() public {
        vm.prank(client);
        vm.expectRevert(PactWrapper.NotOwner.selector);
        wrapper.setPlatformTreasury(makeAddr("x"));
    }

    // ──────────────────────────────────────────────────────────────────────
    //                       withdrawTreasury
    // ──────────────────────────────────────────────────────────────────────

    function test_withdrawTreasury_happy_full() public {
        // Set 70 bps, fund a pact → 7 USDC fee accrues.
        vm.prank(owner);
        wrapper.setPlatformFeeBps(70);
        _fundedPact();

        uint256 expectedFee = (DEFAULT_BUDGET * 70) / 10_000; // 7 USDC raw
        assertEq(wrapper.treasuryBalance(), expectedFee, "fee accrued");

        uint256 treBefore = usdc.balanceOf(treasury);
        vm.expectEmit(true, true, true, true, address(wrapper));
        emit PactWrapper.TreasuryWithdrawn(treasury, expectedFee);
        vm.prank(owner);
        wrapper.withdrawTreasury(expectedFee);

        assertEq(wrapper.treasuryBalance(), 0);
        assertEq(usdc.balanceOf(treasury), treBefore + expectedFee);
    }

    function test_withdrawTreasury_happy_partial() public {
        vm.prank(owner);
        wrapper.setPlatformFeeBps(100); // 1%
        _fundedPact();

        uint256 fee = (DEFAULT_BUDGET * 100) / 10_000; // 10 USDC raw
        uint256 half = fee / 2;

        vm.prank(owner);
        wrapper.withdrawTreasury(half);
        assertEq(wrapper.treasuryBalance(), fee - half);
        assertEq(usdc.balanceOf(treasury), half);

        vm.prank(owner);
        wrapper.withdrawTreasury(fee - half);
        assertEq(wrapper.treasuryBalance(), 0);
        assertEq(usdc.balanceOf(treasury), fee);
    }

    function test_withdrawTreasury_zeroAmount_noop() public {
        // No revert, no state change, no event.
        vm.prank(owner);
        wrapper.withdrawTreasury(0);
        assertEq(wrapper.treasuryBalance(), 0);
        assertEq(usdc.balanceOf(treasury), 0);
    }

    function test_withdrawTreasury_revertsOnOverdraw() public {
        vm.prank(owner);
        wrapper.setPlatformFeeBps(70);
        _fundedPact();
        uint256 fee = (DEFAULT_BUDGET * 70) / 10_000;

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(PactWrapper.InsufficientTreasury.selector, fee, fee + 1)
        );
        wrapper.withdrawTreasury(fee + 1);
    }

    function test_withdrawTreasury_revertsForNonOwner() public {
        vm.prank(owner);
        wrapper.setPlatformFeeBps(70);
        _fundedPact();

        vm.prank(client);
        vm.expectRevert(PactWrapper.NotOwner.selector);
        wrapper.withdrawTreasury(1);
    }

    function test_withdrawTreasury_doesNotTouchBondEscrow() public {
        // Fund + stake an evaluator → wrapper holds budget (in reference) + evaluator stake.
        // Treasury balance should track ONLY accrued platform fees.
        vm.prank(owner);
        wrapper.setPlatformFeeBps(70);

        uint256 pactId = _fundedPact();
        pactId; // silence

        vm.prank(evaluatorA);
        wrapper.stakeEvaluator(100_000_000); // 100 USDC

        uint256 wrapperBal = usdc.balanceOf(address(wrapper));
        uint256 fee = (DEFAULT_BUDGET * 70) / 10_000;

        // Wrapper holds: fee (treasury) + 100 USDC stake.
        assertEq(wrapperBal, fee + 100_000_000);
        assertEq(wrapper.treasuryBalance(), fee);

        vm.prank(owner);
        wrapper.withdrawTreasury(fee);

        // After withdrawal: wrapper should still hold stake intact.
        assertEq(usdc.balanceOf(address(wrapper)), 100_000_000);
        assertEq(wrapper.treasuryBalance(), 0);
    }

    // ──────────────────────────────────────────────────────────────────────
    //                       Fee sweep by bps config
    // ──────────────────────────────────────────────────────────────────────

    function test_feeSweep_zeroBps_noAccrual() public {
        // Fixture default is 0 bps already.
        _fundedPact();
        assertEq(wrapper.treasuryBalance(), 0);
    }

    function test_feeSweep_35bps() public {
        vm.prank(owner);
        wrapper.setPlatformFeeBps(35);
        _fundedPact();
        assertEq(wrapper.treasuryBalance(), (DEFAULT_BUDGET * 35) / 10_000);
    }

    function test_feeSweep_70bps_production() public {
        vm.prank(owner);
        wrapper.setPlatformFeeBps(70);
        _fundedPact();
        assertEq(wrapper.treasuryBalance(), (DEFAULT_BUDGET * 70) / 10_000);
    }

    function test_feeSweep_100bps() public {
        vm.prank(owner);
        wrapper.setPlatformFeeBps(100);
        _fundedPact();
        assertEq(wrapper.treasuryBalance(), (DEFAULT_BUDGET * 100) / 10_000);
    }

    function test_feeSweep_1000bps_cap() public {
        vm.prank(owner);
        wrapper.setPlatformFeeBps(1_000);
        _fundedPact();
        assertEq(wrapper.treasuryBalance(), (DEFAULT_BUDGET * 1_000) / 10_000);
    }

    function test_feeSweep_multipleFunds_accumulate() public {
        vm.prank(owner);
        wrapper.setPlatformFeeBps(70);

        uint256 perFee = (DEFAULT_BUDGET * 70) / 10_000;
        _fundedPact();
        _fundedPact();
        _fundedPact();

        assertEq(wrapper.treasuryBalance(), perFee * 3);
    }

    function test_feeSweep_feeRetainedAfterReject() public {
        // Per locked §11: fee retained on reject/cancel.
        vm.prank(owner);
        wrapper.setPlatformFeeBps(70);

        bytes32 hash = keccak256("deliverable");
        uint256 pactId = _submittedPact(hash);
        uint256 fee = (DEFAULT_BUDGET * 70) / 10_000;
        assertEq(wrapper.treasuryBalance(), fee, "accrued at fund");

        vm.prank(client);
        wrapper.reject(pactId, "rejected");

        // Fee stays in treasury, budget refunded to client.
        assertEq(wrapper.treasuryBalance(), fee, "fee retained after reject");
    }
}
