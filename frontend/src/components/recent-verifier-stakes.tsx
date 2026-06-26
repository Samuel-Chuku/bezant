'use client';

// Staking activity on the current verifier module. Defaults to the connected
// wallet's own stakes/unstakes; a "Global" tab shows everyone's (with handles
// where the staker has claimed one).
import { useEffect, useState } from 'react';
import { useSigner } from '@/hooks/use-signer';
import { getVerifierRecent, getVerifierActivity } from '@/lib/api';
import { shortAddress } from '@/lib/format';
import { arcExplorerTxUrl } from '@/lib/explorers';
import { ExternalLinkIcon } from '@/components/external-link-icon';
import { timeAgo } from '@/lib/relative-time';

type Row = { key: string; isStake: boolean; amountUsdc: string; who: string | null; txHash: string; whenMs: number };

export function RecentVerifierStakes() {
  const signer = useSigner();
  const [tab, setTab] = useState<'mine' | 'global'>('mine');
  const [rows, setRows] = useState<Row[] | null>(null);

  // No "mine" to show when disconnected - fall back to global.
  useEffect(() => {
    if (!signer.isConnected) setTab('global');
  }, [signer.isConnected]);

  useEffect(() => {
    let live = true;
    setRows(null);
    const load = async (): Promise<Row[]> => {
      if (tab === 'mine') {
        if (!signer.isConnected) return [];
        const items = await getVerifierActivity(signer.address);
        return items.map((i) => ({ key: i.key, isStake: i.kind === 'verifier-stake', amountUsdc: i.amountUsdc, who: null, txHash: i.txHash, whenMs: i.whenMs }));
      }
      const items = await getVerifierRecent();
      return items.map((i) => ({
        key: i.key,
        isStake: i.kind === 'verifier-stake',
        amountUsdc: i.amountUsdc,
        who: i.handle ? `@${i.handle}` : shortAddress(i.verifier),
        txHash: i.txHash,
        whenMs: i.whenMs,
      }));
    };
    load()
      .then((r) => live && setRows(r))
      .catch(() => live && setRows([]));
    return () => {
      live = false;
    };
  }, [tab, signer.isConnected, signer.address]);

  const empty = tab === 'mine' ? 'You haven’t staked or unstaked yet.' : 'No staking activity yet.';

  return (
    <section className="mt-8">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-xs uppercase tracking-wide text-muted">Staking activity</h2>
          {rows && rows.length > 0 && (
            <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-surface-2 px-1.5 text-[11px] text-muted">{rows.length}</span>
          )}
        </div>
        <div className="flex gap-1 rounded-lg border border-line bg-surface-2 p-0.5">
          <button onClick={() => setTab('mine')} disabled={!signer.isConnected} className={`rounded-md px-2.5 py-1 text-xs transition ${tab === 'mine' ? 'bg-surface text-fg' : 'text-muted hover:text-fg'} disabled:opacity-40`}>Mine</button>
          <button onClick={() => setTab('global')} className={`rounded-md px-2.5 py-1 text-xs transition ${tab === 'global' ? 'bg-surface text-fg' : 'text-muted hover:text-fg'}`}>Global</button>
        </div>
      </div>

      {rows === null ? (
        <p className="mt-3 text-sm text-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="mt-3 rounded-xl border border-line bg-surface px-3 py-8 text-center text-sm text-muted">{empty}</p>
      ) : (
        <ul className="mt-3 divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
          {rows.map((s) => (
            <li key={s.key} className="flex items-center gap-3 px-4 py-3 text-sm transition hover:bg-surface-2">
              <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${s.isStake ? 'bg-primary/10 text-primary' : 'bg-warn/10 text-warn'}`}>
                <Arrow down={s.isStake} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-fg">
                  {s.isStake ? 'Staked' : 'Unstaked'} {s.amountUsdc} <span className="text-xs font-normal text-muted">USDC</span>
                </div>
                {s.who && <div className={`text-xs text-muted ${s.who.startsWith('@') ? '' : 'font-mono'}`}>{s.who}</div>}
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="text-xs text-muted">{timeAgo(s.whenMs)}</span>
                <a href={arcExplorerTxUrl(s.txHash)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-info transition hover:border-line-strong">
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

function Arrow({ down }: { down: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {down ? <path d="M12 5v14M19 12l-7 7-7-7" /> : <path d="M12 19V5M5 12l7-7 7 7" />}
    </svg>
  );
}
