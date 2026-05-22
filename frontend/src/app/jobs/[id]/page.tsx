'use client';

import { use, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { keccak256, stringToBytes, type Hex } from 'viem';
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
  getDeliverable,
  getJobEvents,
  getJobState,
  getOrCreateReadAuth,
  getUserByAddress,
  uploadDeliverableContent,
  type Deliverable,
  type DeliverableContentType,
  type JobEvent,
  type JobLiveState,
  type JobRole,
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

// One-line lifecycle summary, tailored to the viewer's role. Rendered at
// the top of the Actions panel so every viewer knows where the job stands.
function describeCurrentStep(job: JobLiveState, status: string, roles: JobRole[]): string {
  const isClient = roles.includes('client');
  const isProvider = roles.includes('provider');
  const isEvaluator = roles.includes('evaluator');
  const budgetSet = job.budget.usdc !== '0';

  if (status === 'Completed') return `Complete. ${job.budget.usdc} USDC paid out.`;
  if (status === 'Rejected') return 'Rejected. Funds refunded.';

  if (status === 'Expired') {
    if (job.status === 'Funded' || job.status === 'Submitted') {
      return `Expired with ${job.budget.usdc} USDC locked — anyone can claim refund.`;
    }
    return isClient ? 'Expired. Cancel to clear it.' : 'Expired without funding.';
  }

  if (status === 'Open' && !budgetSet) {
    return isProvider ? 'Set your quote.' : 'Waiting on a quote.';
  }

  if (status === 'Open' && budgetSet) {
    if (isClient) return `Quoted ${job.budget.usdc} USDC. Fund to lock.`;
    if (isProvider) return `Quoted ${job.budget.usdc} USDC. Waiting on client.`;
    return `Quoted ${job.budget.usdc} USDC.`;
  }

  if (status === 'Funded') {
    if (isProvider) return `${job.budget.usdc} USDC locked. Submit a deliverable.`;
    if (isEvaluator) return `${job.budget.usdc} USDC locked. Provider to submit.`;
    return `${job.budget.usdc} USDC locked.`;
  }

  if (status === 'Submitted') {
    if (isEvaluator) return 'Deliverable submitted. Complete or reject.';
    return 'Deliverable submitted. Awaiting review.';
  }

  return `Status: ${status}.`;
}

type ActionState =
  | { status: 'idle' }
  | { status: 'busy'; label: string }
  | { status: 'error'; message: string }
  | { status: 'success'; txHash: string };

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

  // Form inputs for actions that need them.
  const [budgetInput, setBudgetInput] = useState('');
  const [deliverableType, setDeliverableType] = useState<DeliverableContentType>('url');
  const [deliverableInput, setDeliverableInput] = useState('');
  // After a chain-submit succeeds, hold the (hash, content) pair so the user
  // can retry the off-chain upload without re-pasting if the upload step fails.
  const [pendingUpload, setPendingUpload] = useState<
    | { jobId: string; hash: Hex; contentType: DeliverableContentType; content: string }
    | null
  >(null);

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

  // Resolve handles for client/provider/evaluator when the job loads.
  // Deduped + parallel; absent users cache as null so we don't re-query.
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
          return [addr, user?.handle ?? null] as const;
        } catch {
          return [addr, null] as const;
        }
      }),
    ).then((results) => {
      if (cancelled) return;
      setHandlesByAddress((prev) => {
        const next = { ...prev };
        for (const [addr, handle] of results) next[addr] = handle;
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

              {currentStep && (
                <p className="mt-3 rounded-xl border border-neutral-800 bg-neutral-950/40 p-3 text-sm text-neutral-100">
                  {currentStep}
                </p>
              )}

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
                        {(['url', 'text'] as DeliverableContentType[]).map((t) => (
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
                            {t === 'url' ? 'URL' : 'Text'}
                          </label>
                        ))}
                      </div>
                      {deliverableType === 'url' ? (
                        <input
                          type="url"
                          value={deliverableInput}
                          onChange={(e) => setDeliverableInput(e.target.value)}
                          placeholder="https://…"
                          className="w-full rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
                        />
                      ) : (
                        <textarea
                          value={deliverableInput}
                          onChange={(e) => setDeliverableInput(e.target.value)}
                          placeholder="Paste your deliverable text…"
                          rows={5}
                          className="w-full rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
                        />
                      )}
                      <div className="flex justify-end">
                        <button
                          type="button"
                          onClick={() => {
                            if (!guardDeadline('Submitting')) return;
                            if (!signer.isConnected) return;
                            const content = deliverableInput.trim();
                            if (!content) {
                              setActionState({ status: 'error', message: 'Content is required.' });
                              return;
                            }
                            const hash = keccak256(stringToBytes(content));
                            void (async () => {
                              setActionState({ status: 'busy', label: 'Submitting on-chain…' });
                              try {
                                const onchain = await sendUnsigned(
                                  'Submitting on-chain…',
                                  () => buildSubmitUnsigned(jobId, hash),
                                );
                                setActionState({ status: 'busy', label: 'Uploading content…' });
                                try {
                                  await uploadDeliverableContent({
                                    jobId,
                                    contentType: deliverableType,
                                    content,
                                    expectedHash: hash,
                                    uploadedBy: signer.address,
                                  });
                                  setPendingUpload(null);
                                  setDeliverableInput('');
                                  setActionState({ status: 'success', txHash: onchain.txHash });
                                  await fetchJob();
                                } catch (uploadErr) {
                                  setPendingUpload({
                                    jobId,
                                    hash,
                                    contentType: deliverableType,
                                    content,
                                  });
                                  setActionState({
                                    status: 'error',
                                    message: `On-chain submit succeeded (tx ${onchain.txHash}) but content upload failed: ${
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
                          disabled={actionState.status === 'busy' || !deliverableInput.trim()}
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
                        if (!signer.isConnected) return;
                        void (async () => {
                          setActionState({ status: 'busy', label: 'Uploading content…' });
                          try {
                            await uploadDeliverableContent({
                              jobId: pendingUpload.jobId,
                              contentType: pendingUpload.contentType,
                              content: pendingUpload.content,
                              expectedHash: pendingUpload.hash,
                              uploadedBy: signer.address,
                            });
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

function Mono({
  addr,
  you,
  handle,
}: {
  addr: string;
  you?: string;
  handle?: string | null;
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
      {isYou && (
        <span className="ml-2 rounded bg-neutral-800 px-1.5 py-0.5 text-neutral-300 font-sans">
          you
        </span>
      )}
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

  // The hash claimed on-chain; null until indexer catches up.
  const onchainHash = submittedEvent?.hashValue ?? null;

  // Client-side hash verification: recompute and compare to the on-chain
  // commitment. Falsy if content not yet loaded.
  const hashMatches = useMemo(() => {
    if (!content || !onchainHash) return null;
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
            <span
              className={`rounded-md border px-2 py-0.5 ${
                hashMatches
                  ? 'border-emerald-900/60 bg-emerald-950/40 text-emerald-300'
                  : 'border-red-900/60 bg-red-950/40 text-red-300'
              }`}
            >
              {hashMatches ? '✓ Hash verified' : '✗ Hash mismatch'}
            </span>
            <span className="text-neutral-500">
              {content.contentType === 'url' ? 'URL' : 'Text'}
            </span>
          </div>
          {content.contentType === 'url' ? (
            <a
              href={content.textContent}
              target="_blank"
              rel="noreferrer"
              className="block break-all rounded-lg border border-neutral-800 bg-neutral-950/40 p-3 font-mono text-xs text-sky-300 underline hover:text-sky-200"
            >
              {content.textContent}
            </a>
          ) : (
            <pre className="whitespace-pre-wrap rounded-lg border border-neutral-800 bg-neutral-950/40 p-3 text-xs text-neutral-200">
              {content.textContent}
            </pre>
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
  // Jobs at Open/Funded have nothing to show. For Submitted/Completed/Rejected,
  // if no event row has indexed yet (~10s lag), show a soft hint instead of
  // hiding the section entirely.
  const expectsRecord =
    liveStatus === 'Submitted' || liveStatus === 'Completed' || liveStatus === 'Rejected';
  if (events.length === 0 && !expectsRecord) return null;

  const labels: Record<JobEvent['eventType'], { title: string; hashLabel: string }> = {
    Submitted: { title: 'Submitted', hashLabel: 'Deliverable hash' },
    Completed: { title: 'Completed', hashLabel: 'Reason hash' },
    Rejected: { title: 'Rejected', hashLabel: 'Reason hash' },
  };

  return (
    <div className="mt-5 border-t border-neutral-800 pt-4">
      <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
        On-chain record
      </h3>
      {events.length === 0 ? (
        <p className="mt-2 text-xs text-neutral-500">Indexing the event from chain…</p>
      ) : (
        <ul className="mt-2 space-y-3">
          {events.map((e) => {
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
