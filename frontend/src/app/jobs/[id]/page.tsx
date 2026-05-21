'use client';

import { use, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { keccak256, toBytes, type Hex } from 'viem';
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
  getJobState,
  getUserByAddress,
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

// Explains the current state of the job when the user has no action to take.
// Returns a (title, body) pair to render in the Actions panel.
function describeWaiting(
  job: JobLiveState,
  status: string,
  roles: JobRole[],
): { title: string; body: string } {
  if (roles.length === 0) {
    return {
      title: 'Read-only',
      body: 'You are not a party to this job (not client, provider, or evaluator). You can view its state but not act on it.',
    };
  }

  if (status === 'Completed') {
    return {
      title: 'Job complete',
      body: 'The evaluator released the budget to the provider. No further actions are available.',
    };
  }
  if (status === 'Rejected') {
    return {
      title: 'Job rejected',
      body: 'The job was rejected. Any locked funds were returned to the client.',
    };
  }
  if (status === 'Expired') {
    // claimRefund is rendered separately when applicable; this is the terminal case.
    return {
      title: 'Expired',
      body: 'The deadline has passed and no funds are locked. No further actions are available on this job.',
    };
  }

  const isClient = roles.includes('client');
  const isProvider = roles.includes('provider');
  const isEvaluator = roles.includes('evaluator');
  const budgetSet = job.budget.usdc !== '0';

  if (status === 'Open' && isEvaluator && !isClient && !isProvider) {
    return {
      title: 'Waiting on the provider and client',
      body: budgetSet
        ? 'The provider has quoted a price. Waiting for the client to fund the job.'
        : 'Waiting for the provider to set a price, then for the client to fund.',
    };
  }

  if (status === 'Funded' && isClient) {
    return {
      title: 'Waiting on the provider',
      body: 'Funds are locked in escrow. The provider needs to submit a deliverable before the evaluator can complete or reject.',
    };
  }
  if (status === 'Funded' && isEvaluator && !isProvider) {
    return {
      title: 'Waiting on the provider',
      body: 'Funds are locked. The provider needs to submit a deliverable before you can complete the job. You can also reject now if needed.',
    };
  }

  if (status === 'Submitted' && (isClient || isProvider)) {
    return {
      title: 'Waiting on the evaluator',
      body: isProvider
        ? 'You\'ve submitted a deliverable. The evaluator will either complete (releasing the budget to you) or reject (refunding the client).'
        : 'The provider has submitted a deliverable. The evaluator will either complete (releasing the budget to the provider) or reject (refunding you).',
    };
  }

  return {
    title: 'Nothing to do right now',
    body: `Job status is ${status}; nothing is available for your role at this stage.`,
  };
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
  const [loadingJob, setLoadingJob] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionState, setActionState] = useState<ActionState>({ status: 'idle' });
  // Cache of address → handle (or null if not registered). Populated when the
  // job loads so client/provider/evaluator can render as "@handle" + address.
  const [handlesByAddress, setHandlesByAddress] = useState<Record<string, string | null>>({});

  // Form inputs for actions that need them.
  const [budgetInput, setBudgetInput] = useState('');
  const [deliverableInput, setDeliverableInput] = useState('');

  const fetchJob = useCallback(async () => {
    setLoadingJob(true);
    setLoadError(null);
    try {
      const live = await getJobState(jobId);
      setJob(live);
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

  // Detect whether any action card will render for this user given the job
  // state. Used to decide whether to show the explanatory "waiting" message.
  const hasAvailableAction = useMemo(() => {
    if (!job || !signer.isConnected || !status) return false;
    const r = roles;
    if (status === 'Open') {
      if (r.includes('provider')) return true; // setBudget
      if (r.includes('client')) return true; // fund (if budget set) OR cancel
    }
    if (status === 'Funded') {
      if (r.includes('provider')) return true; // submit
      if (r.includes('evaluator')) return true; // reject
    }
    if (status === 'Submitted') {
      if (r.includes('evaluator')) return true; // complete or reject
    }
    if (status === 'Expired' && (job.status === 'Funded' || job.status === 'Submitted')) {
      return true; // claimRefund (anyone)
    }
    if (r.includes('client') && job.status === 'Open') {
      return true; // cancel
    }
    return false;
  }, [job, signer.isConnected, status, roles]);

  const waitingMessage = useMemo(() => {
    if (!job || !status || hasAvailableAction) return null;
    return describeWaiting(job, status, roles);
  }, [job, status, roles, hasAvailableAction]);

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
          </section>

          {!signer.isConnected && (
            <p className="mt-6 rounded-xl border border-amber-900/40 bg-amber-950/20 p-4 text-sm text-amber-200">
              Connect a wallet or sign in to act on this job.{' '}
              <Link href="/" className="underline">
                Go to sign-in
              </Link>
            </p>
          )}

          {signer.isConnected && status && (
            <section className="mt-6 rounded-2xl border border-neutral-800 bg-neutral-900/40 p-5">
              <h2 className="text-sm font-medium text-neutral-300">Actions</h2>
              <div className="mt-4 space-y-4">
                {/* setBudget — provider only, while Open */}
                {roles.includes('provider') && status === 'Open' && (
                  <ActionCard
                    title="Set or update your quote"
                    hint={
                      job.budget.usdc === '0'
                        ? 'No quote set yet. Provide a price in USDC.'
                        : `Current quote is ${job.budget.usdc} USDC. Re-quote any time while the job is Open.`
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
                        ? 'Waiting on the provider to set a quote. Once they do, you can fund.'
                        : `Locks ${job.budget.usdc} USDC into escrow. Approves USDC if needed, then funds.`
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
                        ? 'Deadline has passed. The reference contract has no extend-deadline function — cancelling closes the row so you can post a fresh job with a longer deadline.'
                        : 'Closes the job before anyone funds it. No money has moved yet.'
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

                {/* submit — provider only, while Funded */}
                {roles.includes('provider') && status === 'Funded' && (
                  <ActionCard
                    title="Submit deliverable"
                    hint="Provide either a 32-byte hex hash, or some text we'll hash with keccak256 client-side for you."
                  >
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={deliverableInput}
                        onChange={(e) => setDeliverableInput(e.target.value)}
                        placeholder="0x… or any text to hash"
                        className="flex-1 rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-xs text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          if (!guardDeadline('Submitting')) return;
                          const v = deliverableInput.trim();
                          const hash: Hex = /^0x[0-9a-fA-F]{64}$/.test(v)
                            ? (v as Hex)
                            : keccak256(toBytes(v || `arc-trade:${jobId}:${Date.now()}`));
                          void runAction('Submitting…', () =>
                            sendUnsigned('Submitting…', () => buildSubmitUnsigned(jobId, hash)),
                          );
                        }}
                        disabled={actionState.status === 'busy'}
                        className="rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-950 hover:bg-white disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
                      >
                        Submit
                      </button>
                    </div>
                  </ActionCard>
                )}

                {/* complete — evaluator only, while Submitted */}
                {roles.includes('evaluator') && status === 'Submitted' && (
                  <ActionCard
                    title="Release funds to provider"
                    hint="Approve the deliverable. Provider receives the budget (minus any platform/evaluator fees — currently 0)."
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
                      hint="Return the full budget to the client. No fees are skimmed on rejection."
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
                      hint="Anyone can trigger this. Funds go to the client regardless of who pays the gas."
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

                {/* No-action fallback — explain who/what we're waiting on. */}
                {waitingMessage && (
                  <div className="rounded-xl border border-neutral-800 bg-neutral-950/30 p-4">
                    <h3 className="text-sm font-medium text-neutral-200">{waitingMessage.title}</h3>
                    <p className="mt-1 text-xs text-neutral-500">{waitingMessage.body}</p>
                  </div>
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
