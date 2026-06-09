'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { parseEventLogs } from 'viem';
import { usePublicClient } from 'wagmi';
import { useSigner } from '@/hooks/use-signer';
import { buildCreateTradeUnsigned, resolveAddress } from '@/lib/api';
import { arcTestnet } from '@/lib/chains';
import { useToast } from '@/components/toast';
import { PassportPanel } from '@/components/passport-panel';
import { BridgeWidget } from '@/components/bridge-widget';
import { INITIAL_RUN, type BridgeRun } from '@/lib/bridge-run';

// Mirrors TradeEscrow's TradeProposed event — used to pull the tradeId from the receipt.
const tradeProposedEventAbi = [
  {
    type: 'event',
    name: 'TradeProposed',
    inputs: [
      { name: 'id', type: 'uint256', indexed: true },
      { name: 'buyer', type: 'address', indexed: true },
      { name: 'seller', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256' },
      { name: 'attester', type: 'address' },
    ],
  },
] as const;

type Submission =
  | { status: 'idle' }
  | { status: 'resolving' }
  | { status: 'signing' }
  | { status: 'waiting'; hash: string }
  | { status: 'error'; message: string };

export default function CreateTradePage() {
  const signer = useSigner();
  const toast = useToast();
  const router = useRouter();
  const publicClient = usePublicClient({ chainId: arcTestnet.id });

  const [sellerInput, setSellerInput] = useState('');
  const [amountUsdc, setAmountUsdc] = useState('');
  const [milestone, setMilestone] = useState('Delivery confirmed at destination port');
  const [deadlineDays, setDeadlineDays] = useState(7);
  const [submission, setSubmission] = useState<Submission>({ status: 'idle' });
  const [showBridge, setShowBridge] = useState(false);
  const [bridgeRun, setBridgeRun] = useState<BridgeRun>(INITIAL_RUN);

  const submit = async () => {
    if (!signer.isConnected) {
      setSubmission({ status: 'error', message: 'Connect a wallet first.' });
      return;
    }
    if (!amountUsdc || Number(amountUsdc) <= 0) {
      setSubmission({ status: 'error', message: 'Enter a positive trade amount.' });
      return;
    }
    try {
      setSubmission({ status: 'resolving' });
      const seller = await resolveAddress(sellerInput);

      const unsigned = await buildCreateTradeUnsigned({
        seller,
        amountUsdc,
        milestone: milestone.trim() || 'delivery',
        deadlineSeconds: deadlineDays * 24 * 3600,
      });

      setSubmission({ status: 'signing' });
      const sent = await signer.sendCall({ to: unsigned.to, data: unsigned.data, value: BigInt(unsigned.value) });

      setSubmission({ status: 'waiting', hash: sent.hash });
      const { txHash, status } = await sent.wait();
      if (status !== 'success') throw new Error(`Tx ${status}`);

      if (!publicClient) throw new Error('No public client available');
      const receipt = await publicClient.getTransactionReceipt({ hash: txHash as `0x${string}` });
      const [created] = parseEventLogs({ abi: tradeProposedEventAbi, eventName: 'TradeProposed', logs: receipt.logs });
      if (!created) throw new Error('TradeProposed event missing from receipt');

      const tradeId = created.args.id.toString();
      toast.success(`Trade #${tradeId} created`);
      router.push(`/trade/${tradeId}`);
    } catch (err) {
      setSubmission({ status: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  const isBusy = submission.status === 'resolving' || submission.status === 'signing' || submission.status === 'waiting';

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <header className="mb-8">
        <Link href="/" className="text-xs text-neutral-500 hover:text-neutral-100">
          ← back
        </Link>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">Create a trade</h1>
        <p className="mt-2 text-sm text-neutral-400">
          You&apos;re the <strong>buyer</strong>. The required deposit is priced by your credit passport,
          a verifier attests delivery, and funds release to the seller.
        </p>
      </header>

      {!signer.isConnected && (
        <div className="mb-6 rounded-xl border border-amber-900/40 bg-amber-950/20 p-4 text-sm text-amber-200">
          Connect a wallet or sign in with a passkey first.{' '}
          <Link href="/" className="underline">
            Go to sign-in
          </Link>
        </div>
      )}

      {signer.isConnected && (
        <div className="mb-6">
          <PassportPanel address={signer.address} />
        </div>
      )}

      <div className="space-y-5">
        <label className="block">
          <span className="text-sm text-neutral-300">Seller (handle or 0x address)</span>
          <input
            value={sellerInput}
            onChange={(e) => setSellerInput(e.target.value)}
            placeholder="seller-handle or 0x…"
            className="mt-1 w-full rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm"
          />
        </label>

        <label className="block">
          <span className="text-sm text-neutral-300">Trade amount (USDC)</span>
          <input
            value={amountUsdc}
            onChange={(e) => setAmountUsdc(e.target.value)}
            inputMode="decimal"
            placeholder="0.5"
            className="mt-1 w-full rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm"
          />
        </label>

        <label className="block">
          <span className="text-sm text-neutral-300">Milestone / delivery terms</span>
          <input
            value={milestone}
            onChange={(e) => setMilestone(e.target.value)}
            className="mt-1 w-full rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm"
          />
        </label>

        <label className="block">
          <span className="text-sm text-neutral-300">Deadline (days)</span>
          <input
            type="number"
            min={1}
            value={deadlineDays}
            onChange={(e) => setDeadlineDays(Number(e.target.value))}
            className="mt-1 w-32 rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm"
          />
        </label>

        {signer.isConnected && (
          <div>
            <button onClick={() => setShowBridge((s) => !s)} className="text-sm text-sky-300 hover:underline">
              {showBridge ? 'Hide bridge' : 'Need USDC on Arc? Bridge from another chain →'}
            </button>
            {showBridge && (
              <div className="mt-3 rounded-xl border border-neutral-800 bg-neutral-950/40 p-3">
                <p className="mb-2 text-xs text-neutral-500">
                  Creating a trade locks nothing — your deposit is only taken when you fund, after the seller agrees.
                  Bridge USDC from Ethereum / Base / Arbitrum / Optimism / Solana to your Arc wallet via CCTP now,
                  so it&apos;s ready to fund the moment the trade is agreed.
                </p>
                <BridgeWidget run={bridgeRun} onRunChange={setBridgeRun} />
              </div>
            )}
          </div>
        )}

        <button
          onClick={submit}
          disabled={isBusy || !signer.isConnected}
          className="rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 disabled:opacity-40"
        >
          {isBusy ? 'Working…' : 'Create trade'}
        </button>

        {submission.status === 'waiting' && (
          <p className="text-sm text-neutral-400">Waiting for confirmation… {submission.hash.slice(0, 10)}…</p>
        )}
        {submission.status === 'error' && (
          <p className="text-sm text-red-400">{submission.message}</p>
        )}
      </div>
    </main>
  );
}
