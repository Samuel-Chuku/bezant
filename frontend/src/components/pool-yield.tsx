'use client';

import { useEffect, useState } from 'react';
import { getPoolYield, type PoolYield } from '@/lib/api';

// Compact yield strip: cumulative (since inception) + 24h / 7d windows.
// Windows read "—" until the backend has sampled enough NAV history.
export function PoolYieldStrip({ className = '' }: { className?: string }) {
  const [y, setY] = useState<PoolYield | null>(null);

  useEffect(() => {
    let live = true;
    getPoolYield()
      .then((d) => live && setY(d))
      .catch(() => {
        /* unreachable — render nothing */
      });
    return () => {
      live = false;
    };
  }, []);

  if (!y) return null;

  return (
    <div className={`grid grid-cols-3 gap-2 ${className}`}>
      <YieldStat label="All-time" pct={y.cumulativePct} />
      <YieldStat label="24h" pct={y.dayPct} />
      <YieldStat label="7d" pct={y.weekPct} />
    </div>
  );
}

function YieldStat({ label, pct }: { label: string; pct: number | null }) {
  const color = pct == null ? 'text-neutral-500' : pct >= 0 ? 'text-emerald-300' : 'text-red-300';
  return (
    <div className="rounded-lg border border-neutral-900 bg-neutral-950/40 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-neutral-500">{label}</div>
      <div className={`mt-0.5 text-sm font-medium ${color}`} title={pct == null ? 'Not enough history yet' : undefined}>
        {pct == null ? '—' : `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`}
      </div>
    </div>
  );
}
