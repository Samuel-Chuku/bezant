'use client';

// Lightweight on-brand area chart (mint fill + line). Stretches to width via
// preserveAspectRatio="none"; the stroke stays crisp with non-scaling-stroke.
// Feed it a series of daily counts; pass labels for the x-axis endpoints.
export function ActivityChart({
  data,
  height = 168,
  labels,
}: {
  data: number[];
  height?: number;
  labels?: string[];
}) {
  const W = 600;
  const H = 160;
  const top = 8;
  const max = Math.max(1, ...data);
  const n = data.length;
  const x = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * W);
  const y = (v: number) => H - (v / max) * (H - top);
  const line = data.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const area = data.length ? `${line} L${W} ${H} L0 ${H} Z` : '';

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full" style={{ height }} aria-hidden>
        <defs>
          <linearGradient id="bz-area-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="rgb(var(--primary))" stopOpacity="0.3" />
            <stop offset="100%" stopColor="rgb(var(--primary))" stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* faint baseline */}
        <line x1="0" y1={H - 0.5} x2={W} y2={H - 0.5} stroke="rgb(var(--line))" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        {area && <path d={area} fill="url(#bz-area-fill)" />}
        {area && (
          <path
            d={line}
            fill="none"
            stroke="rgb(var(--primary))"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}
      </svg>
      {labels && labels.length > 0 && (
        <div className="mt-2 flex justify-between font-mono text-[11px] text-muted">
          {labels.map((l, i) => (
            <span key={i}>{l}</span>
          ))}
        </div>
      )}
    </div>
  );
}
