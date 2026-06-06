'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useSigner } from '@/hooks/use-signer';
import { getTradesByAddress, type TradeListItem } from '@/lib/api';
import { PassportPanel } from '@/components/passport-panel';

const STATUS_COLOR: Record<string, string> = {
  Created: 'text-sky-300',
  Funded: 'text-amber-300',
  Attested: 'text-violet-300',
  Released: 'text-emerald-300',
  Disputed: 'text-red-300',
  Refunded: 'text-neutral-300',
};

export default function TradesPage() {
  const signer = useSigner();
  const [trades, setTrades] = useState<TradeListItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!signer.isConnected) return;
    try {
      setTrades(await getTradesByAddress(signer.address));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [signer.isConnected, signer.address]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-semibold tracking-tight">Trades</h1>
        <Link href="/trade/create" className="rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900">
          New trade
        </Link>
      </div>

      {!signer.isConnected && (
        <p className="mt-6 text-sm text-neutral-400">
          Connect a wallet or sign in to see your trades.{' '}
          <Link href="/" className="underline">
            Sign in
          </Link>
        </p>
      )}

      {signer.isConnected && (
        <div className="mt-6 space-y-6">
          <PassportPanel address={signer.address} />

          {err && <p className="text-sm text-red-400">{err}</p>}
          {trades && trades.length === 0 && <p className="text-sm text-neutral-400">No trades yet — create one.</p>}

          <div className="space-y-2">
            {trades?.map((t) => (
              <Link
                key={t.tradeId}
                href={`/trade/${t.tradeId}`}
                className="flex items-center justify-between rounded-xl border border-neutral-800 bg-neutral-950/50 px-4 py-3 text-sm hover:border-neutral-600"
              >
                <div>
                  <div className="font-medium">Trade #{t.tradeId}</div>
                  <div className="text-xs text-neutral-500">
                    {t.role} · {t.amountUsdc} USDC · deposit {t.depositUsdc}
                  </div>
                </div>
                <span className={STATUS_COLOR[t.status] ?? 'text-neutral-200'}>{t.status}</span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </main>
  );
}
