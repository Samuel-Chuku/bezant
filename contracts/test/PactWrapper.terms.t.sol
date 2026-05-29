// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {PactWrapperFixture} from "./helpers/PactWrapperFixture.t.sol";
import {PactWrapper} from "../src/PactWrapper.sol";

// Negotiation pattern coverage per §5.2 of m41-wrapper-spec.md. Three
// functions compose it: proposeTerms (client), setBudget (provider), fund
// (client). Tests walk all four worked examples + reverts.
contract PactWrapperTermsTest is PactWrapperFixture {
    bytes32 internal constant DUMMY_HASH = keccak256("d");

    // Helper: read the three pending-* fields without dragging in the
    // full 17-slot tuple destructure every test.
    function _pending(uint256 pactId)
        internal
        view
        returns (uint256 pendingBudget, uint64 pendingWindow, uint64 pendingAt)
    {
        (
            ,                              // 0  underlyingJobId
            ,                              // 1  client
            ,                              // 2  provider
            ,                              // 3  createdAt
            ,                              // 4  expiredAt
            ,                              // 5  submittedExtCount
            ,                              // 6  status
            ,                              // 7  terminationActor
            ,                              // 8  budget
            ,                              // 9  challengeWindow
            uint256 pBudget,               // 10 pendingBudget
            uint64  pWindow,               // 11 pendingChallengeWindow
            uint64  pAt,                   // 12 pendingProposedAt
            ,                              // 13 deliverableHash
            ,                              // 14 submittedAt
            ,                              // 15 disputeId
                                           // 16 confidentialPayout
        ) = wrapper.pacts(pactId);
        return (pBudget, pWindow, pAt);
    }

    function _liveQuote(uint256 pactId) internal view returns (uint256 budget, uint64 window) {
        (
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            uint256 b,                     // 8 budget
            uint64  w,                     // 9 challengeWindow
            ,
            ,
            ,
            ,
            ,
            ,
        ) = wrapper.pacts(pactId);
        return (b, w);
    }

    // ──────────────────────────────────────────────────────────────────────
    //                            proposeTerms
    // ──────────────────────────────────────────────────────────────────────

    function test_proposeTerms_setsPendingFields() public {
        uint256 pactId = _createDefaultPact();
        vm.prank(client);
        wrapper.proposeTerms(pactId, 800_000_000, 48 hours);

        (uint256 pB, uint64 pW, uint64 pAt) = _pending(pactId);
        assertEq(pB, 800_000_000);
        assertEq(pW, 48 hours);
        assertEq(pAt, uint64(block.timestamp));

        // Live quote untouched.
        (uint256 b, uint64 w) = _liveQuote(pactId);
        assertEq(b, 0, "live budget unchanged");
        assertEq(w, DEFAULT_CHALLENGE, "live window unchanged");
    }

    function test_proposeTerms_overwritesPreviousProposal() public {
        uint256 pactId = _createDefaultPact();
        vm.prank(client);
        wrapper.proposeTerms(pactId, 800_000_000, 48 hours);
        vm.prank(client);
        wrapper.proposeTerms(pactId, 900_000_000, 36 hours);

        (uint256 pB, uint64 pW, ) = _pending(pactId);
        assertEq(pB, 900_000_000, "second proposal wins");
        assertEq(pW, 36 hours);
    }

    function test_proposeTerms_revertsOnNonClient() public {
        uint256 pactId = _createDefaultPact();
        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(PactWrapper.NotClient.selector, provider));
        wrapper.proposeTerms(pactId, DEFAULT_BUDGET, DEFAULT_CHALLENGE);
    }

    function test_proposeTerms_revertsOnZeroBudget() public {
        uint256 pactId = _createDefaultPact();
        vm.prank(client);
        vm.expectRevert(PactWrapper.BudgetNotSet.selector);
        wrapper.proposeTerms(pactId, 0, DEFAULT_CHALLENGE);
    }

    function test_proposeTerms_revertsOnWindowBelowFloor() public {
        uint256 pactId = _createDefaultPact();
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(PactWrapper.ChallengeWindowOutOfRange.selector, uint64(30 minutes)));
        wrapper.proposeTerms(pactId, DEFAULT_BUDGET, 30 minutes);
    }

    function test_proposeTerms_revertsOnWindowAboveCeiling() public {
        uint256 pactId = _createDefaultPact();
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(PactWrapper.ChallengeWindowOutOfRange.selector, uint64(30 days)));
        wrapper.proposeTerms(pactId, DEFAULT_BUDGET, 30 days);
    }

    // ──────────────────────────────────────────────────────────────────────
    //                       setBudget clears pending
    // ──────────────────────────────────────────────────────────────────────

    function test_setBudget_clearsPendingWhenProviderMatches() public {
        uint256 pactId = _createDefaultPact();
        vm.prank(client);
        wrapper.proposeTerms(pactId, 800_000_000, 48 hours);

        // Provider accepts by quoting the same numbers.
        vm.prank(provider);
        wrapper.setBudget(pactId, 800_000_000, 48 hours);

        (uint256 pB, uint64 pW, uint64 pAt) = _pending(pactId);
        assertEq(pB, 0);
        assertEq(pW, 0);
        assertEq(pAt, 0);

        (uint256 b, uint64 w) = _liveQuote(pactId);
        assertEq(b, 800_000_000, "live budget = match");
        assertEq(w, 48 hours);
    }

    function test_setBudget_clearsPendingOnCounterQuote() public {
        uint256 pactId = _createDefaultPact();
        vm.prank(client);
        wrapper.proposeTerms(pactId, 800_000_000, 48 hours);

        // Provider counters with different terms.
        vm.prank(provider);
        wrapper.setBudget(pactId, 950_000_000, 24 hours);

        (uint256 pB, uint64 pW, uint64 pAt) = _pending(pactId);
        assertEq(pB, 0, "pending cleared even on counter");
        assertEq(pW, 0);
        assertEq(pAt, 0);

        (uint256 b, uint64 w) = _liveQuote(pactId);
        assertEq(b, 950_000_000, "live = counter quote");
        assertEq(w, 24 hours);
    }

    // ──────────────────────────────────────────────────────────────────────
    //                §5.2 worked example 2: multi-round counter
    // ──────────────────────────────────────────────────────────────────────

    function test_multiRoundNegotiation() public {
        uint256 pactId = _createDefaultPact();

        // 1) client proposes 800/48h.
        vm.prank(client);
        wrapper.proposeTerms(pactId, 800_000_000, 48 hours);

        // 2) provider counters with 950/24h. Pending clears.
        vm.prank(provider);
        wrapper.setBudget(pactId, 950_000_000, 24 hours);

        // 3) client re-proposes 950/36h (accepts budget, asks for longer window).
        vm.prank(client);
        wrapper.proposeTerms(pactId, 950_000_000, 36 hours);

        // 4) provider matches.
        vm.prank(provider);
        wrapper.setBudget(pactId, 950_000_000, 36 hours);

        // 5) client funds.
        vm.prank(client);
        wrapper.fund(pactId, 950_000_000, 36 hours);

        // Final state: pact Funded with the agreed terms.
        (uint256 b, uint64 w) = _liveQuote(pactId);
        assertEq(b, 950_000_000);
        assertEq(w, 36 hours);
    }

    // ──────────────────────────────────────────────────────────────────────
    //              §5.2 worked example 3: provider re-quote race
    // ──────────────────────────────────────────────────────────────────────

    function test_fundRevertsIfProviderReQuotesMidFlight() public {
        uint256 pactId = _quotedPact(); // live = (1000 USDC, 24h)

        // Provider re-quotes a higher number JUST before client's fund tx lands.
        vm.prank(provider);
        wrapper.setBudget(pactId, 1_100_000_000, DEFAULT_CHALLENGE);

        // Client's tx (signed against the old quote) reverts atomically.
        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(
                PactWrapper.WrongTerms.selector,
                DEFAULT_BUDGET,
                DEFAULT_CHALLENGE,
                1_100_000_000,
                DEFAULT_CHALLENGE
            )
        );
        wrapper.fund(pactId, DEFAULT_BUDGET, DEFAULT_CHALLENGE);

        // No funds moved.
        assertEq(wrapper.treasuryBalance(), 0);
    }

    function test_fundRevertsIfWindowChangedMidFlight() public {
        uint256 pactId = _quotedPact();

        vm.prank(provider);
        wrapper.setBudget(pactId, DEFAULT_BUDGET, 48 hours);

        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(
                PactWrapper.WrongTerms.selector,
                DEFAULT_BUDGET,
                DEFAULT_CHALLENGE,
                DEFAULT_BUDGET,
                48 hours
            )
        );
        wrapper.fund(pactId, DEFAULT_BUDGET, DEFAULT_CHALLENGE);
    }

    // ──────────────────────────────────────────────────────────────────────
    //         §5.2 worked example 4: client never proposes, provider re-quotes
    // ──────────────────────────────────────────────────────────────────────

    function test_providerReQuoteWithoutPendingProposalWorks() public {
        uint256 pactId = _createDefaultPact();

        // First quote.
        vm.prank(provider);
        wrapper.setBudget(pactId, 1_000_000_000, 0);

        // Re-quote some time later.
        vm.warp(block.timestamp + 1 hours);
        vm.prank(provider);
        wrapper.setBudget(pactId, 950_000_000, 0);

        // Client funds against the new quote.
        vm.prank(client);
        wrapper.fund(pactId, 950_000_000, DEFAULT_CHALLENGE);

        (uint256 b, ) = _liveQuote(pactId);
        assertEq(b, 950_000_000);
    }
}
