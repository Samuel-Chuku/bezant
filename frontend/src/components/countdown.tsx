'use client';

import { useEffect, useState } from 'react';

// Urgency color scale. Same thresholds everywhere countdowns render.
type Urgency = 'past' | 'red' | 'amber' | 'emerald';

function urgencyFor(secondsRemaining: number): Urgency {
  if (secondsRemaining <= 0) return 'past';
  if (secondsRemaining < 3600) return 'red'; //   < 1 hour
  if (secondsRemaining < 21600) return 'amber'; // < 6 hours
  return 'emerald';
}

const CHIP_COLOR: Record<Urgency, string> = {
  past: 'border-line bg-bg/60 text-muted',
  red: 'border-danger/60 bg-danger/12 text-danger',
  amber: 'border-warn/60 bg-warn/12 text-warn',
  emerald: 'border-primary/60 bg-primary/12 text-primary',
};

const BANNER_COLOR: Record<Urgency, { bg: string; text: string; dot: string }> = {
  past: {
    bg: 'border-line bg-surface/40',
    text: 'text-muted',
    dot: 'bg-muted',
  },
  red: {
    bg: 'border-danger/60 bg-danger/12',
    text: 'text-danger',
    dot: 'bg-danger',
  },
  amber: {
    bg: 'border-warn/60 bg-warn/12',
    text: 'text-warn',
    dot: 'bg-warn',
  },
  emerald: {
    bg: 'border-primary/60 bg-primary/20',
    text: 'text-primary',
    dot: 'bg-primary',
  },
};

// Coarse formatter for chips - "1h 23m", "4m", "expired". No seconds.
export function formatCoarse(secondsRemaining: number): string {
  if (secondsRemaining <= 0) return 'expired';
  const hours = Math.floor(secondsRemaining / 3600);
  const minutes = Math.floor((secondsRemaining % 3600) / 60);
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
  }
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return `${secondsRemaining}s`;
}

// Fine formatter for the live banner - shows seconds once we're under an hour.
function formatFine(secondsRemaining: number): string {
  if (secondsRemaining <= 0) return 'expired';
  const hours = Math.floor(secondsRemaining / 3600);
  const minutes = Math.floor((secondsRemaining % 3600) / 60);
  const seconds = secondsRemaining % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
  }
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

// Compact chip that ticks itself every second, so list countdowns stay live
// even when the parent list doesn't re-render.
export function CountdownChip({ unix, label }: { unix: number; label?: string }) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  const remaining = unix - now;
  const u = urgencyFor(remaining);
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${CHIP_COLOR[u]}`}
      title={label ?? (remaining > 0 ? 'Time remaining' : 'Past deadline')}
    >
      {formatCoarse(remaining)}
    </span>
  );
}

// Live-ticking banner - updates every second. For the pact-detail page where
// urgency matters and the user is actively deciding.
export function CountdownBanner({
  unix,
  label,
}: {
  unix: number;
  label: string;
}) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  const remaining = unix - now;
  const u = urgencyFor(remaining);
  const color = BANNER_COLOR[u];

  return (
    <div className={`rounded-xl border ${color.bg} p-4`}>
      <div className="flex items-center gap-2">
        <span className={`inline-block h-2 w-2 rounded-full ${color.dot}`} aria-hidden />
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted">
          {label}
        </span>
      </div>
      <div className={`mt-1 font-mono text-2xl tabular-nums ${color.text}`}>
        {formatFine(remaining)}
      </div>
      <div className="mt-0.5 text-[11px] text-muted">
        {remaining > 0
          ? `Deadline: ${new Date(unix * 1000).toLocaleString()}`
          : `Passed: ${new Date(unix * 1000).toLocaleString()}`}
      </div>
    </div>
  );
}
