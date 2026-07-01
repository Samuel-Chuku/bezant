'use client';

import { useEffect, useState } from 'react';
import { getPassport, type PassportSnapshot } from '@/lib/api';

// Credit passport snapshot: the buyer's earned deposit level + track record.
export function PassportPanel({ address }: { address?: string }) {
  const [p, setP] = useState<PassportSnapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!address) return;
    let live = true;
    getPassport(address)
      .then((snap) => live && setP(snap))
      .catch((e) => live && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [address]);

  if (!address) return null;

  return (
    <div className="rounded-xl border border-line bg-bg/50 p-4">
      <div className="text-[11px] uppercase tracking-wide text-muted">Credit passport</div>
      {err && <p className="mt-1 text-sm text-danger">{err}</p>}
      {p && (
        <div className="mt-2 flex items-center gap-8 text-sm">
          <Stat value={`${p.depositPct}%`} label="next deposit" highlight />
          <Stat value={String(p.completedTrades)} label="completed" />
          {p.failedTrades > 0 && <Stat value={String(p.failedTrades)} label="failed" danger />}
        </div>
      )}
      {p && (
        <p className="mt-3 text-xs text-muted">
          Deposit earns down with settled bonds (40% floor at 30). You&apos;re at {p.completedTrades} clean
          {p.completedTrades === 1 ? ' bond' : ' bonds'}.
        </p>
      )}
    </div>
  );
}

function Stat({ value, label, highlight, danger }: { value: string; label: string; highlight?: boolean; danger?: boolean }) {
  const color = danger ? 'text-danger' : highlight ? 'text-primary' : 'text-fg';
  return (
    <div>
      <div className={`text-2xl font-semibold ${color}`}>{value}</div>
      <div className="text-xs text-muted">{label}</div>
    </div>
  );
}
