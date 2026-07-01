'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSigner } from '@/hooks/use-signer';
import { getTradesByAddress, type TradeListItem } from '@/lib/api';
import { HandleAddr } from '@/components/handle-addr';
import { CountdownChip } from '@/components/countdown';
import { StepCue } from '@/components/step-cue';
import { describeTradeStep } from '@/lib/trade-status';
import { Badge, StruckButton } from '@/components/ui';
import { labelForStatus, toneForStatus } from '@/lib/bond-language';

const PlusIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
);

const TERMINAL = new Set(['Released', 'Cancelled', 'Refunded']);
const ACTIVE = new Set(['Proposing', 'Agreed', 'Funded']);
const CLOSED = new Set(['Released', 'Refunded', 'Cancelled']);

type Filter = 'all' | 'active' | 'closed' | 'disputed';
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'closed', label: 'Closed' },
  { id: 'disputed', label: 'Contested' },
];
function inFilter(status: string, f: Filter): boolean {
  if (f === 'all') return true;
  if (f === 'active') return ACTIVE.has(status);
  if (f === 'closed') return CLOSED.has(status);
  return status === 'Disputed';
}

export default function TradesPage() {
  const signer = useSigner();
  const [trades, setTrades] = useState<TradeListItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');

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

  const shown = useMemo(() => (trades ?? []).filter((t) => inFilter(t.status, filter)), [trades, filter]);

  return (
    <main className="mx-auto max-w-5xl px-6 py-16">
      <div className="flex items-center justify-between gap-4">
        <h1 className="t-h1">Bonds</h1>
        <StruckButton href="/trade/create" icon={<PlusIcon />}>Strike a bond</StruckButton>
      </div>

      {!signer.isConnected && (
        <p className="mt-6 text-sm text-muted">
          Connect a wallet or sign in to see your bonds.{' '}
          <Link href="/" className="underline">
            Sign in
          </Link>
        </p>
      )}

      {signer.isConnected && (
        <div className="mt-6 space-y-4">
          {err && <p className="text-sm text-danger">{err}</p>}

          {trades && trades.length > 0 && (
            <div className="flex flex-wrap gap-1 rounded-lg border border-line bg-bg/50 p-0.5 sm:w-fit">
              {FILTERS.map((f) => {
                const n = (trades ?? []).filter((t) => inFilter(t.status, f.id)).length;
                return (
                  <button
                    key={f.id}
                    onClick={() => setFilter(f.id)}
                    className={`rounded-md px-3 py-1.5 text-xs transition ${filter === f.id ? 'bg-surface-2 text-fg' : 'text-muted hover:text-fg'}`}
                  >
                    {f.label}
                    <span className="ml-1.5 text-[10px] text-muted">{n}</span>
                  </button>
                );
              })}
            </div>
          )}

          {trades && trades.length === 0 && <p className="text-sm text-muted">No bonds yet. Strike one.</p>}
          {trades && trades.length > 0 && shown.length === 0 && (
            <p className="rounded-xl border border-line bg-bg/40 px-3 py-8 text-center text-sm text-muted">No {filter === 'disputed' ? 'contested' : filter} bonds.</p>
          )}

          <div className="space-y-2">
            {shown.map((t) => {
              const step = describeTradeStep(t, signer.isConnected ? signer.address : null);
              const live = !TERMINAL.has(t.status);
              return (
                <Link
                  key={t.tradeId}
                  href={`/trade/${t.tradeId}`}
                  className="block rounded-xl border border-line bg-bg/50 px-4 py-3 transition hover:border-line-strong"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-display text-base font-semibold text-fg">Bond #{t.tradeId}</span>
                        <span className="rounded-md border border-line-strong px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
                          {t.role}
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-muted">
                        with <HandleAddr address={t.counterparty} link={false} />
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1.5">
                      <Badge tone={toneForStatus(t.status)}>{labelForStatus(t.status)}</Badge>
                      {live && <CountdownChip unix={t.deadline} />}
                    </div>
                  </div>

                  <div className="mt-2.5 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs">
                    <span className="text-muted">
                      Amount <span className="t-data-sm text-fg">{t.amountUsdc} USDC</span>
                    </span>
                    <span className="text-muted">
                      Deposit <span className="t-data-sm text-fg">{t.depositUsdc} USDC</span>
                    </span>
                  </div>

                  {step && (
                    <div className="mt-2">
                      <StepCue step={step} compact />
                    </div>
                  )}
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </main>
  );
}
