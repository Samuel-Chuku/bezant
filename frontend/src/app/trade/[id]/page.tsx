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
import { sqlTimeAgo } from '@/lib/relative-time';
import { useBalance } from 'wagmi';
import { arcTestnet } from '@/lib/chains';
import { useTxFlow } from '@/components/tx-flow';
import { FundFromChain } from '@/components/fund-from-chain';
import { BridgeProgressModal } from '@/components/bridge-progress-modal';
import { GatewayPayoutPanel } from '@/components/gateway-payout-panel';
import { VerificationPanel, PanelModal } from '@/components/verification-panel';
import { OfficerReviewModal } from '@/components/officer-review-modal';
import { TradeStatusTracker } from '@/components/trade-status-tracker';
import { ContextTabs, StatePill } from '@/components/ui';
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
  triggerFeedbackBoost,
  officerAttestAuthMessage,
  fileToBase64AndHash,
  uploadTradeDeliveryFile,
  type DeliveryDoc,
  getUserByAddress,
  getVerifierInfo,
  getVerification,
  getOfficerReview,
  type OfficerReview,
  type VerificationState,
  type VerifierInfo,
  type TradeState,
  type TradeEvent,
  type UnsignedTx,
} from '@/lib/api';

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
  TradeProposed: 'Buyer proposed the bond.',
  TradeCountered: 'A new amount was proposed.',
  TradeAgreed: 'Both sides agreed the terms.',
  TradeFunded: 'Buyer locked the deposit in escrow.',
  FinancingAdvanced: 'Seller drew an early payout from the financing pool while goods ship - repaid automatically at settlement.',
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
  const [deliveryFile, setDeliveryFile] = useState<File | null>(null);
  const [officerNote, setOfficerNote] = useState<{ reasons: string[]; highValue: boolean } | null>(null);
  const [financingQuote, setFinancingQuote] = useState<FinancingQuote | null>(null);
  const [counterAmount, setCounterAmount] = useState('');
  const [bridgeRun, setBridgeRun] = useState<BridgeRun>(INITIAL_RUN);
  const [verifier, setVerifier] = useState<VerifierInfo | null>(null);
  const [isPanelist, setIsPanelist] = useState(false);
  const [panelAssigned, setPanelAssigned] = useState(false);
  const [verification, setVerification] = useState<VerificationState | null>(null);
  const [showPanelModal, setShowPanelModal] = useState(false);
  const [officerReview, setOfficerReview] = useState<OfficerReview | null>(null);
  const [showOfficerModal, setShowOfficerModal] = useState(false);
  const [tab, setTab] = useState<'overview' | 'activity'>('overview');
  const autoFundedRef = useRef(false);

  useEffect(() => {
    getVerifierInfo().then(setVerifier).catch(() => {});
  }, []);

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
  // Reputation write - rate the counterparty's agentId after settlement.
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
      setError('Paste the full delivery document - name the document type and include a real reference number.');
      return;
    }
    if (!signer.isConnected) {
      setError('Connect a wallet first.');
      return;
    }
    setBusy('attest');
    try {
      // Authenticate the submission: only the seller may submit delivery, proven
      // by a wallet signature the backend verifies against the trade's seller.
      const ts = Date.now();
      const signature = await signer.signMessage(officerAttestAuthMessage(id, ts));
      const docObj: DeliveryDoc = { kind: 'bill_of_lading', content: doc };
      let fileBase64: string | null = null;
      if (deliveryFile) {
        const { base64, hash } = await fileToBase64AndHash(deliveryFile);
        docObj.fileHash = hash;
        docObj.fileName = deliveryFile.name;
        docObj.fileMime = deliveryFile.type || 'application/octet-stream';
        docObj.fileSize = deliveryFile.size;
        fileBase64 = base64;
      }
      const r = await officerAttest(id, docObj, { signature, ts });
      if (r.decision === 'pass') {
        // Officer approved → buyer challenge window opens; the finalizer settles after it elapses.
        // The file hash is now recorded on-chain-anchored, so upload the bytes for parties to fetch.
        if (deliveryFile && fileBase64) {
          try {
            await uploadTradeDeliveryFile({
              tradeId: id,
              fileName: deliveryFile.name,
              mime: deliveryFile.type || 'application/octet-stream',
              fileBase64,
              uploadedBy: signer.address,
            });
          } catch (upErr) {
            toast.error(`Delivery accepted, but the file upload failed: ${upErr instanceof Error ? upErr.message : String(upErr)}`);
          }
        }
        setOfficerNote(null);
        setDeliveryFile(null);
        toast.success('Delivery accepted - the buyer has a short window to dispute, then it settles automatically');
        await refresh();
      } else {
        // Not verified. The seller can correct the document and resubmit - an
        // honest typo never goes straight to a human/refund (only high-value does).
        setOfficerNote({ reasons: r.reasons, highValue: r.category === 'high_value' });
        toast.info(
          r.category === 'high_value'
            ? 'High-value trade - routed to a human reviewer'
            : 'Document not verified - please correct it and resubmit',
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
  const myRole = isBuyer ? 'buyer' : isSeller ? 'seller' : isPanelist ? 'verifier' : me ? 'observer' : null;
  const myOffer = !!trade && me === trade.lastProposer.toLowerCase();
  const myTurn = !!trade && trade.status === 'Proposing' && (isBuyer || isSeller) && !myOffer;
  const isArbitrator = !!trade && me === trade.arbitrator.toLowerCase();
  const deadlinePassed = !!trade && Date.now() / 1000 > trade.deadline;
  const isTerminal = !!trade && ['Released', 'Cancelled', 'Refunded'].includes(trade.status);
  // Only the trade's parties (+ the arbitrator, who may need to resolve a
  // dispute) see the details; everyone else sees just the deadline. NOTE: this
  // is a UI courtesy - the data is public on-chain and via the API.
  // Panel-mode trades set the staked-verifier module as their attester at
  // creation; they verify delivery via the panel instead of the Trade Officer.
  const isPanelTrade =
    !!trade && !!verifier?.address && trade.attester.toLowerCase() === verifier.address.toLowerCase();
  // A drawn panelist isn't the buyer/seller but must reach the trade to review
  // the delivery doc and vote, so they count as a participant here.
  const isParticipant = isBuyer || isSeller || isArbitrator || isPanelist;

  // For panel trades, track membership (gates page access) + whether the panel
  // has been drawn (gates the dispute button). Poll so both stay fresh as the
  // seller submits and the panel forms.
  useEffect(() => {
    if (!isPanelTrade) {
      setIsPanelist(false);
      setPanelAssigned(false);
      setVerification(null);
      return;
    }
    const load = () =>
      getVerification(id, signer.isConnected ? signer.address : undefined)
        .then((vs) => {
          setVerification(vs);
          setPanelAssigned(vs.assigned);
          setIsPanelist(!!me && vs.panel.some((p) => p.toLowerCase() === me));
        })
        .catch(() => {});
    void load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [isPanelTrade, me, id, signer.isConnected, signer.address]);

  // Officer-route review snapshot (powers the "Trade Officer review" link/modal).
  useEffect(() => {
    if (isPanelTrade || !trade) {
      setOfficerReview(null);
      return;
    }
    getOfficerReview(id).then(setOfficerReview).catch(() => setOfficerReview(null));
  }, [isPanelTrade, id, trade?.status]); // eslint-disable-line react-hooks/exhaustive-deps

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
  // "Delivery submitted" = there's actually something to contest: the officer
  // challenge window opened, or the staked panel has been drawn. The dispute
  // button only shows from this point (not during the wait for delivery).
  const deliverySubmitted = isPanelTrade ? panelAssigned : !!trade && trade.challengeWindowUntil != null;
  const offerBy = trade && trade.lastProposer.toLowerCase() === trade.buyer.toLowerCase() ? 'buyer' : 'seller';

  return (
    <main className="mx-auto max-w-[1440px] px-6 py-16">
      <Link href="/trade" className="text-xs text-muted hover:text-fg">
        ← your bonds
      </Link>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <h1 className="font-display text-3xl font-semibold tracking-tight">Bond #{id}</h1>
        {trade && <StatePill status={trade.status} />}
        {myRole && (
          <span className="rounded-full border border-line-strong px-2 py-0.5 text-[11px] uppercase tracking-wide text-muted">
            you: {myRole}
          </span>
        )}
        {trade && trade.status !== 'Released' && trade.status !== 'Cancelled' && trade.status !== 'Refunded' && (
          <CountdownChip unix={trade.deadline} label="Deadline" />
        )}
      </div>

      {!trade && !error && <p className="mt-6 text-sm text-muted">Loading…</p>}
      {error && <p className="mt-4 text-sm text-danger">{error}</p>}

      {trade && (
        <>
          {!isTerminal && (
            <div className="mt-6">
              <CountdownBanner unix={trade.deadline} label="Time remaining" />
            </div>
          )}

          {!isParticipant ? (
            <p className="mt-8 rounded-lg border border-line bg-bg/40 p-4 text-sm text-muted">
              Only the buyer and seller can view this bond&apos;s details.
              {!signer.isConnected && ' Connect the buyer or seller wallet to see it.'}
            </p>
          ) : (
          <>
          <div className="mt-6">
            <ContextTabs
              tabs={[{ key: 'overview', label: 'Overview' }, { key: 'activity', label: 'Activity', badge: events.length }]}
              active={tab}
              onChange={(k) => setTab(k as 'overview' | 'activity')}
            />
          </div>

          {tab === 'overview' && (
          <div className="bz-fadein">
          <div className="mt-6 rounded-xl border border-line bg-bg/40 px-4 py-4">
            <TradeStatusTracker status={trade.status} isPanelTrade={isPanelTrade} />
            {isPanelTrade && verification?.assigned && (
              <button onClick={() => setShowPanelModal(true)} className="mt-3 text-xs text-info hover:text-info">
                View panel decision →
              </button>
            )}
            {!isPanelTrade && officerReview?.exists && (
              <button onClick={() => setShowOfficerModal(true)} className="mt-3 text-xs text-primary hover:text-primary">
                View Trade Officer review →
              </button>
            )}
          </div>

          {/* On Funded panel trades the VerificationPanel conveys the real state
              (pay fee → submit → panel voting), so skip the officer-centric cue. */}
          {step && !(isPanelTrade && trade.status === 'Funded') && (
            <div className="mt-4">
              <StepCue step={step} />
            </div>
          )}

          <div className="mt-6 grid grid-cols-2 gap-3 text-sm">
            <Field label="Status">
              <StatePill status={trade.status} />
            </Field>
            <Field label="Amount">{trade.amountUsdc} USDC</Field>
            <Field label={trade.status === 'Funded' || trade.status === 'Released' ? 'Deposit (locked)' : 'Deposit if funded now'}>
              {(trade.status === 'Funded' || trade.status === 'Released' ? trade.depositUsdc : trade.estimatedDepositUsdc)} USDC
            </Field>
            <Field label="Financing">{trade.financingAdvanced ? `advanced (${trade.financedRepayUsdc} USDC)` : '-'}</Field>
            <Field label="Buyer"><HandleAddr address={trade.buyer} withAddress /></Field>
            <Field label="Seller"><HandleAddr address={trade.seller} withAddress /></Field>
            <Field label={`Attester (${isPanelTrade ? 'Staked panel' : 'Trade Officer'})`}><HandleAddr address={trade.attester} withAddress /></Field>
            <Field label="Deadline">{new Date(trade.deadline * 1000).toLocaleString()}</Field>
          </div>

          {lastTx && (
            <p className="mt-4 text-sm text-muted">
              Last tx:{' '}
              <a href={arcExplorerTxUrl(lastTx)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-info hover:underline">
                {lastTx.slice(0, 10)}… <ExternalLinkIcon />
              </a>
            </p>
          )}

          <div className="mt-8 space-y-4">
            {/* PROPOSING - negotiation */}
            {trade.status === 'Proposing' && (
              <div className="space-y-3">
                <p className="text-sm text-fg">
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
                        <span className="text-xs text-muted">Counter amount (USDC)</span>
                        <input
                          value={counterAmount}
                          onChange={(e) => setCounterAmount(e.target.value)}
                          inputMode="decimal"
                          placeholder="e.g. 9"
                          className="mt-1 w-40 rounded-lg border border-line bg-bg px-3 py-2 text-sm"
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

            {/* AGREED - buyer funds */}
            {trade.status === 'Agreed' && isBuyer && (
              <div className="space-y-3">
                <Action onClick={doFund} busy={busy === 'fund'} disabled={!signer.isConnected}>
                  Fund {trade.estimatedDepositUsdc} USDC (approve + lock)
                </Action>
                <FundFromChain
                  address={signer.isConnected ? signer.address : ''}
                  signerMode={signer.isConnected ? signer.mode : null}
                  lockedAmount={trade.estimatedDepositUsdc}
                  bridgeRun={bridgeRun}
                  onBridgeRunChange={setBridgeRun}
                />
              </div>
            )}
            {trade.status === 'Agreed' && !isBuyer && (
              <Waiting>Agreed at {trade.amountUsdc} USDC. Waiting for the buyer to fund.</Waiting>
            )}

            {/* FUNDED + panel mode - staked-panel verification (fee → submit → vote) */}
            {trade.status === 'Funded' && isPanelTrade && (
              <VerificationPanel tradeId={id} buyer={trade.buyer} seller={trade.seller} amountUsdc={trade.amountUsdc} onChange={refresh} />
            )}

            {/* FUNDED - buyer challenge window open (officer approved, not yet settled) */}
            {trade.status === 'Funded' && !isPanelTrade && windowActive && trade.challengeWindowUntil != null && (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-warn/40 bg-warn/20 p-4">
                <p className="text-sm text-warn">
                  {isBuyer
                    ? 'Delivery submitted. Review it now - it settles to the seller automatically unless you dispute.'
                    : isSeller
                      ? 'Delivery submitted. It settles to you automatically unless the buyer disputes in time.'
                      : 'Delivery submitted - in the buyer review window.'}
                </p>
                <CountdownChip unix={trade.challengeWindowUntil} label="Settles in" />
              </div>
            )}

            {/* FUNDED - seller delivers (officer attests, auto-settles) */}
            {trade.status === 'Funded' && !isPanelTrade && isSeller && !windowActive && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <p className="text-sm text-fg">
                    Submit your delivery document - the Trade Officer reviews it and, on a pass, the bond settles to you automatically.
                  </p>
                  <textarea
                    value={doc}
                    onChange={(e) => setDoc(e.target.value)}
                    rows={3}
                    placeholder="Paste your bill of lading / tracking / customs document - must name the document type and include a real reference number, e.g. 'Bill of Lading MAEU123456789 - 2000kg textiles, Jebel Ali → Lagos, carrier Maersk'."
                    className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm"
                  />
                  <label className="flex flex-wrap items-center gap-2 text-xs text-muted">
                    <span className="cursor-pointer rounded-md border border-line px-2.5 py-1 text-fg transition hover:border-line-strong">Attach a file (optional)</span>
                    <input type="file" className="hidden" onChange={(e) => setDeliveryFile(e.target.files?.[0] ?? null)} />
                    {deliveryFile ? <span className="truncate text-fg">{deliveryFile.name}</span> : <span>PDF, image, or scan — any party can download &amp; verify it</span>}
                  </label>
                  <Action onClick={doSubmitDelivery} busy={busy === 'attest'}>Submit to Trade Officer</Action>
                  {officerNote && (
                    <div className={`rounded-lg border p-3 text-sm ${officerNote.highValue ? 'border-info/50 bg-info/20 text-info' : 'border-warn/50 bg-warn/20 text-warn'}`}>
                      <p className="font-medium">
                        {officerNote.highValue
                          ? 'High-value trade - routed to a human reviewer.'
                          : 'Couldn’t verify this document - please correct it and resubmit.'}
                      </p>
                      {officerNote.reasons.length > 0 && (
                        <ul className="mt-1 list-disc pl-5 text-xs opacity-90">
                          {officerNote.reasons.map((r, i) => (
                            <li key={i}>{r}</li>
                          ))}
                        </ul>
                      )}
                      {!officerNote.highValue && (
                        <p className="mt-1 text-xs opacity-80">Your funds aren’t at risk - nothing is refunded; just fix the document above and submit again.</p>
                      )}
                    </div>
                  )}
                </div>
                {!trade.financingAdvanced && (
                  <div className="border-t border-line pt-3">
                    {financingQuote ? (
                      <div className="space-y-2">
                        <p className="text-xs text-muted">
                          Trade Officer underwriting - buyer is{' '}
                          <strong className="text-fg">tier {financingQuote.buyerTier}</strong>, so you qualify for an advance now (repaid at settlement):
                        </p>
                        <div className="rounded-lg border border-line bg-bg/40 p-3 text-sm">
                          <Row label="Advance now"><span className="text-primary">{financingQuote.advanceUsdc} USDC</span></Row>
                          <Row label={`Fee (${(financingQuote.feeBps / 100).toFixed(financingQuote.feeBps % 100 ? 2 : 0)}%)`}>{financingQuote.feeUsdc} USDC</Row>
                          <Row label="Repaid at settlement">{financingQuote.repayUsdc} USDC</Row>
                        </div>
                        <Action onClick={doFinance} busy={busy === 'finance'} variant="ghost">
                          Draw {financingQuote.advanceUsdc} USDC advance
                        </Action>
                      </div>
                    ) : (
                      <>
                        <p className="mb-2 text-xs text-muted">Need cash before delivery is verified? Draw an advance now (repaid at settlement).</p>
                        <Action onClick={doFinance} busy={busy === 'finance'} variant="ghost">Request financing</Action>
                      </>
                    )}
                  </div>
                )}
                <div className="border-t border-line pt-3">
                  <GatewayPayoutPanel tradeId={id} sellerAddress={trade.seller} defaultAmountUsdc={trade.amountUsdc} mode="prefer" />
                </div>
              </div>
            )}
            {trade.status === 'Funded' && !isPanelTrade && !isSeller && !windowActive && (
              <Waiting>Funded. Awaiting delivery documents from the seller; settlement is automatic once the officer attests.</Waiting>
            )}

            {/* FUNDED - buyer can reclaim after the deadline; either party can
                dispute once delivery is in (nothing to contest before that). */}
            {trade.status === 'Funded' && (isBuyer || isSeller) && (deliverySubmitted || (isBuyer && deadlinePassed)) && (
              <div className="space-y-2 border-t border-line pt-3">
                {isBuyer && deadlinePassed && (
                  <div>
                    <p className="mb-2 text-xs text-muted">The deadline passed with no attestation - reclaim your deposit.</p>
                    <Action onClick={doRefund} busy={busy === 'refund'} variant="ghost">Claim refund</Action>
                  </div>
                )}
                {deliverySubmitted && (
                  <div>
                    <p className="mb-2 text-xs text-muted">
                      {isSeller
                        ? 'Delivered but it isn’t settling, or worried about an unfair refund? Raising a dispute pauses the buyer’s refund and lets the arbitrator decide.'
                        : 'Something wrong with this delivery? Flag it for the arbitrator to resolve.'}
                    </p>
                    <Action onClick={doRaiseDispute} busy={busy === 'dispute'} variant="ghost">Raise a dispute</Action>
                  </div>
                )}
              </div>
            )}

            {trade.status === 'Released' && (
              <div className="space-y-3">
                <OutcomeCard tone="emerald" title="Settled" tx={events.find((e) => e.kind === 'Released')?.txHash} txLabel="View settlement">
                  <strong className="text-primary">{trade.amountUsdc} USDC</strong> released to the seller. The buyer&apos;s credit passport was updated.
                </OutcomeCard>
                <GatewayPayoutPanel tradeId={id} sellerAddress={trade.seller} defaultAmountUsdc={trade.amountUsdc} mode="settle" />
                {(isBuyer || isSeller) && signer.isConnected && (
                  <RateCounterparty tradeId={id} rater={signer.address} counterparty={isBuyer ? trade.seller : trade.buyer} onRate={rateCounterparty} />
                )}
              </div>
            )}
            {trade.status === 'Cancelled' && (
              <OutcomeCard tone="neutral" title="Cancelled" tx={events.find((e) => e.kind === 'TradeCancelled')?.txHash}>
                This trade was cancelled before it was funded.
              </OutcomeCard>
            )}
            {trade.status === 'Refunded' && (
              <OutcomeCard tone="amber" title="Refunded" tx={events.find((e) => e.kind === 'Refunded')?.txHash} txLabel="View refund">
                <strong className="text-warn">{trade.depositUsdc} USDC</strong> deposit returned to the buyer - no delivery was attested by the deadline.
              </OutcomeCard>
            )}
            {trade.status === 'Disputed' && isArbitrator && (
              <div className="space-y-3 rounded-lg border border-danger/40 bg-danger/20 p-4">
                <p className="text-sm text-danger">
                  You are the arbitrator for this disputed trade. Decide the outcome - the escrowed funds go to whichever party you choose.
                </p>
                <div className="flex flex-wrap gap-3">
                  <Action onClick={() => doResolve(true)} busy={busy === 'resolve-seller'}>Release to seller</Action>
                  <Action onClick={() => doResolve(false)} busy={busy === 'resolve-buyer'} variant="ghost">Refund the buyer</Action>
                </div>
              </div>
            )}
            {trade.status === 'Disputed' && !isArbitrator && (
              <OutcomeCard tone="red" title="Under dispute" tx={events.find((e) => e.kind === 'Disputed')?.txHash}>
                An arbitrator is reviewing this bond and will decide the outcome - funds stay locked until then.
              </OutcomeCard>
            )}

            {!signer.isConnected && <p className="text-sm text-warn">Connect a wallet to act on this bond.</p>}
          </div>
          </div>
          )}

          {/* Event timeline */}
          {tab === 'activity' && (
            <div className="bz-fadein mt-6">
              {events.length === 0 && (
                <p className="rounded-lg border border-line bg-bg/40 px-4 py-6 text-sm text-muted">No on-chain activity yet.</p>
              )}
              <ol className="space-y-2">
                {(() => {
                  // If the seller drew financing, the Settled amount is only the
                  // remaining balance - explain that so it doesn't read as the
                  // whole trade being settled for a fraction of its value.
                  const financed = events.find((e) => e.kind === 'FinancingAdvanced')?.amountUsdc;
                  // Newest first (events arrive oldest-first from the indexer).
                  const ordered = [...events].sort((a, b) => b.blockNumber - a.blockNumber);
                  return ordered.map((e, i) => {
                    const financedSettle = e.kind === 'Released' && !!financed;
                    const hint =
                      e.kind === 'Released'
                        ? financed
                          ? `Final ${e.amountUsdc} USDC to the seller - the other ${financed} USDC was paid early from the financing pool, so the full amount was delivered.`
                          : 'Full amount released to the seller.'
                        : EVENT_HINT[e.kind];
                    return (
                      // One tx can emit several events (e.g. attest auto-settle →
                      // Attested + Released share a txHash), so the key includes kind + index.
                      <li key={`${e.txHash}-${e.kind}-${i}`} className="flex items-start justify-between gap-3 rounded-lg border border-line bg-bg/40 px-3 py-2 text-sm">
                        <div>
                          <div>
                            <span className="text-fg">{EVENT_LABEL[e.kind] ?? e.kind}</span>
                            {e.amountUsdc && !financedSettle && <span className="text-muted"> · {e.amountUsdc} USDC</span>}
                            {e.actor && <span className="text-muted"> · {short(e.actor)}</span>}
                          </div>
                          {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1">
                          <span className="text-xs text-muted">{sqlTimeAgo(e.at)}</span>
                          <a href={arcExplorerTxUrl(e.txHash)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-info hover:underline">
                            tx <ExternalLinkIcon />
                          </a>
                        </div>
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

      {showPanelModal && verification && <PanelModal v={verification} me={me} onClose={() => setShowPanelModal(false)} />}
      {showOfficerModal && officerReview?.exists && <OfficerReviewModal review={officerReview} tradeId={id} onClose={() => setShowOfficerModal(false)} />}

      <BridgeProgressModal
        run={bridgeRun}
        onClose={() => setBridgeRun(INITIAL_RUN)}
        tail={busy === 'fund' ? <span className="text-info">Bridged ✓ - funding your bond…</span> : undefined}
      />
    </main>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between py-0.5">
      <span className="text-muted">{label}</span>
      <span className="text-fg">{children}</span>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-bg/50 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-0.5 text-fg">{children}</div>
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
  // Primary actions are the signature struck-coin; secondary stays a quiet outline.
  if (variant === 'solid') {
    return (
      <button type="button" onClick={onClick} disabled={busy || disabled} className="bz-coin mint">
        <span className="cap" aria-hidden>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
        </span>
        <span className="face">{busy ? 'Working…' : children}</span>
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || disabled}
      className="rounded-lg border border-line-strong px-4 py-2 text-sm font-medium text-fg disabled:opacity-40"
    >
      {busy ? 'Working…' : children}
    </button>
  );
}

// Pending / awaiting-someone-else state. Amber fill + a pulsing dot so the
// status reads at a glance rather than blending into the page as muted text.
function Waiting({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-warn/40 bg-warn/10 p-4">
      <span className="mt-1.5 h-2 w-2 shrink-0 animate-pulse rounded-full bg-warn" aria-hidden />
      <p className="text-[0.95rem] font-medium text-fg">{children}</p>
    </div>
  );
}

// Terminal / in-flight outcome summary card (Settled / Refunded / Cancelled /
// Disputed) - icon badge + headline + body + an optional "view tx" button.
const OUTCOME_TONES = {
  emerald: { border: 'border-primary/40', from: 'from-primary/40', badge: 'bg-primary/15 text-primary', title: 'text-primary', btn: 'bg-primary hover:bg-primary', icon: <path d="M20 6 9 17l-5-5" /> },
  amber: { border: 'border-warn/40', from: 'from-warn/40', badge: 'bg-warn/15 text-warn', title: 'text-warn', btn: 'bg-warn hover:bg-warn', icon: <><path d="M9 14 4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-3" /></> },
  red: { border: 'border-danger/40', from: 'from-danger/40', badge: 'bg-danger/15 text-danger', title: 'text-danger', btn: 'bg-danger hover:bg-danger', icon: <><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4" /><path d="M12 17h.01" /></> },
  neutral: { border: 'border-line', from: 'from-surface/40', badge: 'bg-muted/15 text-fg', title: 'text-fg', btn: 'bg-muted hover:bg-surface-2', icon: <><circle cx="12" cy="12" r="9" /><path d="m15 9-6 6M9 9l6 6" /></> },
} as const;

function OutcomeCard({
  tone,
  title,
  tx,
  txLabel = 'View transaction',
  children,
}: {
  tone: keyof typeof OUTCOME_TONES;
  title: string;
  tx?: string;
  txLabel?: string;
  children: React.ReactNode;
}) {
  const T = OUTCOME_TONES[tone];
  return (
    <div className={`rounded-xl border ${T.border} bg-gradient-to-br ${T.from} to-bg/30 p-5`}>
      <div className="flex items-start gap-3">
        <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${T.badge}`}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            {T.icon}
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <h3 className={`text-base font-semibold ${T.title}`}>{title}</h3>
          <div className="mt-0.5 text-sm text-fg">{children}</div>
          {tx && (
            <a href={arcExplorerTxUrl(tx)} target="_blank" rel="noreferrer" className={`mt-3 inline-flex items-center gap-1.5 rounded-lg ${T.btn} px-3 py-1.5 text-xs font-semibold text-white transition`}>
              {txLabel} <ExternalLinkIcon />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

// Thumbs up/down on the counterparty after settlement. Only renders when the
// counterparty has linked an ERC-8004 agentId (reputation is agentId-based).
function RateCounterparty({ tradeId, rater, counterparty, onRate }: { tradeId: string; rater: string; counterparty: string; onRate: (agentId: string, positive: boolean) => Promise<void> }) {
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
    return (
      <p className="rounded-lg border border-line bg-bg/40 px-4 py-3 text-xs text-muted">
        Your counterparty hasn&apos;t linked an agent, so there&apos;s no reputation to leave.
      </p>
    );
  }
  if (rated !== null) {
    return <p className="text-xs text-primary">Thanks - you left {rated ? '👍' : '👎'} feedback.</p>;
  }

  const rate = async (positive: boolean) => {
    setBusy(true);
    try {
      await onRate(agentId, positive);
      setRated(positive);
      toast.success('Feedback submitted');
      // A 👍 on a settled trade earns a trusted operator endorsement (1.2×).
      // Best-effort: the 👍 already landed; don't surface boost failures.
      if (positive) {
        triggerFeedbackBoost(tradeId, agentId, rater)
          .then((r) => { if (r.boosted) toast.success('Operator-verified boost applied (1.2×)'); })
          .catch(() => {});
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-3 rounded-lg border border-line bg-bg/40 px-4 py-3">
      <span className="text-sm text-fg">Rate your counterparty</span>
      <div className="ml-auto flex gap-2">
        <button onClick={() => rate(true)} disabled={busy} className="rounded-md border border-line px-3 py-1.5 text-sm hover:border-primary hover:text-primary disabled:opacity-50">👍</button>
        <button onClick={() => rate(false)} disabled={busy} className="rounded-md border border-line px-3 py-1.5 text-sm hover:border-danger hover:text-danger disabled:opacity-50">👎</button>
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
