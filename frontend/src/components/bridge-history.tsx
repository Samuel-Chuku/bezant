'use client';

import { useEffect, useState } from 'react';
import { useSigner } from '@/hooks/use-signer';
import { loadBridgeHistory, type BridgeHistoryEntry } from '@/lib/bridge-history';
import { shortHash } from '@/lib/format';

export function BridgeHistory() {
  const signer = useSigner();
  const [entries, setEntries] = useState<BridgeHistoryEntry[]>([]);

  useEffect(() => {
    if (!signer.isConnected) {
      setEntries([]);
      return;
    }
    setEntries(loadBridgeHistory(signer.address));
    // Re-read on focus so a bridge run in another tab refreshes here too.
    const onFocus = () => {
      if (signer.isConnected) setEntries(loadBridgeHistory(signer.address));
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [signer.isConnected, signer.isConnected ? signer.address : null]);

  if (!signer.isConnected) return null;

  return (
    <section className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-6">
      <h2 className="text-sm font-medium text-neutral-100">Recent bridges</h2>
      <p className="mt-1 text-xs text-neutral-500">
        Last 3 bridge runs from this browser, keyed to your address.
      </p>

      {entries.length === 0 ? (
        <p className="mt-4 text-xs text-neutral-500">No recent bridges yet.</p>
      ) : (
        <ul className="mt-4 space-y-2">
          {entries.map((entry) => (
            <HistoryRow key={entry.id} entry={entry} />
          ))}
        </ul>
      )}
    </section>
  );
}

function HistoryRow({ entry }: { entry: BridgeHistoryEntry }) {
  const ok = entry.status === 'success';
  return (
    <li className="rounded-lg border border-neutral-800 bg-neutral-950/40 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm text-neutral-100">
            {entry.amount} USDC from {entry.sourceFullName}
          </div>
          <div className="mt-0.5 text-[11px] text-neutral-500">{relativeTime(entry.timestamp)}</div>
        </div>
        <span
          className={[
            'shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
            ok ? 'bg-emerald-950/40 text-emerald-300' : 'bg-red-950/40 text-red-300',
          ].join(' ')}
        >
          {ok ? 'Success' : 'Failed'}
        </span>
      </div>
      {entry.mintTxHash && entry.mintExplorerUrl && (
        <a
          href={entry.mintExplorerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1 inline-block font-mono text-[10px] text-neutral-500 hover:text-neutral-300"
        >
          Mint {shortHash(entry.mintTxHash)} ↗
        </a>
      )}
      {!ok && entry.errorMessage && (
        <p className="mt-1 text-[11px] text-red-400">{entry.errorMessage}</p>
      )}
    </li>
  );
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
