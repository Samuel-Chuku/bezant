// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

// Pure helpers for fee + bond split math. Pulled out of PactWrapper so the
// numeric logic is unit-testable in isolation and the wrapper stays readable.
library BondMath {
    uint16 internal constant BPS_DENOM = 10_000;

    function platformFee(uint256 budget, uint16 bps) internal pure returns (uint256) {
        return (budget * bps) / BPS_DENOM;
    }

    function bondFor(uint256 budget, uint16 bondBps) internal pure returns (uint256) {
        return (budget * bondBps) / BPS_DENOM;
    }

    // Returns (winnerBondReturn, loserBondReturn, evaluatorPoolShare).
    // winner gets their full bond + WINNER_BONUS_BPS of loser's bond.
    // loser keeps LOSER_KEEPS_BPS of their own bond back.
    // evaluator pool takes EVALUATOR_POOL_BPS of the loser's bond.
    function splitDispute(
        uint256 winnerBond,
        uint256 loserBond,
        uint16 loserKeepsBps,
        uint16 winnerBonusBps,
        uint16 evaluatorPoolBps
    ) internal pure returns (uint256 winnerReturn, uint256 loserReturn, uint256 evaluatorShare) {
        winnerReturn = winnerBond + ((loserBond * winnerBonusBps) / BPS_DENOM);
        loserReturn  = (loserBond * loserKeepsBps) / BPS_DENOM;
        evaluatorShare = (loserBond * evaluatorPoolBps) / BPS_DENOM;
    }
}
