// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title StakedVerifierModule — Arm 2 decentralized delivery verification.
/// @notice An authorized *attester* for TradeEscrow. Instead of the single Trade
/// Officer, a stake-backed panel votes on delivery; the majority attests the
/// trade. Honest voters share a buyer-paid verification fee plus the stake
/// slashed from dishonest / no-show panelists. Plugs in via
/// `escrow.setAttester(thisModule, true)` and `createTrade(..., thisModule)` —
/// no core escrow redeploy. Lean v1: simple open vote (no commit-reveal).
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface ITradeEscrow {
    function trades(uint256 id)
        external
        view
        returns (
            address buyer,
            address seller,
            address attester,
            address lastProposer,
            uint256 amount,
            uint256 deposit,
            uint256 shares,
            uint256 financedRepay,
            bytes32 milestoneHash,
            uint48 deadline,
            bool financingAdvanced,
            uint8 status
        );
    function attest(uint256 id, bytes32 proofHash, bool passed) external;
}

contract StakedVerifierModule {
    uint8 internal constant STATUS_FUNDED = 3; // TradeEscrow.Status.Funded

    IERC20 public immutable usdc;
    ITradeEscrow public immutable escrow;
    address public owner;
    address public operator; // assigns panels when the seller submits delivery

    // Tunable economics (owner-settable).
    uint8 public panelSize = 4;
    uint256 public minStake; // minimum stake to be eligible
    uint16 public bondBps = 5000; // bond locked per panelist per assignment = stake * bondBps/10000 (at risk)
    uint16 public slashBps = 5000; // % of that bond a dishonest/no-show panelist forfeits
    uint16 public feeBps = 100; // buyer verification fee = tradeAmount * feeBps/10000
    uint64 public voteWindow = 1 hours;

    // Staking ledger.
    mapping(address => uint256) public stakeOf;
    mapping(address => uint256) public lockedOf;
    address[] public verifiers; // everyone who ever staked (filtered by balance at selection)
    mapping(address => bool) internal known;

    // Reputation (drives selection weight alongside stake).
    mapping(address => uint32) public correctVotes;
    mapping(address => uint32) public totalVotes;

    // Per-trade verification.
    struct V {
        bool assigned;
        bool resolved;
        uint64 deadline;
        bytes32 proofHash;
        uint256 fee;
        address[] panel;
        mapping(address => uint256) bonded; // per-panelist bond locked for this trade
        mapping(address => uint8) vote; // 0 none, 1 pass, 2 fail
        mapping(address => bool) excluded; // no-shows barred from this trade's future panels
        uint8 passes;
        uint8 fails;
        uint8 cast;
        uint8 rounds; // panels drawn so far (a void+retry increments this)
    }

    mapping(uint256 => V) internal V_;
    mapping(uint256 => uint256) public feePrepaid; // tradeId => escrowed buyer fee

    event Staked(address indexed verifier, uint256 amount);
    event Unstaked(address indexed verifier, uint256 amount);
    event VerificationFunded(uint256 indexed tradeId, address indexed buyer, uint256 fee);
    event PanelAssigned(uint256 indexed tradeId, address[] panel, uint256 fee);
    event Voted(uint256 indexed tradeId, address indexed verifier, bool pass);
    event Resolved(uint256 indexed tradeId, bool passed, uint256 rewardPool, uint256 honestCount);
    event VerificationVoided(uint256 indexed tradeId, uint8 round); // no quorum → reset for a fresh panel

    error NotOwner();
    error NotOperator();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address _usdc, address _escrow, uint256 _minStake, uint16 _bondBps) {
        require(_bondBps > 0 && _bondBps <= 10000, "bondBps");
        usdc = IERC20(_usdc);
        escrow = ITradeEscrow(_escrow);
        owner = msg.sender;
        operator = msg.sender;
        minStake = _minStake;
        bondBps = _bondBps;
    }

    // --- owner config ---
    function setOperator(address a) external onlyOwner {
        operator = a;
    }

    function setParams(uint8 _panelSize, uint256 _minStake, uint16 _bondBps, uint16 _slashBps, uint16 _feeBps, uint64 _voteWindow)
        external
        onlyOwner
    {
        require(_panelSize > 0 && _bondBps > 0 && _bondBps <= 10000 && _slashBps <= 10000 && _feeBps <= 10000, "bad params");
        panelSize = _panelSize;
        minStake = _minStake;
        bondBps = _bondBps;
        slashBps = _slashBps;
        feeBps = _feeBps;
        voteWindow = _voteWindow;
    }

    // --- staking ---
    function stake(uint256 amount) external {
        require(amount > 0, "amount");
        // Enforce the floor on-chain (not just in the UI): a sub-minimum stake
        // would never be eligible for selection, so reject it outright.
        require(stakeOf[msg.sender] + amount >= minStake, "below minStake");
        require(usdc.transferFrom(msg.sender, address(this), amount), "transfer");
        stakeOf[msg.sender] += amount;
        if (!known[msg.sender]) {
            known[msg.sender] = true;
            verifiers.push(msg.sender);
        }
        emit Staked(msg.sender, amount);
    }

    /// @notice Withdraw free (unlocked) stake.
    function unstake(uint256 amount) external {
        require(amount > 0 && amount <= stakeOf[msg.sender] - lockedOf[msg.sender], "locked/insufficient");
        stakeOf[msg.sender] -= amount;
        require(usdc.transfer(msg.sender, amount), "transfer");
        emit Unstaked(msg.sender, amount);
    }

    // --- buyer pre-pays the verification fee (opt-in price of the panel route) ---
    function fundVerification(uint256 tradeId) external {
        (address buyer, address attester, uint256 amount, uint8 status) = _trade(tradeId);
        require(attester == address(this), "not our trade");
        require(msg.sender == buyer, "only buyer");
        require(status == STATUS_FUNDED, "not funded");
        require(feePrepaid[tradeId] == 0, "prepaid");
        uint256 fee = (amount * feeBps) / 10000;
        if (fee > 0) require(usdc.transferFrom(buyer, address(this), fee), "fee transfer");
        feePrepaid[tradeId] = fee == 0 ? type(uint256).max : fee; // sentinel so "prepaid" is true even at fee 0
        emit VerificationFunded(tradeId, buyer, fee);
    }

    // --- operator assigns the panel when delivery is submitted ---
    function assignPanel(uint256 tradeId, bytes32 proofHash) external {
        if (msg.sender != operator && msg.sender != owner) revert NotOperator();
        (, address attester,, uint8 status) = _trade(tradeId);
        require(attester == address(this), "not our trade");
        require(status == STATUS_FUNDED, "not funded");
        require(feePrepaid[tradeId] != 0, "fee not prepaid");
        V storage v = V_[tradeId];
        require(!v.assigned, "assigned");

        address[] memory panel = _select(tradeId);
        require(panel.length > 0, "no eligible verifiers");

        v.assigned = true;
        v.proofHash = proofHash;
        v.deadline = uint64(block.timestamp) + voteWindow;
        uint256 fee = feePrepaid[tradeId];
        v.fee = fee == type(uint256).max ? 0 : fee;
        for (uint256 i; i < panel.length; i++) {
            address p = panel[i];
            uint256 bnd = (stakeOf[p] * bondBps) / 10000;
            lockedOf[p] += bnd;
            v.bonded[p] = bnd;
            v.panel.push(p);
        }
        emit PanelAssigned(tradeId, panel, v.fee);
    }

    // --- panel votes ---
    function vote(uint256 tradeId, bool pass) external {
        V storage v = V_[tradeId];
        require(v.assigned && !v.resolved, "not open");
        require(block.timestamp <= v.deadline, "closed");
        require(_onPanel(v, msg.sender), "not on panel");
        require(v.vote[msg.sender] == 0, "voted");

        v.vote[msg.sender] = pass ? 1 : 2;
        if (pass) v.passes++;
        else v.fails++;
        v.cast++;
        emit Voted(tradeId, msg.sender, pass);

        // Resolve early only when EVERYONE has voted — never on a bare majority,
        // so no panelist is ever denied their turn (and thus never slashed for a
        // resolution that beat them to it). Otherwise it waits for resolveTimeout.
        if (v.cast == v.panel.length) _resolve(tradeId, v);
    }

    /// @notice After the window: resolve if quorum was met, else void + retry.
    function resolveTimeout(uint256 tradeId) external {
        V storage v = V_[tradeId];
        require(v.assigned && !v.resolved, "not open");
        require(block.timestamp > v.deadline, "not expired");
        // Quorum = panel − 1 (e.g. 3 of 4): everyone had the full window, so the
        // votes cast are decisive and the no-shows are legitimately slashed.
        // Below quorum → void + retry instead of deciding on too few votes.
        uint256 quorum = v.panel.length > 1 ? v.panel.length - 1 : 1;
        if (v.cast >= quorum) {
            _resolve(tradeId, v);
        } else {
            _voidRetry(tradeId, v);
        }
    }

    /// @notice Below-quorum timeout: slash & bar the no-shows, reward whoever
    /// showed (or compensate the buyer), then reset so the seller can resubmit
    /// for a fresh panel. The buyer's fee is KEPT — retry isn't double-charged.
    function _voidRetry(uint256 tradeId, V storage v) internal {
        address[] memory panel = v.panel;
        uint256 n = panel.length;
        address[] memory showers = new address[](n);
        uint256 showed;
        uint256 slashedPool;

        for (uint256 i; i < n; i++) {
            address a = panel[i];
            uint256 bnd = v.bonded[a];
            lockedOf[a] -= bnd;
            if (v.vote[a] == 0) {
                // No-show: slash, bar from this trade's future panels, rep hit.
                uint256 slash = (bnd * slashBps) / 10000;
                stakeOf[a] -= slash;
                slashedPool += slash;
                v.excluded[a] = true;
                totalVotes[a] += 1;
            } else {
                showers[showed++] = a;
            }
            v.bonded[a] = 0;
            v.vote[a] = 0;
        }

        if (slashedPool > 0) {
            if (showed > 0) {
                uint256 share = slashedPool / showed;
                for (uint256 i; i < showed; i++) stakeOf[showers[i]] += share;
            } else {
                (address buyer,,,) = _trade(tradeId);
                require(usdc.transfer(buyer, slashedPool), "comp");
            }
        }

        // Reset for a fresh panel — fee stays prepaid (feePrepaid untouched).
        delete v.panel;
        v.assigned = false;
        v.passes = 0;
        v.fails = 0;
        v.cast = 0;
        v.proofHash = bytes32(0);
        v.deadline = 0;
        v.rounds += 1;
        emit VerificationVoided(tradeId, v.rounds);
    }

    function _resolve(uint256 tradeId, V storage v) internal {
        v.resolved = true;
        uint8 winSide = v.passes >= v.fails ? 1 : 2; // ties → pass
        bool passed = winSide == 1;

        uint256 rewardPool = v.fee;
        uint256 honestCount;
        address[] memory panel = v.panel;

        // Settle bonds + reputation: honest get bond back + reward share; the rest
        // forfeit slashBps of their bond into the reward pool.
        for (uint256 i; i < panel.length; i++) {
            address a = panel[i];
            uint256 bnd = v.bonded[a];
            totalVotes[a] += 1;
            lockedOf[a] -= bnd;
            if (v.vote[a] == winSide) {
                correctVotes[a] += 1;
                honestCount++;
            } else {
                uint256 slash = (bnd * slashBps) / 10000;
                stakeOf[a] -= slash;
                rewardPool += slash;
            }
        }

        if (honestCount > 0 && rewardPool > 0) {
            // Reward in proportion to bond at risk (= stake): a verifier who put
            // more on the line earns a bigger slice of the pot. Equal bonds → equal split.
            uint256 honestBond;
            for (uint256 i; i < panel.length; i++) {
                if (v.vote[panel[i]] == winSide) honestBond += v.bonded[panel[i]];
            }
            if (honestBond > 0) {
                for (uint256 i; i < panel.length; i++) {
                    if (v.vote[panel[i]] == winSide) stakeOf[panel[i]] += (rewardPool * v.bonded[panel[i]]) / honestBond;
                }
            }
        }
        // (If honestCount == 0 — impossible here since a side won — the fee would
        // stay in the module; not reachable on the majority/cast paths.)

        escrow.attest(tradeId, v.proofHash, passed);
        emit Resolved(tradeId, passed, rewardPool, honestCount);
    }

    // --- selection: weighted-random by stake × reputation (not stake alone) ---
    function _select(uint256 tradeId) internal view returns (address[] memory chosen) {
        // No self-verification: the trade's own buyer/seller can never sit on its
        // panel, even if they're staked verifiers (conflict of interest).
        (address buyer, address seller,,,,,,,,,,) = escrow.trades(tradeId);
        uint256 n = verifiers.length;
        address[] memory elig = new address[](n);
        uint256[] memory wt = new uint256[](n);
        uint256 m;
        for (uint256 i; i < n; i++) {
            address a = verifiers[i];
            if (a == buyer || a == seller) continue;
            if (V_[tradeId].excluded[a]) continue; // barred no-show from a prior round
            uint256 free = stakeOf[a] - lockedOf[a];
            uint256 bnd = (stakeOf[a] * bondBps) / 10000;
            if (stakeOf[a] >= minStake && bnd > 0 && free >= bnd) {
                // reputation factor 100..200; new verifiers get a neutral 150.
                uint256 rep = totalVotes[a] == 0 ? 150 : (100 + (uint256(correctVotes[a]) * 100) / totalVotes[a]);
                elig[m] = a;
                wt[m] = free * rep;
                m++;
            }
        }
        uint256 k = m < panelSize ? m : panelSize;
        chosen = new address[](k);
        uint256 seed = uint256(keccak256(abi.encodePacked(block.prevrandao, tradeId, block.timestamp, m)));
        for (uint256 p; p < k; p++) {
            uint256 tot;
            for (uint256 i; i < m; i++) tot += wt[i];
            if (tot == 0) break;
            uint256 r = seed % tot;
            uint256 acc;
            for (uint256 i; i < m; i++) {
                if (wt[i] == 0) continue;
                acc += wt[i];
                if (r < acc) {
                    chosen[p] = elig[i];
                    wt[i] = 0; // draw without replacement
                    break;
                }
            }
            seed = uint256(keccak256(abi.encodePacked(seed)));
        }
    }

    function _onPanel(V storage v, address a) internal view returns (bool) {
        for (uint256 i; i < v.panel.length; i++) {
            if (v.panel[i] == a) return true;
        }
        return false;
    }

    function _trade(uint256 id) internal view returns (address buyer, address attester, uint256 amount, uint8 status) {
        (buyer,, attester,, amount,,,,,,, status) = escrow.trades(id);
    }

    // --- views ---
    function verifierCount() external view returns (uint256) {
        return verifiers.length;
    }

    function panelOf(uint256 tradeId) external view returns (address[] memory) {
        return V_[tradeId].panel;
    }

    function verificationOf(uint256 tradeId)
        external
        view
        returns (bool assigned, bool resolved, uint64 deadline, uint8 passes, uint8 fails, uint8 cast, uint256 fee)
    {
        V storage v = V_[tradeId];
        return (v.assigned, v.resolved, v.deadline, v.passes, v.fails, v.cast, v.fee);
    }

    function voteOf(uint256 tradeId, address verifier) external view returns (uint8) {
        return V_[tradeId].vote[verifier];
    }
}
