'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useSigner } from '@/hooks/use-signer';
import { useToast } from '@/components/toast';
import { CountdownChip, CountdownBanner } from '@/components/countdown';
import { HandleAddr } from '@/components/handle-addr';
import { StepCue } from '@/components/step-cue';
import { describeTradeStep } from '@/lib/trade-status';
import { arcExplorerTxUrl } from '@/lib/explorers';
import { useBalance } from 'wagmi';
import { arcTestnet } from '@/lib/chains';
import { useTxFlow } from '@/components/tx-flow';
import { BridgeWidget } from '@/components/bridge-widget';
import { BridgeProgressModal } from '@/components/bridge-progress-modal';
import { GatewayPayoutPanel } from '@/components/gateway-payout-panel';
import { ExternalLinkIcon } from '@/components/external-link-icon';
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
  getFinancingQuote,
  type FinancingQuote,
  buildRaiseDisputeUnsigned,
  buildRefundTradeUnsigned,
  buildResolveDisputeUnsigned,
  buildFeedbackUnsigned,
  getUserByAddress,
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
  TradeCountered: 'Counter-offer',
  TradeAgreed: 'Terms agreed',
  TradeCancelled: 'Cancelled',
  TradeFunded: 'Buyer funded escrow',
  FinancingAdvanced: 'Advance to seller',
  Attested: 'Delivery verified',
  Released: 'Settled',
  Disputed: 'Disputed',
  Resolved: 'Dispute resolved',
  Refunded: 'Refunded to buyer',
};

// One-line plain-English explanation shown under each event. The Released row is
// handled separately because its wording depends on whether the trade was financed.
const EVENT_HINT: Record<string, string> = {
  TradeProposed: 'Buyer proposed the trade.',
  TradeCountered: 'A new amount was proposed.',
  TradeAgreed: 'Both sides agreed the terms.',
  TradeFunded: 'Buyer locked the deposit in escrow.',
  FinancingAdvanced: 'Seller drew an early payout from the financing pool while goods ship — repaid automatically at settlement.',
  Attested: 'The Trade Officer confirmed delivery.',
  Disputed: 'Flagged for the arbitrator to resolve.',
  Resolved: 'The arbitrator decided the outcome.',
  Refunded: 'Deposit returned to the buyer.',
};

export default function TradeDetailPage() {
  const params = useParams();
  const id = String(params.id);
  const signer = useSigner();
  const toast = useToast();
  const txFlow = useTxFlow();
  const { data: usdcBalance } = useBalance({
    address: signer.isConnected ? signer.address : undefined,
    chainId: arcTestnet.id,
    query: { enabled: signer.isConnected, refetchInterval: 15_000 },
  });

  const [trade, setTrade] = useState<TradeState | null>(null);
  const [events, setEvents] = useState<TradeEvent[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);
  const [doc, setDoc] = useState('');
  const [officerNote, setOfficerNote] = useState<{ reasons: string[]; highValue: boolean } | null>(null);
  const [financingQuote, setFinancingQuote] = useState<FinancingQuote | null>(null);
  const [counterAmount, setCounterAmount] = useState('');
  const [showBridge, setShowBridge] = useState(false);
  const [bridgeRun, setBridgeRun] = useState<BridgeRun>(INITIAL_RUN);
  const autoFundedRef = useRef(false);

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

  // Poll while the trade is live so the status flips on its own (e.g. the
  // challenge window elapsing → settled) and countdowns stay fresh. After it
  // goes terminal we keep polling briefly: the indexer writes the final
  // Attested/Settled events a few seconds after the on-chain status flips, so
  // stopping immediately would leave the activity timeline missing them.
  useEffect(() => {
    if (!trade) return;
    const terminal = ['Released', 'Cancelled', 'Refunded'].includes(trade.status);
    let count = 0;
    const t = setInterval(() => {
      void refresh();
      count += 1;
      if (terminal && count >= 8) clearInterval(t); // ~24s of indexer catch-up
    }, terminal ? 3000 : 5000);
    return () => clearInterval(t);
  }, [trade?.status, refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  // Trade Officer skill 2: pull the seller's financing quote (priced off the
  // buyer's passport tier) while the trade is Funded and undrawn.
  useEffect(() => {
    const sellerNow = !!trade && signer.isConnected && signer.address.toLowerCase() === trade.seller.toLowerCase();
    if (trade && trade.status === 'Funded' && sellerNow && !trade.financingAdvanced) {
      getFinancingQuote(id).then(setFinancingQuote).catch(() => setFinancingQuote(null));
    } else {
      setFinancingQuote(null);
    }
  }, [trade?.status, trade?.financingAdvanced, trade?.seller, signer.isConnected, signer.address, id]); // eslint-disable-line react-hooks/exhaustive-deps

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
  // Fund pilots the multi-step "Actions" modal: approve → lock, with a
  // before→after overview. Steps send with review:false so this one modal owns
  // the review instead of stacking the per-tx review modals.
  const doFund = async () => {
    if (!trade || !signer.isConnected) return;
    const deposit = trade.estimatedDepositUsdc;
    const bal = usdcBalance ? Number(usdcBalance.formatted) : null;
    const sendStep = async (unsigned: UnsignedTx, label: string) => {
      const sent = await signer.sendCall({ to: unsigned.to, data: unsigned.data, value: BigInt(unsigned.value) }, { review: false });
      const { txHash, status } = await sent.wait();
      if (status !== 'success') throw new Error(`${label} ${status}`);
      return txHash;
    };
    const ok = await txFlow.start({
      title: `Fund ${trade.amountUsdc} USDC`,
      amountUsdc: deposit,
      overview: [
        { label: 'Deposit locked', before: '0', after: `${deposit} USDC` },
        ...(bal !== null ? [{ label: 'Your balance', before: `${bal.toFixed(2)} USDC`, after: `${Math.max(0, bal - Number(deposit)).toFixed(2)} USDC` }] : []),
      ],
      steps: [
        { key: 'approve', label: 'Approve USDC', action: 'Approve', icon: <ShieldIcon />, run: async () => { await sendStep(await buildApproveTradeUnsigned(deposit), 'Approve'); } },
        { key: 'fund', label: 'Lock deposit in escrow', action: 'Lock', icon: <LockIcon />, run: async () => { setLastTx(await sendStep(await buildFundTradeUnsigned(id), 'Fund')); } },
      ],
    });
    if (ok) {
      toast.success('Funded');
      await refresh();
    }
  };
  const doFinance = () => run('finance', async () => signAndWait(await buildRequestFinancingUnsigned(id)), 'Financing advanced');
  const doRaiseDispute = () => run('dispute', async () => signAndWait(await buildRaiseDisputeUnsigned(id)), 'Dispute raised');
  // Reputation write — rate the counterparty's agentId after settlement.
  const rateCounterparty = async (agentId: string, positive: boolean) => {
    await signAndWait(await buildFeedbackUnsigned(agentId, positive));
  };
  const doRefund = () => run('refund', async () => signAndWait(await buildRefundTradeUnsigned(id)), 'Refunded to buyer');
  const doResolve = (releaseToSeller: boolean) =>
    run(
      releaseToSeller ? 'resolve-seller' : 'resolve-buyer',
      async () => signAndWait(await buildResolveDisputeUnsigned(id, releaseToSeller)),
      releaseToSeller ? 'Released to seller' : 'Refunded to buyer',
    );
  const doSubmitDelivery = async () => {
    setError(null);
    if (doc.trim().length < 20) {
      setError('Paste the full delivery document — name the document type and include a real reference number.');
      return;
    }
    setBusy('attest');
    try {
      const r = await officerAttest(id, { kind: 'bill_of_lading', content: doc });
      if (r.decision === 'pass') {
        // Officer approved → buyer challenge window opens; the finalizer settles after it elapses.
        setOfficerNote(null);
        toast.success('Delivery accepted — the buyer has a short window to dispute, then it settles automatically');
        await refresh();
      } else {
        // Not verified. The seller can correct the document and resubmit — an
        // honest typo never goes straight to a human/refund (only high-value does).
        setOfficerNote({ reasons: r.reasons, highValue: r.category === 'high_value' });
        toast.info(
          r.category === 'high_value'
            ? 'High-value trade — routed to a human reviewer'
            : 'Document not verified — please correct it and resubmit',
        );
      }
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      setError(m);
      toast.error(m);
    } finally {
      setBusy(null);
    }
  };

  const me = signer.isConnected ? signer.address.toLowerCase() : null;
  const isBuyer = !!trade && me === trade.buyer.toLowerCase();
  const isSeller = !!trade && me === trade.seller.toLowerCase();
  const myRole = isBuyer ? 'buyer' : isSeller ? 'seller' : me ? 'observer' : null;
  const myOffer = !!trade && me === trade.lastProposer.toLowerCase();
  const myTurn = !!trade && trade.status === 'Proposing' && (isBuyer || isSeller) && !myOffer;
  const isArbitrator = !!trade && me === trade.arbitrator.toLowerCase();
  const deadlinePassed = !!trade && Date.now() / 1000 > trade.deadline;
  const isTerminal = !!trade && ['Released', 'Cancelled', 'Refunded'].includes(trade.status);
  // Only the trade's parties (+ the arbitrator, who may need to resolve a
  // dispute) see the details; everyone else sees just the deadline. NOTE: this
  // is a UI courtesy — the data is public on-chain and via the API.
  const isParticipant = isBuyer || isSeller || isArbitrator;

  // Bridge-into-fund: once the CCTP bridge lands the USDC on Arc, fund the trade
  // automatically (approve + lock) so the buyer doesn't have to come back and
  // click again. Guarded so it fires once per bridge run.
  useEffect(() => {
    if (bridgeRun.status === 'idle') autoFundedRef.current = false;
    if (
      bridgeRun.status === 'success' &&
      !autoFundedRef.current &&
      isBuyer &&
      trade?.status === 'Agreed'
    ) {
      autoFundedRef.current = true;
      void doFund().finally(() => setBridgeRun(INITIAL_RUN));
    }
  }, [bridgeRun.status, isBuyer, trade?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const step = trade ? describeTradeStep(trade, me) : null;
  const windowActive =
    !!trade && trade.status === 'Funded' && trade.challengeWindowUntil != null && trade.challengeWindowUntil > Date.now() / 1000;
  const offerBy = trade && trade.lastProposer.toLowerCase() === trade.buyer.toLowerCase() ? 'buyer' : 'seller';

  return (
    <main className="mx-auto max-w-5xl px-6 py-16">
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
          {!isTerminal && (
            <div className="mt-6">
              <CountdownBanner unix={trade.deadline} label="Time remaining" />
            </div>
          )}

          {!isParticipant ? (
            <p className="mt-8 rounded-lg border border-neutral-800 bg-neutral-950/40 p-4 text-sm text-neutral-400">
              Only the buyer and seller can view this trade&apos;s details.
              {!signer.isConnected && ' Connect the buyer or seller wallet to see it.'}
            </p>
          ) : (
          <>
          {step && (
            <div className="mt-4">
              <StepCue step={step} />
            </div>
          )}

          <div className="mt-6 grid grid-cols-2 gap-3 text-sm">
            <Field label="Status">
              <span className={STATUS_COLOR[trade.status] ?? 'text-neutral-200'}>{trade.status}</span>
            </Field>
            <Field label="Amount">{trade.amountUsdc} USDC</Field>
            <Field label={trade.status === 'Funded' || trade.status === 'Released' ? 'Deposit (locked)' : 'Deposit if funded now'}>
              {(trade.status === 'Funded' || trade.status === 'Released' ? trade.depositUsdc : trade.estimatedDepositUsdc)} USDC
            </Field>
            <Field label="Financing">{trade.financingAdvanced ? `advanced (${trade.financedRepayUsdc} USDC)` : '—'}</Field>
            <Field label="Buyer"><HandleAddr address={trade.buyer} withAddress /></Field>
            <Field label="Seller"><HandleAddr address={trade.seller} withAddress /></Field>
            <Field label="Attester (Trade Officer)"><HandleAddr address={trade.attester} withAddress /></Field>
            <Field label="Deadline">{new Date(trade.deadline * 1000).toLocaleString()}</Field>
          </div>

          {lastTx && (
            <p className="mt-4 text-sm text-neutral-400">
              Last tx:{' '}
              <a href={arcExplorerTxUrl(lastTx)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sky-300 hover:underline">
                {lastTx.slice(0, 10)}… <ExternalLinkIcon />
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
                    {showBridge ? 'Hide bridge' : 'Fund this trade from another chain?'}
                  </button>
                  {showBridge && (
                    <div className="mt-3 rounded-xl border border-neutral-800 bg-neutral-950/40 p-3">
                      <p className="mb-2 text-xs text-neutral-500">
                        Bridge the {trade.estimatedDepositUsdc} USDC you need straight to your Arc wallet via CCTP, then fund — pick a source chain and go.
                      </p>
                      <BridgeWidget run={bridgeRun} onRunChange={setBridgeRun} lockedAmount={trade.estimatedDepositUsdc} lockToArc />
                    </div>
                  )}
                </div>
              </div>
            )}
            {trade.status === 'Agreed' && !isBuyer && (
              <Waiting>Agreed at {trade.amountUsdc} USDC. Waiting for the buyer to fund.</Waiting>
            )}

            {/* FUNDED — buyer challenge window open (officer approved, not yet settled) */}
            {trade.status === 'Funded' && windowActive && trade.challengeWindowUntil != null && (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-900/40 bg-amber-950/20 p-4">
                <p className="text-sm text-amber-100">
                  {isBuyer
                    ? 'Delivery submitted. Review it now — it settles to the seller automatically unless you dispute.'
                    : isSeller
                      ? 'Delivery submitted. It settles to you automatically unless the buyer disputes in time.'
                      : 'Delivery submitted — in the buyer review window.'}
                </p>
                <CountdownChip unix={trade.challengeWindowUntil} label="Settles in" />
              </div>
            )}

            {/* FUNDED — seller delivers (officer attests, auto-settles) */}
            {trade.status === 'Funded' && isSeller && !windowActive && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <p className="text-sm text-neutral-300">
                    Submit your delivery document — the Trade Officer reviews it and, on a pass, the trade settles to you automatically.
                  </p>
                  <textarea
                    value={doc}
                    onChange={(e) => setDoc(e.target.value)}
                    rows={3}
                    placeholder="Paste your bill of lading / tracking / customs document — must name the document type and include a real reference number, e.g. 'Bill of Lading MAEU123456789 — 2000kg textiles, Jebel Ali → Lagos, carrier Maersk'."
                    className="w-full rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm"
                  />
                  <Action onClick={doSubmitDelivery} busy={busy === 'attest'}>Submit to Trade Officer</Action>
                  {officerNote && (
                    <div className={`rounded-lg border p-3 text-sm ${officerNote.highValue ? 'border-sky-900/50 bg-sky-950/20 text-sky-200' : 'border-amber-900/50 bg-amber-950/20 text-amber-100'}`}>
                      <p className="font-medium">
                        {officerNote.highValue
                          ? 'High-value trade — routed to a human reviewer.'
                          : 'Couldn’t verify this document — please correct it and resubmit.'}
                      </p>
                      {officerNote.reasons.length > 0 && (
                        <ul className="mt-1 list-disc pl-5 text-xs opacity-90">
                          {officerNote.reasons.map((r, i) => (
                            <li key={i}>{r}</li>
                          ))}
                        </ul>
                      )}
                      {!officerNote.highValue && (
                        <p className="mt-1 text-xs opacity-80">Your funds aren’t at risk — nothing is refunded; just fix the document above and submit again.</p>
                      )}
                    </div>
                  )}
                </div>
                {!trade.financingAdvanced && (
                  <div className="border-t border-neutral-900 pt-3">
                    {financingQuote ? (
                      <div className="space-y-2">
                        <p className="text-xs text-neutral-400">
                          Trade Officer underwriting — buyer is{' '}
                          <strong className="text-neutral-200">tier {financingQuote.buyerTier}</strong>, so you qualify for an advance now (repaid at settlement):
                        </p>
                        <div className="rounded-lg border border-neutral-800 bg-neutral-950/40 p-3 text-sm">
                          <Row label="Advance now"><span className="text-emerald-300">{financingQuote.advanceUsdc} USDC</span></Row>
                          <Row label={`Fee (${(financingQuote.feeBps / 100).toFixed(financingQuote.feeBps % 100 ? 2 : 0)}%)`}>{financingQuote.feeUsdc} USDC</Row>
                          <Row label="Repaid at settlement">{financingQuote.repayUsdc} USDC</Row>
                        </div>
                        <Action onClick={doFinance} busy={busy === 'finance'} variant="ghost">
                          Draw {financingQuote.advanceUsdc} USDC advance
                        </Action>
                      </div>
                    ) : (
                      <>
                        <p className="mb-2 text-xs text-neutral-500">Need cash before delivery is verified? Draw an advance now (repaid at settlement).</p>
                        <Action onClick={doFinance} busy={busy === 'finance'} variant="ghost">Request financing</Action>
                      </>
                    )}
                  </div>
                )}
                <div className="border-t border-neutral-900 pt-3">
                  <GatewayPayoutPanel tradeId={id} sellerAddress={trade.seller} defaultAmountUsdc={trade.amountUsdc} mode="prefer" />
                </div>
              </div>
            )}
            {trade.status === 'Funded' && !isSeller && !windowActive && (
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
              <div className="space-y-3">
                <p className="rounded-lg border border-emerald-900/40 bg-emerald-950/20 p-4 text-sm text-emerald-200">
                  Settled — funds released to the seller and the buyer&apos;s credit passport updated.
                </p>
                <GatewayPayoutPanel tradeId={id} sellerAddress={trade.seller} defaultAmountUsdc={trade.amountUsdc} mode="settle" />
                {(isBuyer || isSeller) && (
                  <RateCounterparty counterparty={isBuyer ? trade.seller : trade.buyer} onRate={rateCounterparty} />
                )}
              </div>
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
                {(() => {
                  // If the seller drew financing, the Settled amount is only the
                  // remaining balance — explain that so it doesn't read as the
                  // whole trade being settled for a fraction of its value.
                  const financed = events.find((e) => e.kind === 'FinancingAdvanced')?.amountUsdc;
                  return events.map((e, i) => {
                    const financedSettle = e.kind === 'Released' && !!financed;
                    const hint =
                      e.kind === 'Released'
                        ? financed
                          ? `Final ${e.amountUsdc} USDC to the seller — the other ${financed} USDC was paid early from the financing pool, so the full amount was delivered.`
                          : 'Full amount released to the seller.'
                        : EVENT_HINT[e.kind];
                    return (
                      // One tx can emit several events (e.g. attest auto-settle →
                      // Attested + Released share a txHash), so the key includes kind + index.
                      <li key={`${e.txHash}-${e.kind}-${i}`} className="flex items-start justify-between gap-3 rounded-lg border border-neutral-900 bg-neutral-950/40 px-3 py-2 text-sm">
                        <div>
                          <div>
                            <span className="text-neutral-200">{EVENT_LABEL[e.kind] ?? e.kind}</span>
                            {e.amountUsdc && !financedSettle && <span className="text-neutral-500"> · {e.amountUsdc} USDC</span>}
                            {e.actor && <span className="text-neutral-600"> · {short(e.actor)}</span>}
                          </div>
                          {hint && <p className="mt-0.5 text-xs text-neutral-500">{hint}</p>}
                        </div>
                        <a href={arcExplorerTxUrl(e.txHash)} target="_blank" rel="noreferrer" className="mt-0.5 inline-flex shrink-0 items-center gap-1 text-xs text-sky-300 hover:underline">
                          tx <ExternalLinkIcon />
                        </a>
                      </li>
                    );
                  });
                })()}
              </ol>
            </div>
          )}
          </>
          )}
        </>
      )}

      <BridgeProgressModal
        run={bridgeRun}
        onClose={() => setBridgeRun(INITIAL_RUN)}
        tail={busy === 'fund' ? <span className="text-sky-300">Bridged ✓ — funding your trade…</span> : undefined}
      />
    </main>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between py-0.5">
      <span className="text-neutral-500">{label}</span>
      <span className="text-neutral-200">{children}</span>
    </div>
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

function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

// Thumbs up/down on the counterparty after settlement. Only renders when the
// counterparty has linked an ERC-8004 agentId (reputation is agentId-based).
function RateCounterparty({ counterparty, onRate }: { counterparty: string; onRate: (agentId: string, positive: boolean) => Promise<void> }) {
  const toast = useToast();
  const [agentId, setAgentId] = useState<string | null | undefined>(undefined); // undefined = loading
  const [busy, setBusy] = useState(false);
  const [rated, setRated] = useState<boolean | null>(null);

  useEffect(() => {
    getUserByAddress(counterparty)
      .then((u) => setAgentId(u?.agentId ?? null))
      .catch(() => setAgentId(null));
  }, [counterparty]);

  if (agentId === undefined) return null;
  if (agentId === null) {
    return <p className="text-xs text-neutral-500">Your counterparty hasn&apos;t linked an agent, so there&apos;s no reputation to leave.</p>;
  }
  if (rated !== null) {
    return <p className="text-xs text-emerald-300">Thanks — you left {rated ? '👍' : '👎'} feedback.</p>;
  }

  const rate = async (positive: boolean) => {
    setBusy(true);
    try {
      await onRate(agentId, positive);
      setRated(positive);
      toast.success('Feedback submitted');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-950/40 px-4 py-3">
      <span className="text-sm text-neutral-300">Rate your counterparty</span>
      <div className="ml-auto flex gap-2">
        <button onClick={() => rate(true)} disabled={busy} className="rounded-md border border-neutral-800 px-3 py-1.5 text-sm hover:border-emerald-700 hover:text-emerald-300 disabled:opacity-50">👍</button>
        <button onClick={() => rate(false)} disabled={busy} className="rounded-md border border-neutral-800 px-3 py-1.5 text-sm hover:border-red-700 hover:text-red-300 disabled:opacity-50">👎</button>
      </div>
    </div>
  );
}

function ShieldIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}
