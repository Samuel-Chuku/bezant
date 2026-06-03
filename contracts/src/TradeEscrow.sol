// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "./interfaces/IERC20.sol";
import {IPassport} from "./interfaces/IPassport.sol";
import {IYieldVault} from "./interfaces/IYieldVault.sol";
import {IFinancingPool} from "./interfaces/IFinancingPool.sol";

/// @notice Standalone trade-finance escrow (no ERC-8183 dependency).
///
/// - The passport sets the buyer's deposit at creation (executable policy).
/// - A per-trade authorized attester releases funds — the Trade Officer agent for
///   the demo, a staked verifier later — replacing the fraud-prone buyer button.
/// - Idle deposits earn USYC yield, split buyer/seller/pool on settlement.
/// - A financing pool can advance the seller their receivable at attestation,
///   repaid from escrow proceeds on release.
///
/// Verification, yield, and financing are each behind a swappable interface, so
/// the staked-verifier arm, real USYC, and CCTP funding attach without redeploy.
contract TradeEscrow {
    // ---------------------------------------------------------------- config --
    address public owner;
    address public arbitrator;
    address public treasury;            // receives the pool yield slice if no pool set
    IERC20 public immutable usdc;
    IPassport public passport;
    IYieldVault public yieldVault;      // address(0) => yield disabled
    IFinancingPool public financingPool; // address(0) => financing disabled

    mapping(address => bool) public authorizedAttester;

    uint16 public financeBps = 8000;    // advance = 80% of trade value
    struct YieldSplit {
        uint16 buyerBps;
        uint16 sellerBps;
        uint16 poolBps;
    }
    YieldSplit public yieldSplit = YieldSplit(4000, 3000, 3000); // sums to 10000

    // ---------------------------------------------------------------- state ---
    enum Status {
        None,
        Created,
        Funded,
        Attested,
        Released,
        Disputed,
        Refunded
    }

    struct Trade {
        address buyer;
        address seller;
        address attester;
        uint256 amount;          // full trade value (USDC)
        uint256 deposit;         // locked = amount * depositBps / 10000
        uint256 shares;          // USYC shares held (0 => no vault used)
        uint256 financedRepay;   // gross advance owed back to the pool on release
        bytes32 milestoneHash;
        uint48 deadline;
        bool financingAdvanced;
        Status status;
    }

    uint256 public nextId = 1;
    mapping(uint256 => Trade) public trades;

    // ---------------------------------------------------------------- events --
    event TradeCreated(uint256 indexed id, address indexed buyer, address indexed seller, uint256 amount, uint256 deposit, address attester);
    event Funded(uint256 indexed id, uint256 deposit, uint256 shares);
    event Attested(uint256 indexed id, address indexed attester, bytes32 proofHash, bool passed);
    event Released(uint256 indexed id, uint256 toSeller, uint256 buyerYield, uint256 poolYield, uint256 repaidPool);
    event FinancingAdvanced(uint256 indexed id, address indexed seller, uint256 gross, uint256 fee);
    event Disputed(uint256 indexed id, address indexed by);
    event Resolved(uint256 indexed id, bool releasedToSeller);
    event Refunded(uint256 indexed id, uint256 toBuyer);

    // ---------------------------------------------------------------- errors --
    error NotOwner();
    error NotArbitrator();
    error NotAttester();
    error NotSeller();
    error NotParty();
    error BadStatus();
    error BadAttester();
    error BadAmount();
    error BadDeadline();
    error DeadlineNotPassed();

    constructor(address usdc_, address passport_) {
        owner = msg.sender;
        arbitrator = msg.sender;
        treasury = msg.sender;
        usdc = IERC20(usdc_);
        passport = IPassport(passport_);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // --------------------------------------------------------------- admin ----
    function setPassport(address p) external onlyOwner { passport = IPassport(p); }
    function setYieldVault(address v) external onlyOwner { yieldVault = IYieldVault(v); }
    function setFinancingPool(address p) external onlyOwner { financingPool = IFinancingPool(p); }
    function setArbitrator(address a) external onlyOwner { arbitrator = a; }
    function setTreasury(address t) external onlyOwner { treasury = t; }
    function setAttester(address a, bool ok) external onlyOwner { authorizedAttester[a] = ok; }
    function setFinanceBps(uint16 b) external onlyOwner { financeBps = b; }

    function setYieldSplit(uint16 b, uint16 s, uint16 p) external onlyOwner {
        require(uint256(b) + s + p == 10000, "split!=100%");
        yieldSplit = YieldSplit(b, s, p);
    }

    /// @notice The locked deposit for a trade (convenience accessor for UI/agents).
    function depositOf(uint256 id) external view returns (uint256) {
        return trades[id].deposit;
    }

    // ------------------------------------------------------------ lifecycle ---

    /// @notice Buyer opens a trade. Deposit is priced by the passport here.
    function createTrade(address seller, uint256 amount, bytes32 milestoneHash, uint48 deadline, address attester)
        external
        returns (uint256 id)
    {
        if (amount == 0) revert BadAmount();
        if (deadline <= block.timestamp) revert BadDeadline();
        if (!authorizedAttester[attester]) revert BadAttester();

        uint256 deposit = (amount * passport.depositBps(msg.sender)) / 10000;

        id = nextId++;
        trades[id] = Trade({
            buyer: msg.sender,
            seller: seller,
            attester: attester,
            amount: amount,
            deposit: deposit,
            shares: 0,
            financedRepay: 0,
            milestoneHash: milestoneHash,
            deadline: deadline,
            financingAdvanced: false,
            status: Status.Created
        });
        emit TradeCreated(id, msg.sender, seller, amount, deposit, attester);
    }

    /// @notice Buyer locks the deposit; parked in USYC if a vault is configured.
    function fund(uint256 id) external {
        Trade storage t = trades[id];
        if (t.status != Status.Created) revert BadStatus();
        if (msg.sender != t.buyer) revert NotParty();

        usdc.transferFrom(msg.sender, address(this), t.deposit);

        if (address(yieldVault) != address(0)) {
            usdc.approve(address(yieldVault), t.deposit);
            t.shares = yieldVault.deposit(t.deposit);
        }
        t.status = Status.Funded;
        emit Funded(id, t.deposit, t.shares);
    }

    /// @notice The trade's assigned attester confirms (or rejects) delivery.
    function attest(uint256 id, bytes32 proofHash, bool passed) external {
        Trade storage t = trades[id];
        if (t.status != Status.Funded) revert BadStatus();
        if (msg.sender != t.attester) revert NotAttester();

        t.status = passed ? Status.Attested : Status.Disputed;
        emit Attested(id, msg.sender, proofHash, passed);
        if (!passed) emit Disputed(id, msg.sender);
    }

    /// @notice Seller pulls an advance against the attested receivable.
    function requestFinancing(uint256 id) external {
        Trade storage t = trades[id];
        if (t.status != Status.Attested) revert BadStatus();
        if (msg.sender != t.seller) revert NotSeller();
        require(address(financingPool) != address(0), "no pool");
        require(!t.financingAdvanced, "financed");

        uint256 gross = (t.amount * financeBps) / 10000;
        uint8 tierOf = passport.tier(t.buyer);
        uint256 fee = financingPool.advance(t.seller, gross, tierOf);
        t.financingAdvanced = true;
        t.financedRepay = gross; // pool reclaims the gross on release; fee is its margin
        emit FinancingAdvanced(id, t.seller, gross, fee);
    }

    /// @notice Settle an attested trade: redeem yield, split it, repay the pool,
    /// pay the seller, and update the passport. Permissionless once attested.
    function release(uint256 id) external {
        Trade storage t = trades[id];
        if (t.status != Status.Attested) revert BadStatus();
        t.status = Status.Released;

        uint256 got = _redeem(t);
        uint256 yield_ = got > t.deposit ? got - t.deposit : 0;

        uint256 buyerYield = (yield_ * yieldSplit.buyerBps) / 10000;
        uint256 poolYield = (yield_ * yieldSplit.poolBps) / 10000;
        uint256 sellerYield = yield_ - buyerYield - poolYield;

        if (buyerYield > 0) usdc.transfer(t.buyer, buyerYield);
        if (poolYield > 0) {
            usdc.transfer(address(financingPool) != address(0) ? address(financingPool) : treasury, poolYield);
        }

        uint256 sellerOwed = t.deposit + sellerYield;
        uint256 repaidPool;
        if (t.financingAdvanced) {
            repaidPool = t.financedRepay <= sellerOwed ? t.financedRepay : sellerOwed;
            usdc.transfer(address(financingPool), repaidPool);
            sellerOwed -= repaidPool;
        }
        if (sellerOwed > 0) usdc.transfer(t.seller, sellerOwed);

        passport.recordTrade(t.buyer, t.seller, true);
        emit Released(id, sellerOwed, buyerYield, poolYield, repaidPool);
    }

    /// @notice Either party flags a problem; routes to arbitrator resolution.
    function raiseDispute(uint256 id) external {
        Trade storage t = trades[id];
        if (t.status != Status.Funded && t.status != Status.Attested) revert BadStatus();
        if (msg.sender != t.buyer && msg.sender != t.seller) revert NotParty();
        t.status = Status.Disputed;
        emit Disputed(id, msg.sender);
    }

    /// @notice Arbitrator (owner for MVP; a staked verifier later) resolves.
    function resolveDispute(uint256 id, bool releaseToSeller) external {
        if (msg.sender != arbitrator) revert NotArbitrator();
        Trade storage t = trades[id];
        if (t.status != Status.Disputed) revert BadStatus();

        uint256 got = _redeem(t);
        if (releaseToSeller) {
            t.status = Status.Released;
            usdc.transfer(t.seller, got);
            passport.recordTrade(t.buyer, t.seller, true);
        } else {
            t.status = Status.Refunded;
            usdc.transfer(t.buyer, got);
            passport.recordTrade(t.buyer, t.seller, false);
        }
        emit Resolved(id, releaseToSeller);
    }

    /// @notice Buyer reclaims the deposit (+ any yield) if no attestation by the deadline.
    function refund(uint256 id) external {
        Trade storage t = trades[id];
        if (t.status != Status.Funded) revert BadStatus();
        if (block.timestamp <= t.deadline) revert DeadlineNotPassed();
        t.status = Status.Refunded;

        uint256 got = _redeem(t);
        usdc.transfer(t.buyer, got);
        emit Refunded(id, got);
    }

    // ------------------------------------------------------------- internal ---
    function _redeem(Trade storage t) internal returns (uint256 got) {
        if (t.shares > 0 && address(yieldVault) != address(0)) {
            got = yieldVault.redeem(t.shares);
            t.shares = 0;
        } else {
            got = t.deposit; // already held as USDC
        }
    }
}
