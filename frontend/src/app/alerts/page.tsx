'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useNotifications, type NotificationItem } from '@/hooks/use-notifications';
import { useSigner } from '@/hooks/use-signer';

export default function AlertsPage() {
  const signer = useSigner();
  const { items, unreadCount, markAllRead, markRead, isLoading, isError, errorMessage } =
    useNotifications();
  const router = useRouter();

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <header className="mb-8 flex items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Alerts</h1>
          <p className="mt-2 text-sm text-neutral-400">
            Things that happened on your jobs, things waiting on you, and deadlines closing in.
          </p>
        </div>
        {unreadCount > 0 && (
          <button
            type="button"
            onClick={markAllRead}
            className="rounded-lg border border-neutral-800 px-3 py-1.5 text-xs text-neutral-300 transition hover:text-neutral-100"
          >
            Mark all read
          </button>
        )}
      </header>

      {!signer.isConnected && (
        <section className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-6">
          <p className="text-sm text-neutral-300">Connect a wallet to see your alerts.</p>
        </section>
      )}

      {signer.isConnected && isError && (
        <p className="text-sm text-red-400">Couldn&apos;t load alerts: {errorMessage}</p>
      )}

      {signer.isConnected && !isError && isLoading && items.length === 0 && (
        <p className="text-sm text-neutral-500">Loading…</p>
      )}

      {signer.isConnected && !isError && !isLoading && items.length === 0 && (
        <section className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-6 text-center">
          <p className="text-sm text-neutral-300">No alerts yet.</p>
          <p className="mt-2 text-xs text-neutral-500">
            Create or join a job and we&apos;ll surface things needing your attention here.
          </p>
          <Link
            href="/create"
            className="mt-4 inline-block rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-950 hover:bg-white"
          >
            Create a job
          </Link>
        </section>
      )}

      {items.length > 0 && (
        <ul className="space-y-2">
          {items.map((item) => (
            <AlertCard
              key={item.key}
              item={item}
              onOpen={() => {
                markRead(item.key);
                router.push(`/jobs/${encodeURIComponent(item.jobId)}`);
              }}
            />
          ))}
        </ul>
      )}
    </main>
  );
}

function AlertCard({ item, onOpen }: { item: NotificationItem; onOpen: () => void }) {
  const accentBorder: Record<NotificationItem['kind'], string> = {
    action: 'border-l-emerald-500',
    deadline: 'border-l-amber-500',
    event: 'border-l-neutral-600',
    status: 'border-l-sky-600/70',
  };
  const kindLabel: Record<NotificationItem['kind'], string> = {
    action: 'Action required',
    deadline: 'Deadline',
    event: 'Event',
    status: 'Status',
  };

  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className={`flex w-full items-start justify-between gap-3 rounded-xl border border-neutral-800 border-l-2 ${accentBorder[item.kind]} bg-neutral-900/40 p-4 text-left transition hover:border-neutral-700 ${
          item.read ? 'opacity-60' : ''
        }`}
      >
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-wider text-neutral-500">
            {kindLabel[item.kind]}
          </div>
          <div className="mt-1 text-sm text-neutral-100">{item.summary}</div>
          {item.whenIso && (
            <div className="mt-1 text-[11px] text-neutral-500">
              {new Date(item.whenIso).toLocaleString()}
            </div>
          )}
        </div>
        <span className="text-neutral-600">›</span>
      </button>
    </li>
  );
}
