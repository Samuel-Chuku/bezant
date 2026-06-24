'use client';

// Global 10 most-recent pool deposits, so the pool page has signal even before
// the visitor has deposited anything themselves. Read-only, public on-chain data.
import { useEffect, useState } from 'react';
import { getRecentPoolStakes, type RecentPoolStake } from '@/lib/api';
import { shortAddress } from '@/lib/format';
import { arcExplorerTxUrl } from '@/lib/explorers';
import { ExternalLinkIcon } from '@/components/external-link-icon';

function ago(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function RecentPoolStakes() {
  const [items, setItems] = useState<RecentPoolStake[] | null>(null);

  useEffect(() => {
    getRecentPoolStakes()
      .then(setItems)
      .catch(() => setItems([]));
  }, []);

  if (items === null) return null; // first load — stay quiet rather than flash empty

  return (
    <section className="mt-8">
      <h2 className="text-xs uppercase tracking-wide text-neutral-500">Recent deposits</h2>
      {items.length === 0 ? (
        <p className="mt-3 rounded-lg border border-neutral-900 bg-neutral-950/40 px-3 py-6 text-center text-sm text-neutral-500">
          No deposits yet — be the first to provide liquidity.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {items.map((s) => (
            <li key={s.key} className="flex items-center justify-between gap-3 rounded-lg border border-neutral-900 bg-neutral-950/40 px-3 py-2 text-sm">
              <div>
                <span className="text-neutral-200">{s.amountUsdc} USDC</span>
                <span className="text-neutral-600"> · {shortAddress(s.lp)}</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-neutral-500">{ago(s.whenMs)}</span>
                <a href={arcExplorerTxUrl(s.txHash)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-sky-300 hover:underline">
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
