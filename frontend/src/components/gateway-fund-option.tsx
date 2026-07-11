'use client';

// "Fund from another chain" via Circle Gateway. Routes the buyer's unified
// balance onto their Arc wallet (destination = Arc, recipient = self) so it's
// ready to fund the bond with the normal Fund button. One signature + our relay;
// no contract change. EOA-only (Gateway rejects passkey sigs) - the caller gates.
import { useCallback, useEffect, useState } from 'react';
import { type Hex } from 'viem';
import { useSignTypedData } from 'wagmi';
import { useToast } from '@/components/toast';
import { ChainLogo, type ChainLogoKey } from '@/components/chain-logo';
import { getUnifiedBalance, getWithdrawPlan, submitWithdraw, type UnifiedBalance } from '@/lib/api';

export function GatewayFundOption({ address, defaultAmount }: { address: string; defaultAmount?: string }) {
  const toast = useToast();
  const { signTypedDataAsync } = useSignTypedData();
  const [bal, setBal] = useState<UnifiedBalance | null>(null);
  const [sourceKey, setSourceKey] = useState('');
  const [amount, setAmount] = useState(defaultAmount ?? '');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ deliveredUsdc: string } | null>(null);

  const load = useCallback(() => {
    getUnifiedBalance(address).then(setBal).catch(() => {});
  }, [address]);
  useEffect(() => { load(); }, [load]);

  // Balance already sitting on Arc is directly fundable - no routing needed.
  const arc = bal?.byChain.find((c) => c.key === 'arcTestnet');
  const arcBalance = arc ? Number(arc.balanceUsdc) : 0;
  // Sources we can route FROM: any non-Arc chain holding a balance.
  const sources = bal?.byChain.filter((c) => c.key !== 'arcTestnet' && Number(c.balanceUsdc) > 0) ?? [];

  const run = async () => {
    if (!sourceKey) { toast.error('Pick a chain to route from.'); return; }
    if (!amount || Number(amount) <= 0) { toast.error('Enter an amount.'); return; }
    setBusy(true);
    try {
      const plan = await getWithdrawPlan(address, sourceKey, 'arcTestnet', amount);
      if (plan.needsMore) {
        toast.error(`Not enough on ${plan.source.name} — short ${plan.shortfallUsdc} USDC (incl. fee).`);
        return;
      }
      const m = plan.typedData.message;
      const signature = (await signTypedDataAsync({
        domain: plan.typedData.domain,
        types: plan.typedData.types,
        primaryType: plan.typedData.primaryType,
        message: { maxBlockHeight: BigInt(m.maxBlockHeight), maxFee: BigInt(m.maxFee), spec: { ...m.spec, value: BigInt(m.spec.value as string) } },
      } as never)) as Hex;
      const res = await submitWithdraw(plan.typedData.message, signature);
      setDone({ deliveredUsdc: res.deliveredUsdc });
      toast.success(`${res.deliveredUsdc} USDC on your Arc wallet — you can fund now.`);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (bal && sources.length === 0) {
    return (
      <p className="text-xs text-muted">
        {arcBalance > 0
          ? `You have ${arcBalance.toFixed(2)} USDC on Arc already — fund directly, no routing needed.`
          : 'No unified balance on another chain yet. Top up from your profile, then route it here.'}
      </p>
    );
  }

  if (done) {
    return (
      <p className="text-xs text-primary">✓ Routed {done.deliveredUsdc} USDC to your Arc wallet. Fund the bond when it&apos;s agreed.</p>
    );
  }

  return (
    <div className="space-y-2.5">
      <p className="text-xs text-muted">
        Route USDC from your unified balance onto Arc so it&apos;s ready to fund. One signature; a small Gateway fee (≈0.02 USDC) applies.
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {sources.map((c) => (
          <button
            key={c.key}
            onClick={() => setSourceKey(c.key)}
            disabled={busy}
            className={`flex items-center gap-2 rounded-md border px-2.5 py-2 text-sm transition disabled:opacity-50 ${
              sourceKey === c.key ? 'border-info bg-info/12 text-fg' : 'border-line bg-bg text-fg hover:border-line-strong'
            }`}
          >
            <ChainLogo sourceKey={c.key as ChainLogoKey} className="h-4 w-4" />
            <span className="truncate">{c.name}</span>
            <span className="ml-auto font-mono text-[11px] text-muted">{Number(c.balanceUsdc).toFixed(0)}</span>
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-muted">
          Amount (USDC)
          <input value={amount} onChange={(e) => setAmount(e.target.value)} disabled={busy} inputMode="decimal" placeholder="0.00" className="w-28 rounded-md border border-line bg-bg px-2 py-1.5 text-sm text-fg" />
        </label>
        <button onClick={run} disabled={busy} className="rounded-md bg-info px-3 py-1.5 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50">
          {busy ? 'Routing…' : 'Route to Arc'}
        </button>
      </div>
    </div>
  );
}
