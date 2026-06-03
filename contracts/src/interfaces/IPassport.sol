// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @notice On-chain SME credit passport. The escrow reads `depositBps` at trade
/// creation (executable policy — it sets how much the buyer must lock, not a
/// display number) and writes the outcome on settlement. ERC-8004-style; a real
/// ERC-8004 reputation adapter can implement this without changing the escrow.
interface IPassport {
    /// @return basis points of the trade value the buyer must deposit (10000 = 100%).
    function depositBps(address buyer) external view returns (uint16);

    /// @return a coarse tier used to price financing (e.g. completed-trade count, capped).
    function tier(address account) external view returns (uint8);

    /// @notice Escrow-only: record a settled trade outcome for the buyer.
    function recordTrade(address buyer, address seller, bool success) external;
}
