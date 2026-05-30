// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {PactWrapperFixture} from "./helpers/PactWrapperFixture.t.sol";
import {PactWrapper} from "../src/PactWrapper.sol";

// Rule 1 (extension by state), Rule 2 (no funding past expiry — also covered
// in lifecycle), Rule 3 (min 30-min deadline at creation — also covered in
// lifecycle), and the claimRefund path. Cancel/reject termination tests live
// in PactWrapper.cancellation.t.sol.
contract PactWrapperDeadlinesTest is PactWrapperFixture {
    bytes32 internal constant DUMMY_HASH = keccak256("d");

    // ──────────────────────────────────────────────────────────────────────
    //                          extendDeadline (Rule 1)
    // ──────────────────────────────────────────────────────────────────────

    function _expiredAt(uint256 pactId) internal view returns (uint64) {
        (
            ,
            ,
            ,
            ,
            uint64 exp,                    // 4 expiredAt
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
        ) = wrapper.pacts(pactId);
        return exp;
    }

    function _submittedExtCount(uint256 pactId) internal view returns (uint8) {
        (
            ,
            ,
            ,
            ,
            ,
            uint8 count,                   // 5 submittedExtCount
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
        ) = wrapper.pacts(pactId);
        return count;
    }

    function test_extend_Open_unrestrictedForwardDelta() public {
        uint256 pactId = _createDefaultPact();
        uint64 cur = _expiredAt(pactId);
        uint64 newExp = cur + 7 days;

        vm.prank(client);
        wrapper.extendDeadline(pactId, newExp);

        assertEq(_expiredAt(pactId), newExp);
        assertEq(_submittedExtCount(pactId), 0, "no count in Open phase");
    }

    function test_extend_Funded_unrestrictedForwardDelta() public {
        uint256 pactId = _fundedPact();
        uint64 cur = _expiredAt(pactId);
        vm.prank(client);
        wrapper.extendDeadline(pactId, cur + 12 hours);
        assertEq(_expiredAt(pactId), cur + 12 hours);
        assertEq(_submittedExtCount(pactId), 0, "no count in Funded phase");
    }

    function test_extend_Open_revertsOnNonPositiveDelta() public {
        uint256 pactId = _createDefaultPact();
        uint64 cur = _expiredAt(pactId);
        vm.prank(client);
        vm.expectRevert(PactWrapper.ExtensionDeltaNotPositive.selector);
        wrapper.extendDeadline(pactId, cur);
    }

    function test_extend_Open_revertsOnBackwardDelta() public {
        uint256 pactId = _createDefaultPact();
        uint64 cur = _expiredAt(pactId);
        vm.prank(client);
        vm.expectRevert(PactWrapper.ExtensionDeltaNotPositive.selector);
        wrapper.extendDeadline(pactId, cur - 1);
    }

    function test_extend_Submitted_exactlyOneHourPlus_incrementsCount() public {
        uint256 pactId = _submittedPact(DUMMY_HASH);
        uint64 cur = _expiredAt(pactId);

        vm.prank(client);
        wrapper.extendDeadline(pactId, cur + 1 hours);
        assertEq(_expiredAt(pactId), cur + 1 hours);
        assertEq(_submittedExtCount(pactId), 1);

        // Second and third extensions still go through.
        vm.prank(client);
        wrapper.extendDeadline(pactId, cur + 2 hours);
        assertEq(_submittedExtCount(pactId), 2);

        vm.prank(client);
        wrapper.extendDeadline(pactId, cur + 3 hours);
        assertEq(_submittedExtCount(pactId), 3);
    }

    function test_extend_Submitted_revertsOnFourthExtension() public {
        uint256 pactId = _submittedPact(DUMMY_HASH);
        uint64 cur = _expiredAt(pactId);

        for (uint64 i = 1; i <= 3; i++) {
            vm.prank(client);
            wrapper.extendDeadline(pactId, cur + i * 1 hours);
        }

        vm.prank(client);
        vm.expectRevert(PactWrapper.SubmittedExtensionsExhausted.selector);
        wrapper.extendDeadline(pactId, cur + 4 hours);
    }

    function test_extend_Submitted_revertsOnNonOneHourDelta() public {
        uint256 pactId = _submittedPact(DUMMY_HASH);
        uint64 cur = _expiredAt(pactId);

        vm.prank(client);
        vm.expectRevert(PactWrapper.ExtensionDeltaTooLarge.selector);
        wrapper.extendDeadline(pactId, cur + 2 hours);
    }

    function test_extend_revertsOnTerminalStatus_completed() public {
        uint256 pactId = _submittedPact(DUMMY_HASH);
        vm.prank(client);
        wrapper.clientAccept(pactId);

        vm.prank(client);
        vm.expectRevert(PactWrapper.TerminalStatus.selector);
        wrapper.extendDeadline(pactId, _defaultExpiredAt() + 1 days);
    }

    function test_extend_revertsOnTerminalStatus_expired() public {
        uint256 pactId = _createDefaultPact();
        vm.prank(client);
        wrapper.cancel(pactId);

        vm.prank(client);
        vm.expectRevert(PactWrapper.TerminalStatus.selector);
        wrapper.extendDeadline(pactId, _defaultExpiredAt() + 1 days);
    }

    function test_extend_revertsOnNonClient() public {
        uint256 pactId = _createDefaultPact();
        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(PactWrapper.NotClient.selector, provider));
        wrapper.extendDeadline(pactId, _defaultExpiredAt() + 1 days);
    }

    // ──────────────────────────────────────────────────────────────────────
    //                              claimRefund
    // ──────────────────────────────────────────────────────────────────────

    function test_claimRefund_fromFunded_pastDeadline_refundsClient() public {
        uint256 pactId = _fundedPact();
        uint256 clientBefore = usdc.balanceOf(client);
        uint64 exp = _expiredAt(pactId);

        vm.warp(exp + 1);
        address random = makeAddr("randomRefundCaller");
        vm.prank(random);
        wrapper.claimRefund(pactId);

        assertEq(usdc.balanceOf(client), clientBefore + DEFAULT_BUDGET, "client got budget back");
        (
            ,
            ,
            ,
            ,
            ,
            ,
            PactWrapper.Status status,
            address actor,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
        ) = wrapper.pacts(pactId);
        assertEq(uint8(status), uint8(PactWrapper.Status.Refunded));
        assertEq(actor, random, "actor recorded as permissionless caller");
    }

    function test_claimRefund_fromSubmitted_pastDeadline_refundsClient() public {
        uint256 pactId = _submittedPact(DUMMY_HASH);
        uint256 clientBefore = usdc.balanceOf(client);
        uint64 exp = _expiredAt(pactId);

        vm.warp(exp + 1);
        vm.prank(makeAddr("anyone"));
        wrapper.claimRefund(pactId);

        assertEq(usdc.balanceOf(client), clientBefore + DEFAULT_BUDGET);
    }

    function test_claimRefund_revertsBeforeDeadline() public {
        uint256 pactId = _fundedPact();
        uint64 exp = _expiredAt(pactId);

        vm.prank(makeAddr("anyone"));
        vm.expectRevert(
            abi.encodeWithSelector(
                PactWrapper.NotYetExpired.selector,
                exp,
                uint64(block.timestamp)
            )
        );
        wrapper.claimRefund(pactId);
    }

    function test_claimRefund_revertsFromOpen() public {
        uint256 pactId = _createDefaultPact();
        vm.warp(_defaultExpiredAt() + 1);
        vm.prank(makeAddr("anyone"));
        vm.expectRevert(abi.encodeWithSelector(PactWrapper.WrongStatusMulti.selector, PactWrapper.Status.Open));
        wrapper.claimRefund(pactId);
    }

    function test_claimRefund_revertsFromCompleted() public {
        uint256 pactId = _submittedPact(DUMMY_HASH);
        vm.prank(client);
        wrapper.clientAccept(pactId);

        vm.warp(_defaultExpiredAt() + 1);
        vm.prank(makeAddr("anyone"));
        vm.expectRevert(abi.encodeWithSelector(PactWrapper.WrongStatusMulti.selector, PactWrapper.Status.Completed));
        wrapper.claimRefund(pactId);
    }

    // ──────────────────────────────────────────────────────────────────────
    //                  extendDeadline + claimRefund interaction
    // ──────────────────────────────────────────────────────────────────────

    function test_extendThenRefund_respectsExtendedDeadline() public {
        uint256 pactId = _fundedPact();
        uint64 originalExp = _expiredAt(pactId);

        // Push deadline 1 day forward while still in Funded.
        vm.prank(client);
        wrapper.extendDeadline(pactId, originalExp + 1 days);

        // Past original but before extended — refund should still revert.
        vm.warp(originalExp + 1 hours);
        vm.prank(makeAddr("anyone"));
        vm.expectRevert(
            abi.encodeWithSelector(
                PactWrapper.NotYetExpired.selector,
                originalExp + 1 days,
                uint64(block.timestamp)
            )
        );
        wrapper.claimRefund(pactId);

        // Past extended — refund succeeds.
        vm.warp(originalExp + 1 days + 1);
        vm.prank(makeAddr("anyone"));
        wrapper.claimRefund(pactId);
    }
}
