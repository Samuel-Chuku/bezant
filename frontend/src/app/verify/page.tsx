'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSigner } from '@/hooks/use-signer';
import { useToast } from '@/components/toast';
import { useTxFlow } from '@/components/tx-flow';
import { getVerifierInfo, buildVerifierStakeUnsigned, buildVerifierUnstakeUnsigned, type VerifierInfo, type UnsignedTx } from '@/lib/api';

// Staked-verifier (Arm 2) console: stake to join the panel, see the economics,
// withdraw free stake. Selected verifiers vote on delivery for trades that chose
// the "Staked panel" verification mode, earning the buyer fee + slashed stake.
export default function VerifyPage() {
  const signer = useSigner();
  const toast = useToast();
  const txFlow = useTxFlow();
  const [info, setInfo] = useState<VerifierInfo | null>(null);
  const [stakeAmt, setStakeAmt] = useState('');
  const [unstakeAmt, setUnstakeAmt] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setInfo(await getVerifierInfo(signer.isConnected ? signer.address : undefined));
    } catch {
      /* unreachable */
    }
  }, [signer.isConnected, signer.address]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const send = async (u: UnsignedTx, review: boolean) => {
    if (!signer.isConnected) throw new Error('Connect a wallet first.');
    const sent = await signer.sendCall({ to: u.to, data: u.data, value: BigInt(u.value) }, { review });
    if ((await sent.wait()).status !== 'success') throw new Error('Transaction reverted.');
  };

  const doStake = async () => {
    if (!signer.isConnected || !stakeAmt || Number(stakeAmt) <= 0) return;
    const { approve, stake } = await buildVerifierStakeUnsigned(stakeAmt);
    const ok = await txFlow.start({
      title: `Stake ${stakeAmt} USDC`,
      amountUsdc: stakeAmt,
      steps: [
        { key: 'approve', label: 'Approve USDC', action: 'Approve', run: async () => send(approve, false) },
        { key: 'stake', label: 'Stake into the verifier pool', action: 'Stake', run: async () => send(stake, false) },
      ],
    });
    if (ok) {
      toast.success('Staked');
      setStakeAmt('');
      await refresh();
    }
  };

  const doUnstake = async () => {
    if (!signer.isConnected || !unstakeAmt || Number(unstakeAmt) <= 0) return;
    setBusy(true);
    try {
      await send(await buildVerifierUnstakeUnsigned(unstakeAmt), true);
      toast.success('Unstaked');
      setUnstakeAmt('');
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto max-w-5xl px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Verify</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted">
        Stake USDC to join the verifier panel. When a buyer picks decentralized verification, a stake-weighted panel is drawn to vote on delivery — honest voters split the buyer&apos;s fee plus stake slashed from anyone who votes against the majority or no-shows.
      </p>

      {!info?.configured ? (
        <p className="mt-8 rounded-xl border border-line bg-surface p-5 text-sm text-muted">
          The staked verifier isn&apos;t deployed on this network yet.
        </p>
      ) : (
        <div className="mt-8 grid gap-5 sm:grid-cols-2">
          {/* Economics */}
          <section className="rounded-xl border border-line bg-surface p-5">
            <div className="text-[11px] uppercase tracking-wide text-muted">Panel economics</div>
            <dl className="mt-3 space-y-2 text-sm">
              <Row label="Panel size">{info.panelSize}</Row>
              <Row label="Buyer fee">{(info.feeBps ?? 0) / 100}% of trade</Row>
              <Row label="Bond / assignment">{(info.bondBps ?? 0) / 100}% of your stake</Row>
              <Row label="Slash on bad vote">{(info.slashBps ?? 0) / 100}% of bond</Row>
              <Row label="Min stake">{info.minStakeUsdc} USDC</Row>
              <Row label="Vote window">{Math.round((info.voteWindowSeconds ?? 0) / 60)} min</Row>
              <Row label="Verifiers">{info.verifierCount}</Row>
            </dl>
          </section>

          {/* Stake */}
          <section className="rounded-xl border border-line bg-surface p-5">
            <div className="flex items-center justify-between">
              <div className="text-[11px] uppercase tracking-wide text-muted">Your stake</div>
              {signer.isConnected && (
                <span className="text-xs text-muted">
                  {info.myStakeUsdc ?? '0'} USDC{info.myLockedUsdc && info.myLockedUsdc !== '0' ? ` · ${info.myLockedUsdc} locked` : ''}
                </span>
              )}
            </div>

            {!signer.isConnected ? (
              <p className="mt-3 text-sm text-muted">Connect a wallet to stake.</p>
            ) : (
              <div className="mt-3 space-y-3">
                <div className="flex items-end gap-2">
                  <label className="flex flex-1 flex-col gap-1 text-xs text-muted">
                    Stake (USDC)
                    <input value={stakeAmt} onChange={(e) => setStakeAmt(e.target.value)} inputMode="decimal" placeholder={info.minStakeUsdc} className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-fg placeholder:text-muted focus:border-line-strong focus:outline-none" />
                  </label>
                  <button onClick={doStake} disabled={!stakeAmt} className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-fg transition hover:bg-primary-hover disabled:opacity-50">Stake</button>
                </div>
                <div className="flex items-end gap-2">
                  <label className="flex flex-1 flex-col gap-1 text-xs text-muted">
                    Unstake (free only)
                    <input value={unstakeAmt} onChange={(e) => setUnstakeAmt(e.target.value)} inputMode="decimal" placeholder="0.00" className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-fg placeholder:text-muted focus:border-line-strong focus:outline-none" />
                  </label>
                  <button onClick={doUnstake} disabled={busy || !unstakeAmt} className="rounded-md border border-line px-4 py-2 text-sm text-fg transition hover:border-line-strong disabled:opacity-50">{busy ? 'Working…' : 'Unstake'}</button>
                </div>
              </div>
            )}
          </section>
        </div>
      )}
    </main>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className="text-fg">{children}</dd>
    </div>
  );
}
