// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @notice USYC-style yield adapter (ERC-4626-ish). Idle escrow deposits are
/// parked here while a trade is locked and redeemed on settlement; the yield is
/// split buyer/seller/pool by the escrow. USYC is gated — the MVP builds against
/// this interface with a mock and swaps in real USYC via `setYieldVault` with no
/// escrow redeploy.
interface IYieldVault {
    function asset() external view returns (address);
    function deposit(uint256 assets) external returns (uint256 shares);
    function redeem(uint256 shares) external returns (uint256 assets);
    function previewRedeem(uint256 shares) external view returns (uint256 assets);
}
