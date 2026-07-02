'use client';

import { useRef, useState } from 'react';
import type { ProtocolStats } from '@/lib/api';

// 30-day protocol activity. Two filled bands (funded = muted, settled = mint),
// disputed = danger dots, plus an interactive hover crosshair + tooltip. Custom
// SVG (no chart lib) so it stays on-brand and dependency-light.
export function ProtocolChart({ series, height = 200 }: { series: ProtocolStats['series']; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const W = 600;
  const H = 170;
  const top = 14;
  const n = series.length;
  const max = Math.max(1, ...series.flatMap((s) => [s.funded, s.settled, s.disputed]));
  const x = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * W);
  const y = (v: number) => H - (v / max) * (H - top);
  const pctX = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * 100);
  const pctY = (v: number) => (y(v) / H) * 100;

  const linePath = (key: 'funded' | 'settled') =>
    series.map((s, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(s[key]).toFixed(1)}`).join(' ');
  const areaPath = (key: 'funded' | 'settled') => (n ? `${linePath(key)} L${W} ${H} L0 ${H} Z` : '');

  const fmt = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const onMove = (e: React.MouseEvent) => {
    const el = ref.current;
    if (!el || n <= 1) return;
    const rect = el.getBoundingClientRect();
    const f = (e.clientX - rect.left) / rect.width;
    setHover(Math.max(0, Math.min(n - 1, Math.round(f * (n - 1)))));
  };
  const hv = hover != null ? series[hover] : null;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="font-mono text-[11px] text-muted">30-day activity</span>
        <span className="font-mono text-[11px] text-muted">max {max} / day</span>
      </div>

      <div ref={ref} className="relative" style={{ height }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full w-full" aria-hidden>
          <defs>
            <linearGradient id="bz-funded" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="rgb(var(--muted))" stopOpacity="0.16" />
              <stop offset="100%" stopColor="rgb(var(--muted))" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="bz-settled" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="rgb(var(--primary))" stopOpacity="0.28" />
              <stop offset="100%" stopColor="rgb(var(--primary))" stopOpacity="0" />
            </linearGradient>
          </defs>
          <line x1="0" y1={H - 0.5} x2={W} y2={H - 0.5} stroke="rgb(var(--line))" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          {areaPath('funded') && <path d={areaPath('funded')} fill="url(#bz-funded)" />}
          {areaPath('settled') && <path d={areaPath('settled')} fill="url(#bz-settled)" />}
          {n > 0 && (
            <path d={linePath('funded')} fill="none" stroke="rgb(var(--muted))" strokeWidth="1.4" strokeOpacity="0.6" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          )}
          {areaPath('settled') && (
            <path d={linePath('settled')} fill="none" stroke="rgb(var(--primary))" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
          )}
        </svg>

        {/* disputed dots (kept circular via HTML overlay) */}
        {series.map((s, i) =>
          s.disputed > 0 ? (
            <span
              key={i}
              className="absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-danger ring-2 ring-bg"
              style={{ left: `${pctX(i)}%`, top: `${pctY(s.settled)}%` }}
              aria-hidden
            />
          ) : null,
        )}

        {/* hover crosshair + point + tooltip */}
        {hv && (
          <>
            <span className="pointer-events-none absolute top-0 bottom-0 w-px bg-line-strong" style={{ left: `${pctX(hover!)}%` }} aria-hidden />
            <span
              className="pointer-events-none absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary bg-bg"
              style={{ left: `${pctX(hover!)}%`, top: `${pctY(hv.settled)}%` }}
              aria-hidden
            />
            <div
              className="pointer-events-none absolute z-10 min-w-36 -translate-y-2 rounded-lg border border-line bg-bg/95 p-3 shadow-xl backdrop-blur"
              style={{
                left: `${pctX(hover!)}%`,
                top: 0,
                transform: `translateX(${hover! > n / 2 ? '-108%' : '8%'})`,
              }}
            >
              <div className="font-mono text-[11px] text-muted">{fmt(hv.t)}</div>
              <TipRow swatch="bg-primary" label="Settled" value={hv.settled} />
              <TipRow swatch="bg-muted" label="Funded" value={hv.funded} />
              {hv.disputed > 0 && <TipRow swatch="bg-danger" label="Disputed" value={hv.disputed} />}
            </div>
          </>
        )}
      </div>

      <div className="mt-3 flex items-center justify-between">
        <div className="flex gap-4 text-[11px] text-muted">
          <Legend swatch="bg-primary" label="Settled" />
          <Legend swatch="bg-muted" label="Funded" />
          <Legend swatch="bg-danger" label="Disputed" />
        </div>
        {n > 0 && (
          <div className="flex gap-6 font-mono text-[11px] text-muted">
            <span>{fmt(series[0].t)}</span>
            <span>{fmt(series[Math.floor(n / 2)].t)}</span>
            <span>today</span>
          </div>
        )}
      </div>
    </div>
  );
}

function TipRow({ swatch, label, value }: { swatch: string; label: string; value: number }) {
  return (
    <div className="mt-1.5 flex items-center justify-between gap-6 text-xs">
      <span className="inline-flex items-center gap-1.5 text-muted">
        <span className={`h-2 w-2 rounded-[2px] ${swatch}`} aria-hidden />
        {label}
      </span>
      <span className="font-mono font-semibold tabular-nums text-fg">{value}</span>
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
