import type { TradeStep } from '@/lib/trade-status';

// The "blinker" next-action cue: a pinging colored dot + tinted text. Amber when
// it's the connected user's turn to act, sky when they're waiting on the
// counterparty. Shared by the trades list cards and the trade-detail page.
export function StepCue({ step, compact = false }: { step: TradeStep; compact?: boolean }) {
  const c = step.forMe
    ? { dot: 'bg-amber-400', text: 'text-amber-200' }
    : { dot: 'bg-sky-400', text: 'text-sky-300' };
  return (
    <div className="flex items-center gap-2">
      <span className="relative flex h-2 w-2 shrink-0">
        <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-70 ${c.dot}`} />
        <span className={`relative inline-flex h-2 w-2 rounded-full ${c.dot}`} />
      </span>
      <span className={`animate-pulse ${compact ? 'text-xs' : 'text-sm'} ${c.text}`}>{step.line}</span>
    </div>
  );
}
