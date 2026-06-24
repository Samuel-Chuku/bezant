'use client';

// Global recent verifier stake/unstake on the current module, so the verify page
// shows live staking activity (not just an empty form). Read-only, public data.
import { useEffect, useState } from 'react';
import { getVerifierRecent, type RecentVerifierStake } from '@/lib/api';
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

export function RecentVerifierStakes() {
  const [items, setItems] = useState<RecentVerifierStake[] | null>(null);

  useEffect(() => {
    getVerifierRecent()
      .then(setItems)
      .catch(() => setItems([]));
  }, []);

  if (items === null) return null; // first load — stay quiet

  return (
    <section className="mt-8">
      <div className="flex items-center gap-2">
        <h2 className="text-xs uppercase tracking-wide text-muted">Recent staking</h2>
        {items.length > 0 && (
          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-surface-2 px-1.5 text-[11px] text-muted">
            {items.length}
          </span>
        )}
      </div>
      {items.length === 0 ? (
        <p className="mt-3 rounded-xl border border-line bg-surface px-3 py-8 text-center text-sm text-muted">No staking activity yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
          {items.map((s) => {
            const isStake = s.kind === 'verifier-stake';
            return (
              <li key={s.key} className="flex items-center gap-3 px-4 py-3 text-sm transition hover:bg-surface-2">
                <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${isStake ? 'bg-emerald-500/10 text-emerald-400' : 'bg-amber-500/10 text-amber-400'}`}>
                  <Arrow down={isStake} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-fg">
                    {isStake ? 'Staked' : 'Unstaked'} {s.amountUsdc} <span className="text-xs font-normal text-muted">USDC</span>
                  </div>
                  <div className="font-mono text-xs text-muted">{shortAddress(s.verifier)}</div>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className="text-xs text-muted">{ago(s.whenMs)}</span>
                  <a
                    href={arcExplorerTxUrl(s.txHash)}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-sky-300 transition hover:border-line-strong"
                  >
                    tx <ExternalLinkIcon />
                  </a>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Arrow({ down }: { down: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {down ? <path d="M12 5v14M19 12l-7 7-7-7" /> : <path d="M12 19V5M5 12l7-7 7 7" />}
    </svg>
  );
}
