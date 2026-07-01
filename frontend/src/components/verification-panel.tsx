'use client';

// Trade-page UI for staked-panel verification (Arm 2), shown while a panel-mode
// trade is Funded. Branches by role + state: buyer pays the verification fee →
// seller submits the delivery doc → the drawn panel reviews it and votes →
// majority attests (settles or disputes, handled by the parent status block).
import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSigner } from '@/hooks/use-signer';
import { useToast } from '@/components/toast';
import { useTxFlow } from '@/components/tx-flow';
import { CountdownChip } from '@/components/countdown';
import { shortAddress } from '@/lib/format';
import {
  getVerification,
  buildVerificationFundUnsigned,
  buildVerificationVoteUnsigned,
  buildVerificationResolveUnsigned,
  assignVerification,
  verifyAssignAuthMessage,
  type VerificationState,
  type UnsignedTx,
} from '@/lib/api';

export function VerificationPanel({ tradeId, buyer, seller, amountUsdc, onChange }: { tradeId: string; buyer: string; seller: string; amountUsdc: string; onChange: () => void }) {
  const signer = useSigner();
  const toast = useToast();
  const txFlow = useTxFlow();
  const [v, setV] = useState<VerificationState | null>(null);
  const [doc, setDoc] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingVote, setPendingVote] = useState<boolean | null>(null); // verdict awaiting confirmation
  const [showPanel, setShowPanel] = useState(false);

  const me = signer.isConnected ? signer.address.toLowerCase() : null;
  const isBuyer = me === buyer.toLowerCase();
  const isSeller = me === seller.toLowerCase();

  const refresh = useCallback(async () => {
    try {
      setV(await getVerification(tradeId, signer.isConnected ? signer.address : undefined));
    } catch {
      /* leave as-is */
    }
  }, [tradeId, signer.isConnected, signer.address]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll while a panel is voting so tallies + my-vote stay live.
  useEffect(() => {
    if (!v || v.resolved || !v.assigned) return;
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [v?.assigned, v?.resolved, refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = async (u: UnsignedTx, review: boolean) => {
    if (!signer.isConnected) throw new Error('Connect a wallet.');
    const sent = await signer.sendCall({ to: u.to, data: u.data, value: BigInt(u.value) }, { review });
    if ((await sent.wait()).status !== 'success') throw new Error('Transaction reverted.');
  };

  const payFee = async () => {
    const { feeUsdc, approve, fund } = await buildVerificationFundUnsigned(tradeId);
    // Derive the rate from fee/amount so the buyer sees what they're paying and on what.
    const amt = Number(amountUsdc);
    const pct = amt > 0 ? +((Number(feeUsdc) / amt) * 100).toFixed(2) : 0;
    const ok = await txFlow.start({
      title: `Verification fee · ${feeUsdc} USDC`,
      amountUsdc: feeUsdc,
      overview: [
        { label: 'Verification fee', before: '-', after: `${feeUsdc} USDC` },
        { label: 'Fee rate', before: '-', after: `${pct}% of ${amountUsdc} USDC` },
        { label: 'Verified by', before: '-', after: 'Staked panel' },
      ],
      steps: [
        { key: 'approve', label: 'Approve USDC', action: 'Approve', run: async () => send(approve, false) },
        { key: 'fund', label: 'Pay verification fee', action: 'Pay', run: async () => send(fund, false) },
      ],
    });
    if (ok) {
      toast.success('Verification fee paid');
      await refresh();
      onChange();
    }
  };

  const submitToPanel = async () => {
    if (doc.trim().length < 20) {
      toast.error('Paste the full delivery document.');
      return;
    }
    if (!signer.isConnected) return;
    setBusy(true);
    try {
      const ts = Date.now();
      const signature = await signer.signMessage(verifyAssignAuthMessage(tradeId, ts));
      await assignVerification(tradeId, doc, { signature, ts });
      toast.success('Submitted - the panel has been drawn and is voting');
      setDoc('');
      await refresh();
      onChange();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const vote = async (pass: boolean) => {
    setBusy(true);
    try {
      await send(await buildVerificationVoteUnsigned(tradeId, pass), true);
      toast.success(pass ? 'Vote recorded - you confirmed delivery' : 'Vote recorded - you rejected delivery');
      setPendingVote(null);
      await refresh();
      onChange();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const resolve = async () => {
    setBusy(true);
    try {
      await send(await buildVerificationResolveUnsigned(tradeId), true);
      toast.success('Verification resolved');
      await refresh();
      onChange();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!v) return null;

  const card = 'space-y-3 rounded-lg border border-info/30 bg-info/15 p-4';
  const onPanel = !!me && v.panel.some((p) => p.toLowerCase() === me);
  const expired = v.deadline > 0 && Date.now() / 1000 > v.deadline;

  // ── Before assignment: buyer pays fee, then seller submits delivery ──
  if (!v.assigned) {
    if (!v.prepaid) {
      return (
        <div className={card}>
          <p className="text-sm text-info">Decentralized verification (staked panel)</p>
          {isBuyer ? (
            <>
              <p className="text-xs text-muted">Pay the verification fee to start - a staked panel will review delivery instead of the Trade Officer.</p>
              <button onClick={payFee} className="rounded-md bg-info px-3 py-1.5 text-sm font-medium text-white hover:bg-info">Pay verification fee</button>
            </>
          ) : (
            <p className="text-xs text-muted">Waiting for the buyer to pay the verification fee.</p>
          )}
        </div>
      );
    }
    return (
      <div className={card}>
        <p className="text-sm text-info">Decentralized verification (staked panel)</p>
        {isSeller ? (
          <div className="space-y-2">
            <p className="text-xs text-muted">Submit your delivery document - a staked panel will review it and vote.</p>
            <textarea value={doc} onChange={(e) => setDoc(e.target.value)} rows={3} placeholder="Paste your bill of lading / tracking / customs document…" className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm" />
            <button onClick={submitToPanel} disabled={busy} className="rounded-md bg-info px-3 py-1.5 text-sm font-medium text-white hover:bg-info disabled:opacity-50">{busy ? 'Submitting…' : 'Submit to the panel'}</button>
          </div>
        ) : (
          <p className="text-xs text-muted">Verification fee paid. Waiting for the seller to submit delivery.</p>
        )}
      </div>
    );
  }

  // ── Assigned: panel is voting (or awaiting timeout resolution) ──
  return (
    <div className={card}>
      <div className="flex items-center justify-between">
        <p className="text-sm text-info">Staked panel - verifying delivery</p>
        {!expired && !v.resolved && <CountdownChip unix={v.deadline} label="Voting closes" />}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        <span>Panel of {v.panel.length}</span>
        {v.resolved ? (
          <>
            <span className="text-primary">{v.passes} confirmed</span>
            <span className="text-danger">{v.fails} rejected</span>
          </>
        ) : (
          <span className="text-muted">verdicts hidden until voting closes</span>
        )}
        <span>· {v.cast}/{v.panel.length} voted</span>
        <button onClick={() => setShowPanel(true)} className="ml-auto rounded-md border border-info/30 px-2 py-0.5 text-[11px] text-info hover:bg-info/12">
          View panel &amp; decisions
        </button>
      </div>

      {v.document && (
        <details className="rounded-md border border-line bg-bg/50 p-2">
          <summary className="cursor-pointer text-xs text-muted">Delivery document</summary>
          <pre className="mt-2 whitespace-pre-wrap break-words text-xs text-fg">{v.document}</pre>
        </details>
      )}

      {onPanel && !v.resolved && (
        v.myVote && v.myVote !== 0 ? (
          <p className={`text-xs ${v.myVote === 1 ? 'text-primary' : 'text-danger'}`}>
            You {v.myVote === 1 ? 'confirmed' : 'rejected'} this delivery.
          </p>
        ) : expired ? null : pendingVote === null ? (
          <div className="space-y-1.5">
            <p className="text-sm text-fg">Your verdict on this delivery:</p>
            <div className="flex flex-wrap gap-2">
              <button onClick={() => setPendingVote(true)} disabled={busy} className="inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-sm hover:border-primary hover:text-primary disabled:opacity-50">
                <CheckIcon /> Confirm delivery
              </button>
              <button onClick={() => setPendingVote(false)} disabled={busy} className="inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-sm hover:border-danger hover:text-danger disabled:opacity-50">
                <XIcon /> Reject delivery
              </button>
            </div>
          </div>
        ) : (
          // ── #2: are-you-sure confirmation before signing ──
          <div className={`space-y-2 rounded-lg border p-3 ${pendingVote ? 'border-primary/50 bg-primary/20' : 'border-danger/50 bg-danger/20'}`}>
            <p className="text-sm font-medium text-fg">
              {pendingVote ? 'Confirm this delivery?' : 'Reject this delivery?'}
            </p>
            <p className="text-xs text-muted">
              {pendingVote
                ? 'You attest the goods were delivered as described - the panel can release funds to the seller.'
                : 'You attest the delivery is missing or doesn’t match - the panel can refund the buyer.'}{' '}
              This vote is <strong className="text-fg">final and signed on-chain</strong>; if you end up in the minority, your bonded stake is slashed.
            </p>
            <div className="flex gap-2">
              <button onClick={() => vote(pendingVote)} disabled={busy} className={`rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 ${pendingVote ? 'bg-primary hover:bg-primary' : 'bg-danger hover:bg-danger'}`}>
                {busy ? 'Signing…' : `Yes, ${pendingVote ? 'confirm' : 'reject'}`}
              </button>
              <button onClick={() => setPendingVote(null)} disabled={busy} className="rounded-md border border-line-strong px-3 py-1.5 text-sm text-fg hover:text-fg disabled:opacity-50">Cancel</button>
            </div>
          </div>
        )
      )}

      {!onPanel && !v.resolved && <p className="text-xs text-muted">A drawn panel is reviewing the delivery.</p>}

      {expired && !v.resolved && (
        <button onClick={resolve} disabled={busy} className="rounded-md border border-line px-3 py-1.5 text-sm text-fg hover:text-fg disabled:opacity-50">{busy ? 'Resolving…' : 'Resolve (window closed)'}</button>
      )}

      {showPanel && <PanelModal v={v} me={me} onClose={() => setShowPanel(false)} />}
    </div>
  );
}

// #6: panel transparency - who was drawn, how, each verdict, and the outcome.
// Exported so the trade page can show it post-settlement too (the VerificationPanel
// itself only renders while the trade is Funded).
export function PanelModal({ v, me, onClose }: { v: VerificationState; me: string | null; onClose: () => void }) {
  const decisions = v.decisions ?? v.panel.map((address) => ({ address, handle: null, vote: 0 }));
  const outcome = v.resolved ? (v.passes >= v.fails ? 'Delivery confirmed' : 'Delivery rejected') : 'Voting in progress';
  const label = (vote: number) =>
    vote === 1
      ? { t: 'Confirmed', c: 'text-primary' }
      : vote === 2
        ? { t: 'Rejected', c: 'text-danger' }
        : vote === -1
          ? { t: 'Voted', c: 'text-muted' }
          : { t: 'Awaiting', c: 'text-muted' };
  const winSide = v.passes >= v.fails ? 1 : 2; // contract: ties → confirm
  const honestCount = decisions.filter((d) => d.vote === winSide).length;
  const slashPct = (v.slashBps ?? 5000) / 100;

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center px-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div role="dialog" aria-label="Panel decision" className="relative w-full max-w-md rounded-2xl border border-info/30 bg-bg p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold tracking-tight text-fg">Panel decision</h3>
            <p className={`mt-0.5 text-sm ${v.resolved ? (v.passes >= v.fails ? 'text-primary' : 'text-danger') : 'text-muted'}`}>{outcome}</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="rounded-md p-1 text-muted hover:bg-surface hover:text-fg">
            <XIcon />
          </button>
        </div>

        {!v.resolved && (
          <p className="mt-3 rounded-md border border-line bg-bg/40 px-3 py-2 text-[11px] text-muted">
            Individual verdicts are hidden until voting closes - so panelists can&apos;t copy each other.
          </p>
        )}

        <div className="mt-4 space-y-1.5">
          {decisions.map((d) => {
            const l = label(d.vote);
            const mine = !!me && d.address.toLowerCase() === me;
            const slashed = v.resolved && d.vote !== winSide; // minority or no-show
            return (
              <div key={d.address} className="flex items-center justify-between gap-3 rounded-lg border border-line bg-bg/60 px-3 py-2 text-sm">
                <span className="truncate text-fg">
                  {d.handle ? `@${d.handle}` : shortAddress(d.address)}
                  {mine && <span className="ml-1.5 text-[10px] uppercase tracking-wide text-info">you</span>}
                </span>
                <span className="flex shrink-0 items-center gap-2 text-xs font-medium">
                  {v.resolved && (
                    <span className={slashed ? 'text-danger' : 'text-primary'}>{slashed ? 'Slashed' : 'Rewarded'}</span>
                  )}
                  <span className={l.c}>{l.t}</span>
                </span>
              </div>
            );
          })}
        </div>

        {v.resolved && (
          <div className="mt-3 rounded-lg border border-line bg-bg/40 p-3 text-xs leading-relaxed text-muted">
            <span className="font-medium text-muted">Slashing:</span> losing voters and no-shows forfeited{' '}
            <strong className="text-fg">{slashPct}% of their bonded stake</strong>, split among the {honestCount} honest
            voter{honestCount === 1 ? '' : 's'} together with the buyer&apos;s fee.
          </div>
        )}

        <div className="mt-4 rounded-lg border border-line bg-bg/40 p-3 text-xs leading-relaxed text-muted">
          <span className="font-medium text-muted">How this panel was chosen:</span> verifiers were drawn at
          random, weighted by each one&apos;s free stake × reputation, seeded by the block&apos;s randomness at
          assignment. The bond&apos;s buyer and seller are always excluded, and a majority decides the outcome.
        </div>

        <button onClick={onClose} className="mt-4 w-full rounded-lg border border-line px-4 py-2 text-sm text-fg hover:border-line-strong">Close</button>
      </div>
    </div>,
    document.body,
  );
}

function CheckIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}
