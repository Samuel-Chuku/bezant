// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {PactWrapperFixture} from "./helpers/PactWrapperFixture.t.sol";
import {PactWrapper} from "../src/PactWrapper.sol";

// Full dispute lifecycle: open → concede / forceConcede / defend → commit
// → reveal → resolve. Bond math, no-quorum branch, evaluator scoring.
contract PactWrapperDisputeTest is PactWrapperFixture {
    bytes32 internal constant DUMMY_HASH = keccak256("d");
    uint256 internal constant MIN_STAKE  = 100_000_000;

    function _stakeFourEvaluators() internal {
        vm.prank(evaluatorA); wrapper.stakeEvaluator(MIN_STAKE);
        vm.prank(evaluatorB); wrapper.stakeEvaluator(MIN_STAKE);
        vm.prank(evaluatorC); wrapper.stakeEvaluator(MIN_STAKE);
        vm.prank(evaluatorD); wrapper.stakeEvaluator(MIN_STAKE);
    }

    function _commitHash(PactWrapper.Vote v, bytes32 secret, address ev) internal pure returns (bytes32) {
        return keccak256(abi.encode(v, secret, ev));
    }

    function _pactStatus(uint256 pactId) internal view returns (PactWrapper.Status) {
        (, , , , , , PactWrapper.Status s, , , , , , , , , , ) = wrapper.pacts(pactId);
        return s;
    }

    function _selectedEvaluators(uint256 disputeId) internal view returns (address[3] memory) {
        (
            , , , , , , , , , , , ,
            address[3] memory ev,
            , , ,
        ) = wrapper.getDisputeMeta(disputeId);
        return ev;
    }

    function _disputeStatus(uint256 disputeId) internal view returns (PactWrapper.DisputeStatus) {
        (
            , , , , , ,
            PactWrapper.DisputeStatus status,
            , , , , , , , , ,
        ) = wrapper.getDisputeMeta(disputeId);
        return status;
    }

    // ──────────────────────────────────────────────────────────────────────
    //                                dispute
    // ──────────────────────────────────────────────────────────────────────

    function test_dispute_byClient_opensCorrectly() public {
        uint256 pactId = _submittedPact(DUMMY_HASH);
        uint256 expectedBond = (DEFAULT_BUDGET * 500) / 10_000; // 5%

        uint256 clientBefore = usdc.balanceOf(client);

        vm.prank(client);
        uint256 disputeId = wrapper.dispute(pactId, bytes32(uint256(0xBEEF)));

        assertEq(disputeId, 1, "first dispute id");
        assertEq(uint8(_pactStatus(pactId)), uint8(PactWrapper.Status.Disputed));
        assertEq(usdc.balanceOf(client), clientBefore - expectedBond, "client paid bond");

        (
            uint256 pid,
            address disputer,
            address opponent,
            uint256 bondD,
            uint256 bondO,
            bytes32 reason,
            PactWrapper.DisputeStatus status,
            , , , , , , , , ,
        ) = wrapper.getDisputeMeta(disputeId);
        assertEq(pid, pactId);
        assertEq(disputer, client);
        assertEq(opponent, provider);
        assertEq(bondD, expectedBond);
        assertEq(bondO, 0);
        assertEq(reason, bytes32(uint256(0xBEEF)));
        assertEq(uint8(status), uint8(PactWrapper.DisputeStatus.Open));
    }

    function test_dispute_byProvider_opensCorrectly() public {
        uint256 pactId = _submittedPact(DUMMY_HASH);

        vm.prank(provider);
        uint256 disputeId = wrapper.dispute(pactId, bytes32(0));

        (, address disputer, address opponent, , , , , , , , , , , , , , ) =
            wrapper.getDisputeMeta(disputeId);
        assertEq(disputer, provider);
        assertEq(opponent, client);
    }

    function test_dispute_revertsOnNonParty() public {
        uint256 pactId = _submittedPact(DUMMY_HASH);
        address random = makeAddr("random");
        vm.prank(random);
        vm.expectRevert(PactWrapper.NotPactParticipant.selector);
        wrapper.dispute(pactId, bytes32(0));
    }

    function test_dispute_revertsAfterChallengeWindowCloses() public {
        uint256 pactId = _submittedPact(DUMMY_HASH);
        vm.warp(block.timestamp + DEFAULT_CHALLENGE + 1);
        vm.prank(client);
        vm.expectRevert();
        wrapper.dispute(pactId, bytes32(0));
    }

    function test_dispute_revertsIfAlreadyOpen() public {
        uint256 pactId = _submittedPact(DUMMY_HASH);
        vm.prank(client);
        wrapper.dispute(pactId, bytes32(0));

        vm.prank(provider);
        // Pact is now Disputed status, so the inStatus(Submitted) modifier fires.
        vm.expectRevert();
        wrapper.dispute(pactId, bytes32(0));
    }

    // ──────────────────────────────────────────────────────────────────────
    //                              concede
    // ──────────────────────────────────────────────────────────────────────

    function test_concede_disputerIsProvider_pactCompletes() public {
        uint256 pactId = _submittedPact(DUMMY_HASH);
        vm.prank(provider);
        wrapper.dispute(pactId, bytes32(0));

        uint256 expectedBond = (DEFAULT_BUDGET * 500) / 10_000;
        uint256 providerBefore = usdc.balanceOf(provider);

        vm.prank(client);
        wrapper.concede(pactId);

        // Provider's bond returned + budget paid out.
        assertEq(usdc.balanceOf(provider), providerBefore + expectedBond + DEFAULT_BUDGET);
        assertEq(uint8(_pactStatus(pactId)), uint8(PactWrapper.Status.Completed));
    }

    function test_concede_disputerIsClient_pactRejects() public {
        uint256 pactId = _submittedPact(DUMMY_HASH);
        vm.prank(client);
        wrapper.dispute(pactId, bytes32(0));

        uint256 expectedBond = (DEFAULT_BUDGET * 500) / 10_000;
        uint256 clientBefore = usdc.balanceOf(client);

        vm.prank(provider);
        wrapper.concede(pactId);

        // Client's bond returned + budget refunded.
        assertEq(usdc.balanceOf(client), clientBefore + expectedBond + DEFAULT_BUDGET);
        assertEq(uint8(_pactStatus(pactId)), uint8(PactWrapper.Status.Rejected));
    }

    function test_concede_revertsOnNonOpponent() public {
        uint256 pactId = _submittedPact(DUMMY_HASH);
        vm.prank(client);
        wrapper.dispute(pactId, bytes32(0));

        // The disputer themselves can't concede (they opened it).
        vm.prank(client);
        vm.expectRevert(PactWrapper.NotDisputeOpponent.selector);
        wrapper.concede(pactId);
    }

    function test_concede_revertsAfterConcedeDeadline() public {
        uint256 pactId = _submittedPact(DUMMY_HASH);
        vm.prank(client);
        wrapper.dispute(pactId, bytes32(0));

        vm.warp(block.timestamp + 48 hours + 1);
        vm.prank(provider);
        vm.expectRevert(PactWrapper.ConcedeDeadlinePassed.selector);
        wrapper.concede(pactId);
    }

    // ──────────────────────────────────────────────────────────────────────
    //                            forceConcede
    // ──────────────────────────────────────────────────────────────────────

    function test_forceConcede_afterDeadline_disputerWins() public {
        uint256 pactId = _submittedPact(DUMMY_HASH);
        vm.prank(provider);
        wrapper.dispute(pactId, bytes32(0));

        uint256 providerBefore = usdc.balanceOf(provider);
        uint256 expectedBond = (DEFAULT_BUDGET * 500) / 10_000;

        vm.warp(block.timestamp + 48 hours + 1);
        vm.prank(makeAddr("anyone"));
        wrapper.forceConcede(pactId);

        assertEq(usdc.balanceOf(provider), providerBefore + expectedBond + DEFAULT_BUDGET);
        assertEq(uint8(_pactStatus(pactId)), uint8(PactWrapper.Status.Completed));
    }

    function test_forceConcede_revertsBeforeDeadline() public {
        uint256 pactId = _submittedPact(DUMMY_HASH);
        vm.prank(client);
        wrapper.dispute(pactId, bytes32(0));

        vm.prank(makeAddr("anyone"));
        vm.expectRevert(PactWrapper.ConcedeDeadlineNotYetPassed.selector);
        wrapper.forceConcede(pactId);
    }

    // ──────────────────────────────────────────────────────────────────────
    //                              defend
    // ──────────────────────────────────────────────────────────────────────

    function test_defend_pullsBondAndSelectsEvaluators() public {
        _stakeFourEvaluators();
        uint256 pactId = _submittedPact(DUMMY_HASH);
        vm.prank(client);
        uint256 disputeId = wrapper.dispute(pactId, bytes32(0));

        uint256 providerBefore = usdc.balanceOf(provider);
        uint256 expectedBond   = (DEFAULT_BUDGET * 500) / 10_000;

        vm.prank(provider);
        wrapper.defend(pactId);

        assertEq(usdc.balanceOf(provider), providerBefore - expectedBond);
        assertEq(uint8(_disputeStatus(disputeId)), uint8(PactWrapper.DisputeStatus.Defended));

        address[3] memory selected = _selectedEvaluators(disputeId);
        for (uint8 i = 0; i < 3; i++) {
            assertTrue(selected[i] != address(0), "evaluator slot filled");
            (, , , , uint32 refs, ) = wrapper.evaluators(selected[i]);
            assertEq(refs, 1, "pendingDisputeRefs incremented");
        }
    }

    function test_defend_revertsOnInsufficientPool() public {
        // Only 2 evaluators staked — below the 3-min for selection.
        vm.prank(evaluatorA); wrapper.stakeEvaluator(MIN_STAKE);
        vm.prank(evaluatorB); wrapper.stakeEvaluator(MIN_STAKE);

        uint256 pactId = _submittedPact(DUMMY_HASH);
        vm.prank(client);
        wrapper.dispute(pactId, bytes32(0));

        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(PactWrapper.InsufficientEvaluators.selector, uint256(2)));
        wrapper.defend(pactId);
    }

    function test_defend_revertsOnNonOpponent() public {
        _stakeFourEvaluators();
        uint256 pactId = _submittedPact(DUMMY_HASH);
        vm.prank(client);
        wrapper.dispute(pactId, bytes32(0));

        vm.prank(client); // disputer, not opponent
        vm.expectRevert(PactWrapper.NotDisputeOpponent.selector);
        wrapper.defend(pactId);
    }

    // ──────────────────────────────────────────────────────────────────────
    //                            commitVote
    // ──────────────────────────────────────────────────────────────────────

    function test_commitVote_byNonSelected_reverts() public {
        _stakeFourEvaluators();
        uint256 pactId = _submittedPact(DUMMY_HASH);
        vm.prank(client);
        wrapper.dispute(pactId, bytes32(0));
        vm.prank(provider);
        wrapper.defend(pactId);

        // Find a non-selected evaluator.
        uint256 disputeId = 1;
        address[3] memory selected = _selectedEvaluators(disputeId);
        address[4] memory all = [evaluatorA, evaluatorB, evaluatorC, evaluatorD];
        address nonSelected;
        for (uint8 i = 0; i < 4; i++) {
            bool inSet = false;
            for (uint8 j = 0; j < 3; j++) if (all[i] == selected[j]) inSet = true;
            if (!inSet) { nonSelected = all[i]; break; }
        }

        vm.prank(nonSelected);
        vm.expectRevert(abi.encodeWithSelector(PactWrapper.EvaluatorNotSelected.selector, nonSelected));
        wrapper.commitVote(pactId, bytes32(uint256(1)));
    }

    function test_commitVote_revertsAfterGraceDeadline() public {
        _stakeFourEvaluators();
        uint256 pactId = _submittedPact(DUMMY_HASH);
        vm.prank(client); wrapper.dispute(pactId, bytes32(0));
        vm.prank(provider); wrapper.defend(pactId);

        // grace = commit (12h) + 1h = 13h
        vm.warp(block.timestamp + 13 hours + 1);
        address[3] memory selected = _selectedEvaluators(1);

        vm.prank(selected[0]);
        vm.expectRevert(PactWrapper.GraceWindowClosed.selector);
        wrapper.commitVote(pactId, bytes32(uint256(1)));
    }

    // ──────────────────────────────────────────────────────────────────────
    //                            revealVote
    // ──────────────────────────────────────────────────────────────────────

    function test_revealVote_happyPath() public {
        _stakeFourEvaluators();
        uint256 pactId = _submittedPact(DUMMY_HASH);
        vm.prank(client); uint256 disputeId = wrapper.dispute(pactId, bytes32(0));
        vm.prank(provider); wrapper.defend(pactId);

        address[3] memory selected = _selectedEvaluators(disputeId);
        bytes32 secret = bytes32(uint256(0xCAFE));
        bytes32 commit0 = _commitHash(PactWrapper.Vote.ForDisputer, secret, selected[0]);

        vm.prank(selected[0]);
        wrapper.commitVote(pactId, commit0);

        // Warp past grace (commit 12h + grace 1h = 13h), into reveal.
        vm.warp(block.timestamp + 13 hours + 1);

        vm.prank(selected[0]);
        wrapper.revealVote(pactId, selected[0], PactWrapper.Vote.ForDisputer, secret);

        // revealCount should now be 1 / votesForDisputer 1.
        (
            , , , , , , , , , , , , ,
            , uint8 revealCount, uint8 vDisp, uint8 vOpp
        ) = wrapper.getDisputeMeta(disputeId);
        assertEq(revealCount, 1);
        assertEq(vDisp, 1);
        assertEq(vOpp, 0);
    }

    function test_revealVote_revertsOnCommitMismatch() public {
        _stakeFourEvaluators();
        uint256 pactId = _submittedPact(DUMMY_HASH);
        vm.prank(client); uint256 disputeId = wrapper.dispute(pactId, bytes32(0));
        vm.prank(provider); wrapper.defend(pactId);

        address[3] memory selected = _selectedEvaluators(disputeId);
        bytes32 commit0 = _commitHash(PactWrapper.Vote.ForDisputer, bytes32(uint256(1)), selected[0]);
        vm.prank(selected[0]);
        wrapper.commitVote(pactId, commit0);

        vm.warp(block.timestamp + 13 hours + 1);

        // Reveal with a different secret.
        vm.prank(selected[0]);
        vm.expectRevert(PactWrapper.CommitMismatch.selector);
        wrapper.revealVote(pactId, selected[0], PactWrapper.Vote.ForDisputer, bytes32(uint256(2)));
    }

    function test_revealVote_revertsBeforeRevealOpens() public {
        _stakeFourEvaluators();
        uint256 pactId = _submittedPact(DUMMY_HASH);
        vm.prank(client); wrapper.dispute(pactId, bytes32(0));
        vm.prank(provider); wrapper.defend(pactId);

        address[3] memory selected = _selectedEvaluators(1);
        bytes32 commit0 = _commitHash(PactWrapper.Vote.ForDisputer, bytes32(uint256(1)), selected[0]);
        vm.prank(selected[0]);
        wrapper.commitVote(pactId, commit0);

        // No warp — still in commit/grace phase.
        vm.prank(selected[0]);
        vm.expectRevert(PactWrapper.RevealNotOpen.selector);
        wrapper.revealVote(pactId, selected[0], PactWrapper.Vote.ForDisputer, bytes32(uint256(1)));
    }

    // ──────────────────────────────────────────────────────────────────────
    //                              resolve
    // ──────────────────────────────────────────────────────────────────────

    function _runFullDispute(
        address disputer,
        address opponent,
        PactWrapper.Vote[3] memory votes,
        bool[3] memory shouldReveal
    ) internal returns (uint256 pactId, uint256 disputeId, address[3] memory selected) {
        pactId = _submittedPact(DUMMY_HASH);
        vm.prank(disputer);
        disputeId = wrapper.dispute(pactId, bytes32(0));
        vm.prank(opponent);
        wrapper.defend(pactId);

        selected = _selectedEvaluators(disputeId);

        bytes32 secret = bytes32(uint256(0xABCD));
        for (uint8 i = 0; i < 3; i++) {
            bytes32 c = _commitHash(votes[i], secret, selected[i]);
            vm.prank(selected[i]);
            wrapper.commitVote(pactId, c);
        }

        // commit (12h) + grace (1h) = 13h → reveal phase opens at 13h.
        vm.warp(block.timestamp + 13 hours + 1);

        for (uint8 i = 0; i < 3; i++) {
            if (!shouldReveal[i]) continue;
            vm.prank(selected[i]);
            wrapper.revealVote(pactId, selected[i], votes[i], secret);
        }
    }

    function test_resolve_majorityDisputerProvider_paysProviderAndScoresEvaluators() public {
        _stakeFourEvaluators();

        PactWrapper.Vote[3] memory votes = [
            PactWrapper.Vote.ForDisputer,
            PactWrapper.Vote.ForDisputer,
            PactWrapper.Vote.ForOpponent
        ];
        bool[3] memory shouldReveal = [true, true, true];

        uint256 providerBefore = usdc.balanceOf(provider);
        uint256 clientBefore   = usdc.balanceOf(client);
        uint256 bond = (DEFAULT_BUDGET * 500) / 10_000; // 50 USDC
        // winner: bond + 10% of loser bond = 50 + 5 = 55
        // loser:  50% × 50 = 25
        // pool:   40% × 50 = 20 (split 3 ways: 6 + 6 + dust 8 → first revealer)

        (uint256 pactId, uint256 disputeId, address[3] memory selected) = _runFullDispute(
            provider, client, votes, shouldReveal
        );

        // Force the resolution after reveal window.
        vm.warp(block.timestamp + 2 hours + 1);
        vm.prank(makeAddr("resolver"));
        wrapper.resolve(pactId);

        // Provider (disputer + winner): bond back + 10% bonus + budget paid out.
        // Provider net delta vs providerBefore: + bond + bonus + budget - bond_paid
        //   = providerBefore - bond + (55 + DEFAULT_BUDGET)
        //   = providerBefore - 50 + 55 + 1000_000_000
        //   = providerBefore + 5 + 1000_000_000
        assertEq(usdc.balanceOf(provider), providerBefore - bond + 55_000_000 + DEFAULT_BUDGET);

        // Client (opponent + loser) flows over the whole test:
        //   - fund: -DEFAULT_BUDGET (budget locks in reference)
        //   - defend: -bond
        //   - resolve: +25 (loserReturn)
        // Budget stays locked since the pact completes in the provider's favor.
        assertEq(usdc.balanceOf(client), clientBefore - DEFAULT_BUDGET - bond + 25_000_000);

        // Each revealer gets ≥ 6.66; with dust the first gets ~8.
        // Sum across 3 evaluators must equal 20.
        uint256 totalToEvaluators;
        for (uint8 i = 0; i < 3; i++) totalToEvaluators += usdc.balanceOf(selected[i]) - (ACTOR_BALANCE - MIN_STAKE);
        assertEq(totalToEvaluators, 20_000_000, "evaluator pool fully distributed");

        // Dispute status set to Resolved_Disputer.
        assertEq(uint8(_disputeStatus(disputeId)), uint8(PactWrapper.DisputeStatus.Resolved_Disputer));
        assertEq(uint8(_pactStatus(pactId)), uint8(PactWrapper.Status.Completed));

        // Evaluator stats: two aligned with majority, one not. Each gets totalVotes++.
        uint32 aligned;
        for (uint8 i = 0; i < 3; i++) {
            (, , uint32 total, uint32 maj, , ) = wrapper.evaluators(selected[i]);
            assertEq(total, 1);
            if (maj == 1) aligned++;
        }
        assertEq(aligned, 2, "two evaluators aligned with disputer");
    }

    function test_resolve_majorityOpponentClient_refundsClient() public {
        _stakeFourEvaluators();

        // Provider disputes; opponent (client) wins.
        PactWrapper.Vote[3] memory votes = [
            PactWrapper.Vote.ForOpponent,
            PactWrapper.Vote.ForOpponent,
            PactWrapper.Vote.ForOpponent
        ];
        bool[3] memory shouldReveal = [true, true, true];

        uint256 clientBefore = usdc.balanceOf(client);
        uint256 bond = (DEFAULT_BUDGET * 500) / 10_000;

        (uint256 pactId, uint256 disputeId, ) = _runFullDispute(
            provider, client, votes, shouldReveal
        );

        vm.warp(block.timestamp + 2 hours + 1);
        wrapper.resolve(pactId);

        // Client (opponent + winner) flows over the whole test:
        //   - fund: -DEFAULT_BUDGET
        //   - defend: -bond
        //   - resolve: +winnerReturn = bond + 10%×loserBond = 55M
        //   - settleAsRejected: +DEFAULT_BUDGET (refund forwarded to client)
        // Net: +10%×bond = +5M
        assertEq(usdc.balanceOf(client), clientBefore + 5_000_000);

        assertEq(uint8(_disputeStatus(disputeId)), uint8(PactWrapper.DisputeStatus.Resolved_Opponent));
        assertEq(uint8(_pactStatus(pactId)), uint8(PactWrapper.Status.Rejected));
    }

    function test_resolve_noQuorum_refundsBondsAndRewindsPact() public {
        _stakeFourEvaluators();

        // Only 1 evaluator reveals — below QUORUM = 2.
        PactWrapper.Vote[3] memory votes = [
            PactWrapper.Vote.ForDisputer,
            PactWrapper.Vote.ForDisputer,
            PactWrapper.Vote.ForDisputer
        ];
        bool[3] memory shouldReveal = [true, false, false];

        uint256 clientBefore   = usdc.balanceOf(client);
        uint256 providerBefore = usdc.balanceOf(provider);
        uint256 bond = (DEFAULT_BUDGET * 500) / 10_000;

        (uint256 pactId, uint256 disputeId, address[3] memory selected) = _runFullDispute(
            client, provider, votes, shouldReveal
        );

        vm.warp(block.timestamp + 2 hours + 1);
        wrapper.resolve(pactId);

        // Both bonds refunded fully; budget remains locked in reference because the
        // pact rewinds to Submitted instead of resolving. Client paid the budget at
        // fund time so they're still down DEFAULT_BUDGET overall.
        assertEq(usdc.balanceOf(client), clientBefore - DEFAULT_BUDGET);
        assertEq(usdc.balanceOf(provider), providerBefore);

        // Evaluators: no scoring, pendingDisputeRefs back to 0.
        for (uint8 i = 0; i < 3; i++) {
            (, , uint32 total, , uint32 refs, ) = wrapper.evaluators(selected[i]);
            assertEq(total, 0, "no-quorum doesn't score totalVotes");
            assertEq(refs, 0, "pendingDisputeRefs decremented");
        }

        // Pact returns to Submitted with fresh challenge window.
        assertEq(uint8(_pactStatus(pactId)), uint8(PactWrapper.Status.Submitted));
        (, , , , , , , , , , , ,
            ,
            , uint64 newSubmittedAt, , ) = wrapper.pacts(pactId);
        assertEq(newSubmittedAt, uint64(block.timestamp), "submittedAt reset to now");

        assertEq(uint8(_disputeStatus(disputeId)), uint8(PactWrapper.DisputeStatus.Resolved_NoQuorum));
    }

    function test_resolve_revertsBeforeRevealWindowEnds() public {
        _stakeFourEvaluators();

        PactWrapper.Vote[3] memory votes = [
            PactWrapper.Vote.ForDisputer,
            PactWrapper.Vote.ForDisputer,
            PactWrapper.Vote.ForOpponent
        ];
        bool[3] memory shouldReveal = [true, false, false]; // partial, before window close

        (uint256 pactId, , ) = _runFullDispute(client, provider, votes, shouldReveal);

        // Inside reveal window still.
        vm.expectRevert(PactWrapper.ResolutionTooEarly.selector);
        wrapper.resolve(pactId);
    }

    function test_resolve_allRevealedEarlyExit_skipsWaiting() public {
        _stakeFourEvaluators();

        PactWrapper.Vote[3] memory votes = [
            PactWrapper.Vote.ForDisputer,
            PactWrapper.Vote.ForDisputer,
            PactWrapper.Vote.ForDisputer
        ];
        bool[3] memory shouldReveal = [true, true, true];

        (uint256 pactId, , ) = _runFullDispute(client, provider, votes, shouldReveal);

        // Still inside reveal window. All 3 revealed → resolve allowed early.
        wrapper.resolve(pactId);
        assertEq(uint8(_pactStatus(pactId)), uint8(PactWrapper.Status.Rejected));
    }
}
