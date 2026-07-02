'use client';

import type { ProtocolStats } from '@/lib/api';

// 30-day protocol activity, on-brand: settled = mint area+line, funded = a thin
// champagne line, disputed = danger ticks. Deliberately not a stacked area.
export function ProtocolChart({ series, height = 190 }: { series: ProtocolStats['series']; height?: number }) {
  const W = 600;
  const H = 170;
  const top = 12;
  const n = series.length;
  const max = Math.max(1, ...series.flatMap((s) => [s.funded, s.settled, s.disputed]));
  const x = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * W);
  const y = (v: number) => H - (v / max) * (H - top);
  const path = (key: 'funded' | 'settled' | 'disputed') =>
    series.map((s, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(s[key]).toFixed(1)}`).join(' ');

  const settledLine = path('settled');
  const settledArea = n ? `${settledLine} L${W} ${H} L0 ${H} Z` : '';
  const fundedLine = path('funded');
  const fmt = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const mid = Math.floor(n / 2);

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full" style={{ height }} aria-hidden>
        <defs>
          <linearGradient id="bz-proto-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="rgb(var(--primary))" stopOpacity="0.26" />
            <stop offset="100%" stopColor="rgb(var(--primary))" stopOpacity="0" />
          </linearGradient>
        </defs>
        <line x1="0" y1={H - 0.5} x2={W} y2={H - 0.5} stroke="rgb(var(--line))" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        {settledArea && <path d={settledArea} fill="url(#bz-proto-fill)" />}
        {/* funded — thin champagne line */}
        {n > 0 && (
          <path d={fundedLine} fill="none" stroke="rgb(var(--brand))" strokeWidth="1.5" strokeOpacity="0.7" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        )}
        {/* settled — mint line */}
        {settledArea && (
          <path d={settledLine} fill="none" stroke="rgb(var(--primary))" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
        )}
        {/* disputed — danger ticks */}
        {series.map((s, i) =>
          s.disputed > 0 ? (
            <line key={i} x1={x(i)} y1={H} x2={x(i)} y2={H - 22} stroke="rgb(var(--danger))" strokeWidth="2" vectorEffect="non-scaling-stroke" />
          ) : null,
        )}
      </svg>

      <div className="mt-2 flex items-center justify-between">
        <div className="flex gap-4 text-[11px] text-muted">
          <Legend swatch="bg-primary" label="Settled" />
          <Legend swatch="bg-brand" label="Funded" />
          <Legend swatch="bg-danger" label="Disputed" />
        </div>
        {n > 0 && (
          <div className="flex gap-6 font-mono text-[11px] text-muted">
            <span>{fmt(series[0].t)}</span>
            <span>{fmt(series[mid].t)}</span>
            <span>today</span>
          </div>
        )}
      </div>
    </div>
  );
}

function Legend({ swatch, label }: { swatch: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-2 w-2 rounded-[2px] ${swatch}`} aria-hidden />
      {label}
    </span>
  );
}
