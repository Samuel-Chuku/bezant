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
import { ChainBalancesCard } from '@/components/chain-balances-card';
import { StruckButton } from '@/components/ui';
import { getPoolStats, getUserStats, type PoolStats, type UserStats } from '@/lib/api';
import { shortAddress } from '@/lib/format';
import { timeAgo } from '@/lib/relative-time';

// Profile dashboard: greeting, at-a-glance metrics, a standing gauge, the credit
// passport, LP + verifier positions, identity/agent, and recent activity.
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
      <main className="mx-auto max-w-[1440px] px-6 py-16">
        <h1 className="font-display text-4xl font-semibold tracking-tight">Profile</h1>
        <p className="mt-6 text-sm text-muted">
          Connect a wallet or sign in to see your profile.{' '}
          <Link href="/" className="underline">
            Sign in
          </Link>
        </p>
      </main>
    );
  }

  const rep = stats?.reputation;

  return (
    <main className="mx-auto max-w-[1440px] px-6 py-12">
      {/* Greeting */}
      <header className="flex flex-wrap items-center justify-between gap-5">
        <div className="flex items-center gap-4">
          <Avatar address={signer.address} size={56} />
          <div className="min-w-0">
            <h1 className="font-display text-4xl font-semibold tracking-tight">
              Hello, {user?.handle ? `@${user.handle}` : shortAddress(signer.address)}
            </h1>
            <p className="mt-1 text-sm text-muted">Your bonds, standing and reputation at a glance.</p>
          </div>
        </div>
        <StruckButton href="/trade/create" icon={<PlusIcon />}>Strike a bond</StruckButton>
      </header>

      {userState.status === 'error' && (
        <p className="mt-6 text-sm text-danger">Couldn&apos;t reach the backend: {userState.message}</p>
      )}

      {/* At-a-glance metrics */}
      <div className="mt-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard label="Bonds" glyph={<VaultGlyph />} value={stats ? String(stats.tradesTotal) : '-'} hint={stats ? `${stats.settled} settled · ${stats.active} active` : undefined} />
        <MetricCard label="Volume" glyph={<StackGlyph />} value={stats ? Number(stats.volumeUsdc).toLocaleString() : '-'} unit="USDC" hint="settled" />
        <MetricCard label="Success rate" glyph={<CheckGlyph />} featured value={stats?.successRate != null ? String(Math.round(stats.successRate * 100)) : '-'} unit="%" hint="settled vs resolved" />
        <MetricCard label="Reputation" glyph={<SealGlyph />} value={rep ? Number(rep.value).toFixed(2) : '-'} hint={rep ? `${rep.count} ratings${rep.operatorVerified ? ' · ✓ boosted' : ''}` : 'no agent linked'} />
      </div>

      {/* Dashboard grid */}
      <div className="mt-4 grid grid-flow-row-dense gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <PassportPanel address={signer.address} />
        </div>

        {/* Standing gauge */}
        <div className="rounded-2xl border border-line bg-surface p-6">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-brand">Standing</div>
          <StandingGauge value={stats?.successRate != null ? stats.successRate * 100 : 0} known={stats?.successRate != null} />
          <div className="mt-2 grid grid-cols-2 gap-3 text-center text-xs">
            <div><div className="font-mono text-lg font-semibold tabular-nums text-fg">{stats?.settled ?? '-'}</div><div className="text-muted">settled</div></div>
            <div><div className="font-mono text-lg font-semibold tabular-nums text-danger">{stats ? Math.max(0, stats.tradesTotal - stats.settled - stats.active) : '-'}</div><div className="text-muted">contested</div></div>
          </div>
        </div>

        {/* Identity + agent */}
        <div className="rounded-2xl border border-line border-l-2 border-l-brand/40 bg-surface p-6">
          <div className="flex items-center gap-3">
            <Avatar address={signer.address} size={40} />
            <div className="min-w-0">
              <div className="truncate font-medium text-fg">
                {user?.handle ? `@${user.handle}` : shortAddress(signer.address)}
              </div>
              <div className="truncate font-mono text-xs text-muted">{signer.address}</div>
            </div>
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
            <Field label="Signing">{signer.mode === 'external' ? 'Wallet' : 'Email + passkey'}</Field>
            {user?.createdAt && (
              <Field label="Member since">
                {new Date(user.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
              </Field>
            )}
          </dl>
          {userState.status === 'ready' && (
            <div className="mt-4 border-t border-line pt-4">
              {user ? (
                <AgentLinkCard variant="compact" currentAgentId={user.agentId} onLink={(agentId) => linkAgentId(agentId)} onRegister={() => registerAgent()} />
              ) : (
                <div className="rounded-xl border border-info/30 bg-info/10 p-4">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-info">ERC-8004 agent</div>
                  <p className="mt-1 text-[11px] leading-snug text-info/70">
                    Claim a handle to link or mint an agent and carry your reputation.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        <LpPositionCard address={signer.address} />
        {stats?.verifier && <VerifierBlock v={stats.verifier} />}

        <div className="lg:col-span-2">
          <RecentActivity />
        </div>
        {signer.mode !== 'external' && <SendPanel />}
        <ChainBalancesCard address={signer.address} />
      </div>
    </main>
  );
}

// ── Metric card: glyph + label + big mono value + hint. `featured` tints mint. ──
function MetricCard({
  label,
  value,
  unit,
  hint,
  glyph,
  featured,
}: {
  label: string;
  value: string;
  unit?: string;
  hint?: string;
  glyph: React.ReactNode;
  featured?: boolean;
}) {
  return (
    <div className={`rounded-2xl border p-5 ${featured ? 'border-primary/40 bg-primary/10' : 'border-line bg-surface'}`}>
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted">{label}</span>
        <span className={featured ? 'text-primary' : 'text-brand'}>{glyph}</span>
      </div>
      <div className="mt-3 font-mono text-3xl font-semibold tabular-nums text-fg">
        {value}
        {unit && <span className="ml-1 text-sm font-normal text-muted">{unit}</span>}
      </div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </div>
  );
}

// Semicircular gauge (0-100). Track + mint value arc, normalized via pathLength.
function StandingGauge({ value, known }: { value: number; known: boolean }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className="relative mt-2">
      <svg viewBox="0 0 200 116" className="mx-auto block w-full max-w-[240px]">
        <path d="M18 100 A82 82 0 0 1 182 100" fill="none" className="stroke-surface-2" strokeWidth="14" strokeLinecap="round" />
        <path
          d="M18 100 A82 82 0 0 1 182 100"
          fill="none"
          className="stroke-primary"
          strokeWidth="14"
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray={`${known ? pct : 0} 100`}
        />
      </svg>
      <div className="absolute inset-x-0 bottom-0 text-center">
        <div className="font-mono text-3xl font-semibold tabular-nums text-fg">{known ? `${Math.round(pct)}%` : '-'}</div>
        <div className="text-[11px] text-muted">bonds in good standing</div>
      </div>
    </div>
  );
}

// ── Small stroke glyphs (18px, currentColor) ──
function VaultGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="12" cy="12" r="3" /><path d="M12 9V5M12 19v-4M15 12h4M5 12h4" />
    </svg>
  );
}
function StackGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <ellipse cx="12" cy="6" rx="8" ry="3" /><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6" /><path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
    </svg>
  );
}
function CheckGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" /><path d="m8.5 12 2.5 2.5L16 9" />
    </svg>
  );
}
function SealGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="1.1 1.4" />
      <path d="M9 12.2l2.1 2.1L15.2 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
  );
}

// Verifier-role panel - only rendered when the user has staked / served.
function VerifierBlock({ v }: { v: NonNullable<UserStats['verifier']> }) {
  const pnl = Number(v.netPnlUsdc);
  return (
    <div className="rounded-2xl border border-info/30 bg-info/10 p-6">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-info">Verifier</div>
        <Link href="/verify" className="text-xs text-info/80 hover:text-info">
          Open ›
        </Link>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-4 text-sm">
        <Field label="Staked">{v.stakeUsdc} USDC{v.lockedUsdc !== '0' ? <span className="text-muted"> · {v.lockedUsdc} locked</span> : null}</Field>
        <Field label="Panels served">{v.panelsServed}</Field>
        <Field label="Accuracy">{v.accuracy != null ? `${Math.round(v.accuracy * 100)}%` : '-'}</Field>
        <Field label="Net rewards">
          <span className={pnl > 0 ? 'text-primary' : pnl < 0 ? 'text-danger' : 'text-fg'}>
            {pnl > 0 ? '+' : ''}{v.netPnlUsdc} USDC
          </span>
        </Field>
      </div>
    </div>
  );
}

// Compact read-only view of the user's stake in the financing pool.
function LpPositionCard({ address }: { address: string }) {
  const [stats, setStats] = useState<PoolStats | null>(null);

  useEffect(() => {
    let live = true;
    getPoolStats(address)
      .then((s) => live && setStats(s))
      .catch(() => {
        /* pool unreachable - leave null */
      });
    return () => {
      live = false;
    };
  }, [address]);

  const hasPosition = stats?.myShares && stats.myShares !== '0';

  return (
    <div className="rounded-2xl border border-line bg-surface p-6">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-brand">Financing pool</div>
        <Link href="/pool" className="text-xs text-muted hover:text-fg">
          Manage ›
        </Link>
      </div>

      {!stats ? (
        <p className="mt-3 text-sm text-muted">Pool unavailable.</p>
      ) : hasPosition ? (
        <>
          <div className="mt-3">
            <div className="font-mono text-2xl font-semibold tabular-nums text-primary">{stats.myValueUsdc} USDC</div>
            <div className="text-xs text-muted">your position</div>
          </div>
          <div className="mt-3">
            <div className="mb-1 text-[10px] uppercase tracking-wide text-muted">Pool yield</div>
            <PoolYieldStrip />
          </div>
        </>
      ) : (
        <p className="mt-3 text-sm text-muted">
          You haven&apos;t deposited yet.{' '}
          <Link href="/pool" className="underline hover:text-fg">
            Learn about the pool →
          </Link>
        </p>
      )}
    </div>
  );
}

// Five most-recent items from the unified feed, action items pulled to the top.
function RecentActivity() {
  const { items, isLoading } = useNotifications();
  const router = useRouter();

  const live = items.filter((it) => it.category !== 'pact');
  const needsAction = (it: NotificationItem) => it.kind === 'action' || it.kind === 'deadline';
  const actions = live.filter(needsAction).slice(0, 2);
  const events = live.filter((it) => !needsAction(it)).slice(0, 5 - actions.length);
  const recent = [...actions, ...events];

  return (
    <div className="rounded-2xl border border-line bg-surface p-6">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-brand">Recent activity</div>
        <Link href="/activity" className="text-xs text-muted hover:text-fg">
          See all ›
        </Link>
      </div>

      {isLoading && recent.length === 0 ? (
        <div className="mt-3 space-y-2.5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex animate-pulse items-center gap-2.5">
              <span className="h-1.5 w-1.5 rounded-full bg-surface-2" />
              <span className="h-3 flex-1 rounded bg-surface-2" />
            </div>
          ))}
        </div>
      ) : recent.length === 0 ? (
        <p className="mt-3 text-sm text-muted">No activity yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-line/70">
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
          className={`mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${needsAction ? 'bg-primary' : 'bg-muted'}`}
          aria-hidden
        />
        <span className="min-w-0 flex-1">
          <span className="text-sm text-fg">{item.summary}</span>
          {needsAction && (
            <span className="ml-2 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
              action
            </span>
          )}
          <span className="mt-0.5 block text-[11px] text-muted">{timeAgo(item.whenMs)}</span>
        </span>
      </button>
    </li>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 text-fg">{children}</dd>
    </div>
  );
}
