// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "../../src/interfaces/IERC20.sol";
import {IYieldVault} from "../../src/interfaces/IYieldVault.sol";

/// @notice Mock USYC-style vault: one share is a proportional claim on the USDC
/// held. Tests simulate yield by minting extra USDC straight into the vault,
/// which raises the per-share redemption value. For test fixtures only.
contract MockYieldVault is IYieldVault {
    IERC20 public immutable usdc;
    uint256 public totalShares;
    mapping(address => uint256) public sharesOf;

    constructor(address usdc_) {
        usdc = IERC20(usdc_);
    }

    function asset() external view returns (address) {
        return address(usdc);
    }

    function totalAssets() public view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    function deposit(uint256 assets) external returns (uint256 shares) {
        uint256 ta = totalAssets(); // pre-transfer assets back the existing shares
        shares = totalShares == 0 ? assets : (assets * totalShares) / ta;
        usdc.transferFrom(msg.sender, address(this), assets);
        totalShares += shares;
        sharesOf[msg.sender] += shares;
    }

    function previewRedeem(uint256 shares) public view returns (uint256) {
        if (totalShares == 0) return 0;
        return (shares * totalAssets()) / totalShares;
    }

    function redeem(uint256 shares) external returns (uint256 assets) {
        assets = previewRedeem(shares);
        totalShares -= shares;
        sharesOf[msg.sender] -= shares;
        usdc.transfer(msg.sender, assets);
    }
}
