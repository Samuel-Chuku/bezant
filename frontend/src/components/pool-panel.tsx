'use client';

import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSigner } from '@/hooks/use-signer';
import { useToast } from '@/components/toast';
import { useTxFlow } from '@/components/tx-flow';
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
// yield, withdraw up to idle liquidity. The amount is entered in a modal; the
// signing then runs through the multi-step Actions modal (useTxFlow).
export function PoolPanel() {
  const signer = useSigner();
  const toast = useToast();
  const txFlow = useTxFlow();
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

  const runFlow = async (kind: Action, amount: string) => {
    if (!signer.isConnected) return;
    const amt = Number(amount);
    const myVal = Number(stats?.myValueUsdc ?? '0');
    const tvl = Number(stats?.totalAssetsUsdc ?? '0');
    const sendStep = async (u: UnsignedTx) => {
      const sent = await signer.sendCall({ to: u.to, data: u.data, value: BigInt(u.value) }, { review: false });
      const { status } = await sent.wait();
      if (status !== 'success') throw new Error(`Transaction ${status}`);
    };

    const spec =
      kind === 'deposit'
        ? {
            title: `Deposit ${amount} USDC`,
            amountUsdc: amount,
            overview: [
              { label: 'Your position', before: `${myVal.toFixed(2)} USDC`, after: `${(myVal + amt).toFixed(2)} USDC` },
              { label: 'Pool TVL', before: `${tvl.toFixed(2)} USDC`, after: `${(tvl + amt).toFixed(2)} USDC` },
            ],
            steps: [
              { key: 'approve', label: 'Approve USDC', action: 'Approve', run: async () => { await sendStep(await buildPoolApproveUnsigned(amount)); } },
              { key: 'deposit', label: 'Deposit to pool', action: 'Deposit', run: async () => { await sendStep(await buildPoolDepositUnsigned(amount)); } },
            ],
          }
        : {
            title: `Withdraw ${amount} USDC`,
            amountUsdc: amount,
            overview: [
              { label: 'Your position', before: `${myVal.toFixed(2)} USDC`, after: `${Math.max(0, myVal - amt).toFixed(2)} USDC` },
            ],
            steps: [
              { key: 'withdraw', label: 'Withdraw from pool', action: 'Withdraw', run: async () => { await sendStep(await buildPoolWithdrawUnsigned({ amountUsdc: amount })); } },
            ],
          };

    const ok = await txFlow.start(spec);
    if (ok) {
      toast.success(kind === 'deposit' ? 'Deposited to the financing pool' : 'Withdrawn from the pool');
      await refresh();
    }
  };

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
          onSubmit={(amount) => {
            setAction(null);
            void runFlow(action, amount);
          }}
        />
      )}
    </div>
  );
}

// Collects the amount, then hands off to the Actions modal for signing.
function AmountModal({
  action,
  idleUsdc,
  onClose,
  onSubmit,
}: {
  action: Action;
  idleUsdc: string;
  onClose: () => void;
  onSubmit: (amount: string) => void;
}) {
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = () => {
    if (!amount || Number(amount) <= 0) {
      toast.error('Enter an amount.');
      return;
    }
    onSubmit(amount);
  };

  if (!mounted) return null;
  const isDeposit = action === 'deposit';

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center px-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-label={isDeposit ? 'Deposit to pool' : 'Withdraw from pool'}
        className="relative w-full max-w-sm rounded-2xl border border-line bg-surface p-5 shadow-2xl"
      >
        <h3 className="text-lg font-semibold tracking-tight text-fg">{isDeposit ? 'Deposit USDC' : 'Withdraw USDC'}</h3>
        <p className="mt-1 text-xs text-muted">
          {isDeposit ? 'Add liquidity and receive pool shares.' : `Withdrawals are capped at idle liquidity (${idleUsdc} USDC available).`}
        </p>

        <input
          autoFocus
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          inputMode="decimal"
          placeholder="100"
          className="mt-4 w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-fg placeholder:text-muted focus:border-line-strong focus:outline-none"
        />

        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-line px-4 py-2 text-sm text-fg transition hover:border-line-strong">
            Cancel
          </button>
          <button type="button" onClick={submit} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-fg transition hover:bg-primary-hover">
            Continue
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
