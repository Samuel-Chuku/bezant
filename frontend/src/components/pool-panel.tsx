'use client';

import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSigner } from '@/hooks/use-signer';
import { useToast } from '@/components/toast';
import { PoolYieldStrip } from '@/components/pool-yield';
import {
  getPoolStats,
  buildPoolApproveUnsigned,
  buildPoolDepositUnsigned,
  buildPoolWithdrawUnsigned,
  type PoolStats,
  type UnsignedTx,
} from '@/lib/api';

type Action = 'deposit' | 'withdraw';

// Financing pool LP panel: deposit USDC for shares, earn the advance fees as
// yield, withdraw up to idle liquidity. Capital in live advances can't be pulled.
// The amount is entered in a modal opened by the Deposit / Withdraw buttons.
export function PoolPanel() {
  const signer = useSigner();
  const toast = useToast();
  const [stats, setStats] = useState<PoolStats | null>(null);
  const [action, setAction] = useState<Action | null>(null);

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

          <div className="mt-3">
            <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-600">Yield</div>
            <PoolYieldStrip />
          </div>

          {signer.isConnected && stats.myShares && stats.myShares !== '0' && (
            <p className="mt-3 text-sm text-emerald-300">Your position: {stats.myValueUsdc} USDC</p>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              onClick={() => setAction('deposit')}
              disabled={!signer.isConnected}
              className="rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 disabled:opacity-40"
            >
              Deposit
            </button>
            <button
              onClick={() => setAction('withdraw')}
              disabled={!signer.isConnected}
              className="rounded-lg border border-neutral-700 px-4 py-2 text-sm font-medium text-neutral-200 disabled:opacity-40"
            >
              Withdraw
            </button>
          </div>
          {!signer.isConnected && (
            <p className="mt-2 text-xs text-neutral-600">Connect a wallet to deposit or withdraw.</p>
          )}
        </>
      )}

      {action && stats && (
        <AmountModal
          action={action}
          idleUsdc={stats.idleUsdc}
          onClose={() => setAction(null)}
          onDone={refresh}
        />
      )}
    </div>
  );
}

// Modal that collects the amount once the user has chosen deposit or withdraw,
// then signs the tx(s). Portal'd to <body> so the sticky header's blur doesn't
// paint over it (same pattern as the wallet pill's login modal).
function AmountModal({
  action,
  idleUsdc,
  onClose,
  onDone,
}: {
  action: Action;
  idleUsdc: string;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const signer = useSigner();
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const signAndWait = async (u: UnsignedTx) => {
    if (!signer.isConnected) throw new Error('Connect a wallet first.');
    const sent = await signer.sendCall({ to: u.to, data: u.data, value: BigInt(u.value) });
    const { status } = await sent.wait();
    if (status !== 'success') throw new Error(`Tx ${status}`);
  };

  const submit = async () => {
    if (!amount || Number(amount) <= 0) {
      toast.error('Enter an amount.');
      return;
    }
    setBusy(true);
    try {
      if (action === 'deposit') {
        await signAndWait(await buildPoolApproveUnsigned(amount));
        await signAndWait(await buildPoolDepositUnsigned(amount));
        toast.success('Deposited to the financing pool');
      } else {
        await signAndWait(await buildPoolWithdrawUnsigned({ amountUsdc: amount }));
        toast.success('Withdrawn from the pool');
      }
      await onDone();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!mounted) return null;

  const isDeposit = action === 'deposit';

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center px-4">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={() => !busy && onClose()}
        aria-hidden
      />
      <div
        role="dialog"
        aria-label={isDeposit ? 'Deposit to pool' : 'Withdraw from pool'}
        className="relative w-full max-w-sm rounded-xl border border-neutral-800 bg-neutral-950 p-5 shadow-2xl"
      >
        <h3 className="text-lg font-semibold tracking-tight text-neutral-100">
          {isDeposit ? 'Deposit USDC' : 'Withdraw USDC'}
        </h3>
        <p className="mt-1 text-xs text-neutral-500">
          {isDeposit
            ? 'Add liquidity and receive pool shares.'
            : `Withdrawals are capped at idle liquidity (${idleUsdc} USDC available).`}
        </p>

        <input
          autoFocus
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !busy && submit()}
          inputMode="decimal"
          placeholder="100"
          disabled={busy}
          className="mt-4 w-full rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
        />

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg border border-neutral-800 px-4 py-2 text-sm text-neutral-400 hover:text-neutral-100 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 disabled:opacity-40"
          >
            {busy ? 'Working…' : isDeposit ? 'Deposit' : 'Withdraw'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
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
