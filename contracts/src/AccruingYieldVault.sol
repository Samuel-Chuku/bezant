// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "./interfaces/IERC20.sol";
import {IYieldVault} from "./interfaces/IYieldVault.sol";

/// @notice A USYC-faithful yield vault: NAV appreciates continuously at a set
/// APY, so depositors earn by token-value growth (no coupon, no manual top-ups)
/// — exactly how Circle/Hashnote USYC works. The yield is paid out of the
/// vault's USDC reserve (any USDC sent to this address), so fund the reserve
/// once and it accrues hands-off until the reserve runs low.
///
/// Accounting: `storedAssets` is the principal owed to shareholders, checkpointed
/// on each deposit/redeem. Between checkpoints it grows by simple interest at
/// `apyBps`. previewRedeem/totalAssets read the live (accrued) value; deposit and
/// redeem checkpoint first so growth compounds piecewise. The extra USDC needed
/// to honor accrued value above principal comes from the reserve buffer.
contract AccruingYieldVault is IYieldVault {
    IERC20 public immutable usdcToken;
    address public owner;

    uint256 public apyBps; // annual yield in basis points (e.g. 400 = 4%)
    uint256 public storedAssets; // principal + accrued, as of lastAccrual
    uint256 public lastAccrual; // timestamp of the last checkpoint

    uint256 public totalShares;
    mapping(address => uint256) public sharesOf;

    uint256 internal constant YEAR = 365 days;

    event ApySet(uint256 apyBps);
    event ReserveWithdrawn(address indexed to, uint256 amount);

    error NotOwner();

    constructor(address usdc_, uint256 apyBps_) {
        usdcToken = IERC20(usdc_);
        owner = msg.sender;
        apyBps = apyBps_;
        lastAccrual = block.timestamp;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function asset() external view returns (address) {
        return address(usdcToken);
    }

    /// @notice Update the APY. Checkpoints accrued interest at the old rate first
    /// so the change only affects future growth.
    function setApy(uint256 apyBps_) external onlyOwner {
        _accrue();
        apyBps = apyBps_;
        emit ApySet(apyBps_);
    }

    /// @notice Owner can recover un-accrued reserve USDC (anything held above the
    /// current principal-plus-accrued obligation to shareholders).
    function withdrawReserve(address to, uint256 amount) external onlyOwner {
        uint256 bal = usdcToken.balanceOf(address(this));
        uint256 owed = _currentAssets();
        require(bal >= owed && amount <= bal - owed, "would touch principal");
        usdcToken.transfer(to, amount);
        emit ReserveWithdrawn(to, amount);
    }

    // ----------------------------------------------------------- accrual -----

    /// Live obligation to shareholders: stored value plus simple interest since
    /// the last checkpoint.
    function _currentAssets() internal view returns (uint256) {
        if (storedAssets == 0 || apyBps == 0) return storedAssets;
        uint256 dt = block.timestamp - lastAccrual;
        if (dt == 0) return storedAssets;
        return storedAssets + (storedAssets * apyBps * dt) / (10000 * YEAR);
    }

    function _accrue() internal {
        storedAssets = _currentAssets();
        lastAccrual = block.timestamp;
    }

    /// @notice Total USDC value currently backing all shares (accrued).
    function totalAssets() public view returns (uint256) {
        return _currentAssets();
    }

    function previewRedeem(uint256 shares) public view returns (uint256) {
        if (totalShares == 0) return 0;
        return (shares * _currentAssets()) / totalShares;
    }

    // -------------------------------------------------------- ERC4626-ish -----

    function deposit(uint256 assets) external returns (uint256 shares) {
        _accrue();
        shares = totalShares == 0 ? assets : (assets * totalShares) / storedAssets;
        usdcToken.transferFrom(msg.sender, address(this), assets);
        storedAssets += assets;
        totalShares += shares;
        sharesOf[msg.sender] += shares;
    }

    function redeem(uint256 shares) external returns (uint256 assets) {
        _accrue();
        assets = (shares * storedAssets) / totalShares;
        totalShares -= shares;
        sharesOf[msg.sender] -= shares;
        storedAssets -= assets;
        usdcToken.transfer(msg.sender, assets); // accrued portion drawn from reserve
    }
}
