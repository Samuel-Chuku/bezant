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
    error DisputeWindowClosed(uint64 closedAt, uint64 nowTs);
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
        _settleAsRejected(pactId, reason, msg.sender);
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
        PactRecord storage p = pacts[pactId];

        // Only client / provider can dispute.
        if (msg.sender != p.client && msg.sender != p.provider) revert NotPactParticipant();
        if (p.disputeId != 0) revert DisputeAlreadyOpen();

        // Dispute must happen within the challenge window — past that, anyone
        // can permissionlessly auto-finalize via complete().
        uint64 closesAt = p.submittedAt + p.challengeWindow;
        if (block.timestamp >= closesAt) revert DisputeWindowClosed(closesAt, uint64(block.timestamp));

        uint256 bond = BondMath.bondFor(p.budget, BOND_BPS);
        if (!usdc.transferFrom(msg.sender, address(this), bond)) revert TransferFailed();

        disputeId = nextDisputeId++;
        Dispute storage d = disputes[disputeId];
        d.pactId          = pactId;
        d.disputer        = msg.sender;
        d.opponent        = (msg.sender == p.client) ? p.provider : p.client;
        d.bondDisputer    = bond;
        d.reasonHash      = reasonHash;
        d.status          = DisputeStatus.Open;
        d.openedAt        = uint64(block.timestamp);
        d.concedeDeadline = uint64(block.timestamp) + CONCEDE_WINDOW;

        p.status    = Status.Disputed;
        p.disputeId = disputeId;

        emit DisputeOpened(pactId, disputeId, msg.sender, bond, reasonHash);
    }

    function concede(uint256 pactId) external pactExists(pactId) {
        PactRecord storage p = pacts[pactId];
        if (p.status != Status.Disputed) revert WrongStatus(p.status, Status.Disputed);
        Dispute storage d = disputes[p.disputeId];
        if (d.status != DisputeStatus.Open) revert NoActiveDispute();
        if (msg.sender != d.opponent) revert NotDisputeOpponent();
        if (block.timestamp > d.concedeDeadline) revert ConcedeDeadlinePassed();
        _resolveByConcede(pactId, p.disputeId);
    }

    function forceConcede(uint256 pactId) external pactExists(pactId) {
        PactRecord storage p = pacts[pactId];
        if (p.status != Status.Disputed) revert WrongStatus(p.status, Status.Disputed);
        Dispute storage d = disputes[p.disputeId];
        if (d.status != DisputeStatus.Open) revert NoActiveDispute();
        if (block.timestamp <= d.concedeDeadline) revert ConcedeDeadlineNotYetPassed();
        _resolveByConcede(pactId, p.disputeId);
    }

    function defend(uint256 pactId) external pactExists(pactId) {
        PactRecord storage p = pacts[pactId];
        if (p.status != Status.Disputed) revert WrongStatus(p.status, Status.Disputed);
        Dispute storage d = disputes[p.disputeId];
        if (d.status != DisputeStatus.Open) revert NoActiveDispute();
        if (msg.sender != d.opponent) revert NotDisputeOpponent();
        if (block.timestamp > d.concedeDeadline) revert ConcedeDeadlinePassed();

        uint256 bond = d.bondDisputer; // mirror disputer's bond
        if (!usdc.transferFrom(msg.sender, address(this), bond)) revert TransferFailed();
        d.bondOpponent = bond;

        address[3] memory selected = _selectEvaluators(pactId, p.disputeId);
        for (uint8 i = 0; i < EVALUATORS_PER_DISPUTE; i++) {
            d.evaluators[i] = selected[i];
            evaluators[selected[i]].pendingDisputeRefs += 1;
        }

        d.commitDeadline = uint64(block.timestamp) + COMMIT_WINDOW;
        d.graceDeadline  = d.commitDeadline + GRACE_WINDOW;
        d.revealDeadline = d.graceDeadline + REVEAL_WINDOW;
        d.status         = DisputeStatus.Defended;

        emit DisputeDefended(pactId, p.disputeId, msg.sender, bond, selected);
    }

    function commitVote(uint256 pactId, bytes32 commitHash) external pactExists(pactId) {
        PactRecord storage p = pacts[pactId];
        Dispute storage d = disputes[p.disputeId];
        if (d.status != DisputeStatus.Defended) revert NoActiveDispute();
        if (block.timestamp > d.graceDeadline) revert GraceWindowClosed();
        if (!_isSelectedEvaluator(d, msg.sender)) revert EvaluatorNotSelected(msg.sender);

        bool firstCommit = d.commit[msg.sender] == bytes32(0);
        d.commit[msg.sender] = commitHash;
        if (firstCommit) d.commitCount += 1;

        emit CommitSubmitted(pactId, p.disputeId, msg.sender, commitHash);
    }

    function revealVote(uint256 pactId, address evaluator, Vote vote_, bytes32 secret)
        external
        pactExists(pactId)
    {
        PactRecord storage p = pacts[pactId];
        Dispute storage d = disputes[p.disputeId];
        if (d.status != DisputeStatus.Defended) revert NoActiveDispute();
        if (vote_ == Vote.None) revert InvalidVote();
        if (!_isSelectedEvaluator(d, evaluator)) revert EvaluatorNotSelected(evaluator);
        if (block.timestamp <= d.graceDeadline) revert RevealNotOpen();
        if (block.timestamp > d.revealDeadline) revert RevealWindowClosed();

        bytes32 stored = d.commit[evaluator];
        if (stored == bytes32(0)) revert CommitMissing();
        bytes32 expected = keccak256(abi.encode(vote_, secret, evaluator));
        if (stored != expected) revert CommitMismatch();
        if (d.reveal[evaluator] != Vote.None) revert AlreadyRevealed();

        d.reveal[evaluator] = vote_;
        d.revealCount += 1;
        if (vote_ == Vote.ForDisputer) d.votesForDisputer += 1;
        else d.votesForOpponent += 1;

        emit VoteRevealed(pactId, p.disputeId, evaluator, vote_);
    }

    function resolve(uint256 pactId) external pactExists(pactId) {
        PactRecord storage p = pacts[pactId];
        Dispute storage d = disputes[p.disputeId];
        if (d.status != DisputeStatus.Defended) revert NoActiveDispute();

        // Can resolve when (a) reveal window has passed, OR (b) all N evaluators
        // have revealed and the window's still open (early-exit shortcut).
        bool allRevealed = d.revealCount == EVALUATORS_PER_DISPUTE;
        if (!allRevealed && block.timestamp <= d.revealDeadline) revert ResolutionTooEarly();

        if (d.revealCount < QUORUM) {
            _resolveNoQuorum(pactId, p.disputeId);
            return;
        }

        bool disputerWon = d.votesForDisputer > d.votesForOpponent;
        (uint256 winnerReturn, uint256 loserReturn, uint256 evaluatorPoolShare) = BondMath.splitDispute(
            disputerWon ? d.bondDisputer : d.bondOpponent,
            disputerWon ? d.bondOpponent : d.bondDisputer,
            LOSER_KEEPS_BPS,
            WINNER_BONUS_BPS,
            EVALUATOR_POOL_BPS
        );

        address winner = disputerWon ? d.disputer : d.opponent;
        address loser  = disputerWon ? d.opponent : d.disputer;

        if (winnerReturn > 0 && !usdc.transfer(winner, winnerReturn)) revert TransferFailed();
        if (loserReturn  > 0 && !usdc.transfer(loser,  loserReturn))  revert TransferFailed();

        _scoreEvaluatorsAndPayPool(d, evaluatorPoolShare, disputerWon);

        d.status = disputerWon ? DisputeStatus.Resolved_Disputer : DisputeStatus.Resolved_Opponent;
        emit DisputeResolved(pactId, p.disputeId, d.status, winner, winnerReturn, loserReturn, evaluatorPoolShare);

        // Settle the pact in the winning side's favor.
        if (winner == p.provider) {
            _payout(pactId, bytes32(0), msg.sender);
        } else {
            // Winner is the client side.
            _settleAsRejected(pactId, bytes32(0), msg.sender);
        }
    }

    // ──────────────────────────────────────────────────────────────────────
    //                       EVALUATOR POOL (signatures)
    // ──────────────────────────────────────────────────────────────────────

    function stakeEvaluator(uint256 amount) external {
        if (amount < EVALUATOR_MIN_STAKE) revert InsufficientStake(amount, EVALUATOR_MIN_STAKE);
        EvaluatorStake storage e = evaluators[msg.sender];
        if (e.stake != 0) revert AlreadyStaked();

        if (!usdc.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();

        e.stake               = amount;
        e.stakedAt            = uint64(block.timestamp);
        e.totalVotes          = 0;
        e.majorityVotes       = 0;
        e.pendingDisputeRefs  = 0;
        e.active              = true;

        activeEvaluators.push(msg.sender);
        // 1-indexed so 0 means "not in pool".
        activeEvaluatorIndex[msg.sender] = activeEvaluators.length;

        emit EvaluatorStaked(msg.sender, amount);
    }

    function unstakeEvaluator() external {
        EvaluatorStake storage e = evaluators[msg.sender];
        if (e.stake == 0) revert NotStaked();
        if (e.pendingDisputeRefs != 0) revert EvaluatorBusy(e.pendingDisputeRefs);

        uint256 amount = e.stake;

        // Remove from activeEvaluators[] via swap-and-pop. Only relevant if
        // the evaluator is still in the active pool (ejection can drop them
        // out preemptively while leaving the stake locked until refs == 0).
        uint256 idx1 = activeEvaluatorIndex[msg.sender];
        if (idx1 != 0) {
            uint256 idx = idx1 - 1;
            uint256 lastIdx = activeEvaluators.length - 1;
            if (idx != lastIdx) {
                address last = activeEvaluators[lastIdx];
                activeEvaluators[idx] = last;
                activeEvaluatorIndex[last] = idx + 1;
            }
            activeEvaluators.pop();
            activeEvaluatorIndex[msg.sender] = 0;
        }

        // Reset record.
        delete evaluators[msg.sender];

        if (!usdc.transfer(msg.sender, amount)) revert TransferFailed();
        emit EvaluatorUnstaked(msg.sender, amount);
    }

    // ──────────────────────────────────────────────────────────────────────
    //                    EVALUATOR SELECTION (internal)
    // ──────────────────────────────────────────────────────────────────────

    // Picks EVALUATORS_PER_DISPUTE distinct evaluators uniformly at random
    // from activeEvaluators[]. Partial Fisher-Yates: each of the N picks
    // shuffles one slot of an in-memory index array, so no evaluator can be
    // picked twice. Seed mixes block.prevrandao + pactId + disputeId so two
    // disputes in the same block (or even same proposer) don't collide.
    function _selectEvaluators(uint256 pactId, uint256 disputeId)
        internal
        view
        returns (address[3] memory selected)
    {
        uint256 poolSize = activeEvaluators.length;
        if (poolSize < EVALUATORS_PER_DISPUTE) revert InsufficientEvaluators(poolSize);

        // Build [0, 1, 2, ..., poolSize-1] in memory.
        uint256[] memory pool = new uint256[](poolSize);
        for (uint256 i = 0; i < poolSize; i++) pool[i] = i;

        uint256 seed = uint256(
            keccak256(abi.encode(block.prevrandao, pactId, disputeId, block.timestamp))
        );

        for (uint8 k = 0; k < EVALUATORS_PER_DISPUTE; k++) {
            uint256 range  = poolSize - k;
            uint256 offset = seed % range;
            uint256 pickIdx = uint256(k) + offset;
            if (pickIdx != k) {
                uint256 tmp = pool[k];
                pool[k] = pool[pickIdx];
                pool[pickIdx] = tmp;
            }
            selected[k] = activeEvaluators[pool[k]];
            // Mix for the next iteration.
            seed = uint256(keccak256(abi.encode(seed, k)));
        }
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

    // Refund the locked budget to the client and mark the pact Rejected.
    // Used by wrapper.reject (when caller is the client directly) and by the
    // dispute-resolution paths whenever the client-side wins.
    function _settleAsRejected(uint256 pactId, bytes32 reason, address by) internal {
        PactRecord storage p = pacts[pactId];

        uint256 budget       = p.budget;
        address actualClient = p.client;

        p.status           = Status.Rejected;
        p.terminationActor = by;

        // Reference's `client` is the wrapper (since wrapper called createJob),
        // so reference.reject() sends the budget back here. Forward to the real
        // client. Platform fee stays in treasuryBalance per locked §11.
        agenticCommerce.reject(p.underlyingJobId, reason, "");
        if (!usdc.transfer(actualClient, budget)) revert TransferFailed();

        emit Rejected(pactId, reason, by);
    }

    function _isSelectedEvaluator(Dispute storage d, address who) internal view returns (bool) {
        for (uint8 i = 0; i < EVALUATORS_PER_DISPUTE; i++) {
            if (d.evaluators[i] == who) return true;
        }
        return false;
    }

    // Disputer wins by concession (opponent conceded or let the concedeDeadline
    // pass). Refund disputer's bond in full; settle pact in their direction.
    function _resolveByConcede(uint256 pactId, uint256 disputeId) internal {
        Dispute storage d = disputes[disputeId];
        PactRecord storage p = pacts[pactId];
        uint256 bond = d.bondDisputer;
        address disputer = d.disputer;

        d.status = DisputeStatus.Conceded_Disputer;
        emit DisputeConceded(pactId, disputeId, msg.sender);

        if (bond > 0 && !usdc.transfer(disputer, bond)) revert TransferFailed();

        if (disputer == p.provider) {
            _payout(pactId, bytes32(0), msg.sender);
        } else {
            _settleAsRejected(pactId, bytes32(0), msg.sender);
        }
    }

    // <QUORUM reveals — no decision. Refund both bonds, decrement evaluator
    // refs without scoring, and rewind the pact to Submitted with a fresh
    // challenge window so the parties can re-act.
    function _resolveNoQuorum(uint256 pactId, uint256 disputeId) internal {
        Dispute storage d = disputes[disputeId];
        PactRecord storage p = pacts[pactId];

        if (d.bondDisputer > 0 && !usdc.transfer(d.disputer, d.bondDisputer)) revert TransferFailed();
        if (d.bondOpponent > 0 && !usdc.transfer(d.opponent, d.bondOpponent)) revert TransferFailed();

        for (uint8 i = 0; i < EVALUATORS_PER_DISPUTE; i++) {
            address ev = d.evaluators[i];
            if (ev != address(0)) {
                evaluators[ev].pendingDisputeRefs -= 1;
            }
        }

        d.status = DisputeStatus.Resolved_NoQuorum;
        emit DisputeResolved(pactId, disputeId, d.status, address(0), d.bondDisputer, d.bondOpponent, 0);

        // Rewind: pact returns to Submitted, fresh challenge window opens.
        p.status     = Status.Submitted;
        p.disputeId  = 0;
        p.submittedAt = uint64(block.timestamp);
    }

    // Per-evaluator stat update, ejection check, and pool distribution. Pool
    // share is split equally across *revealers* — non-revealers get 0 of the
    // pot but still take a totalVotes++ hit (counted as non-majority below).
    // Dust from integer division goes to the first revealer.
    function _scoreEvaluatorsAndPayPool(Dispute storage d, uint256 poolShare, bool disputerWon) internal {
        Vote majority = disputerWon ? Vote.ForDisputer : Vote.ForOpponent;

        uint256 revealerCount   = d.revealCount;
        uint256 sharePerRevealer = revealerCount > 0 ? poolShare / revealerCount : 0;
        uint256 dust = poolShare - sharePerRevealer * revealerCount;
        bool firstRevealerSeen  = false;

        for (uint8 i = 0; i < EVALUATORS_PER_DISPUTE; i++) {
            address ev = d.evaluators[i];
            EvaluatorStake storage stake = evaluators[ev];

            stake.totalVotes += 1;
            stake.pendingDisputeRefs -= 1;

            Vote revealed = d.reveal[ev];
            if (revealed == majority) {
                stake.majorityVotes += 1;
            }

            if (revealed != Vote.None) {
                uint256 payment = sharePerRevealer;
                if (!firstRevealerSeen) {
                    payment += dust;
                    firstRevealerSeen = true;
                }
                if (payment > 0) {
                    if (!usdc.transfer(ev, payment)) revert TransferFailed();
                    emit EvaluatorPayout(ev, payment, d.pactId);
                }
            }

            // Ejection: <30% lifetime majority alignment AND ≥10 total votes.
            if (stake.totalVotes >= EJECT_MIN_VOTES) {
                uint256 alignment = (uint256(stake.majorityVotes) * 10_000) / uint256(stake.totalVotes);
                if (alignment < EJECT_ALIGNMENT_BPS && stake.active) {
                    uint256 idx1 = activeEvaluatorIndex[ev];
                    if (idx1 != 0) {
                        uint256 idx = idx1 - 1;
                        uint256 lastIdx = activeEvaluators.length - 1;
                        if (idx != lastIdx) {
                            address last = activeEvaluators[lastIdx];
                            activeEvaluators[idx] = last;
                            activeEvaluatorIndex[last] = idx + 1;
                        }
                        activeEvaluators.pop();
                        activeEvaluatorIndex[ev] = 0;
                    }
                    stake.active = false;
                    emit EvaluatorEjected(ev, stake.totalVotes, stake.majorityVotes);
                }
            }
        }
    }
}
