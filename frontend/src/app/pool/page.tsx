'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useOnChainRefresh } from '@/hooks/use-refresh-chain-data';
import { PoolPanel } from '@/components/pool-panel';
import { RecentPoolStakes } from '@/components/recent-pool-stakes';
import { ContextTabs, ContextHeader } from '@/components/ui';
import { TelegramNudge } from '@/components/telegram-nudge';
import { getPoolStats, type PoolStats } from '@/lib/api';

// Dedicated financing-pool page: a short explainer of the LP vault (what it
// funds, who can deposit, the risk) plus the deposit/withdraw panel.
export default function PoolPage() {
  const [tab, setTab] = useState<'overview' | 'activity'>('overview');
  return (
    <main className="mx-auto max-w-[1440px] px-6 py-16">
      <ContextHeader
        eyebrow="Liquidity"
        title="Financing pool"
        meta="The pool fronts sellers their payment the moment a buyer funds escrow, instead of making them wait out the challenge window. You deposit USDC, receive shares, and earn the financing fees as yield. Anyone with a Bezant account can deposit - no whitelist, no minimum."
      />

      <TelegramNudge />

      <div className="mt-6">
        <ContextTabs
          tabs={[{ key: 'overview', label: 'Overview' }, { key: 'activity', label: 'Activity' }]}
          active={tab}
          onChange={(k) => setTab(k as typeof tab)}
        />
      </div>

      {tab === 'overview' && (
        <div className="bz-fadein">
          <PoolStatsBanner />

          <div className="bz-frame mt-6 rounded-lg border border-warn/40 bg-warn/15 px-5 py-4 text-sm leading-relaxed text-fg">
            <span className="font-medium text-warn">Risk:</span> you bear credit risk. If a financed bond is refunded or the buyer wins a dispute, the advance is written off and the loss is
            shared across all LPs (share price can fall below 1.0). Withdrawals are capped at idle
            liquidity - capital in live advances is locked until those bonds settle.
          </div>

          <div className="mt-8">
            <PoolPanel />
          </div>

          <p className="mt-6 text-xs text-muted">
            Track your position on your{' '}
            <Link href="/profile" className="underline hover:text-muted">
              profile
            </Link>
            .
          </p>
        </div>
      )}

      {tab === 'activity' && (
        <div className="bz-fadein mt-6">
          <RecentPoolStakes />
        </div>
      )}
    </main>
  );
}

// At-a-glance pool health, mirroring the Verify page's staked-TVL banner: a
// headline TVL number with share price / idle / deployed alongside. The
// deposit/withdraw controls and yield strip stay in <PoolPanel/> below.
function PoolStatsBanner() {
  const [stats, setStats] = useState<PoolStats | null>(null);

  const load = useCallback(() => {
    getPoolStats()
      .then(setStats)
      .catch(() => {
        /* pool unreachable - banner stays in its skeleton/quiet state */
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);
  useOnChainRefresh(load); // TVL / idle / deployed update after deposit/withdraw

  return (
    <section className="bz-frame mt-6 rounded-xl border border-line bg-surface p-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted">Pool TVL</div>
          <div className="mt-1 font-mono text-3xl font-semibold tabular-nums text-primary">
            {stats ? stats.totalAssetsUsdc : '—'} <span className="text-sm font-normal text-muted">USDC</span>
          </div>
        </div>
        <dl className="grid grid-cols-3 gap-x-8 gap-y-1 text-sm">
          <BannerStat label="Share price">{stats ? stats.sharePrice.toFixed(4) : '—'}</BannerStat>
          <BannerStat label="Idle">{stats ? `${stats.idleUsdc} USDC` : '—'}</BannerStat>
          <BannerStat label="Deployed">{stats ? `${stats.outstandingUsdc} USDC` : '—'}</BannerStat>
        </dl>
      </div>
    </section>
  );
}

function BannerStat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-0.5 font-mono tabular-nums text-fg">{children}</dd>
    </div>
  );
}
