'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSigner } from '@/hooks/use-signer';
import {
  getPactsByAddress,
  getPactState,
  type PactIndexEntry,
  type PactLiveState,
  type PactRole,
} from '@/lib/api';
import { CountdownChip } from '@/components/countdown';
import { displayStatus } from '@/lib/pact-status';
import { ErrorBanner, ListItemSkeleton } from '@/components/async-state';

type EnrichedPact = PactIndexEntry & {
  live: PactLiveState | null;
  error?: string;
};

// On-chain status only transitions to "Expired" when someone calls claimRefund
// (or "Rejected" via reject). A pact past its deadline that nobody has acted on
// stays in its prior status (Open / Funded / Submitted). For users that's
// confusing — they want "past deadline" to read as Expired. We compute an
// effective status here for display + filtering. Terminal statuses are passed
// through unchanged.
function effectiveStatus(pact: EnrichedPact, nowMs: number): string {
  if (!pact.live) return 'Loading…';
  const raw = pact.live.status;
  if (raw === 'Completed' || raw === 'Rejected' || raw === 'Expired') {
    return displayStatus(pact.live, raw);
  }
  if (pact.live.expiredAt.unix * 1000 < nowMs) return 'Expired';
  return raw;
}

const STATUS_OPTIONS = ['All', 'Open', 'Funded', 'Submitted', 'Completed', 'Cancelled', 'Rejected', 'Expired'] as const;
type StatusFilter = (typeof STATUS_OPTIONS)[number];

const SORT_OPTIONS = [
  { key: 'date_desc', label: 'Newest first' },
  { key: 'date_asc', label: 'Oldest first' },
  { key: 'amount_desc', label: 'Highest budget' },
  { key: 'amount_asc', label: 'Lowest budget' },
] as const;
type SortKey = (typeof SORT_OPTIONS)[number]['key'];

const ROLE_LABEL: Record<PactRole, string> = {
  client: 'Client',
  provider: 'Provider',
  evaluator: 'Evaluator',
};

const STATUS_TINT: Record<string, string> = {
  Open: 'bg-sky-950/40 text-sky-300 border-sky-900/60',
  Funded: 'bg-amber-950/40 text-amber-300 border-amber-900/60',
  Submitted: 'bg-violet-950/40 text-violet-300 border-violet-900/60',
  Completed: 'bg-emerald-950/40 text-emerald-300 border-emerald-900/60',
  // Cancelled is a client-cancelled-before-funding case; softer than Rejected
  // since no work was rejected, just an unfunded pact withdrawn.
  Cancelled: 'bg-neutral-900 text-neutral-400 border-neutral-800',
  Rejected: 'bg-red-950/40 text-red-300 border-red-900/60',
  Expired: 'bg-neutral-900 text-neutral-400 border-neutral-800',
};

// Waiting-cue color matches the status badge so card + cue read as one.
// Only non-terminal statuses have entries — terminal states don't pulse.
const WAITING_TINT: Record<'Open' | 'Funded' | 'Submitted', {
  ping: string;
  solid: string;
  text: string;
}> = {
  Open: { ping: 'bg-sky-400', solid: 'bg-sky-500', text: 'text-sky-300' },
  Funded: { ping: 'bg-amber-400', solid: 'bg-amber-500', text: 'text-amber-300' },
  Submitted: { ping: 'bg-violet-400', solid: 'bg-violet-500', text: 'text-violet-300' },
};

export default function MyPactsPage() {
  const signer = useSigner();
  const [pacts, setPacts] = useState<EnrichedPact[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('All');
  const [sortKey, setSortKey] = useState<SortKey>('date_desc');

  const fetchPacts = useCallback(async () => {
    if (!signer.isConnected) return;
    setLoading(true);
    setError(null);
    try {
      const index = await getPactsByAddress(signer.address.toLowerCase());
      // Set the base list immediately so the UI shows skeletons while we enrich.
      setPacts(index.map((entry) => ({ ...entry, live: null })));
      // Enrich each with live on-chain state in parallel.
      const enriched = await Promise.all(
        index.map(async (entry) => {
          try {
            const live = await getPactState(entry.pactId);
            return { ...entry, live } as EnrichedPact;
          } catch (err) {
            return {
              ...entry,
              live: null,
              error: err instanceof Error ? err.message : String(err),
            } as EnrichedPact;
          }
        }),
      );
      setPacts(enriched);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [signer.isConnected, signer.address]);

  useEffect(() => {
    void fetchPacts();
  }, [fetchPacts]);

  const visiblePacts = useMemo(() => {
    const now = Date.now();
    let list = pacts;
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
  }, [pacts, statusFilter, sortKey]);

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <header className="mb-8 flex items-center justify-between gap-4">
        <div>
          <Link href="/" className="text-xs text-neutral-500 hover:text-neutral-100">
            ← back
          </Link>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight">My pacts</h1>
          <p className="mt-2 text-sm text-neutral-400">
            Every pact on Arc where you&apos;re a client, provider, or evaluator.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void fetchPacts()}
          disabled={loading || !signer.isConnected}
          className="rounded-lg border border-neutral-800 px-3 py-1.5 text-xs text-neutral-300 transition hover:text-neutral-100 disabled:opacity-50"
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>

      {/* Tabs — only "My pacts" today; "All pacts" tab will land in a future iteration. */}
      <nav className="mb-6 flex gap-1 border-b border-neutral-800 text-sm">
        <span className="rounded-t-md border-b-2 border-neutral-100 px-3 py-2 text-neutral-100">
          My pacts
        </span>
        <span className="rounded-t-md px-3 py-2 text-neutral-600">All pacts (coming soon)</span>
      </nav>

      {!signer.isConnected && (
        <div className="rounded-xl border border-amber-900/40 bg-amber-950/20 p-4 text-sm text-amber-200">
          Connect a wallet or sign in with a passkey to see your pacts.{' '}
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
              {visiblePacts.length} of {pacts.length} pact{pacts.length === 1 ? '' : 's'}
            </span>
          </div>

          {error && (
            <ErrorBanner
              title="Couldn't load your pacts"
              message={error}
              onRetry={() => void fetchPacts()}
            />
          )}

          {!error && loading && pacts.length === 0 && (
            <ul className="space-y-3">
              <ListItemSkeleton />
              <ListItemSkeleton />
              <ListItemSkeleton />
            </ul>
          )}

          {!error && !loading && pacts.length === 0 && (
            <div className="rounded-xl border border-neutral-800 bg-neutral-900/30 p-8 text-center">
              <p className="text-neutral-300">No pacts yet.</p>
              <p className="mt-2 text-xs text-neutral-500">
                Either you haven&apos;t posted any pacts, or you&apos;re not yet listed as a
                provider/evaluator on someone else&apos;s. The indexer catches new pacts within ~10s.
                Try Refresh after posting.
              </p>
              <Link
                href="/create"
                className="mt-4 inline-block rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-950 hover:bg-white"
              >
                Create a pact
              </Link>
            </div>
          )}

          <ul className="space-y-3">
            {visiblePacts.map((pact) => (
              <PactCard key={pact.pactId} pact={pact} />
            ))}
          </ul>
        </>
      )}
    </main>
  );
}

// Non-terminal pacts get a one-line "Waiting on X..." cue with a pulsing
// dot + text. Completed/Rejected/Expired return null — terminal states
// have nothing to wait on. The detail page's lifecycle timeline tells the
// full story; this list-card cue is the at-a-glance preview.
function pactWaitingLine(live: PactLiveState | null, effectiveStatus: string): string | null {
  if (!live) return null;
  if (
    effectiveStatus === 'Completed' ||
    effectiveStatus === 'Rejected' ||
    effectiveStatus === 'Expired'
  ) {
    return null;
  }
  if (live.status === 'Open') {
    return live.budget.usdc === '0'
      ? 'Waiting for the provider to quote a price…'
      : 'Waiting for the client to fund the pact…';
  }
  if (live.status === 'Funded') {
    return 'Waiting for the provider to submit a deliverable…';
  }
  if (live.status === 'Submitted') {
    return 'Waiting for the evaluator to complete or reject…';
  }
  return null;
}

function PactCard({ pact }: { pact: EnrichedPact }) {
  const status = effectiveStatus(pact, Date.now());
  const isSoftExpired =
    status === 'Expired' && pact.live?.status !== 'Expired' && pact.live?.status !== 'Rejected';
  const statusClass =
    STATUS_TINT[status] ?? 'bg-neutral-900 text-neutral-400 border-neutral-800';
  // Show the pulsing cue for every non-terminal pact. effectiveStatus may
  // upgrade Open/Funded/Submitted → Expired past the deadline; suppress
  // the cue in that case so the soft-expired notice stays the focus.
  const waitingLine = pactWaitingLine(pact.live, status);
  // pactWaitingLine guarantees null unless live.status is Open / Funded /
  // Submitted, so the type assertion is sound and TS keeps WAITING_TINT
  // narrow to those three keys.
  const waitingTint = waitingLine
    ? WAITING_TINT[pact.live!.status as keyof typeof WAITING_TINT]
    : null;

  return (
    <li>
      <Link
        href={`/pacts/${pact.pactId}`}
        className="block rounded-xl border border-neutral-800 bg-neutral-900/40 p-4 transition hover:border-neutral-700 hover:bg-neutral-900/70"
      >
      <div className="flex items-start justify-between gap-4">
        {/* Left column: identity + content */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm text-neutral-300">#{pact.pactId}</span>
            <span
              className={`rounded-md border px-2 py-0.5 text-xs ${statusClass}`}
            >
              {status}
            </span>
            {/* Countdown chip — at-a-glance urgency for non-terminal pacts.
                Terminal states (Completed/Rejected) don't have a meaningful
                deadline anymore. */}
            {status !== 'Completed' && status !== 'Rejected' && pact.live?.status !== 'Expired' && (
              <CountdownChip unix={pact.live?.expiredAt.unix ?? pact.expiredAt} />
            )}
          </div>
          {pact.live?.description && (
            <p className="mt-2 truncate text-sm text-neutral-200">{pact.live.description}</p>
          )}
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-500">
            <span>
              Budget:{' '}
              <span className="text-neutral-300">
                {pact.live ? `${pact.live.budget.usdc} USDC` : '…'}
              </span>
            </span>
            <span>
              Expires:{' '}
              <span className="text-neutral-300">
                {pact.live
                  ? new Date(pact.live.expiredAt.iso).toLocaleString()
                  : new Date(pact.expiredAt * 1000).toLocaleString()}
              </span>
            </span>
          </div>
        </div>

        {/* Right column: roles top-aligned (matching #id row), pulsing
            waiting cue stacked beneath. flex-shrink-0 keeps it from being
            squeezed on narrow viewports. */}
        <div className="flex flex-shrink-0 flex-col items-end gap-3">
          <div className="flex flex-wrap justify-end gap-2">
            {pact.roles.map((role) => (
              <span
                key={role}
                className="rounded-md border border-neutral-800 px-2 py-0.5 text-xs text-neutral-400"
              >
                {ROLE_LABEL[role]}
              </span>
            ))}
          </div>
          {waitingLine && waitingTint && (
            <div className={`flex items-center gap-2 text-xs ${waitingTint.text}`}>
              <span className="relative flex h-2 w-2">
                <span
                  className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${waitingTint.ping}`}
                />
                <span
                  className={`relative inline-flex h-2 w-2 rounded-full ${waitingTint.solid}`}
                />
              </span>
              <span className="animate-pulse">{waitingLine}</span>
            </div>
          )}
        </div>
      </div>
      {isSoftExpired && (
        <p className="mt-2 text-xs text-neutral-500">
          Deadline passed but on-chain status is still <span className="font-mono">{pact.live?.status}</span>.
          Anyone can call claimRefund to release funds back to the client.
        </p>
      )}
      {pact.error && (
        <p className="mt-2 text-xs text-red-400">Couldn&apos;t read live state: {pact.error}</p>
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
