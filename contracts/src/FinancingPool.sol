// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "./interfaces/IERC20.sol";
import {IFinancingPool} from "./interfaces/IFinancingPool.sol";

/// @notice USDC reserve that advances a seller their receivable at attestation,
/// priced off the buyer's passport tier (more history => cheaper). Only the
/// escrow may draw advances; the escrow routes repayment back here on release.
/// In production the seller payout is a Circle Gateway settlement.
contract FinancingPool is IFinancingPool {
    address public owner;
    IERC20 public immutable usdc;
    address public escrow;

    /// fee in bps by tier index; index >= length uses the last entry.
    /// default: tier0 -> 3%, tier1 -> 2%, tier2+ -> 1%.
    uint16[] public feeBpsByTier;

    event EscrowSet(address indexed escrow);
    event Funded(address indexed from, uint256 amount);
    event Advanced(address indexed seller, uint256 net, uint256 fee, uint8 tier);
    event Repaid(address indexed from, uint256 amount);

    error NotOwner();
    error NotEscrow();

    constructor(address usdc_) {
        owner = msg.sender;
        usdc = IERC20(usdc_);
        feeBpsByTier.push(300);
        feeBpsByTier.push(200);
        feeBpsByTier.push(100);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function setEscrow(address e) external onlyOwner {
        escrow = e;
        emit EscrowSet(e);
    }

    function setFeeTiers(uint16[] calldata f) external onlyOwner {
        delete feeBpsByTier;
        for (uint256 i; i < f.length; ++i) feeBpsByTier.push(f[i]);
    }

    /// @notice Top up the reserve (LP / treasury deposits USDC).
    function fund(uint256 amount) external {
        usdc.transferFrom(msg.sender, address(this), amount);
        emit Funded(msg.sender, amount);
    }

    function _feeBps(uint8 t) internal view returns (uint16) {
        uint256 i = t;
        uint256 n = feeBpsByTier.length;
        return feeBpsByTier[i >= n ? n - 1 : i];
    }

    function advance(address seller, uint256 amount, uint8 buyerTier) external returns (uint256 fee) {
        if (msg.sender != escrow) revert NotEscrow();
        fee = (amount * _feeBps(buyerTier)) / 10000;
        usdc.transfer(seller, amount - fee);
        emit Advanced(seller, amount - fee, fee, buyerTier);
    }

    /// @notice Escrow repays the gross advance here on release.
    function repay(uint256 amount) external {
        usdc.transferFrom(msg.sender, address(this), amount);
        emit Repaid(msg.sender, amount);
    }
}
