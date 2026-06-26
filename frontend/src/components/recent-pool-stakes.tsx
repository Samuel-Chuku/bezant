'use client';

// Global 10 most-recent pool deposits, so the pool page has signal even before
// the visitor has deposited anything themselves. Read-only, public on-chain data.
import { useEffect, useState } from 'react';
import { getRecentPoolStakes, type RecentPoolStake } from '@/lib/api';
import { shortAddress } from '@/lib/format';
import { arcExplorerTxUrl } from '@/lib/explorers';
import { ExternalLinkIcon } from '@/components/external-link-icon';
import { timeAgo } from '@/lib/relative-time';

export function RecentPoolStakes() {
  const [items, setItems] = useState<RecentPoolStake[] | null>(null);

  useEffect(() => {
    getRecentPoolStakes()
      .then(setItems)
      .catch(() => setItems([]));
  }, []);

  if (items === null) return null; // first load - stay quiet rather than flash empty

  return (
    <section className="mt-8">
      <h2 className="text-xs uppercase tracking-wide text-muted">Recent deposits</h2>
      {items.length === 0 ? (
        <p className="mt-3 rounded-xl border border-line bg-bg/40 px-3 py-8 text-center text-sm text-muted">
          No deposits yet - be the first to provide liquidity.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-line overflow-hidden rounded-xl border border-line bg-bg/40">
          {items.map((s) => (
            <li key={s.key} className="flex items-center gap-3 px-4 py-3 transition hover:bg-surface/40">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                <DepositGlyph />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-fg">
                  {s.amountUsdc} <span className="text-xs font-normal text-muted">USDC</span>
                </div>
                <div className="font-mono text-xs text-muted">{shortAddress(s.lp)}</div>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="text-xs text-muted">{timeAgo(s.whenMs)}</span>
                <a
                  href={arcExplorerTxUrl(s.txHash)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-info transition hover:border-line-strong hover:bg-surface"
                >
                  tx <ExternalLinkIcon />
                </a>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function DepositGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 5v9" />
      <path d="m8 11 4 4 4-4" />
      <path d="M5 19h14" />
    </svg>
  );
}
