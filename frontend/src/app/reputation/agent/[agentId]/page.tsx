'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  formatReputationValue,
  getReputation,
  getUserByAddress,
  type ReputationDetail,
  type UserRecord,
} from '@/lib/api';

const PAGE_SIZE = 20;

export default function ReputationPage({
  params,
}: {
  params: Promise<{ agentId: string }>;
}) {
  const { agentId } = use(params);
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
        <Link href="/" className="text-xs text-neutral-500 hover:text-neutral-100">
          ← back
        </Link>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">
          Agent <span className="font-mono text-neutral-400">#{agentId}</span>
        </h1>
        <p className="mt-2 text-sm text-neutral-400">
          Portable ERC-8004 identity. Feedback below is this agent&apos;s reputation — it
          accrues to the ID, not a wallet, so trust history travels across apps.
        </p>
      </header>

      {error && (
        <p className="rounded-lg border border-red-900/40 bg-red-950/20 px-3 py-2 text-xs text-red-400">
          {error}
        </p>
      )}

      {loading && !data && <p className="text-sm text-neutral-500">Loading…</p>}

      {data && (
        <>
          <section className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-5">
            <h2 className="text-sm font-medium text-neutral-300">Summary</h2>
            {data.summary.count === 0 ? (
              <p className="mt-3 text-sm text-neutral-400">
                No feedback yet. This agent hasn&apos;t received any ratings on the
                ReputationRegistry.
              </p>
            ) : (
              <div className="mt-4 grid grid-cols-2 gap-4 text-sm">
                <Stat label="Aggregate value" value={summaryValue ?? '—'} mono />
                <Stat label="Feedback count" value={String(data.summary.count)} mono />
                <Stat
                  label="Unique clients"
                  value={String(data.clientsConsulted.length)}
                  mono
                />
                <Stat label="Decimals" value={String(data.summary.valueDecimals)} mono />
              </div>
            )}
          </section>

          {data.totalFeedback > 0 && (
            <section className="mt-6 rounded-2xl border border-neutral-800 bg-neutral-900/40 p-5">
              <PaginationHeader data={data} page={page} pageSize={PAGE_SIZE} />
              {loading && (
                <p className="mt-3 text-xs text-neutral-500">Loading page…</p>
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
                          ? 'border-neutral-800 bg-neutral-950/40 text-neutral-500 line-through'
                          : 'border-neutral-800 bg-neutral-950/40 text-neutral-200'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-neutral-100">{formatted}</span>
                        <span className="text-neutral-500">
                          #{f.feedbackIndex}
                          {f.isRevoked && <span className="ml-2 text-red-400">revoked</span>}
                        </span>
                      </div>
                      <p className="mt-1 break-all font-mono text-neutral-500">
                        from {f.clientAddress}
                        {handle && (
                          <span className="ml-2 rounded bg-neutral-800 px-1.5 py-0.5 font-sans text-neutral-200">
                            @{handle}
                          </span>
                        )}
                      </p>
                      {(f.tag1 || f.tag2) && (
                        <p className="mt-1 text-neutral-500">
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
      <h2 className="text-sm font-medium text-neutral-300">Feedback</h2>
      <p className="text-xs text-neutral-500">
        {total === 0
          ? '0 total'
          : `${start}–${end} of ${total} · page ${page + 1} of ${totalPages}`}
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
    <div className="mt-4 flex items-center justify-between border-t border-neutral-800/60 pt-3 text-xs">
      <button
        type="button"
        onClick={() => onPageChange(Math.max(0, page - 1))}
        disabled={prevDisabled}
        className="rounded-md border border-neutral-800 px-3 py-1.5 text-neutral-300 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40"
      >
        ← Previous
      </button>
      <span className="text-neutral-500">
        Page {page + 1} of {totalPages}
      </span>
      <button
        type="button"
        onClick={() => onPageChange(Math.min(totalPages - 1, page + 1))}
        disabled={nextDisabled}
        className="rounded-md border border-neutral-800 px-3 py-1.5 text-neutral-300 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40"
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
      <dt className="text-xs text-neutral-500">{label}</dt>
      <dd className={`mt-1 text-lg text-neutral-100 ${mono ? 'font-mono' : ''}`}>{value}</dd>
    </div>
  );
}
