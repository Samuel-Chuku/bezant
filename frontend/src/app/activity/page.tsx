'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useNotifications, type NotificationItem } from '@/hooks/use-notifications';
import { useSigner } from '@/hooks/use-signer';
import { arcExplorerTxUrl } from '@/lib/explorers';
import { ExternalLinkIcon } from '@/components/external-link-icon';
import { timeAgo } from '@/lib/relative-time';

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
          <p className="mt-2 text-sm text-muted">
            Your trades and pool moves, things waiting on you, and deadlines closing in.
          </p>
        </div>
        {unreadCount > 0 && (
          <button
            type="button"
            onClick={markAllRead}
            className="shrink-0 rounded-lg border border-line px-3 py-1.5 text-xs text-fg transition hover:text-fg"
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
                    ? 'bg-primary text-primary-fg'
                    : 'border border-line text-muted hover:text-fg',
                ].join(' ')}
              >
                {f.label}
              </button>
            );
          })}
        </div>
      )}

      {!signer.isConnected && (
        <section className="rounded-2xl border border-line bg-surface/40 p-6">
          <p className="text-sm text-fg">Connect a wallet to see your activity.</p>
        </section>
      )}

      {signer.isConnected && isError && (
        <p className="text-sm text-danger">Couldn&apos;t load activity: {errorMessage}</p>
      )}

      {signer.isConnected && !isError && isLoading && items.length === 0 && (
        <ul className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <li key={i} className="animate-pulse rounded-xl border border-line bg-surface/40 p-4">
              <div className="h-3 w-20 rounded bg-surface-2" />
              <div className="mt-2 h-4 w-3/4 rounded bg-surface-2" />
            </li>
          ))}
        </ul>
      )}

      {signer.isConnected && !isError && !isLoading && items.length === 0 && (
        <section className="rounded-2xl border border-line bg-surface/40 p-6 text-center">
          <p className="text-sm text-fg">No activity yet.</p>
          <p className="mt-2 text-xs text-muted">
            Start a trade or deposit into the pool and it&apos;ll show up here.
          </p>
          <div className="mt-4 flex justify-center gap-2">
            <Link
              href="/trade/create"
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-fg hover:bg-primary-hover"
            >
              New trade
            </Link>
            <Link
              href="/pool"
              className="rounded-lg border border-line px-4 py-2 text-sm text-fg hover:text-fg"
            >
              Explore the pool
            </Link>
          </div>
        </section>
      )}

      {signer.isConnected && items.length > 0 && shown.length === 0 && (
        <p className="text-sm text-muted">Nothing matches this filter.</p>
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
  action: { label: 'Action required', className: 'bg-primary/15 text-primary' },
  deadline: { label: 'Deadline', className: 'bg-warn/15 text-warn' },
  event: { label: 'Event', className: 'bg-muted/40 text-fg' },
  status: { label: 'Status', className: 'bg-info/15 text-info' },
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
        className={`flex w-full cursor-pointer items-start justify-between gap-3 rounded-xl border border-line bg-surface/40 p-4 text-left transition hover:border-line-strong ${
          item.read ? 'opacity-60' : ''
        }`}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${badge.className}`}>
              {badge.label}
            </span>
            {!item.read && <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary" aria-label="unread" />}
          </div>
          <div className="mt-2 text-sm text-fg">{item.summary}</div>
          <div className="mt-1 flex items-center gap-3 text-[11px] text-muted">
            <span>{timeAgo(item.whenMs)}</span>
            {item.txHash && (
              <a
                href={arcExplorerTxUrl(item.txHash)}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="inline-flex items-center gap-0.5 text-muted hover:text-fg"
              >
                View tx <ExternalLinkIcon />
              </a>
            )}
          </div>
        </div>
        <span className="mt-0.5 text-muted">›</span>
      </div>
    </li>
  );
}
