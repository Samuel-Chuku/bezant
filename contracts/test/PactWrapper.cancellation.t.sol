// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {PactWrapperFixture} from "./helpers/PactWrapperFixture.t.sol";
import {PactWrapper} from "../src/PactWrapper.sol";

// cancel (from Open) + reject (from Funded/Submitted) coverage. claimRefund
// + extendDeadline live in PactWrapper.deadlines.t.sol since they're
// deadline-driven.
contract PactWrapperCancellationTest is PactWrapperFixture {
    bytes32 internal constant DUMMY_HASH = keccak256("d");

    function _status(uint256 pactId) internal view returns (PactWrapper.Status) {
        (
            ,
            ,
            ,
            ,
            ,
            ,
            PactWrapper.Status s,
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
        return s;
    }

    function _terminationActor(uint256 pactId) internal view returns (address) {
        (
            ,
            ,
            ,
            ,
            ,
            ,
            ,
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
        return actor;
    }

    // ──────────────────────────────────────────────────────────────────────
    //                              cancel
    // ──────────────────────────────────────────────────────────────────────

    function test_cancel_fromOpen_setsExpiredNoFundsMove() public {
        uint256 pactId = _createDefaultPact();
        uint256 clientBefore = usdc.balanceOf(client);

        vm.prank(client);
        wrapper.cancel(pactId);

        assertEq(uint8(_status(pactId)), uint8(PactWrapper.Status.Expired));
        assertEq(_terminationActor(pactId), client);
        assertEq(usdc.balanceOf(client), clientBefore, "no funds moved");
        assertEq(wrapper.treasuryBalance(), 0, "no fee accrual on cancel");
    }

    function test_cancel_fromOpen_afterProviderQuoted_stillWorks() public {
        uint256 pactId = _quotedPact();
        vm.prank(client);
        wrapper.cancel(pactId);
        assertEq(uint8(_status(pactId)), uint8(PactWrapper.Status.Expired));
    }

    function test_cancel_revertsOnNonClient() public {
        uint256 pactId = _createDefaultPact();
        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(PactWrapper.NotClient.selector, provider));
        wrapper.cancel(pactId);
    }

    function test_cancel_revertsFromFunded() public {
        uint256 pactId = _fundedPact();
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(
            PactWrapper.WrongStatus.selector,
            PactWrapper.Status.Funded,
            PactWrapper.Status.Open
        ));
        wrapper.cancel(pactId);
    }

    function test_cancel_revertsFromSubmitted() public {
        uint256 pactId = _submittedPact(DUMMY_HASH);
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(
            PactWrapper.WrongStatus.selector,
            PactWrapper.Status.Submitted,
            PactWrapper.Status.Open
        ));
        wrapper.cancel(pactId);
    }

    // ──────────────────────────────────────────────────────────────────────
    //                              reject
    // ──────────────────────────────────────────────────────────────────────

    function test_reject_fromFunded_refundsClient() public {
        uint256 pactId = _fundedPact();
        uint256 clientBefore = usdc.balanceOf(client);

        vm.prank(client);
        wrapper.reject(pactId, bytes32(uint256(0xCAFE)));

        assertEq(uint8(_status(pactId)), uint8(PactWrapper.Status.Rejected));
        assertEq(_terminationActor(pactId), client);
        assertEq(usdc.balanceOf(client), clientBefore + DEFAULT_BUDGET, "client got budget back");
    }

    function test_reject_fromSubmitted_refundsClient() public {
        uint256 pactId = _submittedPact(DUMMY_HASH);
        uint256 clientBefore = usdc.balanceOf(client);

        vm.prank(client);
        wrapper.reject(pactId, bytes32(0));

        assertEq(uint8(_status(pactId)), uint8(PactWrapper.Status.Rejected));
        assertEq(usdc.balanceOf(client), clientBefore + DEFAULT_BUDGET);
    }

    function test_reject_atProdFee_retainsFeeInTreasury() public {
        // Deploy a fresh wrapper at 70 bps prod fee so we can assert fee retention.
        vm.prank(owner);
        PactWrapper prodWrapper = new PactWrapper(
            address(usdc),
            address(refContract),
            treasury,
            PLATFORM_FEE_BPS_PROD
        );
        vm.prank(client);   usdc.approve(address(prodWrapper), type(uint256).max);
        vm.prank(provider); usdc.approve(address(prodWrapper), type(uint256).max);

        vm.prank(client);
        uint256 pactId = prodWrapper.createPact(provider, _defaultExpiredAt(), "demo", address(0), DEFAULT_CHALLENGE);
        vm.prank(provider); prodWrapper.setBudget(pactId, DEFAULT_BUDGET, 0);

        uint256 expectedFee = (DEFAULT_BUDGET * 70) / 10_000;

        vm.prank(client);
        prodWrapper.fund(pactId, DEFAULT_BUDGET, DEFAULT_CHALLENGE);
        assertEq(prodWrapper.treasuryBalance(), expectedFee);

        // Client rejects mid-Funded.
        uint256 clientBefore = usdc.balanceOf(client);
        vm.prank(client);
        prodWrapper.reject(pactId, bytes32(0));

        assertEq(usdc.balanceOf(client), clientBefore + DEFAULT_BUDGET, "client refunded budget");
        assertEq(prodWrapper.treasuryBalance(), expectedFee, "fee retained per locked spec");
    }

    function test_reject_revertsOnNonClient() public {
        uint256 pactId = _fundedPact();
        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(PactWrapper.NotClient.selector, provider));
        wrapper.reject(pactId, bytes32(0));
    }

    function test_reject_revertsFromOpen() public {
        uint256 pactId = _createDefaultPact();
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(PactWrapper.WrongStatusMulti.selector, PactWrapper.Status.Open));
        wrapper.reject(pactId, bytes32(0));
    }

    function test_reject_revertsFromCompleted() public {
        uint256 pactId = _submittedPact(DUMMY_HASH);
        vm.prank(client);
        wrapper.clientAccept(pactId);

        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(PactWrapper.WrongStatusMulti.selector, PactWrapper.Status.Completed));
        wrapper.reject(pactId, bytes32(0));
    }
}
