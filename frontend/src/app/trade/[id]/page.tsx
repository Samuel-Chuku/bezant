'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useSigner } from '@/hooks/use-signer';
import { useToast } from '@/components/toast';
import { BridgeWidget } from '@/components/bridge-widget';
import { INITIAL_RUN, type BridgeRun } from '@/lib/bridge-run';
import {
  getTrade,
  officerAttest,
  buildApproveTradeUnsigned,
  buildFundTradeUnsigned,
  buildReleaseTradeUnsigned,
  buildRequestFinancingUnsigned,
  type TradeState,
  type UnsignedTx,
} from '@/lib/api';

const STATUS_COLOR: Record<string, string> = {
  Created: 'text-sky-300',
  Funded: 'text-amber-300',
  Attested: 'text-violet-300',
  Released: 'text-emerald-300',
  Disputed: 'text-red-300',
  Refunded: 'text-neutral-300',
};

export default function TradeDetailPage() {
  const params = useParams();
  const id = String(params.id);
  const signer = useSigner();
  const toast = useToast();

  const [trade, setTrade] = useState<TradeState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [doc, setDoc] = useState(
    'Bill of Lading MAEU123456789 — 2000kg textiles, Jebel Ali to Lagos, carrier Maersk, cleared.',
  );
  const [showBridge, setShowBridge] = useState(false);
  const [bridgeRun, setBridgeRun] = useState<BridgeRun>(INITIAL_RUN);

  const refresh = useCallback(async () => {
    try {
      setTrade(await getTrade(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signAndWait = async (unsigned: UnsignedTx) => {
    if (!signer.isConnected) throw new Error('Connect a wallet first.');
    const sent = await signer.sendCall({ to: unsigned.to, data: unsigned.data, value: BigInt(unsigned.value) });
    const { status } = await sent.wait();
    if (status !== 'success') throw new Error(`Tx ${status}`);
  };

  const run = async (label: string, fn: () => Promise<void>) => {
    setError(null);
    setBusy(label);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const fund = () =>
    run('fund', async () => {
      if (!trade) return;
      await signAndWait(await buildApproveTradeUnsigned(trade.depositUsdc));
      await signAndWait(await buildFundTradeUnsigned(id));
      toast.success(`Funded ${trade.depositUsdc} USDC`);
    });

  const attest = () =>
    run('attest', async () => {
      const r = await officerAttest(id, { kind: 'bill_of_lading', reference: 'MAEU123456789', content: doc });
      if (r.attested) toast.success('Trade Officer attested delivery');
      else toast.error(`Escalated to a human verifier: ${r.reasons.join('; ')}`);
    });

  const release = () =>
    run('release', async () => {
      await signAndWait(await buildReleaseTradeUnsigned(id));
      toast.success('Released to seller');
    });

  const finance = () =>
    run('finance', async () => {
      await signAndWait(await buildRequestFinancingUnsigned(id));
      toast.success('Financing advanced to seller');
    });

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <Link href="/trade/create" className="text-xs text-neutral-500 hover:text-neutral-100">
        ← new trade
      </Link>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight">Trade #{id}</h1>

      {!trade && !error && <p className="mt-6 text-sm text-neutral-400">Loading…</p>}
      {error && <p className="mt-4 text-sm text-red-400">{error}</p>}

      {trade && (
        <>
          <div className="mt-6 grid grid-cols-2 gap-3 text-sm">
            <Field label="Status">
              <span className={STATUS_COLOR[trade.status] ?? 'text-neutral-200'}>{trade.status}</span>
            </Field>
            <Field label="Amount">{trade.amountUsdc} USDC</Field>
            <Field label="Deposit (passport-priced)">{trade.depositUsdc} USDC</Field>
            <Field label="Financing">{trade.financingAdvanced ? `advanced (${trade.financedRepayUsdc} USDC)` : '—'}</Field>
            <Field label="Buyer">{short(trade.buyer)}</Field>
            <Field label="Seller">{short(trade.seller)}</Field>
            <Field label="Attester (Trade Officer)">{short(trade.attester)}</Field>
            <Field label="Deadline">{new Date(trade.deadline * 1000).toLocaleString()}</Field>
          </div>

          <div className="mt-8 space-y-4">
            {trade.status === 'Created' && (
              <div className="space-y-3">
                <Action onClick={fund} busy={busy === 'fund'} disabled={!signer.isConnected}>
                  Fund {trade.depositUsdc} USDC (approve + lock)
                </Action>
                <div>
                  <button
                    onClick={() => setShowBridge((s) => !s)}
                    className="text-sm text-sky-300 hover:underline"
                  >
                    {showBridge ? 'Hide bridge' : 'Need USDC? Fund from another chain →'}
                  </button>
                  {showBridge && (
                    <div className="mt-3 rounded-xl border border-neutral-800 bg-neutral-950/40 p-3">
                      <p className="mb-2 text-xs text-neutral-500">
                        Bridge USDC from Ethereum / Base / Arbitrum / Optimism / Solana to your Arc wallet via CCTP, then fund.
                      </p>
                      <BridgeWidget run={bridgeRun} onRunChange={setBridgeRun} />
                    </div>
                  )}
                </div>
              </div>
            )}

            {trade.status === 'Funded' && (
              <div className="space-y-2">
                <p className="text-sm text-neutral-400">Trade Officer reviews the delivery document and attests (or escalates).</p>
                <textarea
                  value={doc}
                  onChange={(e) => setDoc(e.target.value)}
                  rows={3}
                  className="w-full rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm"
                />
                <Action onClick={attest} busy={busy === 'attest'}>
                  Run Trade Officer
                </Action>
              </div>
            )}

            {trade.status === 'Attested' && (
              <div className="flex flex-wrap gap-3">
                <Action onClick={release} busy={busy === 'release'} disabled={!signer.isConnected}>
                  Release to seller
                </Action>
                {!trade.financingAdvanced && (
                  <Action onClick={finance} busy={busy === 'finance'} disabled={!signer.isConnected} variant="ghost">
                    Request financing (seller)
                  </Action>
                )}
              </div>
            )}

            {trade.status === 'Released' && (
              <p className="rounded-lg border border-emerald-900/40 bg-emerald-950/20 p-4 text-sm text-emerald-200">
                Settled — funds released to the seller and the buyer&apos;s credit passport updated.
              </p>
            )}
          </div>
        </>
      )}
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-neutral-900 bg-neutral-950/50 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="mt-0.5 text-neutral-200">{children}</div>
    </div>
  );
}

function Action({
  onClick,
  busy,
  disabled,
  variant = 'solid',
  children,
}: {
  onClick: () => void;
  busy?: boolean;
  disabled?: boolean;
  variant?: 'solid' | 'ghost';
  children: React.ReactNode;
}) {
  const base = 'rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-40';
  const style = variant === 'solid' ? 'bg-neutral-100 text-neutral-900' : 'border border-neutral-700 text-neutral-200';
  return (
    <button onClick={onClick} disabled={busy || disabled} className={`${base} ${style}`}>
      {busy ? 'Working…' : children}
    </button>
  );
}

function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
