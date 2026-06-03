'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { type Hex } from 'viem';
import { usePublicClient } from 'wagmi';
import { useSigner } from '@/hooks/use-signer';
import { arcTestnet, WRAPPER_ADDRESS, USDC_ADDRESS } from '@/lib/chains';
import {
  buildApproveUnsigned,
  buildStakeEvaluatorUnsigned,
  buildUnstakeEvaluatorUnsigned,
  getEvaluatorInfo,
  type EvaluatorInfo,
} from '@/lib/api';
import { ErrorBanner } from '@/components/async-state';

const erc20AllowanceAbi = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
] as const;

type ActionState =
  | { status: 'idle' }
  | { status: 'busy'; label: string }
  | { status: 'error'; message: string }
  | { status: 'success' };

export default function EvaluatorsPage() {
  const signer = useSigner();
  const publicClient = usePublicClient({ chainId: arcTestnet.id });
  const [info, setInfo] = useState<EvaluatorInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [action, setAction] = useState<ActionState>({ status: 'idle' });

  const load = useCallback(async () => {
    if (!signer.isConnected) return;
    setLoadError(null);
    try {
      const data = await getEvaluatorInfo(signer.address.toLowerCase());
      setInfo(data);
      if (!amount) setAmount(data.pool.minStake.usdc);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
    // amount intentionally excluded — we only seed it once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signer.isConnected, signer.address]);

  useEffect(() => {
    void load();
  }, [load]);

  const busy = action.status === 'busy';

  const send = async (label: string, build: () => Promise<{ to: Hex; data: Hex; value: Hex }>) => {
    if (!signer.isConnected) throw new Error('Not connected');
    const tx = await build();
    const sent = await signer.sendCall({ to: tx.to, data: tx.data, value: BigInt(tx.value) });
    setAction({ status: 'busy', label: `${label} (confirming…)` });
    const { status } = await sent.wait();
    if (status !== 'success') throw new Error(`Tx ${status}`);
  };

  const stake = async () => {
    if (!publicClient || !info) return;
    const amt = amount.trim();
    if (!amt || Number(amt) <= 0) {
      setAction({ status: 'error', message: 'Enter a stake amount.' });
      return;
    }
    if (Number(amt) < Number(info.pool.minStake.usdc)) {
      setAction({ status: 'error', message: `Minimum stake is ${info.pool.minStake.usdc} USDC.` });
      return;
    }
    try {
      const amtRaw = BigInt(Math.round(Number(amt) * 1_000_000));
      const allowance = await publicClient.readContract({
        address: USDC_ADDRESS,
        abi: erc20AllowanceAbi,
        functionName: 'allowance',
        args: [signer.address as Hex, WRAPPER_ADDRESS],
      });
      if (allowance < amtRaw) {
        setAction({ status: 'busy', label: 'Approving USDC…' });
        await send('Approving USDC…', () => buildApproveUnsigned(amt));
      }
      setAction({ status: 'busy', label: 'Staking…' });
      await send('Staking…', () => buildStakeEvaluatorUnsigned(amt));
      setAction({ status: 'success' });
      await load();
    } catch (err) {
      setAction({ status: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  const unstake = async () => {
    try {
      setAction({ status: 'busy', label: 'Unstaking…' });
      await send('Unstaking…', () => buildUnstakeEvaluatorUnsigned());
      setAction({ status: 'success' });
      await load();
    } catch (err) {
      setAction({ status: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <header className="mb-8">
        <Link href="/" className="text-xs text-neutral-500 hover:text-neutral-100">
          ← back
        </Link>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">Evaluate</h1>
        <p className="mt-2 text-sm text-neutral-400">
          Stake USDC to join the evaluator pool. When a dispute is defended, three evaluators are
          picked at random to vote — winners share the loser&apos;s forfeited bond.
        </p>
      </header>

      {!signer.isConnected && (
        <div className="rounded-xl border border-amber-900/40 bg-amber-950/20 p-4 text-sm text-amber-200">
          Connect a wallet or sign in with a passkey to stake.{' '}
          <Link href="/" className="underline">
            Go to sign-in
          </Link>
          .
        </div>
      )}

      {signer.isConnected && loadError && (
        <ErrorBanner title="Couldn't load evaluator state" message={loadError} onRetry={() => void load()} />
      )}

      {signer.isConnected && info && (
        <div className="space-y-5">
          {/* Pool stats */}
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Active evaluators" value={info.pool.activeCount} />
            <Stat label="Min stake" value={`${info.pool.minStake.usdc} USDC`} />
            <Stat label="Bond" value={`${info.pool.bondBps / 100}%`} />
            <Stat label="Per dispute" value={String(info.pool.evaluatorsPerDispute)} />
          </section>

          {/* Your status */}
          <section className="rounded-2xl border border-neutral-800 bg-neutral-900/50 p-6">
            {info.active ? (
              <>
                <div className="flex items-center gap-2">
                  <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" />
                  <h2 className="text-sm font-medium text-neutral-100">You&apos;re in the pool</h2>
                </div>
                <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
                  <Row label="Staked" value={`${info.stake.usdc} USDC`} />
                  <Row label="Votes cast" value={String(info.totalVotes)} />
                  <Row label="Majority-aligned" value={String(info.majorityVotes)} />
                  <Row label="Open disputes" value={String(info.pendingDisputeRefs)} />
                </dl>
                <div className="mt-5 border-t border-neutral-800 pt-4">
                  <button
                    type="button"
                    onClick={() => void unstake()}
                    disabled={busy || info.pendingDisputeRefs > 0}
                    className="rounded-lg border border-neutral-700 px-4 py-2 text-sm font-medium text-neutral-200 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Unstake {info.stake.usdc} USDC
                  </button>
                  {info.pendingDisputeRefs > 0 && (
                    <p className="mt-2 text-xs text-neutral-500">
                      Can&apos;t unstake while you&apos;re assigned to {info.pendingDisputeRefs} open
                      dispute{info.pendingDisputeRefs === 1 ? '' : 's'}. Resolve them first.
                    </p>
                  )}
                </div>
              </>
            ) : (
              <>
                <h2 className="text-sm font-medium text-neutral-100">Join the evaluator pool</h2>
                <p className="mt-1 text-xs text-neutral-500">
                  Approves and locks your stake in the wrapper. Withdraw any time you have no open
                  disputes.
                </p>
                <div className="mt-4 flex gap-2">
                  <div className="flex-1">
                    <label className="text-[11px] text-neutral-500">Stake (USDC)</label>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      placeholder={info.pool.minStake.usdc}
                      disabled={busy}
                      className="mt-1 w-full rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-sm text-neutral-100 placeholder:text-neutral-700 focus:border-neutral-600 focus:outline-none"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => void stake()}
                    disabled={busy}
                    className="mt-[18px] rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-950 hover:bg-white disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
                  >
                    Stake
                  </button>
                </div>
              </>
            )}

            <div className="mt-4 min-h-[1rem] text-xs">
              {action.status === 'busy' && <p className="text-neutral-400">{action.label}</p>}
              {action.status === 'success' && <p className="text-emerald-400">Done.</p>}
              {action.status === 'error' && <p className="text-red-400 break-words">{action.message}</p>}
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-3">
      <div className="text-[11px] uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="mt-1 font-mono text-sm text-neutral-100">{value}</div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] text-neutral-500">{label}</dt>
      <dd className="font-mono text-neutral-200">{value}</dd>
    </div>
  );
}
