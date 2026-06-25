'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSigner } from '@/hooks/use-signer';
import { useUserRecord } from '@/hooks/use-user-record';
import { useNotifications, type NotificationItem } from '@/hooks/use-notifications';
import { PassportPanel } from '@/components/passport-panel';
import { AgentLinkCard } from '@/components/agent-link-card';
import { SendPanel } from '@/components/send-panel';
import { Avatar } from '@/components/avatar';
import { PoolYieldStrip } from '@/components/pool-yield';
import { getPoolStats, getUserStats, type PoolStats, type UserStats } from '@/lib/api';
import { shortAddress } from '@/lib/format';

// Profile hub: identity (handle / address / signing mode / agent ID), credit
// passport, and the user's LP position in the financing pool. Agent linking
// lives here too; the handle claim is offered via the global setup banner.
export default function ProfilePage() {
  const signer = useSigner();
  const { state: userState, linkAgentId, registerAgent } = useUserRecord();
  const [stats, setStats] = useState<UserStats | null>(null);

  const user = userState.status === 'ready' ? userState.user : null;

  useEffect(() => {
    if (!signer.isConnected) {
      setStats(null);
      return;
    }
    let live = true;
    getUserStats(signer.address)
      .then((s) => live && setStats(s))
      .catch(() => live && setStats(null));
    return () => {
      live = false;
    };
  }, [signer.isConnected, signer.address]);

  if (!signer.isConnected) {
    return (
      <main className="mx-auto max-w-5xl px-6 py-16">
        <h1 className="text-3xl font-semibold tracking-tight">Profile</h1>
        <p className="mt-6 text-sm text-neutral-400">
          Connect a wallet or sign in to see your profile.{' '}
          <Link href="/" className="underline">
            Sign in
          </Link>
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-5xl px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Profile</h1>

      <div className="mt-6 space-y-6">
        {/* Identity + agent linking (compact, on the right) */}
        <section className="rounded-xl border border-neutral-800 bg-neutral-950/50 p-5">
          <div className="flex flex-col gap-5 md:flex-row md:items-start md:justify-between">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-4">
                <Avatar address={signer.address} size={48} />
                <div className="min-w-0">
                  <div className="truncate text-lg font-medium text-neutral-100">
                    {user?.handle ? `@${user.handle}` : shortAddress(signer.address)}
                  </div>
                  <div className="font-mono text-xs text-neutral-500">{signer.address}</div>
                </div>
              </div>

              <dl className="mt-5 grid grid-cols-2 gap-4 text-sm">
                <Field label="Signing">
                  {signer.mode === 'external' ? 'Browser wallet' : 'Email + passkey'}
                </Field>
                {user?.createdAt && (
                  <Field label="Member since">
                    {new Date(user.createdAt).toLocaleDateString(undefined, {
                      year: 'numeric',
                      month: 'short',
                      day: 'numeric',
                    })}
                  </Field>
                )}
              </dl>

              {userState.status === 'loading' && (
                <p className="mt-3 text-xs text-neutral-500">Looking up your account…</p>
              )}
              {userState.status === 'error' && (
                <p className="mt-3 text-xs text-red-400">Couldn&apos;t reach the backend: {userState.message}</p>
              )}
            </div>

            {userState.status === 'ready' && (
              <div className="md:w-72 md:shrink-0">
                {user ? (
                  <AgentLinkCard
                    variant="compact"
                    currentAgentId={user.agentId}
                    onLink={(agentId) => linkAgentId(agentId)}
                    onRegister={() => registerAgent()}
                  />
                ) : (
                  // No backend record yet — agentId links to your user row, so a
                  // profile must exist first (claim a handle via the top banner).
                  <div className="rounded-xl border border-violet-800/50 bg-violet-950/25 p-4">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-violet-300">ERC-8004 agent</div>
                    <p className="mt-1 text-[11px] leading-snug text-violet-300/70">
                      Set up a profile (claim a handle) to link or mint an agent and carry your reputation.
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        </section>

        {/* At-a-glance stats */}
        <StatsStrip stats={stats} />

        {/* Send USDC — passkey (Circle Modular) wallets only; renders null otherwise */}
        <SendPanel />

        {/* Two columns: credit/verifier on the left, pool/activity on the right */}
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-6">
            <PassportPanel address={signer.address} />
            {stats?.verifier && <VerifierBlock v={stats.verifier} />}
          </div>
          <div className="space-y-6">
            <LpPositionCard address={signer.address} />
            <RecentActivity />
          </div>
        </div>
      </div>
    </main>
  );
}

// At-a-glance identity stats: trade history, volume, success rate, reputation.
function StatsStrip({ stats }: { stats: UserStats | null }) {
  const cards: { label: string; value: string; hint?: string }[] = [
    { label: 'Trades', value: stats ? String(stats.tradesTotal) : '—', hint: stats ? `${stats.settled} settled · ${stats.active} active` : undefined },
    { label: 'Volume', value: stats ? `${Number(stats.volumeUsdc).toLocaleString()} USDC` : '—', hint: 'settled' },
    { label: 'Success rate', value: stats?.successRate != null ? `${Math.round(stats.successRate * 100)}%` : '—', hint: 'settled vs resolved' },
    {
      label: 'Reputation',
      value: stats?.reputation ? Number(stats.reputation.value).toFixed(2) : '—',
      hint: stats?.reputation ? `${stats.reputation.count} ratings${stats.reputation.operatorVerified ? ' · ✓ boosted' : ''}` : 'no agent linked',
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {cards.map((c) => (
        <div key={c.label} className="rounded-xl border border-neutral-800 bg-neutral-950/50 p-4">
          <div className="text-[11px] uppercase tracking-wide text-neutral-500">{c.label}</div>
          <div className="mt-1 text-xl font-semibold text-neutral-100">{c.value}</div>
          {c.hint && <div className="mt-0.5 text-[11px] text-neutral-500">{c.hint}</div>}
        </div>
      ))}
    </div>
  );
}

// Verifier-role panel — only rendered when the user has staked / served.
function VerifierBlock({ v }: { v: NonNullable<UserStats['verifier']> }) {
  const pnl = Number(v.netPnlUsdc);
  return (
    <div className="rounded-xl border border-violet-900/40 bg-violet-950/15 p-5">
      <div className="flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-wide text-violet-300">Verifier</div>
        <Link href="/verify" className="text-xs text-violet-300/80 hover:text-violet-200">
          Open ›
        </Link>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-4 text-sm">
        <Field label="Staked">{v.stakeUsdc} USDC{v.lockedUsdc !== '0' ? <span className="text-neutral-500"> · {v.lockedUsdc} locked</span> : null}</Field>
        <Field label="Panels served">{v.panelsServed}</Field>
        <Field label="Accuracy">{v.accuracy != null ? `${Math.round(v.accuracy * 100)}%` : '—'}</Field>
        <Field label="Net rewards">
          <span className={pnl > 0 ? 'text-emerald-300' : pnl < 0 ? 'text-red-300' : 'text-neutral-200'}>
            {pnl > 0 ? '+' : ''}{v.netPnlUsdc} USDC
          </span>
        </Field>
      </div>
    </div>
  );
}

// Compact read-only view of the user's stake in the financing pool. Deposits
// and withdrawals happen on the /pool page; this just surfaces the position.
function LpPositionCard({ address }: { address: string }) {
  const [stats, setStats] = useState<PoolStats | null>(null);

  useEffect(() => {
    let live = true;
    getPoolStats(address)
      .then((s) => live && setStats(s))
      .catch(() => {
        /* pool unreachable — leave null */
      });
    return () => {
      live = false;
    };
  }, [address]);

  const hasPosition = stats?.myShares && stats.myShares !== '0';

  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-950/50 p-5">
      <div className="flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-wide text-neutral-500">Financing pool (LP)</div>
        <Link href="/pool" className="text-xs text-neutral-400 hover:text-neutral-100">
          Manage ›
        </Link>
      </div>

      {!stats ? (
        <p className="mt-3 text-sm text-neutral-500">Pool unavailable.</p>
      ) : hasPosition ? (
        <>
          <div className="mt-3">
            <div className="text-2xl font-semibold text-emerald-300">{stats.myValueUsdc} USDC</div>
            <div className="text-xs text-neutral-500">your position</div>
          </div>
          <div className="mt-3">
            <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-600">Pool yield</div>
            <PoolYieldStrip />
          </div>
        </>
      ) : (
        <p className="mt-3 text-sm text-neutral-400">
          You haven&apos;t deposited yet.{' '}
          <Link href="/pool" className="underline hover:text-neutral-200">
            Learn about the pool →
          </Link>
        </p>
      )}
    </div>
  );
}

// Five most-recent items from the unified feed, with anything needing the
// user's action pulled to the top and flagged. Full history lives on /activity.
function RecentActivity() {
  const { items, isLoading } = useNotifications();
  const router = useRouter();

  // Drop parked pact-era items (the standalone trade flow is the live product;
  // the pact system is unlinked) so the feed tracks current trade/pool/verifier
  // activity instead of stale "Pact #… " wordings.
  const live = items.filter((it) => it.category !== 'pact');

  // Pending actions carry a deadline-based timestamp (often in the future), so
  // a naive "5 most recent" lets them crowd out genuinely-recent pool/trade
  // events. Reserve up to 2 slots for the most urgent pending actions, then
  // fill the rest with the latest actual events — so a fresh deposit/withdrawal
  // always shows here. Full history + "Needs action" filter live on /activity.
  const needsAction = (it: NotificationItem) => it.kind === 'action' || it.kind === 'deadline';
  const actions = live.filter(needsAction).slice(0, 2);
  const events = live.filter((it) => !needsAction(it)).slice(0, 5 - actions.length);
  const recent = [...actions, ...events];

  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-950/50 p-5">
      <div className="flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-wide text-neutral-500">Recent activity</div>
        <Link href="/activity" className="text-xs text-neutral-400 hover:text-neutral-100">
          See all Activities ›
        </Link>
      </div>

      {isLoading && recent.length === 0 ? (
        <div className="mt-3 space-y-2.5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex animate-pulse items-center gap-2.5">
              <span className="h-1.5 w-1.5 rounded-full bg-neutral-800" />
              <span className="h-3 flex-1 rounded bg-neutral-800" />
            </div>
          ))}
        </div>
      ) : recent.length === 0 ? (
        <p className="mt-3 text-sm text-neutral-400">No activity yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-neutral-800/70">
          {recent.map((it, i) => (
            <ActivityRow key={`${it.key}-${i}`} item={it} onClick={() => router.push(it.href ?? '/activity')} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ActivityRow({ item, onClick }: { item: NotificationItem; onClick: () => void }) {
  const needsAction = item.kind === 'action' || item.kind === 'deadline';
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={`flex w-full items-start gap-2.5 py-2.5 text-left transition hover:opacity-80 ${
          item.read && !needsAction ? 'opacity-60' : ''
        }`}
      >
        <span
          className={`mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
            needsAction ? 'bg-emerald-400' : 'bg-neutral-600'
          }`}
          aria-hidden
        />
        <span className="min-w-0 flex-1 text-sm text-neutral-200">
          {item.summary}
          {needsAction && (
            <span className="ml-2 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">
              action
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-neutral-500">{label}</dt>
      <dd className="mt-0.5 text-neutral-200">{children}</dd>
    </div>
  );
}
