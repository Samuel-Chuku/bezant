'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useNotifications, type NotificationItem } from '@/hooks/use-notifications';
import { useSigner } from '@/hooks/use-signer';
import { arcExplorerTxUrl } from '@/lib/explorers';
import { ExternalLinkIcon } from '@/components/external-link-icon';

type Filter = 'all' | 'action' | 'trade' | 'pool' | 'verifier';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'action', label: 'Needs action' },
  { id: 'trade', label: 'Trades' },
  { id: 'pool', label: 'Pool' },
  { id: 'verifier', label: 'Verifier' },
];

function matches(item: NotificationItem, filter: Filter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'action':
      return item.kind === 'action' || item.kind === 'deadline';
    case 'trade':
      return item.category === 'trade';
    case 'pool':
      return item.category === 'pool';
    case 'verifier':
      return item.category === 'verifier';
  }
}

export default function ActivityPage() {
  const signer = useSigner();
  const { items, unreadCount, markAllRead, markRead, isLoading, isError, errorMessage } =
    useNotifications();
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>('all');

  const shown = useMemo(() => items.filter((it) => matches(it, filter)), [items, filter]);

  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <header className="mb-6 flex items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Activities</h1>
          <p className="mt-2 text-sm text-neutral-400">
            Your trades and pool moves, things waiting on you, and deadlines closing in.
          </p>
        </div>
        {unreadCount > 0 && (
          <button
            type="button"
            onClick={markAllRead}
            className="shrink-0 rounded-lg border border-neutral-800 px-3 py-1.5 text-xs text-neutral-300 transition hover:text-neutral-100"
          >
            Mark all read
          </button>
        )}
      </header>

      {signer.isConnected && (
        <div className="mb-6 flex flex-wrap gap-2">
          {FILTERS.map((f) => {
            const active = filter === f.id;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => setFilter(f.id)}
                className={[
                  'rounded-full px-3 py-1 text-xs transition',
                  active
                    ? 'bg-neutral-100 text-neutral-900'
                    : 'border border-neutral-800 text-neutral-400 hover:text-neutral-100',
                ].join(' ')}
              >
                {f.label}
              </button>
            );
          })}
        </div>
      )}

      {!signer.isConnected && (
        <section className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-6">
          <p className="text-sm text-neutral-300">Connect a wallet to see your activity.</p>
        </section>
      )}

      {signer.isConnected && isError && (
        <p className="text-sm text-red-400">Couldn&apos;t load activity: {errorMessage}</p>
      )}

      {signer.isConnected && !isError && isLoading && items.length === 0 && (
        <ul className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <li key={i} className="animate-pulse rounded-xl border border-neutral-800 bg-neutral-900/40 p-4">
              <div className="h-3 w-20 rounded bg-neutral-800" />
              <div className="mt-2 h-4 w-3/4 rounded bg-neutral-800" />
            </li>
          ))}
        </ul>
      )}

      {signer.isConnected && !isError && !isLoading && items.length === 0 && (
        <section className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-6 text-center">
          <p className="text-sm text-neutral-300">No activity yet.</p>
          <p className="mt-2 text-xs text-neutral-500">
            Start a trade or deposit into the pool and it&apos;ll show up here.
          </p>
          <div className="mt-4 flex justify-center gap-2">
            <Link
              href="/trade/create"
              className="rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-950 hover:bg-white"
            >
              New trade
            </Link>
            <Link
              href="/pool"
              className="rounded-lg border border-neutral-800 px-4 py-2 text-sm text-neutral-300 hover:text-neutral-100"
            >
              Explore the pool
            </Link>
          </div>
        </section>
      )}

      {signer.isConnected && items.length > 0 && shown.length === 0 && (
        <p className="text-sm text-neutral-500">Nothing matches this filter.</p>
      )}

      {shown.length > 0 && (
        <ul className="space-y-2">
          {shown.map((item, i) => (
            <ActivityCard
              key={`${item.key}-${i}`}
              item={item}
              onOpen={() => {
                markRead(item.key);
                router.push(item.href ?? `/pacts/${encodeURIComponent(item.pactId)}`);
              }}
            />
          ))}
        </ul>
      )}
    </main>
  );
}

const KIND_BADGE: Record<NotificationItem['kind'], { label: string; className: string }> = {
  action: { label: 'Action required', className: 'bg-emerald-500/15 text-emerald-300' },
  deadline: { label: 'Deadline', className: 'bg-amber-500/15 text-amber-300' },
  event: { label: 'Event', className: 'bg-neutral-700/40 text-neutral-300' },
  status: { label: 'Status', className: 'bg-sky-500/15 text-sky-300' },
  pool: { label: 'Pool', className: 'bg-violet-500/15 text-violet-300' },
};

function ActivityCard({ item, onOpen }: { item: NotificationItem; onOpen: () => void }) {
  const badge = KIND_BADGE[item.kind];
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onOpen()}
        className={`flex w-full cursor-pointer items-start justify-between gap-3 rounded-xl border border-neutral-800 bg-neutral-900/40 p-4 text-left transition hover:border-neutral-700 ${
          item.read ? 'opacity-60' : ''
        }`}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${badge.className}`}>
              {badge.label}
            </span>
            {!item.read && <span className="inline-block h-1.5 w-1.5 rounded-full bg-neutral-100" aria-label="unread" />}
          </div>
          <div className="mt-2 text-sm text-neutral-100">{item.summary}</div>
          <div className="mt-1 flex items-center gap-3 text-[11px] text-neutral-500">
            {item.whenIso && <span>{new Date(item.whenIso).toLocaleString()}</span>}
            {item.txHash && (
              <a
                href={arcExplorerTxUrl(item.txHash)}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="inline-flex items-center gap-0.5 text-neutral-400 hover:text-neutral-100"
              >
                View tx <ExternalLinkIcon />
              </a>
            )}
          </div>
        </div>
        <span className="mt-0.5 text-neutral-600">›</span>
      </div>
    </li>
  );
}
