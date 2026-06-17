'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSigner } from '@/hooks/use-signer';
import { useToast } from '@/components/toast';
import {
  getPoolStats,
  buildPoolApproveUnsigned,
  buildPoolDepositUnsigned,
  buildPoolWithdrawUnsigned,
  type PoolStats,
  type UnsignedTx,
} from '@/lib/api';

// Financing pool LP panel: deposit USDC for shares, earn the advance fees as
// yield, withdraw up to idle liquidity. Capital in live advances can't be pulled.
export function PoolPanel() {
  const signer = useSigner();
  const toast = useToast();
  const [stats, setStats] = useState<PoolStats | null>(null);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStats(await getPoolStats(signer.isConnected ? signer.address : undefined));
    } catch {
      /* pool not deployed / unreachable — leave stats null */
    }
  }, [signer.isConnected, signer.address]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signAndWait = async (u: UnsignedTx) => {
    if (!signer.isConnected) throw new Error('Connect a wallet first.');
    const sent = await signer.sendCall({ to: u.to, data: u.data, value: BigInt(u.value) });
    const { status } = await sent.wait();
    if (status !== 'success') throw new Error(`Tx ${status}`);
  };

  const run = async (label: string, fn: () => Promise<void>, ok: string) => {
    setBusy(label);
    try {
      await fn();
      toast.success(ok);
      setAmount('');
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const doDeposit = () =>
    run(
      'deposit',
      async () => {
        if (!amount || Number(amount) <= 0) throw new Error('Enter an amount.');
        await signAndWait(await buildPoolApproveUnsigned(amount));
        await signAndWait(await buildPoolDepositUnsigned(amount));
      },
      'Deposited to the financing pool',
    );

  const doWithdraw = () =>
    run(
      'withdraw',
      async () => {
        if (!amount || Number(amount) <= 0) throw new Error('Enter an amount.');
        await signAndWait(await buildPoolWithdrawUnsigned({ amountUsdc: amount }));
      },
      'Withdrawn from the pool',
    );

  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-950/50 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xs uppercase tracking-wide text-neutral-500">Financing pool (LP)</h2>
        {stats && <span className="text-xs text-neutral-500">share price {stats.sharePrice.toFixed(4)}</span>}
      </div>

      {!stats ? (
        <p className="mt-3 text-sm text-neutral-500">Pool unavailable.</p>
      ) : (
        <>
          <div className="mt-3 grid grid-cols-3 gap-2 text-sm">
            <Stat label="TVL">{stats.totalAssetsUsdc}</Stat>
            <Stat label="Idle">{stats.idleUsdc}</Stat>
            <Stat label="Deployed">{stats.outstandingUsdc}</Stat>
          </div>

          {signer.isConnected && stats.myShares && stats.myShares !== '0' && (
            <p className="mt-3 text-sm text-emerald-300">
              Your position: {stats.myValueUsdc} USDC
            </p>
          )}

          <div className="mt-4 flex flex-wrap items-end gap-2">
            <label className="block">
              <span className="text-xs text-neutral-400">Amount (USDC)</span>
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                inputMode="decimal"
                placeholder="100"
                className="mt-1 w-32 rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm"
              />
            </label>
            <button
              onClick={doDeposit}
              disabled={!!busy || !signer.isConnected}
              className="rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 disabled:opacity-40"
            >
              {busy === 'deposit' ? 'Working…' : 'Deposit'}
            </button>
            <button
              onClick={doWithdraw}
              disabled={!!busy || !signer.isConnected}
              className="rounded-lg border border-neutral-700 px-4 py-2 text-sm font-medium text-neutral-200 disabled:opacity-40"
            >
              {busy === 'withdraw' ? 'Working…' : 'Withdraw'}
            </button>
          </div>
          <p className="mt-2 text-xs text-neutral-600">
            LPs fund seller advances and earn the financing fees. Withdrawals are capped at idle liquidity; you bear credit risk on defaults.
          </p>
        </>
      )}
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-neutral-900 bg-neutral-950/40 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="mt-0.5 text-neutral-200">{children} USDC</div>
    </div>
  );
}
