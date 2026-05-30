// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "./interfaces/IERC20.sol";
import {IAgenticCommerce} from "./interfaces/IAgenticCommerce.sol";
import {BondMath} from "./lib/BondMath.sol";

// arc-trade Pact wrapper around ERC-8183 (AgenticCommerce). Spec lives at
// Arc/m41-wrapper-spec.md (LOCKED 2026-05-28). This skeleton declares
// storage, enums, events, errors, and function signatures only. Bodies
// land in subsequent commits per §14 of the spec.
contract PactWrapper {
    // ──────────────────────────────────────────────────────────────────────
    //                              CONSTANTS
    // ──────────────────────────────────────────────────────────────────────

    uint16 public constant BOND_BPS                = 500;     // 5% of pact value
    uint16 public constant LOSER_KEEPS_BPS         = 5_000;   // 50% of own bond back
    uint16 public constant WINNER_BONUS_BPS        = 1_000;   // 10% of loser bond
    uint16 public constant EVALUATOR_POOL_BPS      = 4_000;   // 40% of loser bond

    uint8  public constant EVALUATORS_PER_DISPUTE  = 3;
    uint8  public constant QUORUM                  = 2;

    uint64 public constant CONCEDE_WINDOW          = 48 hours;
    uint64 public constant COMMIT_WINDOW           = 12 hours;
    uint64 public constant GRACE_WINDOW            = 1 hours;
    uint64 public constant REVEAL_WINDOW           = 2 hours;

    uint64 public constant CHALLENGE_DEFAULT       = 24 hours;
    uint64 public constant CHALLENGE_FLOOR         = 1 hours;
    uint64 public constant CHALLENGE_CEILING       = 14 days;

    uint64 public constant MIN_DEADLINE_FROM_NOW   = 30 minutes;
    uint8  public constant MAX_SUBMITTED_EXT       = 3;
    uint64 public constant SUBMITTED_EXT_DELTA     = 1 hours;

    uint256 public constant EVALUATOR_MIN_STAKE    = 100_000_000; // 100 USDC (6 decimals)
    uint16  public constant EJECT_ALIGNMENT_BPS    = 3_000;       // <30% lifetime majority → ejectable
    uint32  public constant EJECT_MIN_VOTES        = 10;          // floor to avoid early-life ejection

    uint16  public constant MAX_PLATFORM_FEE_BPS   = 1_000;       // 10% cap on admin setter

    // ──────────────────────────────────────────────────────────────────────
    //                                ENUMS
    // ──────────────────────────────────────────────────────────────────────

    enum Status {
        Open,
        Funded,
        Submitted,
        Disputed,
        Completed,
        Rejected,
        Refunded,
        Expired
    }

    enum DisputeStatus {
        Open,
        Defended,
        Resolved_Disputer,
        Resolved_Opponent,
        Resolved_NoQuorum,
        Conceded_Disputer
    }

    enum Vote {
        None,
        ForDisputer,
        ForOpponent
    }

    // ──────────────────────────────────────────────────────────────────────
    //                               STRUCTS
    // ──────────────────────────────────────────────────────────────────────

    struct PactRecord {
        // lifecycle
        uint256 underlyingJobId;
        address client;
        address provider;
        uint64  createdAt;
        uint64  expiredAt;
        uint8   submittedExtCount;
        Status  status;
        address terminationActor;

        // live quote (provider's setBudget output)
        uint256 budget;
        uint64  challengeWindow;

        // client's pending counter-proposal (proposeTerms)
        uint256 pendingBudget;
        uint64  pendingChallengeWindow;
        uint64  pendingProposedAt;

        // submission
        bytes32 deliverableHash;
        uint64  submittedAt;

        // dispute pointer
        uint256 disputeId;

        // forward-compat (M42 Fairblock)
        bool confidentialPayout;
    }

    struct Dispute {
        uint256 pactId;
        address disputer;
        address opponent;
        uint256 bondDisputer;
        uint256 bondOpponent;
        bytes32 reasonHash;
        DisputeStatus status;
        uint64  openedAt;
        uint64  concedeDeadline;
        uint64  commitDeadline;
        uint64  graceDeadline;
        uint64  revealDeadline;
        address[3] evaluators;
        mapping(address => bytes32) commit;
        mapping(address => Vote)    reveal;
        uint8 commitCount;
        uint8 revealCount;
        uint8 votesForDisputer;
        uint8 votesForOpponent;
    }

    struct EvaluatorStake {
        uint256 stake;
        uint64  stakedAt;
        uint32  totalVotes;
        uint32  majorityVotes;
        uint32  pendingDisputeRefs;
        bool    active;
    }

    // ──────────────────────────────────────────────────────────────────────
    //                              STORAGE
    // ──────────────────────────────────────────────────────────────────────

    // Immutables — set once in constructor.
    IERC20            public immutable usdc;
    IAgenticCommerce  public immutable agenticCommerce;
    address           public owner;

    // Pacts
    mapping(uint256 => PactRecord) public pacts;
    uint256 public nextPactId; // starts at 1; pactId 0 reserved as sentinel

    // Disputes
    mapping(uint256 => Dispute) internal disputes;
    uint256 public nextDisputeId; // starts at 1

    // Evaluator pool
    mapping(address => EvaluatorStake) public evaluators;
    address[] public activeEvaluators;
    mapping(address => uint256) internal activeEvaluatorIndex; // 1-indexed; 0 = not active

    // Fee + treasury
    uint16  public platformFeeBps;
    address public platformTreasury;
    uint256 public treasuryBalance;

    // ──────────────────────────────────────────────────────────────────────
    //                               EVENTS
    // ──────────────────────────────────────────────────────────────────────

    event PactCreated(
        uint256 indexed pactId,
        uint256 indexed underlyingJobId,
        address indexed client,
        address provider,
        uint64  expiredAt,
        uint64  challengeWindow,
        string  description
    );

    event TermsProposed(
        uint256 indexed pactId,
        uint256 budget,
        uint64  challengeWindow,
        address indexed by
    );

    event BudgetSet(
        uint256 indexed pactId,
        uint256 budget,
        uint64  challengeWindow,
        address indexed by
    );

    event Funded(uint256 indexed pactId, uint256 budget, uint256 platformFee, address indexed by);
    event Submitted(uint256 indexed pactId, bytes32 deliverableHash, address indexed by, uint64 challengeOpensAt);

    event Completed(
        uint256 indexed pactId,
        bytes32 reason,
        address indexed payee,
        uint256 grossAmount,
        address indexed by
    );

    event Rejected(uint256 indexed pactId, bytes32 reason, address indexed by);
    event Refunded(uint256 indexed pactId, uint256 amount, address indexed to);
    event Expired(uint256 indexed pactId, address indexed by);

    event DeadlineExtended(uint256 indexed pactId, uint64 oldExpiredAt, uint64 newExpiredAt, uint8 submittedExtCount);

    // Disputes
    event DisputeOpened(uint256 indexed pactId, uint256 indexed disputeId, address indexed disputer, uint256 bond, bytes32 reasonHash);
    event DisputeConceded(uint256 indexed pactId, uint256 indexed disputeId, address indexed conceder);
    event DisputeDefended(uint256 indexed pactId, uint256 indexed disputeId, address indexed opponent, uint256 bond, address[3] evaluators);
    event CommitSubmitted(uint256 indexed pactId, uint256 indexed disputeId, address indexed evaluator, bytes32 commit);
    event VoteRevealed(uint256 indexed pactId, uint256 indexed disputeId, address indexed evaluator, Vote vote);
    event DisputeResolved(
        uint256 indexed pactId,
        uint256 indexed disputeId,
        DisputeStatus result,
        address winner,
        uint256 winnerBondReturn,
        uint256 loserBondReturn,
        uint256 evaluatorPoolShare
    );
    event EvaluatorPayout(address indexed evaluator, uint256 amount, uint256 indexed disputeId);

    // Evaluator pool
    event EvaluatorStaked(address indexed who, uint256 amount);
    event EvaluatorUnstaked(address indexed who, uint256 amount);
    event EvaluatorEjected(address indexed who, uint32 totalVotes, uint32 majorityVotes);

    // Treasury / admin
    event TreasuryWithdrawn(address indexed to, uint256 amount);
    event PlatformFeeUpdated(uint16 oldBps, uint16 newBps);
    event PlatformTreasuryUpdated(address oldTreasury, address newTreasury);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ──────────────────────────────────────────────────────────────────────
    //                              ERRORS
    // ──────────────────────────────────────────────────────────────────────

    // access
    error NotClient(address caller);
    error NotProvider(address caller);
    error NotPactParticipant();
    error NotDisputeOpponent();
    error EvaluatorNotSelected(address who);
    error UnauthorizedTreasury();
    error NotOwner();

    // lifecycle
    error PactNotFound(uint256 pactId);
    error WrongStatus(Status current, Status expected);
    error WrongStatusMulti(Status current);
    error WrongTerms(uint256 wantBudget, uint64 wantWindow, uint256 gotBudget, uint64 gotWindow);
    error BudgetNotSet();
    error FundingAfterExpiry();
    error DeadlineTooSoon(uint64 minRequired);
    error ExtensionDeltaTooLarge();
    error ExtensionDeltaNotPositive();
    error SubmittedExtensionsExhausted();
    error ChallengeWindowOutOfRange(uint64 requested);
    error ChallengeWindowStillOpen(uint64 challengeOpensAt, uint64 nowTs);
    error TerminalStatus();
    error PastDeadline(uint64 expiredAt, uint64 nowTs);
    error NotYetExpired(uint64 expiredAt, uint64 nowTs);

    // dispute
    error DisputeAlreadyOpen();
    error NoActiveDispute();
    error ConcedeDeadlinePassed();
    error ConcedeDeadlineNotYetPassed();
    error GraceWindowClosed();
    error RevealWindowClosed();
    error RevealNotOpen();
    error CommitMissing();
    error CommitMismatch();
    error AlreadyRevealed();
    error ResolutionTooEarly();
    error InvalidVote();

    // pool / fees / transfers
    error TransferFailed();
    error InsufficientStake(uint256 have, uint256 need);
    error AlreadyStaked();
    error NotStaked();
    error InsufficientEvaluators(uint256 active);
    error EvaluatorBusy(uint32 pendingDisputeRefs);
    error PlatformFeeAboveMax(uint16 requested, uint16 max);
    error ZeroAddress();

    // ──────────────────────────────────────────────────────────────────────
    //                             MODIFIERS
    // ──────────────────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier pactExists(uint256 pactId) {
        if (pacts[pactId].client == address(0)) revert PactNotFound(pactId);
        _;
    }

    modifier onlyClient(uint256 pactId) {
        if (pacts[pactId].client != msg.sender) revert NotClient(msg.sender);
        _;
    }

    modifier onlyProvider(uint256 pactId) {
        if (pacts[pactId].provider != msg.sender) revert NotProvider(msg.sender);
        _;
    }

    modifier onlyPactParty(uint256 pactId) {
        address c = pacts[pactId].client;
        address p = pacts[pactId].provider;
        if (msg.sender != c && msg.sender != p) revert NotPactParticipant();
        _;
    }

    modifier inStatus(uint256 pactId, Status s) {
        Status cur = pacts[pactId].status;
        if (cur != s) revert WrongStatus(cur, s);
        _;
    }

    // ──────────────────────────────────────────────────────────────────────
    //                            CONSTRUCTOR
    // ──────────────────────────────────────────────────────────────────────

    constructor(
        address usdc_,
        address agenticCommerce_,
        address platformTreasury_,
        uint16  platformFeeBps_
    ) {
        if (usdc_ == address(0) || agenticCommerce_ == address(0) || platformTreasury_ == address(0)) {
            revert ZeroAddress();
        }
        if (platformFeeBps_ > MAX_PLATFORM_FEE_BPS) {
            revert PlatformFeeAboveMax(platformFeeBps_, MAX_PLATFORM_FEE_BPS);
        }
        usdc             = IERC20(usdc_);
        agenticCommerce  = IAgenticCommerce(agenticCommerce_);
        platformTreasury = platformTreasury_;
        platformFeeBps   = platformFeeBps_;
        owner            = msg.sender;
        nextPactId       = 1;
        nextDisputeId    = 1;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    // ──────────────────────────────────────────────────────────────────────
    //                       PACT LIFECYCLE (signatures)
    // ──────────────────────────────────────────────────────────────────────

    function createPact(
        address provider,
        uint64  expiredAt,
        string  calldata description,
        address hook,
        uint64  challengeWindow
    ) external returns (uint256 pactId) {
        // Rule 3: minimum 30-minute deadline at creation.
        uint64 minRequired = uint64(block.timestamp) + MIN_DEADLINE_FROM_NOW;
        if (expiredAt < minRequired) revert DeadlineTooSoon(minRequired);

        uint64 cw = challengeWindow == 0 ? CHALLENGE_DEFAULT : challengeWindow;
        if (cw < CHALLENGE_FLOOR || cw > CHALLENGE_CEILING) revert ChallengeWindowOutOfRange(cw);

        // Wrapper acts as the protocol-level evaluator on every Pact it creates.
        // The reference contract's expiredAt is set to max-uint64 so the wrapper's
        // deadline stays authoritative — wrapper.extendDeadline can push the user-
        // facing deadline arbitrarily forward without colliding with the reference
        // contract's own past-deadline guards on fund() and claimRefund(). For the
        // same reason, wrapper.claimRefund routes through reference.reject() rather
        // than reference.claimRefund() (which would refuse with our max-uint64 ref
        // deadline). See §8.1 extendDeadline / claimRefund of the spec.
        uint256 underlyingJobId = agenticCommerce.createJob(
            provider,
            address(this),
            type(uint64).max,
            description,
            hook
        );

        pactId = nextPactId++;
        PactRecord storage p = pacts[pactId];
        p.underlyingJobId  = underlyingJobId;
        p.client           = msg.sender;
        p.provider         = provider;
        p.createdAt        = uint64(block.timestamp);
        p.expiredAt        = expiredAt;
        p.status           = Status.Open;
        p.challengeWindow  = cw;

        emit PactCreated(pactId, underlyingJobId, msg.sender, provider, expiredAt, cw, description);
    }

    function proposeTerms(uint256 pactId, uint256 budget, uint64 challengeWindow)
        external
        onlyClient(pactId)
        pactExists(pactId)
        inStatus(pactId, Status.Open)
    {
        if (budget == 0) revert BudgetNotSet();
        if (challengeWindow < CHALLENGE_FLOOR || challengeWindow > CHALLENGE_CEILING) {
            revert ChallengeWindowOutOfRange(challengeWindow);
        }

        PactRecord storage p = pacts[pactId];
        p.pendingBudget          = budget;
        p.pendingChallengeWindow = challengeWindow;
        p.pendingProposedAt      = uint64(block.timestamp);

        emit TermsProposed(pactId, budget, challengeWindow, msg.sender);
    }

    function setBudget(uint256 pactId, uint256 budget, uint64 challengeWindow)
        external
        onlyProvider(pactId)
        pactExists(pactId)
        inStatus(pactId, Status.Open)
    {
        if (budget == 0) revert BudgetNotSet();
        PactRecord storage p = pacts[pactId];

        if (challengeWindow != 0) {
            if (challengeWindow < CHALLENGE_FLOOR || challengeWindow > CHALLENGE_CEILING) {
                revert ChallengeWindowOutOfRange(challengeWindow);
            }
            p.challengeWindow = challengeWindow;
        }
        p.budget = budget;

        // Clear pending client proposal (provider's setBudget supersedes
        // whether or not they matched).
        p.pendingBudget            = 0;
        p.pendingChallengeWindow   = 0;
        p.pendingProposedAt        = 0;

        agenticCommerce.setBudget(p.underlyingJobId, budget, "");

        emit BudgetSet(pactId, budget, p.challengeWindow, msg.sender);
    }

    function fund(uint256 pactId, uint256 expectedBudget, uint64 expectedChallengeWindow)
        external
        onlyClient(pactId)
        pactExists(pactId)
        inStatus(pactId, Status.Open)
    {
        PactRecord storage p = pacts[pactId];

        // Atomic acceptance — funding signs off on exactly the current live quote.
        if (p.budget != expectedBudget || p.challengeWindow != expectedChallengeWindow) {
            revert WrongTerms(expectedBudget, expectedChallengeWindow, p.budget, p.challengeWindow);
        }
        if (p.budget == 0) revert BudgetNotSet();

        // Rule 2: no funding after expiry.
        if (block.timestamp > p.expiredAt) revert FundingAfterExpiry();

        // Effects before external calls (CEI).
        p.status = Status.Funded;
        uint256 fee = BondMath.platformFee(p.budget, platformFeeBps);
        if (fee > 0) treasuryBalance += fee;

        // Pull (budget + fee) from client, then approve and forward budget to
        // the reference contract.
        if (!usdc.transferFrom(msg.sender, address(this), p.budget + fee)) revert TransferFailed();
        if (!usdc.approve(address(agenticCommerce), p.budget)) revert TransferFailed();
        agenticCommerce.fund(p.underlyingJobId, "");

        emit Funded(pactId, p.budget, fee, msg.sender);
    }

    function submit(uint256 pactId, bytes32 deliverableHash)
        external
        onlyProvider(pactId)
        pactExists(pactId)
        inStatus(pactId, Status.Funded)
    {
        if (deliverableHash == bytes32(0)) revert CommitMissing();
        PactRecord storage p = pacts[pactId];
        if (block.timestamp > p.expiredAt) revert PastDeadline(p.expiredAt, uint64(block.timestamp));

        p.status          = Status.Submitted;
        p.submittedAt     = uint64(block.timestamp);
        p.deliverableHash = deliverableHash;

        agenticCommerce.submit(p.underlyingJobId, deliverableHash, "");

        emit Submitted(pactId, deliverableHash, msg.sender, p.submittedAt);
    }

    function clientAccept(uint256 pactId)
        external
        onlyClient(pactId)
        pactExists(pactId)
        inStatus(pactId, Status.Submitted)
    {
        if (pacts[pactId].disputeId != 0) revert DisputeAlreadyOpen();
        _payout(pactId, bytes32(0), msg.sender);
    }

    function complete(uint256 pactId, bytes32 reason) external pactExists(pactId) {
        PactRecord storage p = pacts[pactId];
        if (p.status != Status.Submitted) revert WrongStatus(p.status, Status.Submitted);
        if (p.disputeId != 0) revert DisputeAlreadyOpen();
        uint64 challengeOpensAt = p.submittedAt;
        uint64 closesAt = challengeOpensAt + p.challengeWindow;
        if (block.timestamp < closesAt) revert ChallengeWindowStillOpen(challengeOpensAt, uint64(block.timestamp));
        _payout(pactId, reason, msg.sender);
    }

    function reject(uint256 pactId, bytes32 reason) external onlyClient(pactId) pactExists(pactId) {
        PactRecord storage p = pacts[pactId];
        if (p.status != Status.Funded && p.status != Status.Submitted) revert WrongStatusMulti(p.status);
        if (p.disputeId != 0) revert DisputeAlreadyOpen();

        uint256 budget       = p.budget;
        address actualClient = p.client;

        p.status           = Status.Rejected;
        p.terminationActor = msg.sender;

        // Reference's `client` is the wrapper (since wrapper called createJob),
        // so reference.reject() sends the budget here. Forward to the real client.
        // Platform fee stays in treasuryBalance per locked §11.
        agenticCommerce.reject(p.underlyingJobId, reason, "");
        if (!usdc.transfer(actualClient, budget)) revert TransferFailed();

        emit Rejected(pactId, reason, msg.sender);
    }

    function cancel(uint256 pactId)
        external
        onlyClient(pactId)
        pactExists(pactId)
        inStatus(pactId, Status.Open)
    {
        PactRecord storage p = pacts[pactId];
        p.status           = Status.Expired;
        p.terminationActor = msg.sender;

        // No funds have moved yet (Open ⇒ never funded). reference.reject is the
        // canonical way to mark the underlying job terminal.
        agenticCommerce.reject(p.underlyingJobId, bytes32(0), "");

        emit Expired(pactId, msg.sender);
    }

    function claimRefund(uint256 pactId) external pactExists(pactId) {
        PactRecord storage p = pacts[pactId];
        if (p.status != Status.Funded && p.status != Status.Submitted) revert WrongStatusMulti(p.status);
        if (block.timestamp <= p.expiredAt) revert NotYetExpired(p.expiredAt, uint64(block.timestamp));
        if (p.disputeId != 0) revert DisputeAlreadyOpen();

        uint256 budget       = p.budget;
        address actualClient = p.client;

        p.status           = Status.Refunded;
        p.terminationActor = msg.sender;

        // Reference contract was given a max-uint64 expiredAt at createPact, so
        // reference.claimRefund() would refuse (its check `now > expiredAt` fails).
        // Use reference.reject() instead — refund lands in the wrapper (because
        // reference's `client` is the wrapper) and we forward to the real client.
        // Platform fee retained per §11.
        agenticCommerce.reject(p.underlyingJobId, bytes32(0), "");
        if (!usdc.transfer(actualClient, budget)) revert TransferFailed();

        emit Refunded(pactId, budget, actualClient);
    }

    function extendDeadline(uint256 pactId, uint64 newExpiredAt)
        external
        onlyClient(pactId)
        pactExists(pactId)
    {
        PactRecord storage p = pacts[pactId];
        Status s = p.status;
        uint64 cur = p.expiredAt;

        // Rule 1, terminal states blocked.
        if (s == Status.Completed || s == Status.Rejected || s == Status.Refunded || s == Status.Expired) {
            revert TerminalStatus();
        }

        if (s == Status.Submitted) {
            // Locked-down: exactly +1h, max 3 extensions, against the current expiredAt.
            uint64 expected = cur + SUBMITTED_EXT_DELTA;
            if (newExpiredAt != expected) revert ExtensionDeltaTooLarge();
            if (p.submittedExtCount >= MAX_SUBMITTED_EXT) revert SubmittedExtensionsExhausted();
            p.submittedExtCount = p.submittedExtCount + 1;
        } else {
            // Open / Funded / Disputed: unrestricted forward extensions.
            if (newExpiredAt <= cur) revert ExtensionDeltaNotPositive();
        }

        p.expiredAt = newExpiredAt;
        emit DeadlineExtended(pactId, cur, newExpiredAt, p.submittedExtCount);
    }

    // ──────────────────────────────────────────────────────────────────────
    //                       DISPUTE (signatures)
    // ──────────────────────────────────────────────────────────────────────

    function dispute(uint256 pactId, bytes32 reasonHash)
        external
        pactExists(pactId)
        inStatus(pactId, Status.Submitted)
        returns (uint256 disputeId)
    {
        pactId; reasonHash;
        revert("NOT_IMPLEMENTED");
    }

    function concede(uint256 pactId) external pactExists(pactId) {
        pactId;
        revert("NOT_IMPLEMENTED");
    }

    function forceConcede(uint256 pactId) external pactExists(pactId) {
        pactId;
        revert("NOT_IMPLEMENTED");
    }

    function defend(uint256 pactId) external pactExists(pactId) {
        pactId;
        revert("NOT_IMPLEMENTED");
    }

    function commitVote(uint256 pactId, bytes32 commitHash) external pactExists(pactId) {
        pactId; commitHash;
        revert("NOT_IMPLEMENTED");
    }

    function revealVote(uint256 pactId, address evaluator, Vote vote_, bytes32 secret)
        external
        pactExists(pactId)
    {
        pactId; evaluator; vote_; secret;
        revert("NOT_IMPLEMENTED");
    }

    function resolve(uint256 pactId) external pactExists(pactId) {
        pactId;
        revert("NOT_IMPLEMENTED");
    }

    // ──────────────────────────────────────────────────────────────────────
    //                       EVALUATOR POOL (signatures)
    // ──────────────────────────────────────────────────────────────────────

    function stakeEvaluator(uint256 amount) external {
        amount;
        revert("NOT_IMPLEMENTED");
    }

    function unstakeEvaluator() external {
        revert("NOT_IMPLEMENTED");
    }

    // ──────────────────────────────────────────────────────────────────────
    //                          ADMIN (signatures)
    // ──────────────────────────────────────────────────────────────────────

    function setPlatformFeeBps(uint16 bps) external onlyOwner {
        bps;
        revert("NOT_IMPLEMENTED");
    }

    function setPlatformTreasury(address treasury) external onlyOwner {
        treasury;
        revert("NOT_IMPLEMENTED");
    }

    function withdrawTreasury(uint256 amount) external onlyOwner {
        amount;
        revert("NOT_IMPLEMENTED");
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ──────────────────────────────────────────────────────────────────────
    //                       VIEW HELPERS (signatures)
    // ──────────────────────────────────────────────────────────────────────

    // Flat view of a Dispute (mappings inside the struct prevent default
    // public auto-getters; expose a tuple instead).
    function getDisputeMeta(uint256 disputeId)
        external
        view
        returns (
            uint256 pactId,
            address disputer,
            address opponent,
            uint256 bondDisputer,
            uint256 bondOpponent,
            bytes32 reasonHash,
            DisputeStatus status,
            uint64 openedAt,
            uint64 concedeDeadline,
            uint64 commitDeadline,
            uint64 graceDeadline,
            uint64 revealDeadline,
            address[3] memory evaluators_,
            uint8 commitCount,
            uint8 revealCount,
            uint8 votesForDisputer,
            uint8 votesForOpponent
        )
    {
        Dispute storage d = disputes[disputeId];
        return (
            d.pactId,
            d.disputer,
            d.opponent,
            d.bondDisputer,
            d.bondOpponent,
            d.reasonHash,
            d.status,
            d.openedAt,
            d.concedeDeadline,
            d.commitDeadline,
            d.graceDeadline,
            d.revealDeadline,
            d.evaluators,
            d.commitCount,
            d.revealCount,
            d.votesForDisputer,
            d.votesForOpponent
        );
    }

    function getActiveEvaluatorCount() external view returns (uint256) {
        return activeEvaluators.length;
    }

    // ──────────────────────────────────────────────────────────────────────
    //                          INTERNAL HELPERS
    // ──────────────────────────────────────────────────────────────────────

    // Settles a Pact in the provider's favor. Reference contract pays the
    // provider directly (its platformFeeBP + evaluatorFeeBP are 0 on Arc
    // Testnet); our platform fee was already collected on fund(), so
    // nothing to skim here.
    function _payout(uint256 pactId, bytes32 reason, address by) internal {
        PactRecord storage p = pacts[pactId];
        p.status           = Status.Completed;
        p.terminationActor = by;
        agenticCommerce.complete(p.underlyingJobId, reason, "");
        emit Completed(pactId, reason, p.provider, p.budget, by);
    }
}
