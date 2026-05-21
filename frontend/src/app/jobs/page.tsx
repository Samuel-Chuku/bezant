'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSigner } from '@/hooks/use-signer';
import {
  getJobsByAddress,
  getJobState,
  type JobIndexEntry,
  type JobLiveState,
  type JobRole,
} from '@/lib/api';

type EnrichedJob = JobIndexEntry & {
  live: JobLiveState | null;
  error?: string;
};

// On-chain status only transitions to "Expired" when someone calls claimRefund
// (or "Rejected" via reject). A job past its deadline that nobody has acted on
// stays in its prior status (Open / Funded / Submitted). For users that's
// confusing — they want "past deadline" to read as Expired. We compute an
// effective status here for display + filtering. Terminal statuses are passed
// through unchanged.
function effectiveStatus(job: EnrichedJob, nowMs: number): string {
  if (!job.live) return 'Loading…';
  const raw = job.live.status;
  if (raw === 'Completed' || raw === 'Rejected' || raw === 'Expired') return raw;
  if (job.live.expiredAt.unix * 1000 < nowMs) return 'Expired';
  return raw;
}

const STATUS_OPTIONS = ['All', 'Open', 'Funded', 'Submitted', 'Completed', 'Rejected', 'Expired'] as const;
type StatusFilter = (typeof STATUS_OPTIONS)[number];

const SORT_OPTIONS = [
  { key: 'date_desc', label: 'Newest first' },
  { key: 'date_asc', label: 'Oldest first' },
  { key: 'amount_desc', label: 'Highest budget' },
  { key: 'amount_asc', label: 'Lowest budget' },
] as const;
type SortKey = (typeof SORT_OPTIONS)[number]['key'];

const ROLE_LABEL: Record<JobRole, string> = {
  client: 'Client',
  provider: 'Provider',
  evaluator: 'Evaluator',
};

const STATUS_TINT: Record<string, string> = {
  Open: 'bg-sky-950/40 text-sky-300 border-sky-900/60',
  Funded: 'bg-amber-950/40 text-amber-300 border-amber-900/60',
  Submitted: 'bg-violet-950/40 text-violet-300 border-violet-900/60',
  Completed: 'bg-emerald-950/40 text-emerald-300 border-emerald-900/60',
  Rejected: 'bg-red-950/40 text-red-300 border-red-900/60',
  Expired: 'bg-neutral-900 text-neutral-400 border-neutral-800',
};

export default function MyJobsPage() {
  const signer = useSigner();
  const [jobs, setJobs] = useState<EnrichedJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('All');
  const [sortKey, setSortKey] = useState<SortKey>('date_desc');

  const fetchJobs = useCallback(async () => {
    if (!signer.isConnected) return;
    setLoading(true);
    setError(null);
    try {
      const index = await getJobsByAddress(signer.address.toLowerCase());
      // Set the base list immediately so the UI shows skeletons while we enrich.
      setJobs(index.map((entry) => ({ ...entry, live: null })));
      // Enrich each with live on-chain state in parallel.
      const enriched = await Promise.all(
        index.map(async (entry) => {
          try {
            const live = await getJobState(entry.jobId);
            return { ...entry, live } as EnrichedJob;
          } catch (err) {
            return {
              ...entry,
              live: null,
              error: err instanceof Error ? err.message : String(err),
            } as EnrichedJob;
          }
        }),
      );
      setJobs(enriched);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [signer.isConnected, signer.address]);

  useEffect(() => {
    void fetchJobs();
  }, [fetchJobs]);

  const visibleJobs = useMemo(() => {
    const now = Date.now();
    let list = jobs;
    if (statusFilter !== 'All') {
      list = list.filter((j) => effectiveStatus(j, now) === statusFilter);
    }
    const sorted = [...list].sort((a, b) => {
      switch (sortKey) {
        case 'date_desc':
          return b.blockNumber - a.blockNumber;
        case 'date_asc':
          return a.blockNumber - b.blockNumber;
        case 'amount_desc':
          return Number(b.live?.budget.raw ?? 0) - Number(a.live?.budget.raw ?? 0);
        case 'amount_asc':
          return Number(a.live?.budget.raw ?? 0) - Number(b.live?.budget.raw ?? 0);
      }
    });
    return sorted;
  }, [jobs, statusFilter, sortKey]);

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <header className="mb-8 flex items-center justify-between gap-4">
        <div>
          <Link href="/" className="text-xs text-neutral-500 hover:text-neutral-100">
            ← back
          </Link>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight">My jobs</h1>
          <p className="mt-2 text-sm text-neutral-400">
            Every job on Arc where you&apos;re a client, provider, or evaluator.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void fetchJobs()}
          disabled={loading || !signer.isConnected}
          className="rounded-lg border border-neutral-800 px-3 py-1.5 text-xs text-neutral-300 transition hover:text-neutral-100 disabled:opacity-50"
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>

      {/* Tabs — only "My jobs" today; "All jobs" tab will land in a future iteration. */}
      <nav className="mb-6 flex gap-1 border-b border-neutral-800 text-sm">
        <span className="rounded-t-md border-b-2 border-neutral-100 px-3 py-2 text-neutral-100">
          My jobs
        </span>
        <span className="rounded-t-md px-3 py-2 text-neutral-600">All jobs (coming soon)</span>
      </nav>

      {!signer.isConnected && (
        <div className="rounded-xl border border-amber-900/40 bg-amber-950/20 p-4 text-sm text-amber-200">
          Connect a wallet or sign in with a passkey to see your jobs.{' '}
          <Link href="/" className="underline">
            Go to sign-in
          </Link>
          .
        </div>
      )}

      {signer.isConnected && (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-neutral-800 bg-neutral-900/50 p-3 text-sm">
            <Select
              label="Status"
              value={statusFilter}
              onChange={(v) => setStatusFilter(v as StatusFilter)}
              options={STATUS_OPTIONS.map((s) => ({ value: s, label: s }))}
            />
            <Select
              label="Sort by"
              value={sortKey}
              onChange={(v) => setSortKey(v as SortKey)}
              options={SORT_OPTIONS.map((s) => ({ value: s.key, label: s.label }))}
            />
            <span className="ml-auto text-xs text-neutral-500">
              {visibleJobs.length} of {jobs.length} job{jobs.length === 1 ? '' : 's'}
            </span>
          </div>

          {error && (
            <p className="rounded-lg border border-red-900/40 bg-red-950/20 px-3 py-2 text-xs text-red-400">
              {error}
            </p>
          )}

          {!error && jobs.length === 0 && !loading && (
            <div className="rounded-xl border border-neutral-800 bg-neutral-900/30 p-8 text-center">
              <p className="text-neutral-300">No jobs yet.</p>
              <p className="mt-2 text-xs text-neutral-500">
                Either you haven&apos;t posted any jobs, or you&apos;re not yet listed as a
                provider/evaluator on someone else&apos;s. The indexer catches new jobs within ~10s
                — try Refresh after posting.
              </p>
              <Link
                href="/create"
                className="mt-4 inline-block rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-950 hover:bg-white"
              >
                Create a job
              </Link>
            </div>
          )}

          <ul className="space-y-3">
            {visibleJobs.map((job) => (
              <JobCard key={job.jobId} job={job} />
            ))}
          </ul>
        </>
      )}
    </main>
  );
}

function JobCard({ job }: { job: EnrichedJob }) {
  const status = effectiveStatus(job, Date.now());
  const isSoftExpired =
    status === 'Expired' && job.live?.status !== 'Expired' && job.live?.status !== 'Rejected';
  const statusClass =
    STATUS_TINT[status] ?? 'bg-neutral-900 text-neutral-400 border-neutral-800';

  return (
    <li>
      <Link
        href={`/jobs/${job.jobId}`}
        className="block rounded-xl border border-neutral-800 bg-neutral-900/40 p-4 transition hover:border-neutral-700 hover:bg-neutral-900/70"
      >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm text-neutral-300">#{job.jobId}</span>
            <span
              className={`rounded-md border px-2 py-0.5 text-xs ${statusClass}`}
            >
              {status}
            </span>
            {job.roles.map((role) => (
              <span
                key={role}
                className="rounded-md border border-neutral-800 px-2 py-0.5 text-xs text-neutral-400"
              >
                {ROLE_LABEL[role]}
              </span>
            ))}
          </div>
          {job.live?.description && (
            <p className="mt-2 truncate text-sm text-neutral-200">{job.live.description}</p>
          )}
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-500">
            <span>
              Budget:{' '}
              <span className="text-neutral-300">
                {job.live ? `${job.live.budget.usdc} USDC` : '—'}
              </span>
            </span>
            <span>
              Expires:{' '}
              <span className="text-neutral-300">
                {job.live
                  ? new Date(job.live.expiredAt.iso).toLocaleString()
                  : new Date(job.expiredAt * 1000).toLocaleString()}
              </span>
            </span>
          </div>
        </div>
      </div>
      {isSoftExpired && (
        <p className="mt-2 text-xs text-neutral-500">
          Deadline passed but on-chain status is still <span className="font-mono">{job.live?.status}</span>.
          Anyone can call claimRefund to release funds back to the client.
        </p>
      )}
      {job.error && (
        <p className="mt-2 text-xs text-red-400">Couldn&apos;t read live state: {job.error}</p>
      )}
      </Link>
    </li>
  );
}

function Select<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (next: T) => void;
  options: Array<{ value: T; label: string }>;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-neutral-400">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1 text-sm text-neutral-100 focus:border-neutral-600 focus:outline-none"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
