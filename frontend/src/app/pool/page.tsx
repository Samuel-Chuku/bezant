'use client';

import Link from 'next/link';
import { PoolPanel } from '@/components/pool-panel';
import { RecentPoolStakes } from '@/components/recent-pool-stakes';

// Dedicated financing-pool page: a short explainer of the LP vault (what it
// funds, who can deposit, the risk) plus the deposit/withdraw panel.
export default function PoolPage() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-16">
      <header>
        <div className="text-[11px] uppercase tracking-[0.18em] text-emerald-400">Liquidity</div>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Financing pool</h1>
        <p className="mt-3 text-sm leading-relaxed text-neutral-400">
          The pool fronts sellers their payment the moment a buyer funds escrow, instead of making
          them wait out the challenge window. You deposit USDC, receive shares, and earn the
          financing fees as yield. Anyone with an arc-trade account can deposit — no whitelist, no
          minimum.
        </p>
      </header>

      <div className="mt-6 rounded-lg border border-amber-900/40 bg-amber-950/15 px-4 py-3 text-xs leading-relaxed text-neutral-300">
        <span className="font-medium text-amber-200">Risk:</span> you bear credit risk. If a financed
        trade is refunded or the buyer wins a dispute, the advance is written off and the loss is
        shared across all LPs (share price can fall below 1.0). Withdrawals are capped at idle
        liquidity — capital in live advances is locked until those trades settle.
      </div>

      <div className="mt-8">
        <PoolPanel />
      </div>

      <RecentPoolStakes />

      <p className="mt-6 text-xs text-neutral-600">
        Track your position on your{' '}
        <Link href="/profile" className="underline hover:text-neutral-400">
          profile
        </Link>
        .
      </p>
    </main>
  );
}
