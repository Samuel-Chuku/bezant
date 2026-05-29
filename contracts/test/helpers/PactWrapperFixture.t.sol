// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {PactWrapper} from "../../src/PactWrapper.sol";
import {MockUSDC} from "./MockUSDC.sol";
import {MockAgenticCommerce} from "./MockAgenticCommerce.sol";

// Shared setUp for every PactWrapper test. Deploys fresh USDC + Mock ERC-8183
// + Wrapper, allocates labelled actors, prefunds them.
abstract contract PactWrapperFixture is Test {
    PactWrapper internal wrapper;
    MockUSDC    internal usdc;
    MockAgenticCommerce internal refContract;

    address internal owner    = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal client   = makeAddr("client");
    address internal provider = makeAddr("provider");

    address internal evaluatorA = makeAddr("evaluatorA");
    address internal evaluatorB = makeAddr("evaluatorB");
    address internal evaluatorC = makeAddr("evaluatorC");
    address internal evaluatorD = makeAddr("evaluatorD");

    uint16 internal constant PLATFORM_FEE_BPS_DEFAULT = 0;     // demo default
    uint16 internal constant PLATFORM_FEE_BPS_PROD    = 70;    // 0.7%

    uint256 internal constant ACTOR_BALANCE = 1_000_000_000_000; // 1,000,000 USDC (6 decimals)
    uint256 internal constant DEFAULT_BUDGET = 1_000_000_000;    // 1,000 USDC

    uint64  internal constant DEFAULT_EXP_OFFSET = 3 days;
    uint64  internal constant DEFAULT_CHALLENGE  = 24 hours;

    function setUp() public virtual {
        usdc      = new MockUSDC();
        refContract = new MockAgenticCommerce(address(usdc));

        vm.prank(owner);
        wrapper = new PactWrapper(
            address(usdc),
            address(refContract),
            treasury,
            PLATFORM_FEE_BPS_DEFAULT
        );

        // Prefund every actor with a million USDC + standing approval to the wrapper.
        address[7] memory actors = [client, provider, evaluatorA, evaluatorB, evaluatorC, evaluatorD, owner];
        for (uint256 i = 0; i < actors.length; i++) {
            usdc.mint(actors[i], ACTOR_BALANCE);
            vm.prank(actors[i]);
            usdc.approve(address(wrapper), type(uint256).max);
        }
    }

    // ──────────────────────────────────────────────────────────────────────
    //                            HELPERS
    // ──────────────────────────────────────────────────────────────────────

    function _defaultExpiredAt() internal view returns (uint64) {
        return uint64(block.timestamp) + DEFAULT_EXP_OFFSET;
    }

    // Create a Pact with the default actors + window. Returns pactId.
    function _createDefaultPact() internal returns (uint256 pactId) {
        vm.prank(client);
        pactId = wrapper.createPact(
            provider,
            _defaultExpiredAt(),
            "test pact",
            address(0),
            DEFAULT_CHALLENGE
        );
    }

    // Walks createPact → setBudget. Returns pactId in Open with budget set.
    function _quotedPact() internal returns (uint256 pactId) {
        pactId = _createDefaultPact();
        vm.prank(provider);
        wrapper.setBudget(pactId, DEFAULT_BUDGET, 0);
    }

    // Walks createPact → setBudget → fund. Returns pactId in Funded.
    function _fundedPact() internal returns (uint256 pactId) {
        pactId = _quotedPact();
        vm.prank(client);
        wrapper.fund(pactId, DEFAULT_BUDGET, DEFAULT_CHALLENGE);
    }

    // Walks all the way to Submitted.
    function _submittedPact(bytes32 deliverableHash) internal returns (uint256 pactId) {
        pactId = _fundedPact();
        vm.prank(provider);
        wrapper.submit(pactId, deliverableHash);
    }
}
