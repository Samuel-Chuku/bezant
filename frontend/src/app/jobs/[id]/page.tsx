'use client';

import { use, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { formatUnits, keccak256, stringToBytes, type Hex } from 'viem';
import { usePublicClient } from 'wagmi';
import { useSigner } from '@/hooks/use-signer';
import {
  buildApproveUnsigned,
  buildCompleteUnsigned,
  buildFundUnsigned,
  buildRefundUnsigned,
  buildRejectUnsigned,
  buildSetBudgetUnsigned,
  buildSubmitUnsigned,
  formatReputationValue,
  getDeliverable,
  getDeliverableFile,
  getJobEvents,
  getJobState,
  getOrCreateReadAuth,
  getReputationSummary,
  getUserByAddress,
  uploadDeliverableContent,
  uploadDeliverableFile,
  type Deliverable,
  type DeliverableContentType,
  type JobEvent,
  type JobLiveState,
  type JobRole,
  type ReputationSummary,
} from '@/lib/api';
import { ERC8183_ADDRESS, USDC_ADDRESS } from '@/lib/chains';

// Minimal ABI fragment to read USDC allowance — saves a backend roundtrip.
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
  Completed: 'bg-emerald-950/40 text-emerald-300 border-emerald-900/60',
  Rejected: 'bg-red-950/40 text-red-300 border-red-900/60',
  Expired: 'bg-neutral-900 text-neutral-400 border-neutral-800',
};

function effectiveStatus(live: JobLiveState, nowMs: number): string {
  const raw = live.status;
  if (raw === 'Completed' || raw === 'Rejected' || raw === 'Expired') return raw;
  if (live.expiredAt.unix * 1000 < nowMs) return 'Expired';
  return raw;
}

function userRoles(live: JobLiveState, address: string | undefined): JobRole[] {
  if (!address) return [];
  const a = address.toLowerCase();
  const roles: JobRole[] = [];
  if (live.client.toLowerCase() === a) roles.push('client');
  if (live.provider.toLowerCase() === a) roles.push('provider');
  if (live.evaluator.toLowerCase() === a) roles.push('evaluator');
  return roles;
}

// What's pending — a single sentence describing the next step, tailored to
// the viewer's role. Pairs with the lifecycle timeline so we don't repeat
// what's already happened; this only answers "what's blocking progress
// right now?". Returns null for terminal states (Completed/Rejected) where
// the timeline tells the whole story on its own.
function describeCurrentStep(job: JobLiveState, status: string, roles: JobRole[]): string | null {
  const isClient = roles.includes('client');
  const isProvider = roles.includes('provider');
  const isEvaluator = roles.includes('evaluator');
  const budgetSet = job.budget.usdc !== '0';

  if (status === 'Completed' || status === 'Rejected') return null;

  if (status === 'Expired') {
    if (job.status === 'Funded' || job.status === 'Submitted') {
      return `Anyone can claim the ${job.budget.usdc} USDC refund for the client.`;
    }
    return isClient
      ? 'Cancel this job to clear it, then post a fresh one with a longer deadline.'
      : 'Waiting for the client to cancel or repost.';
  }

  if (status === 'Open' && !budgetSet) {
    return isProvider
      ? 'Set your quote so the client can fund the job.'
      : 'Waiting for the provider to quote a price.';
  }

  if (status === 'Open' && budgetSet) {
    if (isClient) return `Fund the job to lock the ${job.budget.usdc} USDC and let work begin.`;
    if (isProvider) return 'Quote sent — waiting for the client to fund the job.';
    return 'Waiting for the client to fund the job.';
  }

  if (status === 'Funded') {
    return isProvider
      ? 'Submit your deliverable so the evaluator can review and release the funds.'
      : 'Waiting for the provider to submit a deliverable.';
  }

  if (status === 'Submitted') {
    if (isEvaluator) return 'Review the deliverable, then complete or reject.';
    if (isProvider) return 'Waiting for the evaluator to review your submission.';
    return 'Waiting for the evaluator to complete or reject.';
  }

  return `Status: ${status}.`;
}

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
  actorAddr: string;
  when?: string;
  txHash?: string;
};

// Waiting-cue tint keyed off effective status. Mirrors the job-list page's
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
// - Created: jobs_index (createdAt on JobLiveState)
// - Quoted: derived from job.budget > 0 (no event indexed today, no time)
// - Funded: derived from on-chain status being Funded or beyond (no time)
// - Submitted / Completed / Rejected: job_events table via getJobEvents
// Terminal states (Completed / Rejected) append a value-summary suffix so
// the timeline tells the whole story without a separate banner.
function buildLifecycle(
  job: JobLiveState,
  events: JobEvent[],
  status: string,
): LifecycleRow[] {
  const rows: LifecycleRow[] = [];

  rows.push({
    label: 'Created',
    actorAddr: job.client,
    when: job.createdAt?.indexedAt,
    txHash: job.createdAt?.txHash,
  });

  if (job.budget.usdc !== '0') {
    rows.push({
      label: `Quoted ${job.budget.usdc} USDC`,
      actorAddr: job.provider,
    });
  }

  // Funded: prefer the indexed JobFunded event (timestamp + tx link).
  // Fall back to the derived row from on-chain status when the indexer
  // hasn't caught up — drops the timestamp but keeps the timeline coherent.
  const fundedEvent = events.find((e) => e.eventType === 'Funded');
  const fundedFromStatus =
    job.status === 'Funded' ||
    job.status === 'Submitted' ||
    job.status === 'Completed' ||
    job.status === 'Rejected';
  if (fundedEvent) {
    const amountUsdc = fundedEvent.amountRaw
      ? formatUnits(BigInt(fundedEvent.amountRaw), 6)
      : job.budget.usdc;
    rows.push({
      label: `Funded ${amountUsdc} USDC into escrow`,
      actorAddr: fundedEvent.actor,
      when: fundedEvent.indexedAt,
      txHash: fundedEvent.txHash,
    });
  } else if (fundedFromStatus) {
    rows.push({ label: `Funded ${job.budget.usdc} USDC into escrow`, actorAddr: job.client });
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
      label: `Completed — ${job.budget.usdc} USDC released to provider`,
      actorAddr: completed.actor,
      when: completed.indexedAt,
      txHash: completed.txHash,
    });
  }
  const rejected = events.find((e) => e.eventType === 'Rejected');
  if (rejected) {
    rows.push({
      label: `Rejected — funds refunded to client`,
      actorAddr: rejected.actor,
      when: rejected.indexedAt,
      txHash: rejected.txHash,
    });
  }

  // Note `status` is unused above but kept in the signature for future
  // expiry-row handling once we index JobExpired / claimRefund.
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

export default function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: jobId } = use(params);
  const signer = useSigner();
  const publicClient = usePublicClient();
  const [job, setJob] = useState<JobLiveState | null>(null);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [loadingJob, setLoadingJob] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionState, setActionState] = useState<ActionState>({ status: 'idle' });
  // Cache of address → handle (or null if not registered). Populated when the
  // job loads so client/provider/evaluator can render as "@handle" + address.
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
    jobId: string;
    hash: Hex;
    contentType: 'text' | 'url';
    content: string;
  };
  type PendingFile = {
    jobId: string;
    hash: Hex;
    contentType: 'file';
    fileName: string;
    mime: string;
    fileBase64: string;
  };
  const [pendingUpload, setPendingUpload] = useState<PendingTextUrl | PendingFile | null>(null);

  const fetchJob = useCallback(async () => {
    setLoadingJob(true);
    setLoadError(null);
    try {
      const [live, evts] = await Promise.all([getJobState(jobId), getJobEvents(jobId)]);
      setJob(live);
      setEvents(evts);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingJob(false);
    }
  }, [jobId]);

  useEffect(() => {
    void fetchJob();
  }, [fetchJob]);

  // Resolve handles + agentIds for client/provider/evaluator when the job
  // loads. Deduped + parallel; absent users cache as null so we don't
  // re-query. Pulls handle + agentId from the same UserRecord — one lookup
  // covers both displays (handle chip + reputation badge).
  useEffect(() => {
    if (!job) return;
    const addresses = [job.client, job.provider, job.evaluator]
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
  }, [job]);

  const status = useMemo(() => (job ? effectiveStatus(job, Date.now()) : null), [job]);
  const roles = useMemo(
    () => (job && signer.isConnected ? userRoles(job, signer.address) : []),
    [job, signer],
  );

  // Always-on lifecycle context — what's happening, what's next. Independent
  // of whether an action card renders for this user.
  const currentStep = useMemo(
    () => (job && status ? describeCurrentStep(job, status, roles) : null),
    [job, status, roles],
  );

  // Read-only banner shown only when user has no role at all on this job.
  const showReadOnlyNotice = signer.isConnected && roles.length === 0;

  const runAction = async (
    label: string,
    fn: () => Promise<{ txHash: string }>,
  ): Promise<boolean> => {
    setActionState({ status: 'busy', label });
    try {
      const { txHash } = await fn();
      setActionState({ status: 'success', txHash });
      await fetchJob();
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
    if (!job) return false;
    if (job.expiredAt.unix * 1000 > Date.now()) return true;
    setActionState({
      status: 'error',
      message: `Deadline has passed. ${actionVerb} now would leave this job in an unrecoverable state — the client needs to cancel and post a fresh job with a longer deadline.`,
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
  // Pre-flight checks: job exists, budget set, deadline still in the future.
  const fundJob = async () => {
    if (!signer.isConnected || !job || !publicClient) return;
    const budgetRaw = BigInt(job.budget.raw);
    if (budgetRaw === 0n) {
      setActionState({ status: 'error', message: 'Provider has not set a budget yet.' });
      return;
    }
    if (job.expiredAt.unix * 1000 <= Date.now()) {
      setActionState({
        status: 'error',
        message:
          'Deadline has passed. The chain will refuse to fund this job. Use "Cancel job" to clean it up, or create a new job with a longer deadline.',
      });
      return;
    }
    try {
      const allowance = await publicClient.readContract({
        address: USDC_ADDRESS,
        abi: erc20AllowanceAbi,
        functionName: 'allowance',
        args: [signer.address as Hex, ERC8183_ADDRESS],
      });
      if (allowance < budgetRaw) {
        const approvedOk = await runAction('Approving USDC…', () =>
          sendUnsigned('Approving USDC…', () => buildApproveUnsigned(job.budget.usdc)),
        );
        if (!approvedOk) return;
      }
      await runAction('Funding job…', () =>
        sendUnsigned('Funding job…', () => buildFundUnsigned(jobId)),
      );
    } catch (err) {
      setActionState({
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <header className="mb-6">
        <Link href="/jobs" className="text-xs text-neutral-500 hover:text-neutral-100">
          ← back to my jobs
        </Link>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">
          Job <span className="font-mono">#{jobId}</span>
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
          Couldn&apos;t load this job: {loadError}
        </p>
      )}

      {loadingJob && !job && <p className="text-sm text-neutral-500">Loading…</p>}

      {job && (
        <>
          <section className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-5">
            <h2 className="text-sm font-medium text-neutral-300">Details</h2>
            <dl className="mt-3 space-y-2 text-sm">
              <Detail label="Description" value={job.description || <em className="text-neutral-500">(none)</em>} />
              <Detail label="Budget" value={`${job.budget.usdc} USDC`} />
              <Detail label="Deadline" value={new Date(job.expiredAt.iso).toLocaleString()} />
              <Detail
                label="Client"
                value={
                  <Mono
                    addr={job.client}
                    you={signer.address}
                    handle={handlesByAddress[job.client.toLowerCase()]}
                    agentId={agentIdsByAddress[job.client.toLowerCase()]}
                  />
                }
              />
              <Detail
                label="Provider"
                value={
                  <Mono
                    addr={job.provider}
                    you={signer.address}
                    handle={handlesByAddress[job.provider.toLowerCase()]}
                    agentId={agentIdsByAddress[job.provider.toLowerCase()]}
                  />
                }
              />
              <Detail
                label="Evaluator"
                value={
                  <Mono
                    addr={job.evaluator}
                    you={signer.address}
                    handle={handlesByAddress[job.evaluator.toLowerCase()]}
                    agentId={agentIdsByAddress[job.evaluator.toLowerCase()]}
                  />
                }
              />
            </dl>
            {roles.length > 0 && (
              <p className="mt-3 text-xs text-neutral-400">
                You are: <span className="text-neutral-200">{roles.join(', ')}</span>
              </p>
            )}

            <OnChainRecord events={events} liveStatus={job.status} handlesByAddress={handlesByAddress} />
          </section>

          <DeliverableContent
            jobId={jobId}
            events={events}
            isParty={roles.length > 0}
            signer={signer}
          />

          {!signer.isConnected && (
            <p className="mt-6 rounded-xl border border-amber-900/40 bg-amber-950/20 p-4 text-sm text-amber-200">
              Connect to act on this job.{' '}
              <Link href="/" className="underline">
                Sign in
              </Link>
            </p>
          )}

          {signer.isConnected && status && (
            <section className="mt-6 rounded-2xl border border-neutral-800 bg-neutral-900/40 p-5">
              <h2 className="text-sm font-medium text-neutral-300">Actions</h2>

              <LifecyclePanel
                rows={buildLifecycle(job, events, status)}
                waitingLine={currentStep}
                effectiveStatus={status}
                handlesByAddress={handlesByAddress}
                youAddress={signer.address}
              />

              {showReadOnlyNotice && (
                <p className="mt-3 text-xs text-neutral-500">Read-only — you&apos;re not a party.</p>
              )}

              <div className="mt-4 space-y-4">
                {/* setBudget — provider only, while Open */}
                {roles.includes('provider') && status === 'Open' && (
                  <ActionCard
                    title="Set or update your quote"
                    hint={
                      job.budget.usdc === '0'
                        ? 'Quote a price in USDC.'
                        : `Current quote: ${job.budget.usdc} USDC. Re-quote any time.`
                    }
                  >
                    <div className="flex gap-2">
                      <input
                        type="text"
                        inputMode="decimal"
                        value={budgetInput}
                        onChange={(e) => setBudgetInput(e.target.value)}
                        placeholder={job.budget.usdc === '0' ? '0.1' : job.budget.usdc}
                        className="flex-1 rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          if (!guardDeadline('Quoting')) return;
                          void runAction('Setting budget…', () =>
                            sendUnsigned('Setting budget…', () =>
                              buildSetBudgetUnsigned(jobId, budgetInput.trim() || '0'),
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

                {/* fund — client only, while Open + budget set + deadline not yet passed */}
                {roles.includes('client') && status === 'Open' && (
                  <ActionCard
                    title="Fund the job"
                    hint={
                      job.budget.usdc === '0'
                        ? 'Waiting on the provider to quote.'
                        : `Locks ${job.budget.usdc} USDC into escrow.`
                    }
                  >
                    <button
                      type="button"
                      onClick={fundJob}
                      disabled={actionState.status === 'busy' || job.budget.usdc === '0'}
                      className="rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-950 hover:bg-white disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
                    >
                      Fund {job.budget.usdc} USDC
                    </button>
                  </ActionCard>
                )}

                {/* cancel — client can call reject() while on-chain status is still Open
                    (covers both "before anyone acts" and "stuck past deadline"). The
                    reference contract has no deadline-extension function, so this is
                    the only way out for an expired-Open job. */}
                {roles.includes('client') && job.status === 'Open' && (
                  <ActionCard
                    title="Cancel job"
                    hint={
                      job.expiredAt.unix * 1000 <= Date.now()
                        ? 'Closes an expired job so you can repost.'
                        : 'Cancels before anyone funds it.'
                    }
                  >
                    <button
                      type="button"
                      onClick={() =>
                        runAction('Cancelling…', () =>
                          sendUnsigned('Cancelling…', () => buildRejectUnsigned(jobId)),
                        )
                      }
                      disabled={actionState.status === 'busy'}
                      className="rounded-lg border border-neutral-700 px-4 py-2 text-sm font-medium text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
                    >
                      Cancel job
                    </button>
                  </ActionCard>
                )}

                {/* submit — provider only, while Funded.
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
                                  retry = { jobId, hash, contentType: 'file', fileName, mime, fileBase64: base64 };
                                  upload = async () => {
                                    await uploadDeliverableFile({
                                      jobId,
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
                                  retry = { jobId, hash, contentType: deliverableType, content };
                                  upload = async () => {
                                    await uploadDeliverableContent({
                                      jobId,
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
                                  () => buildSubmitUnsigned(jobId, hash),
                                );
                                onchainTxHash = onchain.txHash;

                                setActionState({ status: 'busy', label: 'Uploading content…' });
                                try {
                                  await upload();
                                  setPendingUpload(null);
                                  setDeliverableInput('');
                                  setDeliverableFile(null);
                                  setActionState({ status: 'success', txHash: onchainTxHash });
                                  await fetchJob();
                                } catch (uploadErr) {
                                  setPendingUpload(retry);
                                  setActionState({
                                    status: 'error',
                                    message: `On-chain submit succeeded (tx ${onchainTxHash}) but content upload failed: ${
                                      uploadErr instanceof Error ? uploadErr.message : String(uploadErr)
                                    }. The hash is committed; use Retry upload below.`,
                                  });
                                  await fetchJob();
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

                {/* Retry-upload surface — chain submit landed, off-chain
                    upload didn't. Provider can re-run the upload step
                    without re-signing on-chain. */}
                {roles.includes('provider') && pendingUpload && pendingUpload.jobId === jobId && (
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
                                jobId: retry.jobId,
                                fileName: retry.fileName,
                                mime: retry.mime,
                                fileBase64: retry.fileBase64,
                                expectedHash: retry.hash,
                                uploadedBy: signer.address,
                              });
                            } else {
                              await uploadDeliverableContent({
                                jobId: retry.jobId,
                                contentType: retry.contentType,
                                content: retry.content,
                                expectedHash: retry.hash,
                                uploadedBy: signer.address,
                              });
                            }
                            setPendingUpload(null);
                            setActionState({ status: 'success', txHash: '0x' as Hex });
                            await fetchJob();
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

                {/* complete — evaluator only, while Submitted */}
                {roles.includes('evaluator') && status === 'Submitted' && (
                  <ActionCard
                    title="Release funds to provider"
                    hint="Pays out the budget."
                  >
                    <button
                      type="button"
                      onClick={() => {
                        if (!guardDeadline('Completing')) return;
                        void runAction('Completing…', () =>
                          sendUnsigned('Completing…', () => buildCompleteUnsigned(jobId)),
                        );
                      }}
                      disabled={actionState.status === 'busy'}
                      className="rounded-lg bg-emerald-700/60 px-4 py-2 text-sm font-medium text-neutral-100 hover:bg-emerald-700/90 disabled:opacity-50"
                    >
                      Complete
                    </button>
                  </ActionCard>
                )}

                {/* reject — evaluator only, while Funded or Submitted */}
                {roles.includes('evaluator') &&
                  (status === 'Funded' || status === 'Submitted') && (
                    <ActionCard
                      title="Reject and refund the client"
                      hint="Full budget returned to the client."
                    >
                      <button
                        type="button"
                        onClick={() =>
                          runAction('Rejecting…', () =>
                            sendUnsigned('Rejecting…', () => buildRejectUnsigned(jobId)),
                          )
                        }
                        disabled={actionState.status === 'busy'}
                        className="rounded-lg bg-red-700/60 px-4 py-2 text-sm font-medium text-neutral-100 hover:bg-red-700/90 disabled:opacity-50"
                      >
                        Reject
                      </button>
                    </ActionCard>
                  )}

                {/* claimRefund — anyone, when deadline passed + job is Funded/Submitted */}
                {status === 'Expired' &&
                  (job.status === 'Funded' || job.status === 'Submitted') && (
                    <ActionCard
                      title="Claim refund (deadline passed)"
                      hint="Anyone can trigger; funds go to the client."
                    >
                      <button
                        type="button"
                        onClick={() =>
                          runAction('Claiming refund…', () =>
                            sendUnsigned('Claiming refund…', () => buildRefundUnsigned(jobId)),
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
                      href={`https://testnet.arcscan.app/tx/${actionState.txHash}`}
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
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-2 text-sm">
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
      {formatted ? `★ ${formatted}` : '★ —'}
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
        const handle = handlesByAddress[row.actorAddr.toLowerCase()] ?? null;
        return (
          <div key={i} className="flex items-start gap-2 text-sm">
            <span className="mt-0.5 text-emerald-500">✓</span>
            <div className="min-w-0 flex-1">
              <p className="text-neutral-100">{row.label}</p>
              <p className="text-xs text-neutral-500">
                by <Actor addr={row.actorAddr} handle={handle} you={youAddress} />
                {row.when && <> · {timeAgo(row.when)}</>}
                {row.txHash && (
                  <a
                    href={`https://testnet.arcscan.app/tx/${row.txHash}`}
                    target="_blank"
                    rel="noreferrer"
                    className="ml-2 text-neutral-600 underline hover:text-neutral-400"
                    onClick={(e) => e.stopPropagation()}
                  >
                    view tx
                  </a>
                )}
              </p>
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
  jobId,
  events,
  isParty,
  signer,
}: {
  jobId: string;
  events: JobEvent[];
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
  // against the on-chain commitment — we only know the commitment matches
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
        jobId,
        signer.address,
        signer.signMessage,
      );
      const fetched = await getDeliverable(jobId, submittedEvent.hashValue, auth);
      setContent(fetched);
      setNeedsUnlock(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [jobId, signer, submittedEvent]);

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
      const auth = await getOrCreateReadAuth(jobId, signer.address, signer.signMessage);
      const blob = await getDeliverableFile(jobId, submittedEvent.hashValue, auth);
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
  }, [content, jobId, signer, submittedEvent, onchainHash]);

  // On mount / when becoming a party: if a cached signature exists, auto-load.
  // Otherwise surface an explicit "Unlock" button so the user understands
  // why a wallet popup is about to appear.
  useEffect(() => {
    if (!isParty || !signer.isConnected || !submittedEvent) return;
    if (typeof window === 'undefined') return;
    const cacheKey = `arc:deliv-sig:${jobId}:${signer.address.toLowerCase()}`;
    if (localStorage.getItem(cacheKey)) {
      void loadContent();
    } else {
      setNeedsUnlock(true);
    }
  }, [isParty, signer.isConnected, signer.address, submittedEvent, jobId, loadContent]);

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
  events: JobEvent[];
  liveStatus: string;
  handlesByAddress: Record<string, string | null>;
}) {
  // This section is the "what hash was committed on-chain" view. Funded
  // events carry an amount instead of a hash and show up in the lifecycle
  // timeline above; filter them out here.
  type HashEventType = 'Submitted' | 'Completed' | 'Rejected';
  const hashEvents = events.filter(
    (e): e is JobEvent & { eventType: HashEventType } => e.eventType !== 'Funded',
  );
  // Jobs at Open/Funded have nothing to show. For Submitted/Completed/Rejected,
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
                    href={`https://testnet.arcscan.app/tx/${e.txHash}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-neutral-500 underline hover:text-neutral-300"
                  >
                    view tx
                  </a>
                </div>
                <dl className="mt-2 space-y-1">
                  <div className="grid grid-cols-[7rem_1fr] gap-2">
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
                  <div className="grid grid-cols-[7rem_1fr] gap-2">
                    <dt className="text-neutral-500">{hashLabel}</dt>
                    <dd className="font-mono text-neutral-300 break-all">{e.hashValue}</dd>
                  </div>
                  <div className="grid grid-cols-[7rem_1fr] gap-2">
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
