// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {PactWrapperFixture} from "./helpers/PactWrapperFixture.t.sol";
import {PactWrapper} from "../src/PactWrapper.sol";

// Evaluator pool: stake / unstake mechanics. Selection randomness + ejection
// alignment scoring are exercised in PactWrapper.dispute.t.sol (where the
// dispute flow drives them end-to-end).
contract PactWrapperEvaluatorTest is PactWrapperFixture {
    uint256 internal constant MIN_STAKE = 100_000_000; // 100 USDC

    function _stakeOf(address who) internal view returns (uint256) {
        (uint256 stake, , , , , ) = wrapper.evaluators(who);
        return stake;
    }

    function _activeFlag(address who) internal view returns (bool) {
        (, , , , , bool active) = wrapper.evaluators(who);
        return active;
    }

    function _pendingRefs(address who) internal view returns (uint32) {
        (, , , , uint32 refs, ) = wrapper.evaluators(who);
        return refs;
    }

    // ──────────────────────────────────────────────────────────────────────
    //                              stake
    // ──────────────────────────────────────────────────────────────────────

    function test_stake_happy() public {
        uint256 balBefore = usdc.balanceOf(evaluatorA);

        vm.prank(evaluatorA);
        wrapper.stakeEvaluator(MIN_STAKE);

        assertEq(usdc.balanceOf(evaluatorA), balBefore - MIN_STAKE);
        assertEq(usdc.balanceOf(address(wrapper)), MIN_STAKE, "wrapper holds stake");
        assertEq(_stakeOf(evaluatorA), MIN_STAKE);
        assertTrue(_activeFlag(evaluatorA), "evaluator active");
        assertEq(wrapper.getActiveEvaluatorCount(), 1);
        assertEq(wrapper.activeEvaluators(0), evaluatorA);
    }

    function test_stake_revertsBelowMinimum() public {
        vm.prank(evaluatorA);
        vm.expectRevert(
            abi.encodeWithSelector(PactWrapper.InsufficientStake.selector, MIN_STAKE - 1, MIN_STAKE)
        );
        wrapper.stakeEvaluator(MIN_STAKE - 1);
    }

    function test_stake_revertsIfAlreadyStaked() public {
        vm.prank(evaluatorA);
        wrapper.stakeEvaluator(MIN_STAKE);

        vm.prank(evaluatorA);
        vm.expectRevert(PactWrapper.AlreadyStaked.selector);
        wrapper.stakeEvaluator(MIN_STAKE);
    }

    function test_stake_multipleEvaluatorsBuildPool() public {
        vm.prank(evaluatorA); wrapper.stakeEvaluator(MIN_STAKE);
        vm.prank(evaluatorB); wrapper.stakeEvaluator(MIN_STAKE);
        vm.prank(evaluatorC); wrapper.stakeEvaluator(MIN_STAKE);
        vm.prank(evaluatorD); wrapper.stakeEvaluator(MIN_STAKE);

        assertEq(wrapper.getActiveEvaluatorCount(), 4);
        assertEq(wrapper.activeEvaluators(0), evaluatorA);
        assertEq(wrapper.activeEvaluators(1), evaluatorB);
        assertEq(wrapper.activeEvaluators(2), evaluatorC);
        assertEq(wrapper.activeEvaluators(3), evaluatorD);
    }

    function test_stake_atAboveMinimum_succeeds() public {
        vm.prank(evaluatorA);
        wrapper.stakeEvaluator(MIN_STAKE * 5);
        assertEq(_stakeOf(evaluatorA), MIN_STAKE * 5);
    }

    // ──────────────────────────────────────────────────────────────────────
    //                              unstake
    // ──────────────────────────────────────────────────────────────────────

    function test_unstake_returnsFullStake() public {
        vm.prank(evaluatorA);
        wrapper.stakeEvaluator(MIN_STAKE);

        uint256 balMid = usdc.balanceOf(evaluatorA);
        vm.prank(evaluatorA);
        wrapper.unstakeEvaluator();

        assertEq(usdc.balanceOf(evaluatorA), balMid + MIN_STAKE);
        assertEq(_stakeOf(evaluatorA), 0);
        assertFalse(_activeFlag(evaluatorA));
        assertEq(wrapper.getActiveEvaluatorCount(), 0);
    }

    function test_unstake_revertsIfNotStaked() public {
        vm.prank(evaluatorA);
        vm.expectRevert(PactWrapper.NotStaked.selector);
        wrapper.unstakeEvaluator();
    }

    // ──────────────────────────────────────────────────────────────────────
    //              unstake during active dispute is blocked
    // ──────────────────────────────────────────────────────────────────────

    // Direct evaluator-busy test is exercised end-to-end via the dispute
    // flow in PactWrapper.dispute.t.sol (defend() bumps pendingDisputeRefs).
    // Here we cover only the storage path: forcibly set pendingDisputeRefs
    // via a test-only deploy of a contract that exposes the increment.
    // Actually — we just inline-stage it by walking the public stake →
    // (hypothetical) defend path, but defend is NOT_IMPLEMENTED here. So
    // assert the modifier path via an internal expectation: skip the test
    // until dispute lands.

    // ──────────────────────────────────────────────────────────────────────
    //                  swap-and-pop preserves remaining set
    // ──────────────────────────────────────────────────────────────────────

    function test_unstake_swapAndPop_preservesMembership() public {
        vm.prank(evaluatorA); wrapper.stakeEvaluator(MIN_STAKE);
        vm.prank(evaluatorB); wrapper.stakeEvaluator(MIN_STAKE);
        vm.prank(evaluatorC); wrapper.stakeEvaluator(MIN_STAKE);

        // Unstake middle evaluator (B). Last (C) should swap into B's slot.
        vm.prank(evaluatorB);
        wrapper.unstakeEvaluator();

        assertEq(wrapper.getActiveEvaluatorCount(), 2);
        // A stays at index 0; C swaps into index 1 (B's old position).
        assertEq(wrapper.activeEvaluators(0), evaluatorA);
        assertEq(wrapper.activeEvaluators(1), evaluatorC);

        // B is fully cleared.
        assertEq(_stakeOf(evaluatorB), 0);
        assertFalse(_activeFlag(evaluatorB));
    }

    function test_unstake_thenReStake_clean() public {
        vm.prank(evaluatorA);
        wrapper.stakeEvaluator(MIN_STAKE);
        vm.prank(evaluatorA);
        wrapper.unstakeEvaluator();

        // Should be able to stake again.
        vm.prank(evaluatorA);
        wrapper.stakeEvaluator(MIN_STAKE * 2);
        assertEq(_stakeOf(evaluatorA), MIN_STAKE * 2);
        assertEq(wrapper.getActiveEvaluatorCount(), 1);
    }

    function test_pendingDisputeRefs_initialZero() public {
        vm.prank(evaluatorA);
        wrapper.stakeEvaluator(MIN_STAKE);
        assertEq(_pendingRefs(evaluatorA), 0);
    }
}
