'use client';

import { arcExplorerTxUrl } from '@/lib/explorers';
import { timeAgo } from '@/lib/relative-time';
import { ExternalLinkIcon } from '@/components/external-link-icon';
import type { ProtocolStats } from '@/lib/api';

// Event kind → ledger label + status-dot colour. On brand: mint = settled/good,
// champagne = attested (brand/verification), info = funded/financed, danger =
// contested, muted = neutral.
const KIND: Record<string, { label: string; dot: string }> = {
  TradeProposed: { label: 'Proposed', dot: 'bg-muted' },
  TradeAgreed: { label: 'Struck', dot: 'bg-info' },
  TradeFunded: { label: 'Funded', dot: 'bg-info' },
  FinancingAdvanced: { label: 'Financed', dot: 'bg-info' },
  Attested: { label: 'Attested', dot: 'bg-brand' },
  Released: { label: 'Settled', dot: 'bg-primary' },
  Disputed: { label: 'Contested', dot: 'bg-danger' },
  Refunded: { label: 'Refunded', dot: 'bg-warn' },
};

// A live "deal tape": newest deal prints on top; each newly-arrived row fades in
// (rows are keyed by tx+kind, so only new ones animate on poll). Not a marquee.
export function DealTape({ deals, limit = 7 }: { deals: ProtocolStats['recent']; limit?: number }) {
  const shown = deals.slice(0, limit);
  return (
    <div className="bz-frame border border-line bg-surface p-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" aria-hidden />
          <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-brand">Deal tape</div>
        </div>
        <span className="font-mono text-[11px] text-muted">as they land</span>
      </div>

      {shown.length === 0 ? (
        <p className="mt-4 text-sm text-muted">No deals indexed yet.</p>
      ) : (
        <ul className="mt-3">
          {shown.map((d) => {
            const k = KIND[d.kind] ?? { label: d.kind, dot: 'bg-muted' };
            return (
              <li
                key={`${d.txHash}-${d.kind}`}
                className="bz-fadein flex items-center gap-3 border-b border-line/60 py-2.5 text-sm last:border-0"
              >
                <span className={`h-2 w-2 shrink-0 rounded-[2px] ${k.dot}`} aria-hidden />
                <span className="w-12 shrink-0 font-mono text-xs text-muted">#{d.tradeId}</span>
                <span className="flex-1 truncate text-fg">{k.label}</span>
                {d.amountUsdc && (
                  <span className="shrink-0 font-mono tabular-nums text-fg">
                    {Number(d.amountUsdc).toLocaleString()} <span className="text-[10px] text-muted">USDC</span>
                  </span>
                )}
                <span className="w-16 shrink-0 text-right text-xs text-muted">{d.whenMs ? timeAgo(d.whenMs) : '—'}</span>
                <a
                  href={arcExplorerTxUrl(d.txHash)}
                  target="_blank"
                  rel="noreferrer"
                  className="shrink-0 text-muted transition hover:text-fg"
                  aria-label="View transaction"
                >
                  <ExternalLinkIcon />
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
