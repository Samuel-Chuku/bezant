// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "./interfaces/IERC20.sol";
import {IYieldVault} from "./interfaces/IYieldVault.sol";
import {IFinancingPool} from "./interfaces/IFinancingPool.sol";

/// @notice LP-funded USDC vault (minimal ERC-4626-style) that advances sellers
/// their receivable, priced off the buyer's passport tier (more history =>
/// cheaper). LPs deposit USDC for shares and earn the financing fees as yield;
/// they bear credit risk — a written-off advance lowers NAV for all LPs.
///
/// Idle USDC (not currently advanced) is parked in an external yield vault
/// (USYC adapter) so it earns a baseline return on top of the financing fees.
/// The vault is optional: with no vault set the pool behaves exactly as a plain
/// USDC reserve. `setYieldVault` swaps the adapter (mock today, real USYC later)
/// with no pool redeploy.
///
/// Accounting: totalAssets = idle + outstanding. `idle` = the pool's redeemable
/// value in the vault (previewRedeem) plus any un-invested USDC buffer.
///   - advance:   moves `net` from idle to outstanding (NAV flat).
///   - repay:     escrow sends the gross back first; outstanding drops by net,
///                idle rises by gross => NAV up by the fee.
///   - write-off: outstanding drops with no cash in => NAV down by the loss.
///   - vault yield: previewRedeem grows over time => idle (and NAV) rise.
contract FinancingPool is IFinancingPool {
    address public owner;
    address public escrow;
    IERC20 public immutable usdc;

    /// Yield vault for idle USDC (0 => hold USDC directly, no yield).
    IYieldVault public yieldVault;
    /// Our share balance in `yieldVault` (the pool's parked idle).
    uint256 public vaultShares;

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
    event YieldVaultSet(address indexed vault);
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

    /// @notice Point idle USDC at a yield vault. Divests fully from any prior
    /// vault first, then parks the current USDC buffer into the new one.
    function setYieldVault(address v) external onlyOwner {
        if (address(yieldVault) != address(0) && vaultShares > 0) {
            yieldVault.redeem(vaultShares);
            vaultShares = 0;
        }
        yieldVault = IYieldVault(v);
        _invest();
        emit YieldVaultSet(v);
    }

    function setFeeTiers(uint16[] calldata f) external onlyOwner {
        delete feeBpsByTier;
        for (uint256 i; i < f.length; ++i) feeBpsByTier.push(f[i]);
    }

    /// @notice Park any stray USDC buffer (e.g. the escrow's pool-yield split)
    /// into the vault. Permissionless — it only ever moves the pool's own USDC
    /// into the pool's own vault position.
    function sweep() external {
        _invest();
    }

    // -------------------------------------------------------------- views -----

    /// @notice Idle USDC available to advance or withdraw right now — the pool's
    /// redeemable value in the vault plus any un-invested buffer.
    function idle() public view returns (uint256) {
        uint256 buffer = usdc.balanceOf(address(this));
        if (address(yieldVault) != address(0) && vaultShares > 0) {
            return buffer + yieldVault.previewRedeem(vaultShares);
        }
        return buffer;
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
        _invest(); // park the new USDC into the yield vault
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
        _divest(assets); // pull enough USDC out of the vault to pay out
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
        _divest(net); // free up USDC to pay the seller
        usdc.transfer(seller, net);
        emit Advanced(tradeId, seller, net, fee, buyerTier);
    }

    /// @notice Clear a trade's outstanding principal. The escrow transfers the
    /// gross (amount) here first, so idle rises by gross while outstanding falls
    /// by net — NAV gains the fee. The incoming gross is parked into the vault.
    function repay(uint256 tradeId) external onlyEscrow {
        uint256 net = advanceNet[tradeId];
        delete advanceNet[tradeId];
        outstanding -= net;
        _invest(); // park the repaid gross (principal + fee) into the vault
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

    // ------------------------------------------------------ vault helpers -----

    /// Deposit the entire USDC buffer into the yield vault.
    function _invest() internal {
        if (address(yieldVault) == address(0)) return;
        uint256 bal = usdc.balanceOf(address(this));
        if (bal == 0) return;
        usdc.approve(address(yieldVault), bal);
        vaultShares += yieldVault.deposit(bal);
    }

    /// Redeem enough shares so the USDC buffer covers `need`. Rounds shares up so
    /// we never come up short on the payout (any surplus stays as buffer and is
    /// re-invested on the next deposit/repay/sweep).
    function _divest(uint256 need) internal {
        if (address(yieldVault) == address(0)) return;
        uint256 bal = usdc.balanceOf(address(this));
        if (bal >= need) return;
        uint256 short = need - bal;
        uint256 vaultAssets = yieldVault.previewRedeem(vaultShares);
        if (vaultAssets == 0) return;
        uint256 toRedeem = (short * vaultShares + vaultAssets - 1) / vaultAssets; // ceil
        if (toRedeem > vaultShares) toRedeem = vaultShares;
        vaultShares -= toRedeem;
        yieldVault.redeem(toRedeem);
    }
}
