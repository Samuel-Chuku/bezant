'use client';

import { use, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { formatUnits, keccak256, stringToBytes, type Hex } from 'viem';
import { useChainId, usePublicClient, useSwitchChain } from 'wagmi';
import { useSigner } from '@/hooks/use-signer';
import { arcTestnet } from '@/lib/chains';
import {
  buildApproveUnsigned,
  buildCancelUnsigned,
  buildCompleteUnsigned,
  buildFundUnsigned,
  buildRefundUnsigned,
  buildRejectUnsigned,
  buildSetBudgetUnsigned,
  buildSubmitUnsigned,
  buildFinalizeUnsigned,
  buildDisputeUnsigned,
  buildConcedeUnsigned,
  buildForceConcedeUnsigned,
  buildDefendUnsigned,
  buildCommitVoteUnsigned,
  buildRevealVoteUnsigned,
  buildResolveUnsigned,
  formatReputationValue,
  getDeliverable,
  getDeliverableFile,
  getPactEvents,
  getPactState,
  getDisputeState,
  getEvaluatorInfo,
  registerAutoReveal,
  getOrCreateReadAuth,
  getReputationSummary,
  getUserByAddress,
  uploadDeliverableContent,
  uploadDeliverableFile,
  type Deliverable,
  type DeliverableContentType,
  type DisputeState,
  type PactEvent,
  type PactLiveState,
  type PactRole,
  type ReputationSummary,
} from '@/lib/api';
import { WRAPPER_ADDRESS, USDC_ADDRESS } from '@/lib/chains';
import {
  computeCommitHash,
  generateSecret,
  saveVote,
  loadVote,
  clearVote,
  type VoteChoice,
} from '@/lib/vote';
import { actionVerbForMe, describeCurrentStep, displayStatus } from '@/lib/pact-status';
import { CountdownBanner, CountdownChip } from '@/components/countdown';
import { useToast } from '@/components/toast';
import { arcExplorerTxUrl } from '@/lib/explorers';
import { shortAddress } from '@/lib/format';

// Maps an in-flight action label to its past-tense confirmation toast. Keeps the
// toast copy in one place; runAction looks it up on success. (Falls back to a
// generic "Done" for anything not listed.)
const ACTION_TOAST: Record<string, string> = {
  'Funding pact…': 'Pact funded',
  'Releasing…': 'Funds released to the provider',
  'Rejecting…': 'Pact rejected - refund issued',
  'Cancelling…': 'Pact cancelled',
  'Setting budget…': 'Quote updated',
  'Opening dispute…': 'Dispute opened',
  'Defending…': 'Dispute defended - evaluators selected',
  'Conceding…': 'Conceded',
  'Force-settling…': 'Dispute force-settled',
  'Committing vote…': 'Vote committed',
  'Revealing vote…': 'Vote revealed',
  'Resolving…': 'Dispute resolved',
  'Finalizing…': 'Pact finalized',
  'Claiming refund…': 'Refund claimed',
  'Approving USDC…': 'USDC approved',
};

// Minimal ABI fragment to read USDC allowance - saves a backend roundtrip.
const erc20AllowanceAbi = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
] as const;

const STATUS_TINT: Record<string, string> = {
  Open: 'bg-sky-950/40 text-sky-300 border-sky-900/60',
  Funded: 'bg-amber-950/40 text-amber-300 border-amber-900/60',
  Submitted: 'bg-violet-950/40 text-violet-300 border-violet-900/60',
  Disputed: 'bg-orange-950/40 text-orange-300 border-orange-900/60',
  Completed: 'bg-emerald-950/40 text-emerald-300 border-emerald-900/60',
  Cancelled: 'bg-neutral-900 text-neutral-400 border-neutral-800',
  Rejected: 'bg-red-950/40 text-red-300 border-red-900/60',
  Expired: 'bg-neutral-900 text-neutral-400 border-neutral-800',
};

// Mirrors the wrapper's immutable BOND_BPS (5%). Used to size the USDC approval
// before dispute()/defend(); the contract pulls the exact bond.
const DISPUTE_BOND_BPS = 500n;

function effectiveStatus(live: PactLiveState, nowMs: number): string {
  const raw = live.status;
  if (raw === 'Completed' || raw === 'Rejected' || raw === 'Expired') {
    return displayStatus(live, raw);
  }
  if (live.expiredAt.unix * 1000 < nowMs) return 'Expired';
  return raw;
}

function userRoles(live: PactLiveState, address: string | undefined): PactRole[] {
  if (!address) return [];
  const a = address.toLowerCase();
  const roles: PactRole[] = [];
  if (live.client.toLowerCase() === a) roles.push('client');
  if (live.provider.toLowerCase() === a) roles.push('provider');
  if (live.evaluator.toLowerCase() === a) roles.push('evaluator');
  return roles;
}

// describeCurrentStep moved to lib/pact-status.ts so the notifications feed
// and other surfaces can derive the same sentences without duplication.

// Compact relative-time formatter ("3m ago", "2h ago", "5d ago"). Beyond a
// month, falls back to the locale date so we don't show "47 days ago".
function timeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 30) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 86400 * 30) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

type LifecycleRow = {
  label: string;
  // Optional - derived rows for actions with no indexed event (e.g. refund
  // closed terminal state via claimRefund, which is permissionless and
  // doesn't tell us the caller) can omit the actor entirely. Render skips
  // the by-line for those rows.
  actorAddr?: string;
  when?: string;
  txHash?: string;
};

// Waiting-cue tint keyed off effective status. Mirrors the pact-list page's
// WAITING_TINT but with an Expired fallback (the detail page still surfaces
// a waiting line for expired-with-funds-locked while lists go quiet).
const LIFECYCLE_TINT: Record<string, { ping: string; solid: string; text: string }> = {
  Open: { ping: 'bg-sky-400', solid: 'bg-sky-500', text: 'text-sky-300' },
  Funded: { ping: 'bg-amber-400', solid: 'bg-amber-500', text: 'text-amber-300' },
  Submitted: { ping: 'bg-violet-400', solid: 'bg-violet-500', text: 'text-violet-300' },
  Expired: { ping: 'bg-neutral-500', solid: 'bg-neutral-600', text: 'text-neutral-400' },
};
const DEFAULT_LIFECYCLE_TINT = LIFECYCLE_TINT.Open;

// Builds the ordered list of completed lifecycle steps. Sources:
// - Created: pacts_index (createdAt on PactLiveState)
// - Quoted: derived from pact.budget > 0 (no event indexed today, no time)
// - Funded: derived from on-chain status being Funded or beyond (no time)
// - Submitted / Completed / Rejected: pact_events table via getPactEvents
// Terminal states (Completed / Rejected) append a value-summary suffix so
// the timeline tells the whole story without a separate banner.
function buildLifecycle(
  pact: PactLiveState,
  events: PactEvent[],
  status: string,
): LifecycleRow[] {
  const rows: LifecycleRow[] = [];

  rows.push({
    label: 'Created',
    actorAddr: pact.client,
    when: pact.createdAt?.indexedAt,
    txHash: pact.createdAt?.txHash,
  });

  if (pact.budget.usdc !== '0') {
    rows.push({
      label: `Quoted ${pact.budget.usdc} USDC`,
      actorAddr: pact.provider,
    });
  }

  // Funded: prefer the indexed JobFunded event (timestamp + tx link).
  // Fall back to the derived row from on-chain status when the indexer
  // hasn't caught up - drops the timestamp but keeps the timeline coherent.
  const fundedEvent = events.find((e) => e.eventType === 'Funded');
  // A cancelled-from-Open pact hits status Rejected without ever being
  // Funded, so exclude that case from the fallback. Detect it by checking
  // whether the indexed Rejected event was emitted by the client.
  const rejectedEv = events.find((e) => e.eventType === 'Rejected');
  const wasClientCancellation =
    !!rejectedEv && rejectedEv.actor.toLowerCase() === pact.client.toLowerCase();
  const fundedFromStatus =
    pact.status === 'Funded' ||
    pact.status === 'Submitted' ||
    pact.status === 'Completed' ||
    (pact.status === 'Rejected' && !wasClientCancellation);
  if (fundedEvent) {
    const amountUsdc = fundedEvent.amountRaw
      ? formatUnits(BigInt(fundedEvent.amountRaw), 6)
      : pact.budget.usdc;
    rows.push({
      label: `Funded ${amountUsdc} USDC into escrow`,
      actorAddr: fundedEvent.actor,
      when: fundedEvent.indexedAt,
      txHash: fundedEvent.txHash,
    });
  } else if (fundedFromStatus) {
    rows.push({ label: `Funded ${pact.budget.usdc} USDC into escrow`, actorAddr: pact.client });
  }

  const submitted = events.find((e) => e.eventType === 'Submitted');
  if (submitted) {
    rows.push({
      label: 'Submitted a deliverable',
      actorAddr: submitted.actor,
      when: submitted.indexedAt,
      txHash: submitted.txHash,
    });
  }
  const completed = events.find((e) => e.eventType === 'Completed');
  if (completed) {
    rows.push({
      label: `Completed. ${pact.budget.usdc} USDC released to provider.`,
      actorAddr: completed.actor,
      when: completed.indexedAt,
      txHash: completed.txHash,
    });
  }
  if (rejectedEv) {
    // Same reject() function powers both client-cancellation (pact was
    // never funded) and evaluator-rejection (after a submission). Label
    // based on the actor so the timeline reads correctly.
    rows.push({
      label: wasClientCancellation
        ? `Cancelled by client. No funds were locked.`
        : `Rejected. Funds refunded to client.`,
      actorAddr: rejectedEv.actor,
      when: rejectedEv.indexedAt,
      txHash: rejectedEv.txHash,
    });
  }

  // Refund-claimed closes the story for pacts where the deadline lapsed and
  // someone (anyone) called claimRefund. Prefer the indexed Refunded event
  // (timestamp + tx link); fall back to a derived row when the indexer
  // hasn't caught up. The event's `client` field is the recipient - caller
  // identity isn't recoverable from the log, so the row label leans on
  // "returned to client" rather than a misleading "by @client".
  const refundedEvent = events.find((e) => e.eventType === 'Refunded');
  if (refundedEvent) {
    const amountUsdc = refundedEvent.amountRaw
      ? formatUnits(BigInt(refundedEvent.amountRaw), 6)
      : pact.budget.usdc;
    rows.push({
      label: `Refund of ${amountUsdc} USDC returned to client (deadline passed)`,
      when: refundedEvent.indexedAt,
      txHash: refundedEvent.txHash,
    });
  } else if (pact.status === 'Expired') {
    rows.push({
      label: `Refund of ${pact.budget.usdc} USDC returned to client (deadline passed)`,
    });
  }

  void status;
  return rows;
}

type ActionState =
  | { status: 'idle' }
  | { status: 'busy'; label: string }
  | { status: 'error'; message: string }
  | { status: 'success'; txHash: string };

// Read a File into a Uint8Array, compute keccak256 over the raw bytes, and
// base64-encode in chunks (sidesteps the call-stack limit on big files).
async function fileToBase64AndHash(file: File): Promise<{ base64: string; hash: Hex }> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const hash = keccak256(bytes);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return { base64: btoa(binary), hash };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export default function PactDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: pactId } = use(params);
  const signer = useSigner();
  const toast = useToast();
  // Allowance + any other Arc reads must stay pinned to Arc even if the
  // user just bridged and the wallet is sitting on Base / Sepolia / etc.
  const publicClient = usePublicClient({ chainId: arcTestnet.id });
  const wagmiChainId = useChainId();
  const { switchChain } = useSwitchChain();
  const isOffArc = signer.isConnected && signer.mode === 'external' && wagmiChainId !== arcTestnet.id;
  const [pact, setPact] = useState<PactLiveState | null>(null);
  const [events, setEvents] = useState<PactEvent[]>([]);
  const [loadingPact, setLoadingPact] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionState, setActionState] = useState<ActionState>({ status: 'idle' });
  // Cache of address → handle (or null if not registered). Populated when the
  // pact loads so client/provider/evaluator can render as "@handle" + address.
  const [handlesByAddress, setHandlesByAddress] = useState<Record<string, string | null>>({});
  // Cache of address → linked ERC-8004 agentId (or null). Drives the
  // ReputationBadge next to each party's address.
  const [agentIdsByAddress, setAgentIdsByAddress] = useState<Record<string, string | null>>({});

  // Form inputs for actions that need them.
  const [budgetInput, setBudgetInput] = useState('');
  const [deliverableType, setDeliverableType] = useState<DeliverableContentType>('url');
  const [deliverableInput, setDeliverableInput] = useState('');
  const [deliverableFile, setDeliverableFile] = useState<File | null>(null);
  // After a chain-submit succeeds, hold the (hash, content) pair so the user
  // can retry the off-chain upload without re-pasting if the upload step fails.
  // For files we keep the precomputed base64 + metadata so the retry path
  // never asks the user to re-pick the file.
  type PendingTextUrl = {
    pactId: string;
    hash: Hex;
    contentType: 'text' | 'url';
    content: string;
  };
  type PendingFile = {
    pactId: string;
    hash: Hex;
    contentType: 'file';
    fileName: string;
    mime: string;
    fileBase64: string;
  };
  const [pendingUpload, setPendingUpload] = useState<PendingTextUrl | PendingFile | null>(null);

  const [dispute, setDispute] = useState<DisputeState | null>(null);
  // Auto-reveal opt-in (default on) - when committing, also hand the agent the
  // secret so it reveals on the evaluator's behalf if they go offline.
  const [autoReveal, setAutoReveal] = useState(true);
  // Per-selected-evaluator dispute alignment, as a trust signal on the panel.
  const [evaluatorRep, setEvaluatorRep] = useState<
    Record<string, { alignment: number | null; totalVotes: number }>
  >({});

  const fetchPact = useCallback(async () => {
    setLoadingPact(true);
    setLoadError(null);
    try {
      const [live, evts] = await Promise.all([getPactState(pactId), getPactEvents(pactId)]);
      setPact(live);
      setEvents(evts);
      // Pull live dispute state only when one exists (disputeId 0 = none).
      if (live.disputeId && live.disputeId !== '0') {
        setDispute(await getDisputeState(pactId));
      } else {
        setDispute(null);
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingPact(false);
    }
  }, [pactId]);

  useEffect(() => {
    void fetchPact();
  }, [fetchPact]);

  // Resolve handles + agentIds for client/provider/evaluator when the pact
  // loads. Deduped + parallel; absent users cache as null so we don't
  // re-query. Pulls handle + agentId from the same UserRecord - one lookup
  // covers both displays (handle chip + reputation badge).
  useEffect(() => {
    if (!pact) return;
    const addresses = [pact.client, pact.provider, pact.evaluator]
      .map((a) => a.toLowerCase())
      .filter((a, i, arr) => arr.indexOf(a) === i);
    let cancelled = false;
    void Promise.all(
      addresses.map(async (addr) => {
        try {
          const user = await getUserByAddress(addr);
          return [addr, user?.handle ?? null, user?.agentId ?? null] as const;
        } catch {
          return [addr, null, null] as const;
        }
      }),
    ).then((results) => {
      if (cancelled) return;
      setHandlesByAddress((prev) => {
        const next = { ...prev };
        for (const [addr, handle] of results) next[addr] = handle;
        return next;
      });
      setAgentIdsByAddress((prev) => {
        const next = { ...prev };
        for (const [addr, , agentId] of results) next[addr] = agentId;
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [pact]);

  // Pull each selected evaluator's lifetime alignment once a dispute is in the
  // voting phase - shown on the panel so parties can gauge the jurors.
  useEffect(() => {
    if (!dispute || dispute.status !== 'Defended' || dispute.evaluators.length === 0) {
      setEvaluatorRep({});
      return;
    }
    let cancelled = false;
    void Promise.all(
      dispute.evaluators.map(async (addr) => {
        const key = addr.toLowerCase();
        try {
          const info = await getEvaluatorInfo(key);
          const alignment =
            info.totalVotes > 0 ? Math.round((info.majorityVotes / info.totalVotes) * 100) : null;
          return [key, { alignment, totalVotes: info.totalVotes }] as const;
        } catch {
          return [key, { alignment: null, totalVotes: 0 }] as const;
        }
      }),
    ).then((entries) => {
      if (!cancelled) setEvaluatorRep(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [dispute]);

  const status = useMemo(() => (pact ? effectiveStatus(pact, Date.now()) : null), [pact]);
  const roles = useMemo(
    () => (pact && signer.isConnected ? userRoles(pact, signer.address) : []),
    [pact, signer],
  );

  // Always-on lifecycle context - what's happening, what's next. Independent
  // of whether an action card renders for this user.
  const currentStep = useMemo(
    () => (pact && status ? describeCurrentStep(pact, status, roles) : null),
    [pact, status, roles],
  );

  // Read-only banner shown only when user has no role at all on this pact.
  const showReadOnlyNotice = signer.isConnected && roles.length === 0;

  const runAction = async (
    label: string,
    fn: () => Promise<{ txHash: string }>,
  ): Promise<boolean> => {
    setActionState({ status: 'busy', label });
    try {
      const { txHash } = await fn();
      setActionState({ status: 'success', txHash });
      toast.success(ACTION_TOAST[label] ?? 'Done');
      await fetchPact();
      return true;
    } catch (err) {
      setActionState({
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  };

  // Pre-flight: refuse the action if the deadline already passed. The reference
  // contract's chain-side check varies by function (fund + claimRefund check
  // it; setBudget / submit / complete / reject don't). For UX consistency we
  // block all "forward-progress" actions client-side so the user doesn't waste
  // gas on a tx that produces a useless state.
  const guardDeadline = (actionVerb: string): boolean => {
    if (!pact) return false;
    if (pact.expiredAt.unix * 1000 > Date.now()) return true;
    setActionState({
      status: 'error',
      message: `Deadline has passed. ${actionVerb} now would leave this pact in an unrecoverable state. The client needs to cancel and post a fresh pact with a longer deadline.`,
    });
    return false;
  };

  // Single action runner that builds an unsigned tx, sends it, waits.
  const sendUnsigned = async (label: string, builder: () => Promise<{ to: Hex; data: Hex; value: Hex }>) => {
    if (!signer.isConnected) throw new Error('Not connected');
    setActionState({ status: 'busy', label });
    const unsigned = await builder();
    const sent = await signer.sendCall({
      to: unsigned.to,
      data: unsigned.data,
      value: BigInt(unsigned.value),
    });
    const { txHash, status: txStatus } = await sent.wait();
    if (txStatus !== 'success') throw new Error(`Tx ${txStatus}`);
    return { txHash };
  };

  // Approve + fund. Skips approve if current allowance already covers the budget.
  // Pre-flight checks: pact exists, budget set, deadline still in the future.
  const fundPact = async () => {
    if (!signer.isConnected || !pact || !publicClient) return;
    const budgetRaw = BigInt(pact.budget.raw);
    if (budgetRaw === 0n) {
      setActionState({ status: 'error', message: 'Provider has not set a budget yet.' });
      return;
    }
    if (pact.expiredAt.unix * 1000 <= Date.now()) {
      setActionState({
        status: 'error',
        message:
          'Deadline has passed. The chain will refuse to fund this pact. Use "Cancel pact" to clean it up, or create a new pact with a longer deadline.',
      });
      return;
    }
    try {
      const allowance = await publicClient.readContract({
        address: USDC_ADDRESS,
        abi: erc20AllowanceAbi,
        functionName: 'allowance',
        args: [signer.address as Hex, WRAPPER_ADDRESS],
      });
      if (allowance < budgetRaw) {
        const approvedOk = await runAction('Approving USDC…', () =>
          sendUnsigned('Approving USDC…', () => buildApproveUnsigned(pact.budget.usdc)),
        );
        if (!approvedOk) return;
      }
      // Atomic acceptance - pass the current quote so the wrapper can reject a
      // mid-flight re-quote rather than silently funding stale terms.
      await runAction('Funding pact…', () =>
        sendUnsigned('Funding pact…', () =>
          buildFundUnsigned(pactId, pact.budget.usdc, pact.challengeWindow),
        ),
      );
    } catch (err) {
      setActionState({
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // Ensure the wrapper is approved for at least `raw` USDC before a bond/stake
  // pull. Returns false (and surfaces the error) if the approve step fails.
  const ensureAllowance = async (raw: bigint, usdc: string): Promise<boolean> => {
    if (!publicClient || !signer.isConnected) return false;
    const allowance = await publicClient.readContract({
      address: USDC_ADDRESS,
      abi: erc20AllowanceAbi,
      functionName: 'allowance',
      args: [signer.address as Hex, WRAPPER_ADDRESS],
    });
    if (allowance >= raw) return true;
    return runAction('Approving USDC…', () =>
      sendUnsigned('Approving USDC…', () => buildApproveUnsigned(usdc)),
    );
  };

  // Open a dispute (client or provider). Pulls a 5% bond - approve first.
  const openDispute = async () => {
    if (!pact) return;
    const bondRaw = (BigInt(pact.budget.raw) * DISPUTE_BOND_BPS) / 10000n;
    const bondUsdc = formatUnits(bondRaw, 6);
    try {
      if (!(await ensureAllowance(bondRaw, bondUsdc))) return;
      await runAction('Opening dispute…', () =>
        sendUnsigned('Opening dispute…', () => buildDisputeUnsigned(pactId)),
      );
    } catch (err) {
      setActionState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  // Defend a dispute (opponent posts a matching bond → evaluator vote).
  const defendDispute = async () => {
    if (!pact) return;
    const bondRaw = (BigInt(pact.budget.raw) * DISPUTE_BOND_BPS) / 10000n;
    const bondUsdc = formatUnits(bondRaw, 6);
    try {
      if (!(await ensureAllowance(bondRaw, bondUsdc))) return;
      await runAction('Defending…', () =>
        sendUnsigned('Defending…', () => buildDefendUnsigned(pactId)),
      );
    } catch (err) {
      setActionState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  // Evaluator commit: generate a secret, save it locally, commit the hash. If
  // auto-reveal is on, also hand the secret to the agent so it can reveal even
  // if this browser is closed during the reveal window.
  const commitVote = async (vote: VoteChoice) => {
    if (!pact || !dispute || !signer.isConnected) return;
    const secret = generateSecret();
    const hash = computeCommitHash(vote, secret, signer.address);
    saveVote(pactId, dispute.disputeId, signer.address, { vote, secret });
    const evaluator = signer.address;
    const disputeId = dispute.disputeId;
    const ok = await runAction('Committing vote…', () =>
      sendUnsigned('Committing vote…', () => buildCommitVoteUnsigned(pactId, hash)),
    );
    if (ok && autoReveal) {
      try {
        await registerAutoReveal(pactId, { disputeId, evaluator, vote, secret });
      } catch {
        // Non-fatal - the commit landed and the secret is saved locally, so the
        // evaluator can still reveal manually. Don't surface over the success.
      }
    }
  };

  // Evaluator reveal: replay the locally-stored vote + secret.
  const revealVote = async () => {
    if (!pact || !dispute || !signer.isConnected) return;
    const stored = loadVote(pactId, dispute.disputeId, signer.address);
    if (!stored) {
      setActionState({
        status: 'error',
        message: 'No saved vote found on this device - the secret was lost. Reveal must happen from the device that committed.',
      });
      return;
    }
    const ok = await runAction('Revealing vote…', () =>
      sendUnsigned('Revealing vote…', () =>
        buildRevealVoteUnsigned(pactId, signer.address, stored.vote, stored.secret),
      ),
    );
    if (ok) clearVote(pactId, dispute.disputeId, signer.address);
  };

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <header className="mb-6">
        <Link href="/pacts" className="text-xs text-neutral-500 hover:text-neutral-100">
          ← back to my pacts
        </Link>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">
          Pact <span className="font-mono">#{pactId}</span>
        </h1>
        {status && (
          <span
            className={`mt-2 inline-block rounded-md border px-2 py-0.5 text-xs ${STATUS_TINT[status] ?? 'bg-neutral-900 text-neutral-400 border-neutral-800'}`}
          >
            {status}
          </span>
        )}
      </header>

      {loadError && (
        <p className="rounded-lg border border-red-900/40 bg-red-950/20 px-3 py-2 text-xs text-red-400">
          Couldn&apos;t load this pact: {loadError}
        </p>
      )}

      {loadingPact && !pact && <p className="text-sm text-neutral-500">Loading…</p>}

      {pact && status && (
        <>
          {/* Live countdown banner - sits above Details so the time-pressure
              is the first thing the user sees. Hidden on terminal states
              where no deadline matters. Label adapts to the connected user's
              role: "Time to fund / submit / review / cancel" when it's their
              turn, generic "Deadline" otherwise. */}
          {status !== 'Completed' && status !== 'Rejected' && pact.status !== 'Expired' && (
            <CountdownBanner
              unix={pact.expiredAt.unix}
              label={(() => {
                const verb = actionVerbForMe(pact, status, roles);
                if (verb) return `Time to ${verb}`;
                return status === 'Expired' ? 'Past deadline' : 'Deadline';
              })()}
            />
          )}

          <section className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-5">
            <h2 className="text-sm font-medium text-neutral-300">Details</h2>
            <dl className="mt-3 space-y-2 text-sm">
              <Detail label="Description" value={pact.description || <em className="text-neutral-500">(none)</em>} />
              <Detail label="Budget" value={`${pact.budget.usdc} USDC`} />
              <Detail
                label="Client"
                value={
                  <Mono
                    addr={pact.client}
                    you={signer.address}
                    handle={handlesByAddress[pact.client.toLowerCase()]}
                    agentId={agentIdsByAddress[pact.client.toLowerCase()]}
                  />
                }
              />
              <Detail
                label="Provider"
                value={
                  <Mono
                    addr={pact.provider}
                    you={signer.address}
                    handle={handlesByAddress[pact.provider.toLowerCase()]}
                    agentId={agentIdsByAddress[pact.provider.toLowerCase()]}
                  />
                }
              />
              <Detail
                label="Evaluator"
                value={
                  <Mono
                    addr={pact.evaluator}
                    you={signer.address}
                    handle={handlesByAddress[pact.evaluator.toLowerCase()]}
                    agentId={agentIdsByAddress[pact.evaluator.toLowerCase()]}
                  />
                }
              />
            </dl>
            {roles.length > 0 && (
              <p className="mt-3 text-xs text-neutral-400">
                You are: <span className="text-neutral-200">{roles.join(', ')}</span>
              </p>
            )}

            <OnChainRecord events={events} liveStatus={pact.status} handlesByAddress={handlesByAddress} />
          </section>

          <DeliverableContent
            pactId={pactId}
            events={events}
            isParty={roles.length > 0}
            signer={signer}
          />

          {!signer.isConnected && (
            <p className="mt-6 rounded-xl border border-amber-900/40 bg-amber-950/20 p-4 text-sm text-amber-200">
              Connect to act on this pact.{' '}
              <Link href="/" className="underline">
                Sign in
              </Link>
            </p>
          )}

          {signer.isConnected && status && (
            <section className="mt-6 rounded-2xl border border-neutral-800 bg-neutral-900/40 p-5">
              <h2 className="text-sm font-medium text-neutral-300">Actions</h2>

              <LifecyclePanel
                rows={buildLifecycle(pact, events, status)}
                waitingLine={currentStep}
                effectiveStatus={status}
                handlesByAddress={handlesByAddress}
                youAddress={signer.address}
              />

              {showReadOnlyNotice && (
                <p className="mt-3 text-xs text-neutral-500">Read-only. You&apos;re not a party on this pact.</p>
              )}

              {!showReadOnlyNotice && isOffArc && (
                <div className="mt-4 rounded-xl border border-amber-700/40 bg-amber-950/20 p-3">
                  <p className="text-sm text-amber-200">Switch to Arc to take action on this pact.</p>
                  <p className="mt-1 text-xs text-amber-200/70">
                    Your wallet is on a different network. Fund, submit, and complete must be signed on Arc.
                  </p>
                  <button
                    type="button"
                    onClick={() => switchChain({ chainId: arcTestnet.id })}
                    className="mt-3 rounded-lg bg-amber-200 px-3 py-1.5 text-xs font-medium text-amber-950 hover:bg-amber-100"
                  >
                    Switch to Arc
                  </button>
                </div>
              )}


              <div
                className={`mt-4 space-y-4 ${isOffArc ? 'pointer-events-none opacity-50' : ''}`}
              >
                {/* setBudget - provider only, while Open */}
                {roles.includes('provider') && status === 'Open' && (
                  <ActionCard
                    title="Set or update your quote"
                    hint={
                      pact.budget.usdc === '0'
                        ? 'Quote a price in USDC.'
                        : `Current quote: ${pact.budget.usdc} USDC. Re-quote any time.`
                    }
                  >
                    <div className="flex gap-2">
                      <input
                        type="text"
                        inputMode="decimal"
                        value={budgetInput}
                        onChange={(e) => setBudgetInput(e.target.value)}
                        placeholder={pact.budget.usdc === '0' ? '0.1' : pact.budget.usdc}
                        className="flex-1 rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          if (!guardDeadline('Quoting')) return;
                          void runAction('Setting budget…', () =>
                            sendUnsigned('Setting budget…', () =>
                              buildSetBudgetUnsigned(pactId, budgetInput.trim() || '0'),
                            ),
                          );
                        }}
                        disabled={
                          actionState.status === 'busy' ||
                          !budgetInput.trim() ||
                          Number(budgetInput) <= 0
                        }
                        className="rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-950 hover:bg-white disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
                      >
                        Set budget
                      </button>
                    </div>
                  </ActionCard>
                )}

                {/* fund - client only, while Open + budget set + deadline not yet passed */}
                {roles.includes('client') && status === 'Open' && (
                  <ActionCard
                    title="Fund the pact"
                    hint={
                      pact.budget.usdc === '0'
                        ? 'Waiting on the provider to quote.'
                        : `Locks ${pact.budget.usdc} USDC into escrow.`
                    }
                  >
                    <button
                      type="button"
                      onClick={fundPact}
                      disabled={actionState.status === 'busy' || pact.budget.usdc === '0'}
                      className="rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-950 hover:bg-white disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
                    >
                      Fund {pact.budget.usdc} USDC
                    </button>
                  </ActionCard>
                )}

                {/* cancel - client withdraws an Open (unfunded) pact via the
                    wrapper's cancel(). reject() is the Funded/Submitted refund
                    path and reverts on Open, so these are deliberately distinct. */}
                {roles.includes('client') && pact.status === 'Open' && (
                  <ActionCard
                    title="Cancel pact"
                    hint={
                      pact.expiredAt.unix * 1000 <= Date.now()
                        ? 'Closes an expired pact so you can repost.'
                        : 'Cancels before anyone funds it.'
                    }
                  >
                    <button
                      type="button"
                      onClick={() =>
                        runAction('Cancelling…', () =>
                          sendUnsigned('Cancelling…', () => buildCancelUnsigned(pactId)),
                        )
                      }
                      disabled={actionState.status === 'busy'}
                      className="rounded-lg border border-neutral-700 px-4 py-2 text-sm font-medium text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
                    >
                      Cancel pact
                    </button>
                  </ActionCard>
                )}

                {/* submit - provider only, while Funded.
                    Two-phase: commit hash on-chain, then upload content
                    off-chain (parties-only read). Upload-only retry surface
                    appears if the off-chain step fails after the chain step
                    succeeds. */}
                {roles.includes('provider') && status === 'Funded' && (
                  <ActionCard
                    title="Submit deliverable"
                    hint="Hash committed on-chain. Content visible to parties only."
                  >
                    <div className="space-y-3">
                      <div className="flex gap-2 text-xs">
                        {(['url', 'text', 'file'] as DeliverableContentType[]).map((t) => (
                          <label
                            key={t}
                            className={`cursor-pointer rounded-md border px-3 py-1.5 ${
                              deliverableType === t
                                ? 'border-neutral-400 bg-neutral-800 text-neutral-100'
                                : 'border-neutral-800 bg-neutral-950 text-neutral-400'
                            }`}
                          >
                            <input
                              type="radio"
                              name="deliverable-type"
                              value={t}
                              checked={deliverableType === t}
                              onChange={() => setDeliverableType(t)}
                              className="sr-only"
                            />
                            {t === 'url' ? 'URL' : t === 'text' ? 'Text' : 'File'}
                          </label>
                        ))}
                      </div>
                      {deliverableType === 'url' && (
                        <input
                          type="url"
                          value={deliverableInput}
                          onChange={(e) => setDeliverableInput(e.target.value)}
                          placeholder="https://…"
                          className="w-full rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
                        />
                      )}
                      {deliverableType === 'text' && (
                        <textarea
                          value={deliverableInput}
                          onChange={(e) => setDeliverableInput(e.target.value)}
                          placeholder="Paste your deliverable text…"
                          rows={5}
                          className="w-full rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
                        />
                      )}
                      {deliverableType === 'file' && (
                        <div className="space-y-2">
                          <input
                            type="file"
                            onChange={(e) => setDeliverableFile(e.target.files?.[0] ?? null)}
                            className="block w-full text-xs text-neutral-300 file:mr-3 file:rounded-md file:border-0 file:bg-neutral-800 file:px-3 file:py-1.5 file:text-neutral-100 hover:file:bg-neutral-700"
                          />
                          {deliverableFile && (
                            <p className="text-xs text-neutral-500">
                              {deliverableFile.name} · {formatBytes(deliverableFile.size)}
                            </p>
                          )}
                          <p className="text-xs text-neutral-600">Max 10 MB.</p>
                        </div>
                      )}
                      <div className="flex justify-end">
                        <button
                          type="button"
                          onClick={() => {
                            if (!guardDeadline('Submitting')) return;
                            if (!signer.isConnected) return;

                            void (async () => {
                              try {
                                let hash: Hex;
                                let onchainTxHash: string;
                                let upload: () => Promise<void>;
                                let retry: PendingTextUrl | PendingFile;

                                if (deliverableType === 'file') {
                                  if (!deliverableFile) {
                                    setActionState({ status: 'error', message: 'Pick a file first.' });
                                    return;
                                  }
                                  if (deliverableFile.size > 10 * 1024 * 1024) {
                                    setActionState({ status: 'error', message: 'File exceeds 10 MB.' });
                                    return;
                                  }
                                  setActionState({ status: 'busy', label: 'Hashing file…' });
                                  const { base64, hash: fileHash } = await fileToBase64AndHash(deliverableFile);
                                  hash = fileHash;
                                  const fileName = deliverableFile.name;
                                  const mime = deliverableFile.type || 'application/octet-stream';
                                  retry = { pactId, hash, contentType: 'file', fileName, mime, fileBase64: base64 };
                                  upload = async () => {
                                    await uploadDeliverableFile({
                                      pactId,
                                      fileName,
                                      mime,
                                      fileBase64: base64,
                                      expectedHash: hash,
                                      uploadedBy: signer.address,
                                    });
                                  };
                                } else {
                                  const content = deliverableInput.trim();
                                  if (!content) {
                                    setActionState({ status: 'error', message: 'Content is required.' });
                                    return;
                                  }
                                  hash = keccak256(stringToBytes(content));
                                  retry = { pactId, hash, contentType: deliverableType, content };
                                  upload = async () => {
                                    await uploadDeliverableContent({
                                      pactId,
                                      contentType: deliverableType,
                                      content,
                                      expectedHash: hash,
                                      uploadedBy: signer.address,
                                    });
                                  };
                                }

                                setActionState({ status: 'busy', label: 'Submitting on-chain…' });
                                const onchain = await sendUnsigned(
                                  'Submitting on-chain…',
                                  () => buildSubmitUnsigned(pactId, hash),
                                );
                                // eslint-disable-next-line prefer-const -- must stay `let`: declared in the outer scope so it's readable in the catch block below
                                onchainTxHash = onchain.txHash;

                                setActionState({ status: 'busy', label: 'Uploading content…' });
                                try {
                                  await upload();
                                  setPendingUpload(null);
                                  setDeliverableInput('');
                                  setDeliverableFile(null);
                                  setActionState({ status: 'success', txHash: onchainTxHash });
                                  toast.success('Deliverable submitted');
                                  await fetchPact();
                                } catch (uploadErr) {
                                  setPendingUpload(retry);
                                  setActionState({
                                    status: 'error',
                                    message: `On-chain submit succeeded (tx ${onchainTxHash}) but content upload failed: ${
                                      uploadErr instanceof Error ? uploadErr.message : String(uploadErr)
                                    }. The hash is committed; use Retry upload below.`,
                                  });
                                  await fetchPact();
                                }
                              } catch (err) {
                                setActionState({
                                  status: 'error',
                                  message: err instanceof Error ? err.message : String(err),
                                });
                              }
                            })();
                          }}
                          disabled={
                            actionState.status === 'busy' ||
                            (deliverableType === 'file' ? !deliverableFile : !deliverableInput.trim())
                          }
                          className="rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-950 hover:bg-white disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
                        >
                          Submit
                        </button>
                      </div>
                    </div>
                  </ActionCard>
                )}

                {/* Retry-upload surface - chain submit landed, off-chain
                    upload didn't. Provider can re-run the upload step
                    without re-signing on-chain. */}
                {roles.includes('provider') && pendingUpload && pendingUpload.pactId === pactId && (
                  <ActionCard
                    title="Retry upload"
                    hint={`Hash ${pendingUpload.hash.slice(0, 10)}… already on-chain.`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        if (!signer.isConnected || !pendingUpload) return;
                        const retry = pendingUpload;
                        void (async () => {
                          setActionState({ status: 'busy', label: 'Uploading content…' });
                          try {
                            if (retry.contentType === 'file') {
                              await uploadDeliverableFile({
                                pactId: retry.pactId,
                                fileName: retry.fileName,
                                mime: retry.mime,
                                fileBase64: retry.fileBase64,
                                expectedHash: retry.hash,
                                uploadedBy: signer.address,
                              });
                            } else {
                              await uploadDeliverableContent({
                                pactId: retry.pactId,
                                contentType: retry.contentType,
                                content: retry.content,
                                expectedHash: retry.hash,
                                uploadedBy: signer.address,
                              });
                            }
                            setPendingUpload(null);
                            setActionState({ status: 'success', txHash: '0x' as Hex });
                            await fetchPact();
                          } catch (err) {
                            setActionState({
                              status: 'error',
                              message: err instanceof Error ? err.message : String(err),
                            });
                          }
                        })();
                      }}
                      disabled={actionState.status === 'busy'}
                      className="rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-950 hover:bg-white disabled:opacity-50"
                    >
                      Retry upload
                    </button>
                  </ActionCard>
                )}

                {/* Submitted - challenge-window status banner. */}
                {pact.status === 'Submitted' && (
                  <div className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-3 text-xs text-neutral-400">
                    {Math.floor(Date.now() / 1000) < pact.submittedAt + pact.challengeWindow ? (
                      <span className="inline-flex flex-wrap items-center gap-1.5">
                        Challenge window closes
                        <CountdownChip unix={pact.submittedAt + pact.challengeWindow} />
                        - either party can dispute until then; the client can accept early.
                      </span>
                    ) : (
                      <>Challenge window closed - anyone can finalize to release the budget to the provider.</>
                    )}
                  </div>
                )}

                {/* Accept & release - client only, while Submitted (instant payout). */}
                {roles.includes('client') && pact.status === 'Submitted' && (
                  <ActionCard
                    title="Accept & release"
                    hint="Pays the provider now, skipping the rest of the challenge window."
                  >
                    <button
                      type="button"
                      onClick={() =>
                        runAction('Releasing…', () =>
                          sendUnsigned('Releasing…', () => buildCompleteUnsigned(pactId)),
                        )
                      }
                      disabled={actionState.status === 'busy'}
                      className="rounded-lg bg-emerald-700/60 px-4 py-2 text-sm font-medium text-neutral-100 hover:bg-emerald-700/90 disabled:opacity-50"
                    >
                      Accept &amp; release
                    </button>
                  </ActionCard>
                )}

                {/* Reject & refund - client only, while Funded or Submitted. */}
                {roles.includes('client') &&
                  (pact.status === 'Funded' || pact.status === 'Submitted') && (
                    <ActionCard
                      title="Reject &amp; refund"
                      hint="Returns the budget to you. The platform fee taken at funding is retained."
                    >
                      <button
                        type="button"
                        onClick={() =>
                          runAction('Rejecting…', () =>
                            sendUnsigned('Rejecting…', () => buildRejectUnsigned(pactId)),
                          )
                        }
                        disabled={actionState.status === 'busy'}
                        className="rounded-lg bg-red-700/60 px-4 py-2 text-sm font-medium text-neutral-100 hover:bg-red-700/90 disabled:opacity-50"
                      >
                        Reject &amp; refund
                      </button>
                    </ActionCard>
                  )}

                {/* Dispute - client or provider, while Submitted + within window. */}
                {(roles.includes('client') || roles.includes('provider')) &&
                  pact.status === 'Submitted' &&
                  Math.floor(Date.now() / 1000) < pact.submittedAt + pact.challengeWindow && (
                    <ActionCard
                      title="Dispute the deliverable"
                      hint="Posts a 5% bond and freezes the payout. The other side can concede or defend; if defended, staked evaluators vote."
                    >
                      <button
                        type="button"
                        onClick={() => void openDispute()}
                        disabled={actionState.status === 'busy'}
                        className="rounded-lg bg-orange-700/60 px-4 py-2 text-sm font-medium text-neutral-100 hover:bg-orange-700/90 disabled:opacity-50"
                      >
                        Open dispute
                      </button>
                    </ActionCard>
                  )}

                {/* Finalize - anyone, while Submitted + challenge window closed. */}
                {pact.status === 'Submitted' &&
                  Math.floor(Date.now() / 1000) >= pact.submittedAt + pact.challengeWindow && (
                    <ActionCard
                      title="Finalize (challenge window closed)"
                      hint="No dispute was raised - release the budget to the provider. Anyone can trigger."
                    >
                      <button
                        type="button"
                        onClick={() =>
                          runAction('Finalizing…', () =>
                            sendUnsigned('Finalizing…', () => buildFinalizeUnsigned(pactId)),
                          )
                        }
                        disabled={actionState.status === 'busy'}
                        className="rounded-lg bg-emerald-700/60 px-4 py-2 text-sm font-medium text-neutral-100 hover:bg-emerald-700/90 disabled:opacity-50"
                      >
                        Finalize
                      </button>
                    </ActionCard>
                  )}

                {/* Disputed - the full dispute panel. */}
                {pact.status === 'Disputed' && dispute && (
                  <DisputePanel
                    dispute={dispute}
                    evaluatorRep={evaluatorRep}
                    signerAddress={signer.isConnected ? signer.address.toLowerCase() : undefined}
                    busy={actionState.status === 'busy'}
                    onConcede={() =>
                      void runAction('Conceding…', () =>
                        sendUnsigned('Conceding…', () => buildConcedeUnsigned(pactId)),
                      )
                    }
                    onDefend={() => void defendDispute()}
                    onForceConcede={() =>
                      void runAction('Force-settling…', () =>
                        sendUnsigned('Force-settling…', () => buildForceConcedeUnsigned(pactId)),
                      )
                    }
                    onCommit={(vote) => void commitVote(vote)}
                    autoReveal={autoReveal}
                    onToggleAutoReveal={setAutoReveal}
                    onReveal={() => void revealVote()}
                    onResolve={() =>
                      void runAction('Resolving…', () =>
                        sendUnsigned('Resolving…', () => buildResolveUnsigned(pactId)),
                      )
                    }
                    hasStoredVote={
                      signer.isConnected
                        ? loadVote(pactId, dispute.disputeId, signer.address) !== null
                        : false
                    }
                  />
                )}

                {/* claimRefund - anyone, when deadline passed + pact is Funded/Submitted
                    + no open dispute (the wrapper reverts claimRefund mid-dispute). */}
                {status === 'Expired' &&
                  (pact.status === 'Funded' || pact.status === 'Submitted') &&
                  pact.disputeId === '0' && (
                    <ActionCard
                      title="Claim refund (deadline passed)"
                      hint="Anyone can trigger; funds go to the client."
                    >
                      <button
                        type="button"
                        onClick={() =>
                          runAction('Claiming refund…', () =>
                            sendUnsigned('Claiming refund…', () => buildRefundUnsigned(pactId)),
                          )
                        }
                        disabled={actionState.status === 'busy'}
                        className="rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-950 hover:bg-white disabled:opacity-50"
                      >
                        Claim refund
                      </button>
                    </ActionCard>
                  )}

              </div>

              {/* Action status surface */}
              <div className="mt-4 border-t border-neutral-800 pt-3 text-xs">
                {actionState.status === 'busy' && (
                  <p className="text-neutral-300">{actionState.label}</p>
                )}
                {actionState.status === 'success' && (
                  <p className="text-emerald-400 break-words">
                    ✓ Done.{' '}
                    <a
                      href={arcExplorerTxUrl(actionState.txHash)}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono underline"
                    >
                      View tx
                    </a>
                  </p>
                )}
                {actionState.status === 'error' && (
                  <p className="text-red-400 break-words">{actionState.message}</p>
                )}
              </div>
            </section>
          )}
        </>
      )}
    </main>
  );
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  // Stack label above value under sm so long addresses + descriptions get
  // the full width instead of being squeezed into the ~140px that's left
  // after the 8rem label column on a phone.
  return (
    <div className="grid grid-cols-1 gap-0.5 text-sm sm:grid-cols-[8rem_1fr] sm:gap-2">
      <dt className="text-neutral-500">{label}</dt>
      <dd className="text-neutral-200 break-words">{value}</dd>
    </div>
  );
}

function ReputationBadge({ agentId }: { agentId: string }) {
  const [data, setData] = useState<ReputationSummary | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getReputationSummary(agentId)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  if (error) return null;
  if (!data) {
    return (
      <Link
        href={`/reputation/agent/${encodeURIComponent(agentId)}`}
        onClick={(e) => e.stopPropagation()}
        className="ml-2 rounded bg-neutral-800 px-1.5 py-0.5 not-italic font-sans text-neutral-500"
      >
        #{agentId}
      </Link>
    );
  }
  const formatted =
    data.summary.count > 0
      ? formatReputationValue(data.summary.value, data.summary.valueDecimals)
      : null;
  return (
    <Link
      href={`/reputation/agent/${encodeURIComponent(agentId)}`}
      onClick={(e) => e.stopPropagation()}
      className="ml-2 rounded bg-amber-950/40 px-1.5 py-0.5 not-italic font-sans text-amber-300 hover:bg-amber-900/40"
      title={`agent #${agentId} · ${data.summary.count} feedback${data.summary.count === 1 ? '' : 's'}`}
    >
      {formatted ? `★ ${formatted}` : '★ new'}
      <span className="ml-1 text-amber-500/80">({data.summary.count})</span>
    </Link>
  );
}

function Mono({
  addr,
  you,
  handle,
  agentId,
}: {
  addr: string;
  you?: string;
  handle?: string | null;
  agentId?: string | null;
}) {
  const isYou = you && addr.toLowerCase() === you.toLowerCase();
  return (
    <span className="font-mono text-xs">
      {addr}
      {handle && (
        <span className="ml-2 rounded bg-neutral-800 px-1.5 py-0.5 not-italic text-neutral-200 font-sans">
          @{handle}
        </span>
      )}
      {agentId && <ReputationBadge agentId={agentId} />}
      {isYou && (
        <span className="ml-2 rounded bg-neutral-800 px-1.5 py-0.5 text-neutral-300 font-sans">
          you
        </span>
      )}
    </span>
  );
}

function LifecyclePanel({
  rows,
  waitingLine,
  effectiveStatus,
  handlesByAddress,
  youAddress,
}: {
  rows: LifecycleRow[];
  waitingLine: string | null;
  effectiveStatus: string;
  handlesByAddress: Record<string, string | null>;
  youAddress?: string;
}) {
  const tint = LIFECYCLE_TINT[effectiveStatus] ?? DEFAULT_LIFECYCLE_TINT;
  return (
    <div className="mt-3 space-y-2.5 rounded-xl border border-neutral-800 bg-neutral-950/40 p-4">
      {rows.map((row, i) => {
        const handle = row.actorAddr
          ? (handlesByAddress[row.actorAddr.toLowerCase()] ?? null)
          : null;
        const hasMeta = !!row.actorAddr || !!row.when || !!row.txHash;
        return (
          <div key={i} className="flex items-start gap-2 text-sm">
            <span className="mt-0.5 text-emerald-500">✓</span>
            <div className="min-w-0 flex-1">
              <p className="text-neutral-100">{row.label}</p>
              {hasMeta && (
                <p className="text-xs text-neutral-500">
                  {row.actorAddr && (
                    <>
                      by <Actor addr={row.actorAddr} handle={handle} you={youAddress} />
                    </>
                  )}
                  {row.when && (
                    <>
                      {row.actorAddr ? ' · ' : ''}
                      {timeAgo(row.when)}
                    </>
                  )}
                  {row.txHash && (
                    <a
                      href={arcExplorerTxUrl(row.txHash)}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-2 text-neutral-600 underline hover:text-neutral-400"
                      onClick={(e) => e.stopPropagation()}
                    >
                      view tx
                    </a>
                  )}
                </p>
              )}
            </div>
          </div>
        );
      })}

      {waitingLine && (
        <div className="flex items-start gap-2 border-t border-neutral-800/60 pt-2.5 text-sm">
          <span className="relative mt-1.5 flex h-2 w-2">
            <span
              className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${tint.ping}`}
            />
            <span
              className={`relative inline-flex h-2 w-2 rounded-full ${tint.solid}`}
            />
          </span>
          <p className={`animate-pulse ${tint.text}`}>{waitingLine}</p>
        </div>
      )}
    </div>
  );
}

function Actor({
  addr,
  handle,
  you,
}: {
  addr: string;
  handle?: string | null;
  you?: string;
}) {
  const isYou = !!you && addr.toLowerCase() === you.toLowerCase();
  if (handle) {
    return (
      <span className="text-neutral-300">
        @{handle}
        {isYou && <span className="ml-1 text-neutral-500">(you)</span>}
      </span>
    );
  }
  return (
    <span className="font-mono text-neutral-300">
      {addr.slice(0, 6)}…{addr.slice(-4)}
      {isYou && <span className="ml-1 text-neutral-500">(you)</span>}
    </span>
  );
}

function DeliverableContent({
  pactId,
  events,
  isParty,
  signer,
}: {
  pactId: string;
  events: PactEvent[];
  isParty: boolean;
  signer: ReturnType<typeof useSigner>;
}) {
  const submittedEvent = useMemo(
    () => events.find((e) => e.eventType === 'Submitted'),
    [events],
  );

  const [content, setContent] = useState<Deliverable | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [needsUnlock, setNeedsUnlock] = useState(false);

  // File downloads need their own state: the metadata alone can't be hashed
  // against the on-chain commitment - we only know the commitment matches
  // after fetching the bytes and recomputing client-side.
  type FileState =
    | { status: 'idle' }
    | { status: 'downloading' }
    | { status: 'verified' }
    | { status: 'mismatch' }
    | { status: 'error'; message: string };
  const [fileState, setFileState] = useState<FileState>({ status: 'idle' });

  // The hash claimed on-chain; null until indexer catches up.
  const onchainHash = submittedEvent?.hashValue ?? null;

  // Client-side hash verification for text/url. Files verify on download
  // (see downloadAndVerify); the metadata view can't prove the bytes match.
  const hashMatches = useMemo(() => {
    if (!content || !onchainHash) return null;
    if (content.contentType === 'file') return null;
    const recomputed = keccak256(stringToBytes(content.textContent));
    return recomputed.toLowerCase() === onchainHash.toLowerCase();
  }, [content, onchainHash]);

  const loadContent = useCallback(async () => {
    if (!signer.isConnected || !submittedEvent) return;
    setLoading(true);
    setError(null);
    try {
      const auth = await getOrCreateReadAuth(
        pactId,
        signer.address,
        signer.signMessage,
      );
      const fetched = await getDeliverable(pactId, submittedEvent.hashValue, auth);
      setContent(fetched);
      setNeedsUnlock(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [pactId, signer, submittedEvent]);

  const downloadAndVerify = useCallback(async () => {
    if (
      !signer.isConnected ||
      !content ||
      content.contentType !== 'file' ||
      !submittedEvent ||
      !onchainHash
    ) {
      return;
    }
    setFileState({ status: 'downloading' });
    try {
      const auth = await getOrCreateReadAuth(pactId, signer.address, signer.signMessage);
      const blob = await getDeliverableFile(pactId, submittedEvent.hashValue, auth);
      const buf = await blob.arrayBuffer();
      const recomputed = keccak256(new Uint8Array(buf));
      if (recomputed.toLowerCase() !== onchainHash.toLowerCase()) {
        setFileState({ status: 'mismatch' });
        return;
      }
      // Trigger browser download only after the hash matches.
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = content.textContent;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setFileState({ status: 'verified' });
    } catch (err) {
      setFileState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }, [content, pactId, signer, submittedEvent, onchainHash]);

  // On mount / when becoming a party: if a cached signature exists, auto-load.
  // Otherwise surface an explicit "Unlock" button so the user understands
  // why a wallet popup is about to appear.
  useEffect(() => {
    if (!isParty || !signer.isConnected || !submittedEvent) return;
    if (typeof window === 'undefined') return;
    const cacheKey = `arc:deliv-sig:${pactId}:${signer.address.toLowerCase()}`;
    if (localStorage.getItem(cacheKey)) {
      void loadContent();
    } else {
      setNeedsUnlock(true);
    }
  }, [isParty, signer.isConnected, signer.address, submittedEvent, pactId, loadContent]);

  if (!submittedEvent) return null;

  return (
    <section className="mt-6 rounded-2xl border border-neutral-800 bg-neutral-900/40 p-5">
      <h2 className="text-sm font-medium text-neutral-300">Deliverable content</h2>

      {!signer.isConnected && (
        <p className="mt-3 text-xs text-neutral-500">Parties only. Connect to view.</p>
      )}

      {signer.isConnected && !isParty && (
        <p className="mt-3 text-xs text-neutral-500">Parties only.</p>
      )}

      {signer.isConnected && isParty && needsUnlock && !content && (
        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            onClick={() => void loadContent()}
            disabled={loading}
            className="rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-950 hover:bg-white disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
          >
            {loading ? 'Waiting for signature…' : 'Unlock'}
          </button>
          <span className="text-xs text-neutral-500">One sig, cached ~24h.</span>
        </div>
      )}

      {loading && !needsUnlock && (
        <p className="mt-3 text-xs text-neutral-400">Loading…</p>
      )}

      {error && (
        <div className="mt-3 rounded-lg border border-red-900/40 bg-red-950/20 px-3 py-2 text-xs text-red-300">
          <p>{error}</p>
          <button
            type="button"
            onClick={() => void loadContent()}
            className="mt-2 text-red-200 underline"
          >
            Try again
          </button>
        </div>
      )}

      {content && (
        <div className="mt-3 space-y-3">
          <div className="flex items-center gap-2 text-xs">
            {content.contentType === 'file' ? (
              <span
                className={`rounded-md border px-2 py-0.5 ${
                  fileState.status === 'verified'
                    ? 'border-emerald-900/60 bg-emerald-950/40 text-emerald-300'
                    : fileState.status === 'mismatch'
                      ? 'border-red-900/60 bg-red-950/40 text-red-300'
                      : 'border-neutral-800 bg-neutral-900 text-neutral-400'
                }`}
              >
                {fileState.status === 'verified'
                  ? '✓ Hash verified'
                  : fileState.status === 'mismatch'
                    ? '✗ Hash mismatch'
                    : 'Unverified until download'}
              </span>
            ) : (
              <span
                className={`rounded-md border px-2 py-0.5 ${
                  hashMatches
                    ? 'border-emerald-900/60 bg-emerald-950/40 text-emerald-300'
                    : 'border-red-900/60 bg-red-950/40 text-red-300'
                }`}
              >
                {hashMatches ? '✓ Hash verified' : '✗ Hash mismatch'}
              </span>
            )}
            <span className="text-neutral-500">
              {content.contentType === 'url' ? 'URL' : content.contentType === 'text' ? 'Text' : 'File'}
            </span>
          </div>

          {content.contentType === 'url' && (
            <a
              href={content.textContent}
              target="_blank"
              rel="noreferrer"
              className="block break-all rounded-lg border border-neutral-800 bg-neutral-950/40 p-3 font-mono text-xs text-sky-300 underline hover:text-sky-200"
            >
              {content.textContent}
            </a>
          )}

          {content.contentType === 'text' && (
            <pre className="whitespace-pre-wrap rounded-lg border border-neutral-800 bg-neutral-950/40 p-3 text-xs text-neutral-200">
              {content.textContent}
            </pre>
          )}

          {content.contentType === 'file' && (
            <div className="rounded-lg border border-neutral-800 bg-neutral-950/40 p-3 text-xs">
              <p className="font-mono text-neutral-200 break-all">{content.textContent}</p>
              <p className="mt-1 text-neutral-500">
                {content.mime ?? 'application/octet-stream'}
                {content.sizeBytes != null && ` · ${formatBytes(content.sizeBytes)}`}
              </p>
              <div className="mt-3 flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => void downloadAndVerify()}
                  disabled={fileState.status === 'downloading'}
                  className="rounded-lg bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-950 hover:bg-white disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
                >
                  {fileState.status === 'downloading' ? 'Downloading…' : 'Download & verify'}
                </button>
                {fileState.status === 'error' && (
                  <span className="text-red-300">{fileState.message}</span>
                )}
              </div>
            </div>
          )}

          <p className="text-xs text-neutral-500">
            By <span className="font-mono">{content.uploadedBy.slice(0, 6)}…{content.uploadedBy.slice(-4)}</span>{' '}
            · {new Date(content.uploadedAt).toLocaleString()}
          </p>
        </div>
      )}
    </section>
  );
}

function OnChainRecord({
  events,
  liveStatus,
  handlesByAddress,
}: {
  events: PactEvent[];
  liveStatus: string;
  handlesByAddress: Record<string, string | null>;
}) {
  // This section is the "what hash was committed on-chain" view. Funded
  // and Refunded events carry an amount instead of a hash and show up in
  // the lifecycle timeline above; filter them out here.
  type HashEventType = 'Submitted' | 'Completed' | 'Rejected';
  const hashEvents = events.filter(
    (e): e is PactEvent & { eventType: HashEventType } =>
      e.eventType === 'Submitted' ||
      e.eventType === 'Completed' ||
      e.eventType === 'Rejected',
  );
  // Pacts at Open/Funded have nothing to show. For Submitted/Completed/Rejected,
  // if no event row has indexed yet (~10s lag), show a soft hint instead of
  // hiding the section entirely.
  const expectsRecord =
    liveStatus === 'Submitted' || liveStatus === 'Completed' || liveStatus === 'Rejected';
  if (hashEvents.length === 0 && !expectsRecord) return null;

  const labels: Record<HashEventType, { title: string; hashLabel: string }> = {
    Submitted: { title: 'Submitted', hashLabel: 'Deliverable hash' },
    Completed: { title: 'Completed', hashLabel: 'Reason hash' },
    Rejected: { title: 'Rejected', hashLabel: 'Reason hash' },
  };

  return (
    <div className="mt-5 border-t border-neutral-800 pt-4">
      <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
        On-chain record
      </h3>
      {hashEvents.length === 0 ? (
        <p className="mt-2 text-xs text-neutral-500">Indexing the event from chain…</p>
      ) : (
        <ul className="mt-2 space-y-3">
          {hashEvents.map((e) => {
            const handle = handlesByAddress[e.actor.toLowerCase()];
            const { title, hashLabel } = labels[e.eventType];
            return (
              <li
                key={`${e.txHash}-${e.logIndex}`}
                className="rounded-lg border border-neutral-800 bg-neutral-950/40 p-3 text-xs"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-neutral-200">{title}</span>
                  <a
                    href={arcExplorerTxUrl(e.txHash)}
                    target="_blank"
                    rel="noreferrer"
                    className="text-neutral-500 underline hover:text-neutral-300"
                  >
                    view tx
                  </a>
                </div>
                <dl className="mt-2 space-y-1">
                  <div className="grid grid-cols-1 gap-0.5 sm:grid-cols-[7rem_1fr] sm:gap-2">
                    <dt className="text-neutral-500">By</dt>
                    <dd className="font-mono text-neutral-300 break-all">
                      {e.actor}
                      {handle && (
                        <span className="ml-2 rounded bg-neutral-800 px-1.5 py-0.5 font-sans text-neutral-200">
                          @{handle}
                        </span>
                      )}
                    </dd>
                  </div>
                  <div className="grid grid-cols-1 gap-0.5 sm:grid-cols-[7rem_1fr] sm:gap-2">
                    <dt className="text-neutral-500">{hashLabel}</dt>
                    <dd className="font-mono text-neutral-300 break-all">{e.hashValue}</dd>
                  </div>
                  <div className="grid grid-cols-1 gap-0.5 sm:grid-cols-[7rem_1fr] sm:gap-2">
                    <dt className="text-neutral-500">Block</dt>
                    <dd className="font-mono text-neutral-400">{e.blockNumber}</dd>
                  </div>
                </dl>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function ActionCard({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-950/30 p-4">
      <h3 className="text-sm font-medium text-neutral-100">{title}</h3>
      {hint && <p className="mt-1 text-xs text-neutral-500">{hint}</p>}
      <div className="mt-3">{children}</div>
    </div>
  );
}

const DISPUTE_BTN =
  'rounded-lg px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50';

function DisputePanel({
  dispute,
  evaluatorRep,
  signerAddress,
  busy,
  onConcede,
  onDefend,
  onForceConcede,
  onCommit,
  autoReveal,
  onToggleAutoReveal,
  onReveal,
  onResolve,
  hasStoredVote,
}: {
  dispute: DisputeState;
  evaluatorRep: Record<string, { alignment: number | null; totalVotes: number }>;
  signerAddress: string | undefined;
  busy: boolean;
  onConcede: () => void;
  onDefend: () => void;
  onForceConcede: () => void;
  onCommit: (vote: VoteChoice) => void;
  autoReveal: boolean;
  onToggleAutoReveal: (next: boolean) => void;
  onReveal: () => void;
  onResolve: () => void;
  hasStoredVote: boolean;
}) {
  const [voteChoice, setVoteChoice] = useState<VoteChoice | null>(null);
  const nowSec = Math.floor(Date.now() / 1000);

  const isDisputer = !!signerAddress && signerAddress === dispute.disputer.toLowerCase();
  const isOpponent = !!signerAddress && signerAddress === dispute.opponent.toLowerCase();
  const isEvaluator =
    !!signerAddress && dispute.evaluators.some((e) => e.toLowerCase() === signerAddress);

  const resolved = dispute.status.startsWith('Resolved') || dispute.status === 'Conceded_Disputer';
  const allRevealed =
    dispute.evaluators.length > 0 && dispute.revealCount >= dispute.evaluators.length;

  return (
    <div className="rounded-xl border border-orange-900/40 bg-orange-950/10 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium text-orange-200">Dispute #{dispute.disputeId}</h3>
        <span className="rounded-md border border-orange-900/60 bg-orange-950/40 px-2 py-0.5 text-[11px] text-orange-300">
          {dispute.status}
        </span>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-xs text-neutral-400">
        <div>
          <dt className="text-neutral-500">Raised by</dt>
          <dd className="font-mono text-neutral-300">{shortAddress(dispute.disputer)}</dd>
        </div>
        <div>
          <dt className="text-neutral-500">Against</dt>
          <dd className="font-mono text-neutral-300">{shortAddress(dispute.opponent)}</dd>
        </div>
      </dl>

      {/* Phase: Open - opponent concedes/defends; anyone force-settles after the deadline. */}
      {dispute.status === 'Open' && (
        <div className="mt-4 space-y-3">
          <p className="text-xs text-neutral-400">
            {nowSec < dispute.concedeDeadline ? (
              <span className="inline-flex flex-wrap items-center gap-1.5">
                The other side must respond before
                <CountdownChip unix={dispute.concedeDeadline} />
              </span>
            ) : (
              'Response deadline passed - anyone can settle this in the disputer’s favour.'
            )}
          </p>
          {isOpponent && nowSec < dispute.concedeDeadline && (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={onConcede}
                disabled={busy}
                className={`${DISPUTE_BTN} border border-neutral-700 text-neutral-200 hover:bg-neutral-800`}
              >
                Concede
              </button>
              <button
                type="button"
                onClick={onDefend}
                disabled={busy}
                className={`${DISPUTE_BTN} bg-orange-700/60 text-neutral-100 hover:bg-orange-700/90`}
              >
                Defend (post 5% bond)
              </button>
            </div>
          )}
          {nowSec >= dispute.concedeDeadline && (
            <button
              type="button"
              onClick={onForceConcede}
              disabled={busy}
              className={`${DISPUTE_BTN} bg-neutral-100 text-neutral-950 hover:bg-white`}
            >
              Force-settle
            </button>
          )}
        </div>
      )}

      {/* Phase: Defended - commit/reveal voting. */}
      {dispute.status === 'Defended' && (
        <div className="mt-4 space-y-3">
          <div className="grid grid-cols-3 gap-2 text-center text-xs">
            <Pill label="Evaluators" value={String(dispute.evaluators.length)} />
            <Pill label="Committed" value={`${dispute.commitCount}/${dispute.evaluators.length}`} />
            <Pill label="Revealed" value={`${dispute.revealCount}/${dispute.evaluators.length}`} />
          </div>

          {/* Juror trust signal - each selected evaluator's lifetime alignment. */}
          <ul className="space-y-1 text-xs">
            {dispute.evaluators.map((addr) => {
              const r = evaluatorRep[addr.toLowerCase()];
              return (
                <li key={addr} className="flex items-center justify-between text-neutral-400">
                  <span className="font-mono">{shortAddress(addr)}</span>
                  <span className="text-neutral-500">
                    {r && r.alignment !== null
                      ? `${r.alignment}% aligned · ${r.totalVotes} disputes`
                      : 'no track record yet'}
                  </span>
                </li>
              );
            })}
          </ul>

          {isEvaluator && nowSec <= dispute.graceDeadline && (
            <div className="rounded-lg border border-neutral-800 bg-neutral-950/40 p-3">
              <p className="text-xs text-neutral-400">
                You&apos;re a selected evaluator. Commit your vote before
                <CountdownChip unix={dispute.graceDeadline} /> - you can re-commit until then.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {([1, 2] as VoteChoice[]).map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setVoteChoice(v)}
                    className={`rounded-md border px-3 py-1.5 text-xs ${
                      voteChoice === v
                        ? 'border-neutral-400 bg-neutral-800 text-neutral-100'
                        : 'border-neutral-800 text-neutral-400 hover:text-neutral-200'
                    }`}
                  >
                    {v === 1
                      ? `For disputer (${shortAddress(dispute.disputer)})`
                      : `For defender (${shortAddress(dispute.opponent)})`}
                  </button>
                ))}
              </div>
              <label className="mt-3 flex items-center gap-2 text-xs text-neutral-400">
                <input
                  type="checkbox"
                  checked={autoReveal}
                  onChange={(e) => onToggleAutoReveal(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-neutral-700 bg-neutral-950"
                />
                Auto-reveal - let arc-trade reveal this vote for me when the window opens
              </label>
              <button
                type="button"
                onClick={() => voteChoice && onCommit(voteChoice)}
                disabled={busy || !voteChoice}
                className={`${DISPUTE_BTN} mt-3 bg-neutral-100 text-neutral-950 hover:bg-white`}
              >
                Commit vote
              </button>
            </div>
          )}

          {isEvaluator && nowSec > dispute.graceDeadline && nowSec <= dispute.revealDeadline && (
            <div className="rounded-lg border border-neutral-800 bg-neutral-950/40 p-3">
              <p className="text-xs text-neutral-400">
                Reveal phase - closes <CountdownChip unix={dispute.revealDeadline} />.
              </p>
              <button
                type="button"
                onClick={onReveal}
                disabled={busy || !hasStoredVote}
                className={`${DISPUTE_BTN} mt-2 bg-neutral-100 text-neutral-950 hover:bg-white`}
              >
                Reveal vote
              </button>
              {!hasStoredVote && (
                <p className="mt-2 text-[11px] text-amber-400">
                  No saved vote on this device - reveal must happen where you committed.
                </p>
              )}
            </div>
          )}

          {(allRevealed || nowSec > dispute.revealDeadline) && (
            <button
              type="button"
              onClick={onResolve}
              disabled={busy}
              className={`${DISPUTE_BTN} bg-emerald-700/60 text-neutral-100 hover:bg-emerald-700/90`}
            >
              Resolve dispute
            </button>
          )}
        </div>
      )}

      {resolved && (
        <p className="mt-3 text-xs text-neutral-400">
          This dispute is settled ({dispute.status}). The pact has moved to its final state.
        </p>
      )}

      {!isDisputer && !isOpponent && !isEvaluator && !resolved && (
        <p className="mt-3 text-[11px] text-neutral-500">
          You&apos;re an observer on this dispute.
        </p>
      )}
    </div>
  );
}

function Pill({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-neutral-800 bg-neutral-950/40 p-2">
      <div className="text-[10px] uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="mt-0.5 font-mono text-neutral-200">{value}</div>
    </div>
  );
}
