'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSigner } from '@/hooks/use-signer';
import { useToast } from '@/components/toast';
import { useTxFlow } from '@/components/tx-flow';
import { useVerifierAssignments } from '@/hooks/use-verifier-assignments';
import { RecentVerifierStakes } from '@/components/recent-verifier-stakes';
import { CountdownChip } from '@/components/countdown';
import { StruckButton } from '@/components/ui';
import { getVerifierInfo, buildVerifierStakeUnsigned, buildVerifierUnstakeUnsigned, type VerifierInfo, type UnsignedTx, type VerifierAssignment } from '@/lib/api';

const PlusIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
);

type Filter = 'pending' | 'voted' | 'done' | 'all';
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'pending', label: 'Pending' },
  { key: 'voted', label: 'Voted' },
  { key: 'done', label: 'Done' },
  { key: 'all', label: 'All' },
];
const EMPTY: Record<Filter, string> = {
  pending: 'No verifications awaiting your vote.',
  voted: 'You haven’t voted on any open panels.',
  done: 'No completed verifications yet.',
  all: 'You haven’t been drawn onto any panels yet. Stake to join the pool.',
};
function inFilter(a: VerifierAssignment, f: Filter): boolean {
  if (f === 'all') return true;
  if (f === 'done') return a.status === 'resolved' || a.status === 'expired';
  return a.status === f;
}

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
  const [filter, setFilter] = useState<Filter>('pending');
  const { items: assignments, loaded: assignmentsLoaded } = useVerifierAssignments();

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
    // minStake is enforced at selection, not in stake() - a sub-min stake would
    // sit idle and never be drawn. Block it here so it can't happen by accident.
    const min = Number(info?.minStakeUsdc ?? 0);
    const current = Number(info?.myStakeUsdc ?? 0);
    if (current + Number(stakeAmt) < min) {
      toast.error(`Minimum stake is ${info?.minStakeUsdc} USDC - add at least ${(min - current).toFixed(2)} more to qualify.`);
      return;
    }
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
      toast.success(`Staked ${stakeAmt} USDC`);
      setStakeAmt('');
      await refresh();
    }
  };

  const doUnstake = async () => {
    if (!signer.isConnected || !unstakeAmt || Number(unstakeAmt) <= 0) return;
    const amt = unstakeAmt;
    const ok = await txFlow.start({
      title: `Unstake ${amt} USDC`,
      amountUsdc: amt,
      steps: [
        { key: 'unstake', label: 'Unstake from the verifier pool', action: 'Unstake', run: async () => send(await buildVerifierUnstakeUnsigned(amt), false) },
      ],
    });
    if (ok) {
      toast.success(`Unstaked ${amt} USDC`);
      setUnstakeAmt('');
      await refresh();
    }
  };

  return (
    <main className="mx-auto max-w-[1440px] px-6 py-16">
      <h1 className="font-display text-3xl font-semibold tracking-tight">Verify</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted">
        Stake USDC to join the verifier panel. When a buyer picks decentralized verification, a stake-weighted panel is drawn to vote on delivery - honest voters split the buyer&apos;s fee plus stake slashed from anyone who votes against the majority or no-shows.
      </p>

      {signer.isConnected && info?.configured && (
        <section className="mt-8 rounded-xl border border-line bg-surface p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-medium text-fg">My verifications</h2>
            <div className="flex gap-1 rounded-lg border border-line bg-surface-2 p-0.5">
              {FILTERS.map((f) => {
                const n = f.key === 'all' ? assignments.length : assignments.filter((a) => inFilter(a, f.key)).length;
                return (
                  <button
                    key={f.key}
                    onClick={() => setFilter(f.key)}
                    className={`rounded-md px-2.5 py-1 text-xs transition ${filter === f.key ? 'bg-surface text-fg' : 'text-muted hover:text-fg'}`}
                  >
                    {f.label}
                    {n > 0 && <span className="ml-1 text-[10px] text-muted">{n}</span>}
                  </button>
                );
              })}
            </div>
          </div>

          {(() => {
            const shown = assignments.filter((a) => inFilter(a, filter));
            if (!assignmentsLoaded) return <p className="mt-4 text-sm text-muted">Loading…</p>;
            if (shown.length === 0) return <p className="mt-4 rounded-xl border border-line bg-surface-2 px-3 py-8 text-center text-sm text-muted">{EMPTY[filter]}</p>;
            return (
              <ul className="mt-4 divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface-2">
                {shown.map((a) => (
                  <li key={a.tradeId} className="flex items-center gap-3 px-4 py-3 text-sm transition hover:bg-surface">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                      <VerifyGlyph />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-fg">Bond #{a.tradeId}</span>
                        <StatusPill status={a.status} />
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      {a.status === 'pending' && <CountdownChip unix={a.deadline} label="Closes" />}
                      <Link
                        href={`/trade/${a.tradeId}`}
                        className={a.status === 'pending'
                          ? 'rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-fg transition hover:bg-primary-hover'
                          : 'rounded-md border border-line px-3 py-1.5 text-xs text-fg transition hover:border-line-strong'}
                      >
                        {a.status === 'pending' ? 'Review & vote' : 'View'}
                      </Link>
                    </div>
                  </li>
                ))}
              </ul>
            );
          })()}
        </section>
      )}

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
              <Row label="Buyer fee">{(info.feeBps ?? 0) / 100}% of bond</Row>
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
                  <StruckButton size="sm" onClick={doStake} disabled={!stakeAmt} icon={<PlusIcon />}>Stake</StruckButton>
                </div>
                <div>
                  <div className="flex items-end gap-2">
                    <label className="flex flex-1 flex-col gap-1 text-xs text-muted">
                      Unstake (free only)
                      <input value={unstakeAmt} onChange={(e) => setUnstakeAmt(e.target.value)} inputMode="decimal" placeholder="0.00" className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-fg placeholder:text-muted focus:border-line-strong focus:outline-none" />
                    </label>
                    <button onClick={doUnstake} disabled={!unstakeAmt} className="rounded-md border border-line px-4 py-2 text-sm text-fg transition hover:border-line-strong disabled:opacity-50">Unstake</button>
                  </div>
                  {(() => {
                    const free = Math.max(0, Number(info.myStakeUsdc ?? 0) - Number(info.myLockedUsdc ?? 0));
                    if (free <= 0) return null;
                    return (
                      <div className="mt-1.5 flex items-center gap-2 text-[11px] text-muted">
                        <span>{free.toFixed(2)} free</span>
                        <button type="button" onClick={() => setUnstakeAmt((free / 2).toFixed(2))} className="rounded border border-line px-1.5 py-0.5 transition hover:text-fg">50%</button>
                        <button type="button" onClick={() => setUnstakeAmt(String(free))} className="rounded border border-line px-1.5 py-0.5 transition hover:text-fg">Max</button>
                      </div>
                    );
                  })()}
                </div>
              </div>
            )}
          </section>
        </div>
      )}

      {info?.configured && <RecentVerifierStakes />}
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

function VerifyGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 11l3 3L22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  );
}

function StatusPill({ status }: { status: VerifierAssignment['status'] }) {
  const style: Record<VerifierAssignment['status'], string> = {
    pending: 'bg-primary/15 text-primary',
    voted: 'bg-info/15 text-info',
    resolved: 'bg-muted/15 text-fg',
    expired: 'bg-danger/15 text-danger',
  };
  const label: Record<VerifierAssignment['status'], string> = {
    pending: 'needs your vote',
    voted: 'voted',
    resolved: 'resolved',
    expired: 'missed',
  };
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${style[status]}`}>{label[status]}</span>;
}
