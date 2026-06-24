'use client';

// Trade-page UI for staked-panel verification (Arm 2), shown while a panel-mode
// trade is Funded. Branches by role + state: buyer pays the verification fee →
// seller submits the delivery doc → the drawn panel reviews it and votes →
// majority attests (settles or disputes, handled by the parent status block).
import { useCallback, useEffect, useState } from 'react';
import { useSigner } from '@/hooks/use-signer';
import { useToast } from '@/components/toast';
import { useTxFlow } from '@/components/tx-flow';
import { CountdownChip } from '@/components/countdown';
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
        { label: 'Verification fee', before: '—', after: `${feeUsdc} USDC` },
        { label: 'Fee rate', before: '—', after: `${pct}% of ${amountUsdc} USDC` },
        { label: 'Verified by', before: '—', after: 'Staked panel' },
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
      toast.success('Submitted — the panel has been drawn and is voting');
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
      toast.success(`Voted ${pass ? '👍' : '👎'}`);
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

  const card = 'space-y-3 rounded-lg border border-violet-900/40 bg-violet-950/15 p-4';
  const onPanel = !!me && v.panel.some((p) => p.toLowerCase() === me);
  const expired = v.deadline > 0 && Date.now() / 1000 > v.deadline;

  // ── Before assignment: buyer pays fee, then seller submits delivery ──
  if (!v.assigned) {
    if (!v.prepaid) {
      return (
        <div className={card}>
          <p className="text-sm text-violet-100">Decentralized verification (staked panel)</p>
          {isBuyer ? (
            <>
              <p className="text-xs text-neutral-400">Pay the verification fee to start — a staked panel will review delivery instead of the Trade Officer.</p>
              <button onClick={payFee} className="rounded-md bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-500">Pay verification fee</button>
            </>
          ) : (
            <p className="text-xs text-neutral-500">Waiting for the buyer to pay the verification fee.</p>
          )}
        </div>
      );
    }
    return (
      <div className={card}>
        <p className="text-sm text-violet-100">Decentralized verification (staked panel)</p>
        {isSeller ? (
          <div className="space-y-2">
            <p className="text-xs text-neutral-400">Submit your delivery document — a staked panel will review it and vote.</p>
            <textarea value={doc} onChange={(e) => setDoc(e.target.value)} rows={3} placeholder="Paste your bill of lading / tracking / customs document…" className="w-full rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm" />
            <button onClick={submitToPanel} disabled={busy} className="rounded-md bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50">{busy ? 'Submitting…' : 'Submit to the panel'}</button>
          </div>
        ) : (
          <p className="text-xs text-neutral-500">Verification fee paid. Waiting for the seller to submit delivery.</p>
        )}
      </div>
    );
  }

  // ── Assigned: panel is voting (or awaiting timeout resolution) ──
  return (
    <div className={card}>
      <div className="flex items-center justify-between">
        <p className="text-sm text-violet-100">Staked panel — verifying delivery</p>
        {!expired && !v.resolved && <CountdownChip unix={v.deadline} label="Voting closes" />}
      </div>
      <div className="text-xs text-neutral-400">
        Panel of {v.panel.length} · 👍 {v.passes} · 👎 {v.fails} · {v.cast}/{v.panel.length} voted
      </div>

      {v.document && (
        <details className="rounded-md border border-neutral-800 bg-neutral-950/50 p-2">
          <summary className="cursor-pointer text-xs text-neutral-400">Delivery document</summary>
          <pre className="mt-2 whitespace-pre-wrap break-words text-xs text-neutral-300">{v.document}</pre>
        </details>
      )}

      {onPanel && !v.resolved && (
        v.myVote && v.myVote !== 0 ? (
          <p className="text-xs text-emerald-300">You voted {v.myVote === 1 ? '👍 pass' : '👎 fail'}.</p>
        ) : expired ? null : (
          <div className="flex items-center gap-2">
            <span className="text-sm text-neutral-300">Your verdict:</span>
            <button onClick={() => vote(true)} disabled={busy} className="rounded-md border border-neutral-800 px-3 py-1.5 text-sm hover:border-emerald-700 hover:text-emerald-300 disabled:opacity-50">👍 Pass</button>
            <button onClick={() => vote(false)} disabled={busy} className="rounded-md border border-neutral-800 px-3 py-1.5 text-sm hover:border-red-700 hover:text-red-300 disabled:opacity-50">👎 Fail</button>
          </div>
        )
      )}

      {!onPanel && !v.resolved && <p className="text-xs text-neutral-500">A drawn panel is reviewing the delivery.</p>}

      {expired && !v.resolved && (
        <button onClick={resolve} disabled={busy} className="rounded-md border border-neutral-800 px-3 py-1.5 text-sm text-neutral-300 hover:text-neutral-100 disabled:opacity-50">{busy ? 'Resolving…' : 'Resolve (window closed)'}</button>
      )}
    </div>
  );
}
