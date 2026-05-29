// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {PactWrapperFixture} from "./helpers/PactWrapperFixture.t.sol";
import {PactWrapper} from "../src/PactWrapper.sol";

contract PactWrapperLifecycleTest is PactWrapperFixture {
    // ──────────────────────────────────────────────────────────────────────
    //                              createPact
    // ──────────────────────────────────────────────────────────────────────

    function test_createPact_happy() public {
        uint64 expiredAt = _defaultExpiredAt();
        vm.prank(client);
        uint256 pactId = wrapper.createPact(provider, expiredAt, "demo", address(0), DEFAULT_CHALLENGE);

        assertEq(pactId, 1, "pactId starts at 1");
        (
            uint256 underlyingJobId,
            address c,
            address p,
            ,
            uint64 storedExpiredAt,
            ,
            PactWrapper.Status status,
            ,
            uint256 budget,
            uint64 cw,
            ,
            ,
            ,
            ,
            ,
            ,

        ) = wrapper.pacts(pactId);
        assertEq(c, client, "client set");
        assertEq(p, provider, "provider set");
        assertEq(storedExpiredAt, expiredAt, "expiredAt set");
        assertEq(uint8(status), uint8(PactWrapper.Status.Open), "status Open");
        assertEq(budget, 0, "budget unset at create");
        assertEq(cw, DEFAULT_CHALLENGE, "challenge window stored");
        assertEq(underlyingJobId, 1, "underlying job id 1");
    }

    function test_createPact_defaultWindowWhenZero() public {
        vm.prank(client);
        uint256 pactId = wrapper.createPact(provider, _defaultExpiredAt(), "demo", address(0), 0);
        (, , , , , , , , , uint64 cw, , , , , , , ) = wrapper.pacts(pactId);
        assertEq(cw, 24 hours, "0 defaults to CHALLENGE_DEFAULT");
    }

    function test_createPact_revertsOnTooShortDeadline() public {
        // 30-minute floor; ask for 10 minutes from now.
        uint64 expiredAt = uint64(block.timestamp) + 10 minutes;
        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(
                PactWrapper.DeadlineTooSoon.selector,
                uint64(block.timestamp) + 30 minutes
            )
        );
        wrapper.createPact(provider, expiredAt, "x", address(0), DEFAULT_CHALLENGE);
    }

    function test_createPact_revertsOnWindowBelowFloor() public {
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(PactWrapper.ChallengeWindowOutOfRange.selector, uint64(30 minutes)));
        wrapper.createPact(provider, _defaultExpiredAt(), "x", address(0), 30 minutes);
    }

    function test_createPact_revertsOnWindowAboveCeiling() public {
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(PactWrapper.ChallengeWindowOutOfRange.selector, uint64(30 days)));
        wrapper.createPact(provider, _defaultExpiredAt(), "x", address(0), 30 days);
    }

    // ──────────────────────────────────────────────────────────────────────
    //                              setBudget
    // ──────────────────────────────────────────────────────────────────────

    function test_setBudget_happy() public {
        uint256 pactId = _createDefaultPact();
        vm.prank(provider);
        wrapper.setBudget(pactId, DEFAULT_BUDGET, 0);
        (, , , , , , , , uint256 budget, uint64 cw, , , , , , , ) = wrapper.pacts(pactId);
        assertEq(budget, DEFAULT_BUDGET);
        assertEq(cw, DEFAULT_CHALLENGE, "window unchanged when 0 passed");
    }

    function test_setBudget_overridesWindow() public {
        uint256 pactId = _createDefaultPact();
        vm.prank(provider);
        wrapper.setBudget(pactId, DEFAULT_BUDGET, 48 hours);
        (, , , , , , , , , uint64 cw, , , , , , , ) = wrapper.pacts(pactId);
        assertEq(cw, 48 hours, "provider overrode window");
    }

    function test_setBudget_revertsOnNonProvider() public {
        uint256 pactId = _createDefaultPact();
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(PactWrapper.NotProvider.selector, client));
        wrapper.setBudget(pactId, DEFAULT_BUDGET, 0);
    }

    function test_setBudget_revertsOnZeroBudget() public {
        uint256 pactId = _createDefaultPact();
        vm.prank(provider);
        vm.expectRevert(PactWrapper.BudgetNotSet.selector);
        wrapper.setBudget(pactId, 0, 0);
    }

    // ──────────────────────────────────────────────────────────────────────
    //                                fund
    // ──────────────────────────────────────────────────────────────────────

    function test_fund_happy_atZeroFee() public {
        uint256 pactId = _quotedPact();
        uint256 clientBefore = usdc.balanceOf(client);

        vm.prank(client);
        wrapper.fund(pactId, DEFAULT_BUDGET, DEFAULT_CHALLENGE);

        assertEq(usdc.balanceOf(client), clientBefore - DEFAULT_BUDGET, "client paid budget only at 0 fee");
        assertEq(usdc.balanceOf(address(refContract)), DEFAULT_BUDGET, "reference holds escrow");
        assertEq(wrapper.treasuryBalance(), 0, "no fee accrued at 0 bps");

        (, , , , , , PactWrapper.Status status, , , , , , , , , , ) = wrapper.pacts(pactId);
        assertEq(uint8(status), uint8(PactWrapper.Status.Funded));
    }

    function test_fund_atProdFee_accruesTreasury() public {
        // setPlatformFeeBps is still NOT_IMPLEMENTED; deploy a fresh wrapper with prod fee.
        vm.prank(owner);
        PactWrapper prodWrapper = new PactWrapper(
            address(usdc),
            address(refContract),
            treasury,
            PLATFORM_FEE_BPS_PROD
        );

        // Approve and prefund actors for the new wrapper.
        vm.prank(client);    usdc.approve(address(prodWrapper), type(uint256).max);
        vm.prank(provider);  usdc.approve(address(prodWrapper), type(uint256).max);

        // Walk the lifecycle on the prod wrapper.
        vm.prank(client);
        uint256 pactId = prodWrapper.createPact(provider, _defaultExpiredAt(), "demo", address(0), DEFAULT_CHALLENGE);
        vm.prank(provider);
        prodWrapper.setBudget(pactId, DEFAULT_BUDGET, 0);

        uint256 clientBefore = usdc.balanceOf(client);
        uint256 expectedFee = (DEFAULT_BUDGET * 70) / 10_000;

        vm.prank(client);
        prodWrapper.fund(pactId, DEFAULT_BUDGET, DEFAULT_CHALLENGE);

        assertEq(usdc.balanceOf(client), clientBefore - DEFAULT_BUDGET - expectedFee, "client paid budget + fee");
        assertEq(prodWrapper.treasuryBalance(), expectedFee, "fee accrued to treasuryBalance");
        assertEq(usdc.balanceOf(address(refContract)), DEFAULT_BUDGET, "reference still holds only the budget");
    }

    function test_fund_revertsOnWrongTerms() public {
        uint256 pactId = _quotedPact();
        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(
                PactWrapper.WrongTerms.selector,
                DEFAULT_BUDGET + 1,
                DEFAULT_CHALLENGE,
                DEFAULT_BUDGET,
                DEFAULT_CHALLENGE
            )
        );
        wrapper.fund(pactId, DEFAULT_BUDGET + 1, DEFAULT_CHALLENGE);
    }

    function test_fund_revertsAfterDeadline() public {
        uint256 pactId = _quotedPact();
        // Roll past expiredAt.
        vm.warp(_defaultExpiredAt() + 1);
        vm.prank(client);
        vm.expectRevert(PactWrapper.FundingAfterExpiry.selector);
        wrapper.fund(pactId, DEFAULT_BUDGET, DEFAULT_CHALLENGE);
    }

    // ──────────────────────────────────────────────────────────────────────
    //                              submit
    // ──────────────────────────────────────────────────────────────────────

    function test_submit_happy() public {
        uint256 pactId = _fundedPact();
        bytes32 hash = keccak256("deliverable");
        vm.prank(provider);
        wrapper.submit(pactId, hash);

        (
            ,                              // 0  underlyingJobId
            ,                              // 1  client
            ,                              // 2  provider
            ,                              // 3  createdAt
            ,                              // 4  expiredAt
            ,                              // 5  submittedExtCount
            PactWrapper.Status status,     // 6  status
            ,                              // 7  terminationActor
            ,                              // 8  budget
            ,                              // 9  challengeWindow
            ,                              // 10 pendingBudget
            ,                              // 11 pendingChallengeWindow
            ,                              // 12 pendingProposedAt
            bytes32 storedHash,            // 13 deliverableHash
            uint64 submittedAt,            // 14 submittedAt
            ,                              // 15 disputeId
                                           // 16 confidentialPayout
        ) = wrapper.pacts(pactId);
        assertEq(uint8(status), uint8(PactWrapper.Status.Submitted));
        assertEq(storedHash, hash);
        assertEq(submittedAt, uint64(block.timestamp));
    }

    function test_submit_revertsOnZeroHash() public {
        uint256 pactId = _fundedPact();
        vm.prank(provider);
        vm.expectRevert(PactWrapper.CommitMissing.selector);
        wrapper.submit(pactId, bytes32(0));
    }

    // ──────────────────────────────────────────────────────────────────────
    //                            clientAccept
    // ──────────────────────────────────────────────────────────────────────

    function test_clientAccept_paysProviderInFull() public {
        uint256 pactId = _submittedPact(keccak256("d"));
        uint256 providerBefore = usdc.balanceOf(provider);

        vm.prank(client);
        wrapper.clientAccept(pactId);

        assertEq(usdc.balanceOf(provider), providerBefore + DEFAULT_BUDGET, "provider got full budget");
        (, , , , , , PactWrapper.Status status, address actor, , , , , , , , , ) =
            wrapper.pacts(pactId);
        assertEq(uint8(status), uint8(PactWrapper.Status.Completed));
        assertEq(actor, client, "terminationActor = client");
    }

    function test_clientAccept_revertsOnNonClient() public {
        uint256 pactId = _submittedPact(keccak256("d"));
        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(PactWrapper.NotClient.selector, provider));
        wrapper.clientAccept(pactId);
    }

    // ──────────────────────────────────────────────────────────────────────
    //                          complete (permissionless)
    // ──────────────────────────────────────────────────────────────────────

    function test_complete_revertsBeforeChallengeWindowCloses() public {
        uint256 pactId = _submittedPact(keccak256("d"));
        vm.prank(makeAddr("randomCaller"));
        vm.expectRevert(
            abi.encodeWithSelector(
                PactWrapper.ChallengeWindowStillOpen.selector,
                uint64(block.timestamp),
                uint64(block.timestamp)
            )
        );
        wrapper.complete(pactId, bytes32(0));
    }

    function test_complete_succeedsAfterChallengeWindowCloses() public {
        uint256 pactId = _submittedPact(keccak256("d"));
        uint256 providerBefore = usdc.balanceOf(provider);

        vm.warp(block.timestamp + DEFAULT_CHALLENGE + 1);
        address caller = makeAddr("randomCaller");
        vm.prank(caller);
        wrapper.complete(pactId, bytes32(uint256(0xDEADBEEF)));

        assertEq(usdc.balanceOf(provider), providerBefore + DEFAULT_BUDGET, "provider paid");
        (, , , , , , PactWrapper.Status status, address actor, , , , , , , , , ) =
            wrapper.pacts(pactId);
        assertEq(uint8(status), uint8(PactWrapper.Status.Completed));
        assertEq(actor, caller, "actor recorded as permissionless caller");
    }
}
