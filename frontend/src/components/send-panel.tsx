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
import { resolveAddress, getUserByAddress } from '@/lib/api';

const TRANSFER_ABI = [
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const;

type Pending = { address: `0x${string}`; handle: string | null };

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
  const [pending, setPending] = useState<Pending | null>(null);

  // Passkey (Circle Modular) wallets only.
  if (!signer.isConnected || signer.mode !== 'circle') return null;

  const available = balance ? Number(balance.formatted) : 0;

  // Step 1 — resolve the recipient and show who the funds will actually go to.
  const review = async () => {
    setError(null);
    try {
      const amt = Number(amount);
      if (!amount || amt <= 0) throw new Error('Enter an amount to send.');
      if (amt > available) throw new Error(`You only have ${available.toLocaleString()} USDC.`);
      if (!to.trim()) throw new Error('Enter a recipient.');
      setBusy(true);
      const isAddress = /^0x[0-9a-fA-F]{40}$/.test(to.trim());
      const address = await resolveAddress(to); // accepts a 0x address or an @handle
      // Pasted an address → reverse-look-up its handle. Typed a handle → keep it.
      const handle = isAddress
        ? (await getUserByAddress(address).catch(() => null))?.handle ?? null
        : to.trim().replace(/^@/, '');
      setPending({ address, handle });
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      setError(m);
      toast.error(m);
    } finally {
      setBusy(false);
    }
  };

  // Step 2 — confirmed recipient; sign + send (global review modal handles signing).
  const confirmSend = async () => {
    if (!pending || !signer.isConnected) return;
    const dest = pending.address;
    setPending(null);
    setBusy(true);
    try {
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
          onClick={review}
          disabled={busy || !to || !amount}
          className="rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50"
        >
          {busy ? 'Checking…' : 'Send'}
        </button>

        {error && <p className="text-xs text-red-300">{error}</p>}
        <p className="text-[11px] text-neutral-600">Gas is sponsored — you only spend the amount you send.</p>
      </div>

      {/* Recipient confirmation — shows exactly who the funds go to before signing. */}
      {pending && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => !busy && setPending(null)} />
          <div className="relative w-full max-w-sm rounded-2xl border border-neutral-800 bg-neutral-950 p-5 shadow-2xl">
            <p className="text-sm text-neutral-400">You&apos;re sending</p>
            <p className="mt-1 text-2xl font-semibold text-neutral-100">
              {amount} <span className="text-base text-neutral-400">USDC</span>
            </p>

            <p className="mt-4 text-xs uppercase tracking-wide text-neutral-500">To</p>
            {pending.handle ? (
              <div className="mt-1">
                <p className="text-lg font-bold text-neutral-100">@{pending.handle}</p>
                <p className="mt-0.5 break-all font-mono text-sm font-bold text-neutral-300">({pending.address})</p>
              </div>
            ) : (
              <div className="mt-1">
                <p className="break-all font-mono text-base font-bold text-neutral-100">{pending.address}</p>
                <p className="mt-1 text-xs text-amber-300">No handle linked to this address — double-check it&apos;s correct.</p>
              </div>
            )}

            <div className="mt-5 flex gap-2">
              <button
                onClick={() => setPending(null)}
                disabled={busy}
                className="flex-1 rounded-lg border border-neutral-800 px-4 py-2 text-sm text-neutral-300 hover:text-neutral-100 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={confirmSend}
                disabled={busy}
                className="flex-1 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50"
              >
                Confirm &amp; send
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
