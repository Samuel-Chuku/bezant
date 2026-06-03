'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { getOpenPacts, type OpenPactEntry, type OpenPactsResponse } from '@/lib/api';
import { shortAddress } from '@/lib/format';
import { CountdownChip } from '@/components/countdown';
import { ErrorBanner, ListItemSkeleton } from '@/components/async-state';

const PAGE_SIZE = 20;

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; data: OpenPactsResponse }
  | { status: 'error'; message: string };

// The "Browse" tab of the Pacts hub: every Open ERC-8183 pact on Arc the
// indexer has seen, including pacts created outside arc-trade. Public — no
// wallet required. Extracted from the old standalone /market page.
export function BrowsePacts() {
  // Two layers of filter state — `input` is what the user is typing,
  // `applied` is what the backend was queried with. Keeps requests stable
  // until the user actually hits Apply.
  const [inputMin, setInputMin] = useState('');
  const [inputMax, setInputMax] = useState('');
  const [appliedMin, setAppliedMin] = useState('');
  const [appliedMax, setAppliedMax] = useState('');
  const [offset, setOffset] = useState(0);
  const [state, setState] = useState<LoadState>({ status: 'idle' });

  const fetchPage = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const data = await getOpenPacts({
        limit: PAGE_SIZE,
        offset,
        minBudget: appliedMin || undefined,
        maxBudget: appliedMax || undefined,
      });
      setState({ status: 'ready', data });
    } catch (err) {
      setState({
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [offset, appliedMin, appliedMax]);

  useEffect(() => {
    void fetchPage();
  }, [fetchPage]);

  const apply = () => {
    // Reset to page 1 whenever filters change.
    setAppliedMin(inputMin.trim());
    setAppliedMax(inputMax.trim());
    setOffset(0);
  };

  const reset = () => {
    setInputMin('');
    setInputMax('');
    setAppliedMin('');
    setAppliedMax('');
    setOffset(0);
  };

  const pageInfo = useMemo(() => {
    if (state.status !== 'ready') return null;
    const { total } = state.data;
    const from = total === 0 ? 0 : offset + 1;
    const to = Math.min(offset + PAGE_SIZE, total);
    return { from, to, total };
  }, [state, offset]);

  const hasPrev = offset > 0;
  const hasNext = state.status === 'ready' && offset + PAGE_SIZE < state.data.total;

  return (
    <>
      {/* Filter bar */}
      <section className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-5">
        <div className="text-xs uppercase tracking-wide text-neutral-500">Filter by budget</div>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[120px]">
            <label className="text-[11px] text-neutral-500">Min (USDC)</label>
            <input
              type="text"
              inputMode="decimal"
              value={inputMin}
              onChange={(e) => setInputMin(e.target.value)}
              placeholder="0.00"
              className="mt-1 w-full rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-700 focus:border-neutral-600 focus:outline-none"
            />
          </div>
          <div className="flex-1 min-w-[120px]">
            <label className="text-[11px] text-neutral-500">Max (USDC)</label>
            <input
              type="text"
              inputMode="decimal"
              value={inputMax}
              onChange={(e) => setInputMax(e.target.value)}
              placeholder="any"
              className="mt-1 w-full rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-700 focus:border-neutral-600 focus:outline-none"
            />
          </div>
          <button
            type="button"
            onClick={apply}
            className="rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-950 transition hover:bg-white"
          >
            Apply
          </button>
          {(appliedMin || appliedMax) && (
            <button
              type="button"
              onClick={reset}
              className="rounded-lg border border-neutral-800 px-3 py-2 text-xs text-neutral-400 hover:text-neutral-100"
            >
              Reset
            </button>
          )}
        </div>
        {(appliedMin || appliedMax) && (
          <p className="mt-2 text-[11px] text-neutral-500">
            Active filter: {appliedMin || '0'} – {appliedMax || '∞'} USDC
          </p>
        )}
      </section>

      {/* Results */}
      <section className="mt-6">
        {state.status === 'loading' && (
          <ul className="space-y-3">
            <ListItemSkeleton />
            <ListItemSkeleton />
            <ListItemSkeleton />
            <ListItemSkeleton />
          </ul>
        )}

        {state.status === 'error' && (
          <ErrorBanner
            title="Couldn't load the market"
            message={state.message}
            onRetry={() => void fetchPage()}
          />
        )}

        {state.status === 'ready' && state.data.pacts.length === 0 && (
          <div className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-6 text-center">
            <p className="text-sm text-neutral-300">
              {appliedMin || appliedMax
                ? 'No open pacts match that filter.'
                : 'No open pacts right now.'}
            </p>
            <p className="mt-2 text-xs text-neutral-500">
              {appliedMin || appliedMax
                ? 'Try widening the budget range.'
                : 'Create the first one. Providers will see it here.'}
            </p>
            {(appliedMin || appliedMax) ? (
              <button
                type="button"
                onClick={reset}
                className="mt-4 rounded-lg border border-neutral-800 px-3 py-1.5 text-xs text-neutral-300 hover:text-neutral-100"
              >
                Clear filter
              </button>
            ) : (
              <Link
                href="/create"
                className="mt-4 inline-block rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-950 hover:bg-white"
              >
                Create a pact
              </Link>
            )}
          </div>
        )}

        {state.status === 'ready' && state.data.pacts.length > 0 && (
          <ul className="space-y-3">
            {state.data.pacts.map((pact) => (
              <BrowseCard key={pact.pactId} pact={pact} />
            ))}
          </ul>
        )}
      </section>

      {/* Pagination */}
      {state.status === 'ready' && state.data.total > 0 && (
        <nav className="mt-6 flex items-center justify-between text-xs text-neutral-500">
          <div>
            {pageInfo && (
              <span>
                Showing {pageInfo.from}–{pageInfo.to} of {pageInfo.total}
              </span>
            )}
            <span className="ml-2 text-neutral-700">· scanned {state.data.indexScanned} recent</span>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={!hasPrev}
              onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
              className="rounded-md border border-neutral-800 px-3 py-1.5 text-xs text-neutral-300 transition hover:text-neutral-100 disabled:cursor-not-allowed disabled:opacity-40"
            >
              ← Previous
            </button>
            <button
              type="button"
              disabled={!hasNext}
              onClick={() => setOffset((o) => o + PAGE_SIZE)}
              className="rounded-md border border-neutral-800 px-3 py-1.5 text-xs text-neutral-300 transition hover:text-neutral-100 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Next →
            </button>
          </div>
        </nav>
      )}
    </>
  );
}

function BrowseCard({ pact }: { pact: OpenPactEntry }) {
  return (
    <li className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-4 transition hover:border-neutral-700">
      <Link href={`/pacts/${encodeURIComponent(pact.pactId)}`} className="block">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[11px] text-neutral-500">#{pact.pactId}</span>
              <span className="rounded-md bg-sky-950/40 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-sky-300">
                Open
              </span>
              <CountdownChip unix={pact.expiredAt.unix} />
            </div>
            <p className="mt-2 text-sm text-neutral-100 line-clamp-2">{pact.description || 'No description'}</p>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-neutral-500">
              <span>
                Client <span className="font-mono text-neutral-400">{shortAddress(pact.client)}</span>
              </span>
              <span aria-hidden>·</span>
              <span>
                Provider <span className="font-mono text-neutral-400">{shortAddress(pact.provider)}</span>
              </span>
            </div>
          </div>
          <div className="text-right">
            <div className="font-mono text-sm text-neutral-100">{pact.budget.usdc}</div>
            <div className="text-[10px] uppercase tracking-wide text-neutral-500">USDC quoted</div>
          </div>
        </div>
      </Link>
    </li>
  );
}
