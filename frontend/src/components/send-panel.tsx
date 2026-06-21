'use client';

// Send USDC — available ONLY to Circle Modular (passkey) wallet users. External
// wallets already have their own wallet UI to move funds; passkey accounts don't,
// so without this they can hold a balance but can't spend it. Renders nothing for
// external/disconnected users. USDC on Arc is the native token but we move it via
// the ERC-20 transfer on 0x3600 for consistency with the rest of the app.
import { useState } from 'react';
import { useBalance } from 'wagmi';
import { encodeFunctionData, parseUnits } from 'viem';
import { useSigner } from '@/hooks/use-signer';
import { useToast } from '@/components/toast';
import { arcTestnet, USDC_ADDRESS } from '@/lib/chains';
import { arcExplorerTxUrl } from '@/lib/explorers';
import { resolveAddress } from '@/lib/api';

const TRANSFER_ABI = [
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const;

export function SendPanel() {
  const signer = useSigner();
  const toast = useToast();
  const { data: balance } = useBalance({
    address: signer.isConnected ? signer.address : undefined,
    chainId: arcTestnet.id,
    query: { enabled: signer.isConnected, refetchInterval: 15_000 },
  });
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Passkey (Circle Modular) wallets only.
  if (!signer.isConnected || signer.mode !== 'circle') return null;

  const available = balance ? Number(balance.formatted) : 0;

  const send = async () => {
    setError(null);
    if (!signer.isConnected) return;
    try {
      const amt = Number(amount);
      if (!amount || amt <= 0) throw new Error('Enter an amount to send.');
      if (amt > available) throw new Error(`You only have ${available.toLocaleString()} USDC.`);
      setBusy(true);
      const dest = await resolveAddress(to); // accepts a 0x address or an @handle
      const call = await signer.sendCall({
        to: USDC_ADDRESS,
        data: encodeFunctionData({ abi: TRANSFER_ABI, functionName: 'transfer', args: [dest, parseUnits(amount, 6)] }),
      });
      const r = await call.wait();
      if (r.status !== 'success') throw new Error('Transaction reverted.');
      toast.success(`Sent ${amount} USDC`, { href: arcExplorerTxUrl(r.txHash), hrefLabel: 'view tx' });
      setTo('');
      setAmount('');
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      setError(m);
      toast.error(m);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-xl border border-neutral-800 bg-neutral-950/50 p-5">
      <div className="flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-wide text-neutral-500">Send USDC</div>
        <span className="rounded-full bg-violet-500/15 px-2 py-0.5 text-[10px] font-medium text-violet-300">passkey wallet</span>
      </div>

      <div className="mt-1 text-sm text-neutral-500">
        Spendable balance: <span className="font-medium text-neutral-200">{available.toLocaleString()} USDC</span>
      </div>

      <div className="mt-4 space-y-3">
        <label className="block">
          <span className="text-xs text-neutral-500">Recipient (address or @handle)</span>
          <input
            value={to}
            onChange={(e) => setTo(e.target.value)}
            disabled={busy}
            placeholder="0x… or handle"
            className="mt-1 w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
          />
        </label>

        <label className="block">
          <span className="text-xs text-neutral-500">Amount (USDC)</span>
          <div className="mt-1 flex items-center gap-2">
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={busy}
              inputMode="decimal"
              placeholder="0.00"
              className="w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => setAmount(String(available))}
              disabled={busy || available <= 0}
              className="shrink-0 rounded-md border border-neutral-800 px-2.5 py-2 text-xs text-neutral-400 hover:text-neutral-100 disabled:opacity-40"
            >
              Max
            </button>
          </div>
        </label>

        <button
          onClick={send}
          disabled={busy || !to || !amount}
          className="rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50"
        >
          {busy ? 'Sending…' : 'Send'}
        </button>

        {error && <p className="text-xs text-red-300">{error}</p>}
        <p className="text-[11px] text-neutral-600">Gas is sponsored — you only spend the amount you send.</p>
      </div>
    </section>
  );
}
