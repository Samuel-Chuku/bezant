// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @notice USDC reserve that advances a seller their receivable at attestation,
/// priced off the buyer's passport tier. In production the payout is a Circle
/// Gateway settlement to the seller's Circle Wallet; on-chain it is a USDC
/// transfer. Only the escrow may draw advances.
interface IFinancingPool {
    /// @return fee charged on the advance (deducted from the seller payout).
    function advance(address seller, uint256 amount, uint8 buyerTier) external returns (uint256 fee);
}
