// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @notice LP-funded USDC vault that advances a seller their receivable, priced
/// off the buyer's passport tier. Only the escrow may draw/settle advances.
/// In production the seller payout is a Circle Gateway settlement.
interface IFinancingPool {
    /// @notice Advance `amount` (gross) against trade `tradeId`; pays the seller
    /// the net (amount − fee), records the principal as outstanding.
    /// @return fee charged on the advance (kept by the pool as yield on repay).
    function advance(uint256 tradeId, address seller, uint256 amount, uint8 buyerTier) external returns (uint256 fee);

    /// @notice Mark a trade's advance repaid (the escrow transfers the gross here
    /// first). Clears its outstanding principal.
    function repay(uint256 tradeId) external;

    /// @notice Write off a trade's advance as a loss (buyer-win dispute / refund):
    /// the principal leaves the pool's assets, lowering NAV for all LPs.
    function writeOff(uint256 tradeId) external;
}
