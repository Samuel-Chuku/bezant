'use client';

// Optional cross-chain seller payout via Circle Gateway. Shown on a settled
// (Released) trade to the seller: the escrow already paid them on Arc; this
// routes that USDC to another chain. External (EOA) wallets only — the seller's
// own wallet does approve + deposit (Arc) + the EIP-712 burn-intent signature;
// the backend relays the destination mint.
import { useCallback, useEffect, useState } from 'react';
import { encodeFunctionData, parseUnits, type Hex } from 'viem';
import { useSigner } from '@/hooks/use-signer';
import { useToast } from '@/components/toast';
import {
  getGatewayDestinations,
  getGatewayPayoutPlan,
  getGatewayBalance,
  submitGatewayPayout,
  type GatewayDestination,
  type GatewayPayoutResult,
} from '@/lib/api';

const ERC20_APPROVE_ABI = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const;
const GATEWAY_DEPOSIT_ABI = [
  { type: 'function', name: 'deposit', stateMutability: 'nonpayable', inputs: [{ name: 'token', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [] },
] as const;

type Phase = 'idle' | 'approving' | 'depositing' | 'crediting' | 'signing' | 'settling' | 'done';

const PHASE_LABEL: Record<Exclude<Phase, 'idle' | 'done'>, string> = {
  approving: 'Approve USDC on Arc',
  depositing: 'Deposit into Gateway',
  crediting: 'Wait for Gateway to credit',
  signing: 'Sign the transfer',
  settling: 'Mint on destination',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function GatewayPayoutPanel({ tradeId, sellerAddress, defaultAmountUsdc }: { tradeId: string; sellerAddress: string; defaultAmountUsdc: string }) {
  const signer = useSigner();
  const toast = useToast();
  const [destinations, setDestinations] = useState<GatewayDestination[]>([]);
  const [destKey, setDestKey] = useState('');
  const [amount, setAmount] = useState(defaultAmountUsdc);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GatewayPayoutResult | null>(null);

  useEffect(() => {
    getGatewayDestinations()
      .then((list) => {
        const ok = list.filter((d) => d.supported);
        setDestinations(ok);
        if (ok[0]) setDestKey(ok[0].key);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const isSeller = signer.isConnected && signer.address.toLowerCase() === sellerAddress.toLowerCase();
  const busy = phase !== 'idle' && phase !== 'done';

  const run = useCallback(async () => {
    if (!signer.isConnected) return;
    setError(null);
    setResult(null);
    try {
      if (signer.mode !== 'external') {
        throw new Error('Connect an external wallet (MetaMask, Rabby, etc.) to route your payout — passkey wallets aren’t supported for this yet.');
      }
      if (!amount || Number(amount) <= 0) throw new Error('Enter an amount to route.');

      const plan = await getGatewayPayoutPlan(tradeId, destKey, { amountUsdc: amount });

      if (plan.needsDeposit) {
        const depositRaw = parseUnits(plan.depositUsdc, 6);
        setPhase('approving');
        const approve = await signer.sendCall({
          to: plan.contracts.arcUsdc,
          data: encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: 'approve', args: [plan.contracts.gatewayWallet, depositRaw] }),
        });
        if ((await approve.wait()).status !== 'success') throw new Error('Approve reverted.');

        setPhase('depositing');
        const deposit = await signer.sendCall({
          to: plan.contracts.gatewayWallet,
          data: encodeFunctionData({ abi: GATEWAY_DEPOSIT_ABI, functionName: 'deposit', args: [plan.contracts.arcUsdc, depositRaw] }),
        });
        if ((await deposit.wait()).status !== 'success') throw new Error('Deposit reverted.');

        setPhase('crediting');
        const required = Number(plan.requiredUsdc);
        const deadline = Date.now() + 120_000;
        let credited = Number(plan.unifiedBalanceUsdc);
        while (Date.now() < deadline && credited < required) {
          await sleep(3_000);
          credited = Number(await getGatewayBalance(sellerAddress));
        }
        if (credited < required) throw new Error('Gateway hasn’t credited the deposit yet — try again in a moment.');
      }

      // Sign the burn intent (numeric fields → bigint for viem; the original
      // string message is submitted back unchanged).
      setPhase('signing');
      const m = plan.typedData.message;
      const signature = (await signer.signTypedData({
        domain: plan.typedData.domain,
        types: plan.typedData.types,
        primaryType: plan.typedData.primaryType,
        message: {
          maxBlockHeight: BigInt(m.maxBlockHeight),
          maxFee: BigInt(m.maxFee),
          spec: { ...m.spec, value: BigInt(m.spec.value as string) },
        },
      })) as Hex;

      setPhase('settling');
      const res = await submitGatewayPayout(tradeId, plan.typedData.message, signature);
      setResult(res);
      setPhase('done');
      toast.success(`Routed ${res.deliveredUsdc} USDC to ${res.destination.name}.`);
    } catch (err) {
      setPhase('idle');
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      toast.error(msg);
    }
  }, [signer, amount, destKey, tradeId, sellerAddress, toast]);

  if (!isSeller) return null;

  if (result) {
    return (
      <div className="rounded-lg border border-emerald-900/40 bg-emerald-950/20 p-4 text-sm">
        <p className="text-emerald-200">
          Routed <span className="font-medium">{result.deliveredUsdc} USDC</span> to {result.destination.name}.
        </p>
        <p className="mt-1 break-all text-xs text-neutral-500">mint tx: {result.mintTxHash}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-sky-900/40 bg-sky-950/20 p-4">
      <div>
        <p className="text-sm text-sky-100">Receive on another chain <span className="text-neutral-500">(optional)</span></p>
        <p className="mt-1 text-xs text-neutral-500">
          You were paid on Arc. Route some or all of it to another chain via Circle Gateway — instant, from a unified balance.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-neutral-400">
          Destination
          <select
            value={destKey}
            onChange={(e) => setDestKey(e.target.value)}
            disabled={busy || destinations.length === 0}
            className="rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100"
          >
            {destinations.length === 0 && <option>Loading…</option>}
            {destinations.map((d) => (
              <option key={d.key} value={d.key}>{d.name}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-neutral-400">
          Amount (USDC)
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={busy}
            inputMode="decimal"
            className="w-32 rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100"
          />
        </label>
        <button
          onClick={run}
          disabled={busy || !destKey}
          className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
        >
          {busy ? 'Routing…' : 'Route payout'}
        </button>
      </div>

      {signer.isConnected && signer.mode !== 'external' && (
        <p className="text-xs text-amber-300">Passkey wallets can’t route cross-chain yet — connect an external wallet.</p>
      )}

      {busy && (
        <ol className="space-y-1 text-xs">
          {(['approving', 'depositing', 'crediting', 'signing', 'settling'] as const).map((p) => {
            const order: Phase[] = ['approving', 'depositing', 'crediting', 'signing', 'settling'];
            const active = phase === p;
            const done = order.indexOf(phase) > order.indexOf(p);
            return (
              <li key={p} className={active ? 'text-sky-300' : done ? 'text-emerald-400' : 'text-neutral-600'}>
                {done ? '✓' : active ? '•' : '○'} {PHASE_LABEL[p]}
              </li>
            );
          })}
        </ol>
      )}

      {error && <p className="text-xs text-red-300">{error}</p>}
      <p className="text-[11px] text-neutral-600">A small Gateway fee (≈0.02 USDC) is taken on top of the amount.</p>
    </div>
  );
}
