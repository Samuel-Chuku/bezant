// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "./interfaces/IERC20.sol";
import {IPassport} from "./interfaces/IPassport.sol";
import {IYieldVault} from "./interfaces/IYieldVault.sol";
import {IFinancingPool} from "./interfaces/IFinancingPool.sol";

/// @notice Standalone trade-finance escrow (no ERC-8183).
///
/// Lifecycle:
///   Proposing  buyer proposes an amount; either party counters; one accepts
///   Agreed     terms locked; buyer may fund
///   Funded     deposit locked (passport-priced); seller may draw financing
///   (attest)   the assigned attester confirms delivery -> AUTO-SETTLES:
///   Released   funds paid to seller (pool repaid, yield split). No release button.
///
/// Verification, yield, financing and the passport are each behind a swappable
/// interface so the staked-verifier arm, real USYC and CCTP attach without redeploy.
contract TradeEscrow {
    // ---------------------------------------------------------------- config --
    address public owner;
    address public arbitrator;
    address public treasury;
    IERC20 public immutable usdc;
    IPassport public passport;
    IYieldVault public yieldVault;
    IFinancingPool public financingPool;
    mapping(address => bool) public authorizedAttester;

    uint16 public financeBps = 8000; // advance = 80% of trade value
    struct YieldSplit {
        uint16 buyerBps;
        uint16 sellerBps;
        uint16 poolBps;
    }
    YieldSplit public yieldSplit = YieldSplit(4000, 3000, 3000);

    // ---------------------------------------------------------------- state ---
    enum Status {
        None,
        Proposing,
        Agreed,
        Funded,
        Released,
        Disputed,
        Refunded,
        Cancelled
    }

    struct Trade {
        address buyer;
        address seller;
        address attester;
        address lastProposer; // who owns the standing offer during negotiation
        uint256 amount; // proposed/agreed trade value
        uint256 deposit; // locked at fund (passport-priced)
        uint256 shares; // USYC shares (0 => no vault)
        uint256 financedRepay; // gross advance owed back to the pool at settle
        bytes32 milestoneHash;
        uint48 deadline;
        bool financingAdvanced;
        Status status;
    }

    uint256 public nextId = 1;
    mapping(uint256 => Trade) public trades;

    // ---------------------------------------------------------------- events --
    event TradeProposed(uint256 indexed id, address indexed buyer, address indexed seller, uint256 amount, address attester);
    event TradeCountered(uint256 indexed id, address indexed by, uint256 newAmount);
    event TradeAgreed(uint256 indexed id, address indexed by, uint256 amount);
    event TradeCancelled(uint256 indexed id, address indexed by);
    event TradeFunded(uint256 indexed id, uint256 deposit, uint256 shares);
    event FinancingAdvanced(uint256 indexed id, address indexed seller, uint256 gross, uint256 fee);
    event Attested(uint256 indexed id, address indexed attester, bytes32 proofHash);
    event Released(uint256 indexed id, uint256 toSeller, uint256 buyerYield, uint256 poolYield, uint256 repaidPool);
    event Disputed(uint256 indexed id, address indexed by);
    event Resolved(uint256 indexed id, bool releasedToSeller);
    event Refunded(uint256 indexed id, uint256 toBuyer);

    // ---------------------------------------------------------------- errors --
    error NotOwner();
    error NotArbitrator();
    error NotAttester();
    error NotSeller();
    error NotBuyer();
    error NotParty();
    error NotYourTurn();
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

    function depositOf(uint256 id) external view returns (uint256) {
        return trades[id].deposit;
    }

    function amountOf(uint256 id) external view returns (uint256) {
        return trades[id].amount;
    }

    function statusOf(uint256 id) external view returns (Status) {
        return trades[id].status;
    }

    /// @notice Deposit the buyer would lock if they funded now (passport-priced).
    function estimatedDeposit(uint256 id) external view returns (uint256) {
        Trade storage t = trades[id];
        return (t.amount * passport.depositBps(t.buyer)) / 10000;
    }

    // ----------------------------------------------------------- negotiation --

    /// @notice Buyer proposes a trade. Nothing locks until both sides agree + fund.
    function createTrade(address seller, uint256 amount, bytes32 milestoneHash, uint48 deadline, address attester)
        external
        returns (uint256 id)
    {
        if (amount == 0) revert BadAmount();
        if (deadline <= block.timestamp) revert BadDeadline();
        if (!authorizedAttester[attester]) revert BadAttester();

        id = nextId++;
        Trade storage t = trades[id];
        t.buyer = msg.sender;
        t.seller = seller;
        t.attester = attester;
        t.lastProposer = msg.sender;
        t.amount = amount;
        t.milestoneHash = milestoneHash;
        t.deadline = deadline;
        t.status = Status.Proposing;
        emit TradeProposed(id, msg.sender, seller, amount, attester);
    }

    /// @notice Either party proposes a new amount — but not when it's their offer on the table.
    function counter(uint256 id, uint256 newAmount) external {
        Trade storage t = trades[id];
        if (t.status != Status.Proposing) revert BadStatus();
        if (newAmount == 0) revert BadAmount();
        if (msg.sender != t.buyer && msg.sender != t.seller) revert NotParty();
        if (msg.sender == t.lastProposer) revert NotYourTurn();
        t.amount = newAmount;
        t.lastProposer = msg.sender;
        emit TradeCountered(id, msg.sender, newAmount);
    }

    /// @notice Accept the standing offer. You can't accept your own offer.
    function accept(uint256 id) external {
        Trade storage t = trades[id];
        if (t.status != Status.Proposing) revert BadStatus();
        if (msg.sender != t.buyer && msg.sender != t.seller) revert NotParty();
        if (msg.sender == t.lastProposer) revert NotYourTurn();
        t.status = Status.Agreed;
        emit TradeAgreed(id, msg.sender, t.amount);
    }

    /// @notice Either party walks away before funding.
    function cancel(uint256 id) external {
        Trade storage t = trades[id];
        if (t.status != Status.Proposing && t.status != Status.Agreed) revert BadStatus();
        if (msg.sender != t.buyer && msg.sender != t.seller) revert NotParty();
        t.status = Status.Cancelled;
        emit TradeCancelled(id, msg.sender);
    }

    // --------------------------------------------------------------- fund -----
    function fund(uint256 id) external {
        Trade storage t = trades[id];
        if (t.status != Status.Agreed) revert BadStatus();
        if (msg.sender != t.buyer) revert NotBuyer();

        uint256 deposit = (t.amount * passport.depositBps(t.buyer)) / 10000;
        t.deposit = deposit;
        usdc.transferFrom(msg.sender, address(this), deposit);
        if (address(yieldVault) != address(0)) {
            usdc.approve(address(yieldVault), deposit);
            t.shares = yieldVault.deposit(deposit);
        }
        t.status = Status.Funded;
        emit TradeFunded(id, deposit, t.shares);
    }

    /// @notice Seller draws working capital while goods are in transit (pre-attest).
    function requestFinancing(uint256 id) external {
        Trade storage t = trades[id];
        if (t.status != Status.Funded) revert BadStatus();
        if (msg.sender != t.seller) revert NotSeller();
        require(address(financingPool) != address(0), "no pool");
        require(!t.financingAdvanced, "financed");

        // Finance against the escrowed deposit (not the trade amount) so the
        // escrow always holds enough to repay the pool on a clean settle.
        uint256 gross = (t.deposit * financeBps) / 10000;
        uint256 fee = financingPool.advance(id, t.seller, gross, passport.tier(t.buyer));
        t.financingAdvanced = true;
        t.financedRepay = gross;
        emit FinancingAdvanced(id, t.seller, gross, fee);
    }

    // ----------------------------------------------------- attest -> settle ---

    /// @notice The assigned attester confirms (or rejects) delivery. A pass
    /// AUTO-SETTLES the trade in the same tx — no separate release step.
    function attest(uint256 id, bytes32 proofHash, bool passed) external {
        Trade storage t = trades[id];
        if (t.status != Status.Funded) revert BadStatus();
        if (msg.sender != t.attester) revert NotAttester();
        if (!passed) {
            t.status = Status.Disputed;
            emit Disputed(id, msg.sender);
            return;
        }
        emit Attested(id, msg.sender, proofHash);
        _settle(id, t);
    }

    function _settle(uint256 id, Trade storage t) internal {
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
            // gross ≤ deposit ≤ sellerOwed, so the pool is always made whole here.
            repaidPool = t.financedRepay;
            usdc.transfer(address(financingPool), repaidPool);
            financingPool.repay(id);
            sellerOwed -= repaidPool;
        }
        if (sellerOwed > 0) usdc.transfer(t.seller, sellerOwed);

        passport.recordTrade(t.buyer, t.seller, true);
        emit Released(id, sellerOwed, buyerYield, poolYield, repaidPool);
    }

    // ----------------------------------------------------- dispute / refund ---
    function raiseDispute(uint256 id) external {
        Trade storage t = trades[id];
        if (t.status != Status.Funded) revert BadStatus();
        if (msg.sender != t.buyer && msg.sender != t.seller) revert NotParty();
        t.status = Status.Disputed;
        emit Disputed(id, msg.sender);
    }

    function resolveDispute(uint256 id, bool releaseToSeller) external {
        if (msg.sender != arbitrator) revert NotArbitrator();
        Trade storage t = trades[id];
        if (t.status != Status.Disputed) revert BadStatus();

        uint256 got = _redeem(t);
        if (releaseToSeller) {
            t.status = Status.Released;
            if (t.financingAdvanced) {
                // Repay the pool first (gross ≤ deposit ≤ got), then the remainder to the seller.
                usdc.transfer(address(financingPool), t.financedRepay);
                financingPool.repay(id);
                uint256 rem = got - t.financedRepay;
                if (rem > 0) usdc.transfer(t.seller, rem);
            } else {
                usdc.transfer(t.seller, got);
            }
            passport.recordTrade(t.buyer, t.seller, true);
        } else {
            t.status = Status.Refunded;
            // Buyer made whole; the pool eats the advance (seller kept it).
            if (t.financingAdvanced) financingPool.writeOff(id);
            usdc.transfer(t.buyer, got);
            passport.recordTrade(t.buyer, t.seller, false);
        }
        emit Resolved(id, releaseToSeller);
    }

    function refund(uint256 id) external {
        Trade storage t = trades[id];
        if (t.status != Status.Funded) revert BadStatus();
        if (block.timestamp <= t.deadline) revert DeadlineNotPassed();
        t.status = Status.Refunded;
        uint256 got = _redeem(t);
        // Buyer made whole; the pool eats any advance (seller kept it).
        if (t.financingAdvanced) financingPool.writeOff(id);
        usdc.transfer(t.buyer, got);
        emit Refunded(id, got);
    }

    // ------------------------------------------------------------- internal ---
    function _redeem(Trade storage t) internal returns (uint256 got) {
        if (t.shares > 0 && address(yieldVault) != address(0)) {
            got = yieldVault.redeem(t.shares);
            t.shares = 0;
        } else {
            got = t.deposit;
        }
    }
}
