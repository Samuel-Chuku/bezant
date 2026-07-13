'use client';

import { useCallback, useEffect, useState } from 'react';
import { getPassport, type PassportSnapshot } from '@/lib/api';
import { useOnChainRefresh } from '@/hooks/use-refresh-chain-data';

// Credit passport snapshot: the buyer's settled-bond track record, which sets
// their credit standing (financing fee tier now, buyer credit later). Note: the
// buyer escrows the FULL trade amount - reputation drives terms, not principal.
export function PassportPanel({ address }: { address?: string }) {
  const [p, setP] = useState<PassportSnapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!address) return;
    getPassport(address)
      .then(setP)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [address]);

  useEffect(() => {
    load();
  }, [load]);
  useOnChainRefresh(load); // deposit tier earns down after a settled bond, etc.

  if (!address) return null;

  return (
    <div className="rounded-xl border border-line bg-bg/50 p-4">
      <div className="text-[11px] uppercase tracking-wide text-muted">Credit passport</div>
      {err && <p className="mt-1 text-sm text-danger">{err}</p>}
      {p && (
        <div className="mt-2 flex items-center gap-8 text-sm">
          <Stat value={String(p.completedTrades)} label="settled bonds" highlight />
          {p.failedTrades > 0 && <Stat value={String(p.failedTrades)} label="failed" danger />}
        </div>
      )}
      {p && (
        <p className="mt-3 text-xs text-muted">
          Your settled-bond track record is your credit standing — it sets your financing terms and grows as you settle
          cleanly. You&apos;re at {p.completedTrades} clean {p.completedTrades === 1 ? 'bond' : 'bonds'}.
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
