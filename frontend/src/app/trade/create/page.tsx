'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { parseEventLogs } from 'viem';
import { usePublicClient } from 'wagmi';
import { useSigner } from '@/hooks/use-signer';
import { buildCreateTradeUnsigned, resolveAddress, getVerifierInfo, type VerifierInfo } from '@/lib/api';
import { arcTestnet } from '@/lib/chains';
import { useToast } from '@/components/toast';
import { arcExplorerTxUrl } from '@/lib/explorers';
import { PassportPanel } from '@/components/passport-panel';
import { BridgeWidget } from '@/components/bridge-widget';
import { StruckButton } from '@/components/ui';
import { INITIAL_RUN, type BridgeRun } from '@/lib/bridge-run';

const PlusIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
);

const STRIKE_STEPS: [string, string][] = [
  ['Struck', 'You set the amount, terms and deadline. Nothing is locked yet.'],
  ['Funded', 'Once the seller agrees, you fund the passport-priced deposit.'],
  ['Attested & settled', 'A verifier confirms delivery on chain; the bond settles to the seller.'],
];

// Mirrors TradeEscrow's TradeProposed event - used to pull the tradeId from the receipt.
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

type DeadlineUnit = 'minutes' | 'hours' | 'days';
const UNIT_SECONDS: Record<DeadlineUnit, number> = { minutes: 60, hours: 3600, days: 24 * 3600 };

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
  const [deadlineValue, setDeadlineValue] = useState(7);
  const [deadlineUnit, setDeadlineUnit] = useState<DeadlineUnit>('days');
  const [submission, setSubmission] = useState<Submission>({ status: 'idle' });
  const [showBridge, setShowBridge] = useState(false);
  const [bridgeRun, setBridgeRun] = useState<BridgeRun>(INITIAL_RUN);
  const [verifyMode, setVerifyMode] = useState<'officer' | 'panel'>('officer');
  const [verifier, setVerifier] = useState<VerifierInfo | null>(null);

  useEffect(() => {
    getVerifierInfo().then(setVerifier).catch(() => {});
  }, []);

  const submit = async () => {
    if (!signer.isConnected) {
      setSubmission({ status: 'error', message: 'Connect a wallet first.' });
      return;
    }
    if (!amountUsdc || Number(amountUsdc) <= 0) {
      setSubmission({ status: 'error', message: 'Enter a positive bond amount.' });
      return;
    }
    try {
      setSubmission({ status: 'resolving' });
      const seller = await resolveAddress(sellerInput);

      const unsigned = await buildCreateTradeUnsigned({
        seller,
        amountUsdc,
        milestone: milestone.trim() || 'delivery',
        deadlineSeconds: Math.max(60, Math.round(deadlineValue * UNIT_SECONDS[deadlineUnit])),
        // Staked-panel mode sets the verifier module as the trade's attester.
        attester: verifyMode === 'panel' && verifier?.address ? verifier.address : undefined,
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
      toast.success(`Bond #${tradeId} struck`, { href: arcExplorerTxUrl(txHash), hrefLabel: 'view tx' });
      router.push(`/trade/${tradeId}`);
    } catch (err) {
      setSubmission({ status: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  const isBusy = submission.status === 'resolving' || submission.status === 'signing' || submission.status === 'waiting';

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <header className="mb-8">
        <Link href="/trade" className="text-xs text-muted hover:text-fg">
          ← your bonds
        </Link>
        <h1 className="mt-3 font-display text-3xl font-semibold tracking-tight">Strike a bond</h1>
        <p className="mt-2 max-w-xl text-sm text-muted">
          You&apos;re the <strong className="text-fg">buyer</strong>. Propose terms; the deposit is priced
          by your credit passport, a verifier attests delivery, and the bonded USDC releases to the seller
          on proof.
        </p>
      </header>

      <div className="mb-6 grid gap-4 rounded-xl border border-line bg-surface p-5 sm:grid-cols-3">
        {STRIKE_STEPS.map(([t, d]) => (
          <div key={t}>
            <div className="text-xs font-semibold uppercase tracking-wider text-brand">{t}</div>
            <p className="mt-1.5 text-xs leading-relaxed text-muted">{d}</p>
          </div>
        ))}
      </div>

      {!signer.isConnected && (
        <div className="mb-6 rounded-xl border border-warn/40 bg-warn/20 p-4 text-sm text-warn">
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
          <span className="text-sm text-fg">Seller (handle or 0x address)</span>
          <input
            value={sellerInput}
            onChange={(e) => setSellerInput(e.target.value)}
            placeholder="seller-handle or 0x…"
            className="mt-1 w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm text-fg placeholder:text-muted focus:border-primary focus:outline-none"
          />
        </label>

        <label className="block">
          <span className="text-sm text-fg">Bond amount (USDC)</span>
          <input
            value={amountUsdc}
            onChange={(e) => setAmountUsdc(e.target.value)}
            inputMode="decimal"
            placeholder="0.5"
            className="mt-1 w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm text-fg placeholder:text-muted focus:border-primary focus:outline-none"
          />
        </label>

        <label className="block">
          <span className="text-sm text-fg">Milestone / delivery terms</span>
          <input
            value={milestone}
            onChange={(e) => setMilestone(e.target.value)}
            className="mt-1 w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm text-fg placeholder:text-muted focus:border-primary focus:outline-none"
          />
        </label>

        <label className="block">
          <span className="text-sm text-fg">Deadline</span>
          <div className="mt-1 flex gap-2">
            <input
              type="number"
              min={1}
              value={deadlineValue}
              onChange={(e) => setDeadlineValue(Number(e.target.value))}
              className="w-24 rounded-lg border border-line bg-bg px-3 py-2 text-sm text-fg placeholder:text-muted focus:border-primary focus:outline-none"
            />
            <select
              value={deadlineUnit}
              onChange={(e) => setDeadlineUnit(e.target.value as DeadlineUnit)}
              className="rounded-lg border border-line bg-bg px-3 py-2 text-sm text-fg placeholder:text-muted focus:border-primary focus:outline-none"
            >
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
              <option value="days">days</option>
            </select>
          </div>
        </label>

        {verifier?.configured && (
          <div>
            <span className="text-sm text-fg">Delivery verification</span>
            <div className="mt-1 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setVerifyMode('officer')}
                className={`rounded-lg border px-3 py-2 text-left text-sm transition ${verifyMode === 'officer' ? 'border-line-strong bg-surface text-fg' : 'border-line text-muted hover:border-line-strong'}`}
              >
                <div className="font-medium">Trade Officer</div>
                <div className="text-xs text-muted">Fast - an automated agent attests.</div>
              </button>
              <button
                type="button"
                onClick={() => setVerifyMode('panel')}
                className={`rounded-lg border px-3 py-2 text-left text-sm transition ${verifyMode === 'panel' ? 'border-line-strong bg-surface text-fg' : 'border-line text-muted hover:border-line-strong'}`}
              >
                <div className="font-medium">Staked panel</div>
                <div className="text-xs text-muted">Decentralized - a {verifier.panelSize}-verifier panel votes. +{(verifier.feeBps ?? 0) / 100}% fee.</div>
              </button>
            </div>
          </div>
        )}

        {signer.isConnected && (
          <div>
            <button onClick={() => setShowBridge((s) => !s)} className="text-sm text-info hover:underline">
              {showBridge ? 'Hide bridge' : 'Fund this bond from another chain?'}
            </button>
            {showBridge && (
              <div className="mt-3 rounded-xl border border-line bg-bg/40 p-3">
                <p className="mb-2 text-xs text-muted">
                  Striking a bond locks nothing - your deposit is taken when you fund, after the seller agrees.
                  {amountUsdc && Number(amountUsdc) > 0
                    ? ` Bridge the ${amountUsdc} USDC to your Arc wallet now so it's ready the moment the bond is agreed.`
                    : ` Bridge USDC to your Arc wallet now so it's ready the moment the bond is agreed.`}
                </p>
                <BridgeWidget
                  run={bridgeRun}
                  onRunChange={setBridgeRun}
                  lockedAmount={amountUsdc && Number(amountUsdc) > 0 ? amountUsdc : undefined}
                  lockToArc
                />
              </div>
            )}
          </div>
        )}

        <StruckButton onClick={submit} disabled={isBusy || !signer.isConnected} icon={<PlusIcon />}>
          {isBusy ? 'Striking…' : 'Strike the bond'}
        </StruckButton>

        {submission.status === 'waiting' && (
          <p className="text-sm text-muted">Waiting for confirmation… {submission.hash.slice(0, 10)}…</p>
        )}
        {submission.status === 'error' && (
          <p className="text-sm text-danger">{submission.message}</p>
        )}
      </div>
    </main>
  );
}
