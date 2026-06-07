'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useSigner } from '@/hooks/use-signer';
import { useToast } from '@/components/toast';
import { CountdownChip } from '@/components/countdown';
import { arcExplorerTxUrl, arcExplorerAddressUrl } from '@/lib/explorers';
import { BridgeWidget } from '@/components/bridge-widget';
import { INITIAL_RUN, type BridgeRun } from '@/lib/bridge-run';
import {
  getTrade,
  getTradeEvents,
  officerAttest,
  buildApproveTradeUnsigned,
  buildFundTradeUnsigned,
  buildAcceptTradeUnsigned,
  buildCounterTradeUnsigned,
  buildCancelTradeUnsigned,
  buildRequestFinancingUnsigned,
  buildRaiseDisputeUnsigned,
  buildRefundTradeUnsigned,
  buildResolveDisputeUnsigned,
  type TradeState,
  type TradeEvent,
  type UnsignedTx,
} from '@/lib/api';

const STATUS_COLOR: Record<string, string> = {
  Proposing: 'text-sky-300',
  Agreed: 'text-amber-300',
  Funded: 'text-violet-300',
  Released: 'text-emerald-300',
  Disputed: 'text-red-300',
  Refunded: 'text-neutral-300',
  Cancelled: 'text-neutral-400',
};

const EVENT_LABEL: Record<string, string> = {
  TradeProposed: 'Proposed',
  TradeCountered: 'Countered',
  TradeAgreed: 'Agreed',
  TradeCancelled: 'Cancelled',
  TradeFunded: 'Funded',
  FinancingAdvanced: 'Financing advanced',
  Attested: 'Delivery attested',
  Released: 'Settled — paid to seller',
  Disputed: 'Disputed',
  Resolved: 'Dispute resolved',
  Refunded: 'Refunded',
};

export default function TradeDetailPage() {
  const params = useParams();
  const id = String(params.id);
  const signer = useSigner();
  const toast = useToast();

  const [trade, setTrade] = useState<TradeState | null>(null);
  const [events, setEvents] = useState<TradeEvent[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);
  const [doc, setDoc] = useState('');
  const [counterAmount, setCounterAmount] = useState('');
  const [showBridge, setShowBridge] = useState(false);
  const [bridgeRun, setBridgeRun] = useState<BridgeRun>(INITIAL_RUN);

  const refresh = useCallback(async () => {
    try {
      const [t, evs] = await Promise.all([getTrade(id), getTradeEvents(id).catch(() => [])]);
      setTrade(t);
      setEvents(evs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signAndWait = async (unsigned: UnsignedTx): Promise<string> => {
    if (!signer.isConnected) throw new Error('Connect a wallet first.');
    const sent = await signer.sendCall({ to: unsigned.to, data: unsigned.data, value: BigInt(unsigned.value) });
    const { txHash, status } = await sent.wait();
    if (status !== 'success') throw new Error(`Tx ${status}`);
    return txHash;
  };

  const run = async (label: string, fn: () => Promise<string | void>, okMsg: string) => {
    setError(null);
    setBusy(label);
    try {
      const tx = await fn();
      if (typeof tx === 'string') setLastTx(tx);
      toast.success(okMsg);
      await refresh();
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      setError(m);
      toast.error(m);
    } finally {
      setBusy(null);
    }
  };

  const doAccept = () => run('accept', async () => signAndWait(await buildAcceptTradeUnsigned(id)), 'Offer accepted');
  const doCounter = () =>
    run('counter', async () => {
      if (!counterAmount || Number(counterAmount) <= 0) throw new Error('Enter a counter amount.');
      return signAndWait(await buildCounterTradeUnsigned(id, counterAmount));
    }, 'Counter-offer sent');
  const doCancel = () => run('cancel', async () => signAndWait(await buildCancelTradeUnsigned(id)), 'Trade cancelled');
  const doFund = () =>
    run('fund', async () => {
      if (!trade) return;
      await signAndWait(await buildApproveTradeUnsigned(trade.estimatedDepositUsdc));
      return signAndWait(await buildFundTradeUnsigned(id));
    }, 'Funded');
  const doFinance = () => run('finance', async () => signAndWait(await buildRequestFinancingUnsigned(id)), 'Financing advanced');
  const doRaiseDispute = () => run('dispute', async () => signAndWait(await buildRaiseDisputeUnsigned(id)), 'Dispute raised');
  const doRefund = () => run('refund', async () => signAndWait(await buildRefundTradeUnsigned(id)), 'Refunded to buyer');
  const doResolve = (releaseToSeller: boolean) =>
    run(
      releaseToSeller ? 'resolve-seller' : 'resolve-buyer',
      async () => signAndWait(await buildResolveDisputeUnsigned(id, releaseToSeller)),
      releaseToSeller ? 'Released to seller' : 'Refunded to buyer',
    );
  const doSubmitDelivery = () =>
    run('attest', async () => {
      if (doc.trim().length < 8) throw new Error('Paste your delivery document (with a reference number).');
      const r = await officerAttest(id, { kind: 'bill_of_lading', content: doc });
      if (!r.attested) throw new Error(`Officer escalated to a human verifier: ${r.reasons.join('; ')}`);
      return r.txHash;
    }, 'Trade Officer attested — trade settled');

  const me = signer.isConnected ? signer.address.toLowerCase() : null;
  const isBuyer = !!trade && me === trade.buyer.toLowerCase();
  const isSeller = !!trade && me === trade.seller.toLowerCase();
  const myRole = isBuyer ? 'buyer' : isSeller ? 'seller' : me ? 'observer' : null;
  const myOffer = !!trade && me === trade.lastProposer.toLowerCase();
  const myTurn = !!trade && trade.status === 'Proposing' && (isBuyer || isSeller) && !myOffer;
  const isArbitrator = !!trade && me === trade.arbitrator.toLowerCase();
  const deadlinePassed = !!trade && Date.now() / 1000 > trade.deadline;
  const offerBy = trade && trade.lastProposer.toLowerCase() === trade.buyer.toLowerCase() ? 'buyer' : 'seller';

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <Link href="/trade" className="text-xs text-neutral-500 hover:text-neutral-100">
        ← my trades
      </Link>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">Trade #{id}</h1>
        {myRole && (
          <span className="rounded-full border border-neutral-700 px-2 py-0.5 text-[11px] uppercase tracking-wide text-neutral-400">
            you: {myRole}
          </span>
        )}
        {trade && trade.status !== 'Released' && trade.status !== 'Cancelled' && trade.status !== 'Refunded' && (
          <CountdownChip unix={trade.deadline} label="Deadline" />
        )}
      </div>

      {!trade && !error && <p className="mt-6 text-sm text-neutral-400">Loading…</p>}
      {error && <p className="mt-4 text-sm text-red-400">{error}</p>}

      {trade && (
        <>
          <div className="mt-6 grid grid-cols-2 gap-3 text-sm">
            <Field label="Status">
              <span className={STATUS_COLOR[trade.status] ?? 'text-neutral-200'}>{trade.status}</span>
            </Field>
            <Field label="Amount">{trade.amountUsdc} USDC</Field>
            <Field label={trade.status === 'Funded' || trade.status === 'Released' ? 'Deposit (locked)' : 'Deposit if funded now'}>
              {(trade.status === 'Funded' || trade.status === 'Released' ? trade.depositUsdc : trade.estimatedDepositUsdc)} USDC
            </Field>
            <Field label="Financing">{trade.financingAdvanced ? `advanced (${trade.financedRepayUsdc} USDC)` : '—'}</Field>
            <Field label="Buyer"><Addr a={trade.buyer} /></Field>
            <Field label="Seller"><Addr a={trade.seller} /></Field>
            <Field label="Attester (Trade Officer)"><Addr a={trade.attester} /></Field>
            <Field label="Deadline">{new Date(trade.deadline * 1000).toLocaleString()}</Field>
          </div>

          {lastTx && (
            <p className="mt-4 text-sm text-neutral-400">
              Last tx:{' '}
              <a href={arcExplorerTxUrl(lastTx)} target="_blank" rel="noreferrer" className="text-sky-300 hover:underline">
                {lastTx.slice(0, 10)}… ↗
              </a>
            </p>
          )}

          <div className="mt-8 space-y-4">
            {/* PROPOSING — negotiation */}
            {trade.status === 'Proposing' && (
              <div className="space-y-3">
                <p className="text-sm text-neutral-300">
                  Standing offer: <strong>{trade.amountUsdc} USDC</strong>, proposed by the <strong>{offerBy}</strong>.
                </p>
                {myTurn && (
                  <div className="space-y-3">
                    <div className="flex flex-wrap gap-3">
                      <Action onClick={doAccept} busy={busy === 'accept'}>Accept {trade.amountUsdc} USDC</Action>
                      <Action onClick={doCancel} busy={busy === 'cancel'} variant="ghost">Cancel</Action>
                    </div>
                    <div className="flex items-end gap-2">
                      <label className="block">
                        <span className="text-xs text-neutral-400">Counter amount (USDC)</span>
                        <input
                          value={counterAmount}
                          onChange={(e) => setCounterAmount(e.target.value)}
                          inputMode="decimal"
                          placeholder="e.g. 9"
                          className="mt-1 w-40 rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm"
                        />
                      </label>
                      <Action onClick={doCounter} busy={busy === 'counter'} variant="ghost">Counter</Action>
                    </div>
                  </div>
                )}
                {myOffer && (
                  <div className="space-y-2">
                    <Waiting>Your offer is on the table. Waiting for the {offerBy === 'buyer' ? 'seller' : 'buyer'} to accept or counter.</Waiting>
                    <Action onClick={doCancel} busy={busy === 'cancel'} variant="ghost">Cancel</Action>
                  </div>
                )}
                {!isBuyer && !isSeller && <Waiting>Negotiation in progress.</Waiting>}
              </div>
            )}

            {/* AGREED — buyer funds */}
            {trade.status === 'Agreed' && isBuyer && (
              <div className="space-y-3">
                <Action onClick={doFund} busy={busy === 'fund'} disabled={!signer.isConnected}>
                  Fund {trade.estimatedDepositUsdc} USDC (approve + lock)
                </Action>
                <div>
                  <button onClick={() => setShowBridge((s) => !s)} className="text-sm text-sky-300 hover:underline">
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
            {trade.status === 'Agreed' && !isBuyer && (
              <Waiting>Agreed at {trade.amountUsdc} USDC. Waiting for the buyer to fund.</Waiting>
            )}

            {/* FUNDED — seller delivers (officer attests, auto-settles) */}
            {trade.status === 'Funded' && isSeller && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <p className="text-sm text-neutral-300">
                    Submit your delivery document — the Trade Officer reviews it and, on a pass, the trade settles to you automatically.
                  </p>
                  <textarea
                    value={doc}
                    onChange={(e) => setDoc(e.target.value)}
                    rows={3}
                    placeholder="Paste your bill of lading / tracking / customs document (must include a reference number)…"
                    className="w-full rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm"
                  />
                  <Action onClick={doSubmitDelivery} busy={busy === 'attest'}>Submit to Trade Officer</Action>
                </div>
                {!trade.financingAdvanced && (
                  <div className="border-t border-neutral-900 pt-3">
                    <p className="mb-2 text-xs text-neutral-500">Need cash before delivery is verified? Draw an advance now (repaid at settlement).</p>
                    <Action onClick={doFinance} busy={busy === 'finance'} variant="ghost">Request financing</Action>
                  </div>
                )}
              </div>
            )}
            {trade.status === 'Funded' && !isSeller && (
              <Waiting>Funded. Awaiting delivery documents from the seller; settlement is automatic once the officer attests.</Waiting>
            )}

            {/* FUNDED — either party can flag a problem; buyer can reclaim after the deadline */}
            {trade.status === 'Funded' && (isBuyer || isSeller) && (
              <div className="space-y-2 border-t border-neutral-900 pt-3">
                {isBuyer && deadlinePassed && (
                  <div>
                    <p className="mb-2 text-xs text-neutral-500">The deadline passed with no attestation — reclaim your deposit.</p>
                    <Action onClick={doRefund} busy={busy === 'refund'} variant="ghost">Claim refund</Action>
                  </div>
                )}
                <div>
                  <p className="mb-2 text-xs text-neutral-500">Something wrong with this trade? Flag it for the arbitrator to resolve.</p>
                  <Action onClick={doRaiseDispute} busy={busy === 'dispute'} variant="ghost">Raise a dispute</Action>
                </div>
              </div>
            )}

            {trade.status === 'Released' && (
              <p className="rounded-lg border border-emerald-900/40 bg-emerald-950/20 p-4 text-sm text-emerald-200">
                Settled — funds released to the seller and the buyer&apos;s credit passport updated.
              </p>
            )}
            {trade.status === 'Cancelled' && <Waiting>This trade was cancelled before funding.</Waiting>}
            {trade.status === 'Refunded' && <Waiting>Refunded to the buyer (no attestation by the deadline).</Waiting>}
            {trade.status === 'Disputed' && isArbitrator && (
              <div className="space-y-3 rounded-lg border border-red-900/40 bg-red-950/20 p-4">
                <p className="text-sm text-red-200">
                  You are the arbitrator for this disputed trade. Decide the outcome — the escrowed funds go to whichever party you choose.
                </p>
                <div className="flex flex-wrap gap-3">
                  <Action onClick={() => doResolve(true)} busy={busy === 'resolve-seller'}>Release to seller</Action>
                  <Action onClick={() => doResolve(false)} busy={busy === 'resolve-buyer'} variant="ghost">Refund the buyer</Action>
                </div>
              </div>
            )}
            {trade.status === 'Disputed' && !isArbitrator && (
              <Waiting>Under dispute — awaiting the arbitrator&apos;s decision.</Waiting>
            )}

            {!signer.isConnected && <p className="text-sm text-amber-300">Connect a wallet to act on this trade.</p>}
          </div>

          {/* Event timeline */}
          {events.length > 0 && (
            <div className="mt-10">
              <h2 className="text-xs uppercase tracking-wide text-neutral-500">Activity</h2>
              <ol className="mt-3 space-y-2">
                {events.map((e) => (
                  <li key={e.txHash} className="flex items-center justify-between rounded-lg border border-neutral-900 bg-neutral-950/40 px-3 py-2 text-sm">
                    <div>
                      <span className="text-neutral-200">{EVENT_LABEL[e.kind] ?? e.kind}</span>
                      {e.amountUsdc && <span className="text-neutral-500"> · {e.amountUsdc} USDC</span>}
                      {e.actor && <span className="text-neutral-600"> · {short(e.actor)}</span>}
                    </div>
                    <a href={arcExplorerTxUrl(e.txHash)} target="_blank" rel="noreferrer" className="text-xs text-sky-300 hover:underline">
                      tx ↗
                    </a>
                  </li>
                ))}
              </ol>
            </div>
          )}
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

function Waiting({ children }: { children: React.ReactNode }) {
  return <p className="rounded-lg border border-neutral-800 bg-neutral-950/40 p-4 text-sm text-neutral-400">{children}</p>;
}

function Addr({ a }: { a: string }) {
  return (
    <a href={arcExplorerAddressUrl(a)} target="_blank" rel="noreferrer" className="hover:underline">
      {short(a)}
    </a>
  );
}

function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
