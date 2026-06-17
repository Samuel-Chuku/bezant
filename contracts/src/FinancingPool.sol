// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "./interfaces/IERC20.sol";
import {IFinancingPool} from "./interfaces/IFinancingPool.sol";

/// @notice LP-funded USDC vault (minimal ERC-4626-style) that advances sellers
/// their receivable, priced off the buyer's passport tier (more history =>
/// cheaper). LPs deposit USDC for shares and earn the financing fees as yield;
/// they bear credit risk — a written-off advance lowers NAV for all LPs.
///
/// Accounting: totalAssets = idle USDC + outstanding (principal advanced, not
/// yet repaid). An advance moves `net` from idle to outstanding (NAV flat); a
/// repay brings the gross back in (NAV up by the fee); a write-off drops the
/// outstanding with no cash in (NAV down by the lost principal).
contract FinancingPool is IFinancingPool {
    address public owner;
    address public escrow;
    IERC20 public immutable usdc;

    /// fee in bps by tier index; index >= length uses the last entry.
    /// default: tier0 -> 3%, tier1 -> 2%, tier2+ -> 1%.
    uint16[] public feeBpsByTier;

    // --- LP shares ---
    uint256 public totalShares;
    mapping(address => uint256) public shares;

    // --- deployed principal ---
    uint256 public outstanding; // sum of net advances not yet repaid/written off
    mapping(uint256 => uint256) public advanceNet; // tradeId => net advanced

    event EscrowSet(address indexed escrow);
    event Deposit(address indexed lp, uint256 assets, uint256 shares);
    event Withdraw(address indexed lp, uint256 assets, uint256 shares);
    event Advanced(uint256 indexed tradeId, address indexed seller, uint256 net, uint256 fee, uint8 tier);
    event Repaid(uint256 indexed tradeId, uint256 net);
    event WrittenOff(uint256 indexed tradeId, uint256 net);

    error NotOwner();
    error NotEscrow();
    error ZeroAmount();
    error InsufficientLiquidity();

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

    modifier onlyEscrow() {
        if (msg.sender != escrow) revert NotEscrow();
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

    // -------------------------------------------------------------- views -----

    /// @notice Idle USDC available to advance or withdraw right now.
    function idle() public view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    /// @notice Total assets backing the shares = idle + deployed principal.
    function totalAssets() public view returns (uint256) {
        return idle() + outstanding;
    }

    function convertToShares(uint256 assets) public view returns (uint256) {
        uint256 ta = totalAssets();
        if (totalShares == 0 || ta == 0) return assets;
        return (assets * totalShares) / ta;
    }

    function convertToAssets(uint256 shareAmount) public view returns (uint256) {
        if (totalShares == 0) return shareAmount;
        return (shareAmount * totalAssets()) / totalShares;
    }

    // ----------------------------------------------------------- LP flows -----

    /// @notice Deposit USDC, mint shares at the current NAV.
    function deposit(uint256 assets) external returns (uint256 minted) {
        if (assets == 0) revert ZeroAmount();
        minted = convertToShares(assets); // NAV before the incoming transfer
        usdc.transferFrom(msg.sender, address(this), assets);
        shares[msg.sender] += minted;
        totalShares += minted;
        emit Deposit(msg.sender, assets, minted);
    }

    /// @notice Burn shares for USDC at the current NAV. Capped at idle liquidity —
    /// capital deployed in live advances can't be withdrawn until repaid.
    function redeem(uint256 shareAmount) external returns (uint256 assets) {
        if (shareAmount == 0) revert ZeroAmount();
        assets = convertToAssets(shareAmount);
        if (assets > idle()) revert InsufficientLiquidity();
        shares[msg.sender] -= shareAmount; // reverts on overflow if too many
        totalShares -= shareAmount;
        usdc.transfer(msg.sender, assets);
        emit Withdraw(msg.sender, assets, shareAmount);
    }

    // -------------------------------------------------------- escrow flows -----

    function _feeBps(uint8 t) internal view returns (uint16) {
        uint256 i = t;
        uint256 n = feeBpsByTier.length;
        return feeBpsByTier[i >= n ? n - 1 : i];
    }

    function advance(uint256 tradeId, address seller, uint256 amount, uint8 buyerTier)
        external
        onlyEscrow
        returns (uint256 fee)
    {
        fee = (amount * _feeBps(buyerTier)) / 10000;
        uint256 net = amount - fee;
        if (net > idle()) revert InsufficientLiquidity();
        advanceNet[tradeId] = net;
        outstanding += net;
        usdc.transfer(seller, net);
        emit Advanced(tradeId, seller, net, fee, buyerTier);
    }

    /// @notice Clear a trade's outstanding principal. The escrow transfers the
    /// gross (amount) here first, so idle rises by gross while outstanding falls
    /// by net — NAV gains the fee.
    function repay(uint256 tradeId) external onlyEscrow {
        uint256 net = advanceNet[tradeId];
        delete advanceNet[tradeId];
        outstanding -= net;
        emit Repaid(tradeId, net);
    }

    /// @notice Write off a defaulted advance — outstanding drops with no cash in,
    /// so NAV falls by the lost net. LPs socialize the loss.
    function writeOff(uint256 tradeId) external onlyEscrow {
        uint256 net = advanceNet[tradeId];
        delete advanceNet[tradeId];
        outstanding -= net;
        emit WrittenOff(tradeId, net);
    }
}
