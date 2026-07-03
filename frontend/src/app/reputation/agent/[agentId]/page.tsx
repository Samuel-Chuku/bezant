'use client';

import { use, useCallback, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  formatReputationValue,
  getReputation,
  getUserByAddress,
  type ReputationDetail,
  type UserRecord,
} from '@/lib/api';
import { ErrorBanner, Skeleton } from '@/components/async-state';
import { useSigner } from '@/hooks/use-signer';
import { useUserRecord } from '@/hooks/use-user-record';
import { PassportPanel } from '@/components/passport-panel';

const PAGE_SIZE = 20;

export default function ReputationPage({
  params,
}: {
  params: Promise<{ agentId: string }>;
}) {
  const { agentId } = use(params);
  const signer = useSigner();
  const { state: userState } = useUserRecord();
  // Surface the credit passport only on the viewer's own agent page (it's
  // address-keyed, and we only have the connected wallet's address).
  const isOwn = userState.status === 'ready' && userState.user?.agentId === agentId;
  const [data, setData] = useState<ReputationDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // 0-indexed page number (page 0 = most recent PAGE_SIZE feedback entries).
  const [page, setPage] = useState(0);
  // Cache of clientAddress → handle (or null) so feedback rows can render
  // @handle next to the address when known.
  const [handles, setHandles] = useState<Record<string, string | null>>({});

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await getReputation(agentId, {
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      });
      setData(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [agentId, page]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  // Resolve handles for the unique set of clients across all feedback rows.
  useEffect(() => {
    if (!data) return;
    const unique = Array.from(
      new Set(data.feedback.map((f) => f.clientAddress.toLowerCase())),
    );
    let cancelled = false;
    void Promise.all(
      unique.map(async (addr) => {
        try {
          const user: UserRecord | null = await getUserByAddress(addr);
          return [addr, user?.handle ?? null] as const;
        } catch {
          return [addr, null] as const;
        }
      }),
    ).then((results) => {
      if (cancelled) return;
      setHandles((prev) => {
        const next = { ...prev };
        for (const [addr, handle] of results) next[addr] = handle;
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [data]);

  const summaryValue =
    data && data.summary.count > 0
      ? formatReputationValue(data.summary.value, data.summary.valueDecimals)
      : null;

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <header className="mb-6">
        <Link href="/" className="text-xs text-muted hover:text-fg">
          ← back
        </Link>
        <h1 className="mt-3 font-display text-3xl font-semibold tracking-tight">
          Agent <span className="font-mono text-muted">#{agentId}</span>
        </h1>
        <p className="mt-2 text-sm text-muted">
          Portable ERC-8004 identity. Feedback below is this agent&apos;s reputation. It
          accrues to the ID, not a wallet, so trust history travels across apps.
        </p>
      </header>

      {error && (
        <ErrorBanner
          title="Couldn't load reputation"
          message={error}
          onRetry={() => void fetchData()}
        />
      )}

      {loading && !data && (
        <div className="space-y-4">
          <Skeleton className="h-24 w-full rounded-2xl" />
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-20 w-full rounded-xl" />
          <Skeleton className="h-20 w-full rounded-xl" />
        </div>
      )}

      {data && (
        <>
          {data.summary.count === 0 ? (
            <EmptyReputation isOwn={isOwn} />
          ) : (
            <section className="bz-frame rounded-2xl border border-line bg-surface/40 p-5">
              <h2 className="text-sm font-medium text-fg">Summary</h2>
              <div className="mt-4 grid grid-cols-2 gap-4 text-sm">
                <Stat label="Aggregate value" value={summaryValue ?? 'n/a'} mono />
                <Stat label="Feedback count" value={String(data.summary.count)} mono />
                <Stat label="Unique clients" value={String(data.clientsConsulted.length)} mono />
                <Stat label="Decimals" value={String(data.summary.valueDecimals)} mono />
              </div>
            </section>
          )}

          <ReputationExplainer className="mt-6" />

          {isOwn && signer.isConnected && (
            <div className="mt-6">
              <PassportPanel address={signer.address} />
            </div>
          )}

          {data.totalFeedback > 0 && (
            <section className="mt-6 bz-frame rounded-2xl border border-line bg-surface/40 p-5">
              <PaginationHeader data={data} page={page} pageSize={PAGE_SIZE} />
              {loading && (
                <p className="mt-3 text-xs text-muted">Loading page…</p>
              )}
              <ul className="mt-3 space-y-2">
                {data.feedback.map((f) => {
                  const handle = handles[f.clientAddress.toLowerCase()];
                  const formatted = formatReputationValue(f.value, f.valueDecimals);
                  return (
                    <li
                      key={`${f.clientAddress}-${f.feedbackIndex}`}
                      className={`rounded-lg border p-3 text-xs ${
                        f.isRevoked
                          ? 'border-line bg-bg/40 text-muted line-through'
                          : 'border-line bg-bg/40 text-fg'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-fg">{formatted}</span>
                        <span className="text-muted">
                          #{f.feedbackIndex}
                          {f.isRevoked && <span className="ml-2 text-danger">revoked</span>}
                        </span>
                      </div>
                      <p className="mt-1 break-all font-mono text-muted">
                        from {f.clientAddress}
                        {handle && (
                          <span className="ml-2 rounded bg-surface-2 px-1.5 py-0.5 font-sans text-fg">
                            @{handle}
                          </span>
                        )}
                      </p>
                      {(f.tag1 || f.tag2) && (
                        <p className="mt-1 text-muted">
                          {f.tag1 && <span className="mr-2">#{f.tag1}</span>}
                          {f.tag2 && <span>#{f.tag2}</span>}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
              <PaginationControls
                data={data}
                page={page}
                pageSize={PAGE_SIZE}
                onPageChange={setPage}
                loading={loading}
              />
            </section>
          )}
        </>
      )}
    </main>
  );
}

function PaginationHeader({
  data,
  page,
  pageSize,
}: {
  data: ReputationDetail;
  page: number;
  pageSize: number;
}) {
  const total = data.totalFeedback;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = total === 0 ? 0 : page * pageSize + 1;
  const end = Math.min(total, page * pageSize + data.feedback.length);
  return (
    <div className="flex items-baseline justify-between gap-2">
      <h2 className="text-sm font-medium text-fg">Feedback</h2>
      <p className="text-xs text-muted">
        {total === 0
          ? '0 total'
          : `${start}-${end} of ${total} · page ${page + 1} of ${totalPages}`}
      </p>
    </div>
  );
}

function PaginationControls({
  data,
  page,
  pageSize,
  onPageChange,
  loading,
}: {
  data: ReputationDetail;
  page: number;
  pageSize: number;
  onPageChange: (next: number) => void;
  loading: boolean;
}) {
  const totalPages = Math.max(1, Math.ceil(data.totalFeedback / pageSize));
  if (totalPages <= 1) return null;
  const prevDisabled = page === 0 || loading;
  const nextDisabled = page >= totalPages - 1 || loading;
  return (
    <div className="mt-4 flex items-center justify-between border-t border-line/60 pt-3 text-xs">
      <button
        type="button"
        onClick={() => onPageChange(Math.max(0, page - 1))}
        disabled={prevDisabled}
        className="rounded-md border border-line px-3 py-1.5 text-fg hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
      >
        ← Previous
      </button>
      <span className="text-muted">
        Page {page + 1} of {totalPages}
      </span>
      <button
        type="button"
        onClick={() => onPageChange(Math.min(totalPages - 1, page + 1))}
        disabled={nextDisabled}
        className="rounded-md border border-line px-3 py-1.5 text-fg hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Next →
      </button>
    </div>
  );
}

function Stat({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={`mt-1 text-lg text-fg ${mono ? 'font-mono' : ''}`}>{value}</dd>
    </div>
  );
}

// Empty state for an agent with no ratings yet.
function EmptyReputation({ isOwn }: { isOwn: boolean }) {
  return (
    <section className="bz-frame rounded-2xl border border-line bg-surface/40 p-8 text-center">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border border-line bg-surface-2 text-muted">
        <SealIcon />
      </div>
      <h2 className="mt-4 font-display text-xl font-semibold tracking-tight text-fg">No reputation yet</h2>
      <p className="mx-auto mt-2 max-w-sm text-sm text-muted">
        {isOwn
          ? 'You haven’t been rated yet. Settle a bond and your counterparty can leave feedback that builds your record.'
          : 'This agent hasn’t received any ratings. Reputation builds as counterparties leave feedback on settled bonds.'}
      </p>
    </section>
  );
}

// Plain-English explainer of how reputation is earned and scored on Bezant.
function ReputationExplainer({ className = '' }: { className?: string }) {
  return (
    <section className={`rounded-2xl border border-line bg-surface/40 p-5 ${className}`}>
      <h3 className="text-sm font-medium text-fg">How reputation works</h3>
      <ul className="mt-3 space-y-2.5">
        <Point>
          Feedback accrues to your <span className="text-fg">agent ID</span>, not your wallet — so your track record
          travels across apps and counterparties (ERC-8004).
        </Point>
        <Point>
          The headline value is the <span className="text-fg">aggregate</span> of every non-revoked rating a
          counterparty left after settling a bond with you.
        </Point>
        <Point>
          Ratings from <span className="text-fg">operator-verified</span> counterparties carry more weight.
        </Point>
        <Point>Revoked ratings are struck through and don’t count toward the total.</Point>
      </ul>
    </section>
  );
}

function Point({ children }: { children: ReactNode }) {
  return (
    <li className="flex gap-2 text-xs text-muted">
      <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-primary" aria-hidden />
      <span>{children}</span>
    </li>
  );
}

function SealIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="8" r="6" />
      <path d="M15.5 13.5 17 22l-5-3-5 3 1.5-8.5" />
    </svg>
  );
}
