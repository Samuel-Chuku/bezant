'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { parseEventLogs } from 'viem';
import { usePublicClient, useChainId, useSwitchChain } from 'wagmi';
import { useSigner } from '@/hooks/use-signer';
import { buildCreateTradeUnsigned, resolveAddress, getUserByHandle, getVerifierInfo, type VerifierInfo } from '@/lib/api';
import { arcTestnet } from '@/lib/chains';
import { friendlyTxError } from '@/lib/tx-error';
import { shortAddress } from '@/lib/format';
import { useToast } from '@/components/toast';
import { arcExplorerTxUrl } from '@/lib/explorers';
import { PassportPanel } from '@/components/passport-panel';
import { FundFromChain } from '@/components/fund-from-chain';
import { StruckButton } from '@/components/ui';

const PlusIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
);
const ArrowIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
);
const CheckIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 5 5L20 6" /></svg>
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

// Live counterparty resolution shown under the handle/address input.
type SellerCheck =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'address'; address: string }
  | { status: 'found'; handle: string; address: string }
  | { status: 'notfound' };

// Bigger, taller inputs for the wizard (readability on the wide layout).
const bigField =
  'w-full rounded-none border border-line bg-surface-2 px-4 py-3.5 text-base text-fg placeholder:text-muted transition focus:border-primary focus:outline-none';

export default function CreateTradePage() {
  const signer = useSigner();
  const toast = useToast();
  const router = useRouter();
  const publicClient = usePublicClient({ chainId: arcTestnet.id });
  const wagmiChainId = useChainId();
  const { switchChain } = useSwitchChain();
  // External wallets can drift off Arc (e.g. after bridging); block the strike
  // and offer a one-tap switch instead of letting a raw chain-mismatch surface.
  const isOffArc = signer.isConnected && signer.mode === 'external' && wagmiChainId !== arcTestnet.id;

  const [sellerInput, setSellerInput] = useState('');
  const [amountUsdc, setAmountUsdc] = useState('');
  const [milestone, setMilestone] = useState('Delivery confirmed at destination port');
  const [deadlineValue, setDeadlineValue] = useState(7);
  const [deadlineUnit, setDeadlineUnit] = useState<DeadlineUnit>('days');
  const [submission, setSubmission] = useState<Submission>({ status: 'idle' });
  const [verifyMode, setVerifyMode] = useState<'officer' | 'panel'>('officer');
  const [verifier, setVerifier] = useState<VerifierInfo | null>(null);
  const [stepIdx, setStepIdx] = useState(0);
  const [stepError, setStepError] = useState<string | null>(null);
  const [sellerCheck, setSellerCheck] = useState<SellerCheck>({ status: 'idle' });

  useEffect(() => {
    getVerifierInfo().then(setVerifier).catch(() => {});
  }, []);

  // Live-resolve the counterparty as they type: a 0x address is accepted as-is;
  // anything else is looked up as a Bezant handle (debounced) so the buyer knows
  // it exists — or is told to paste an address — before submitting.
  useEffect(() => {
    const raw = sellerInput.trim();
    if (!raw) {
      setSellerCheck({ status: 'idle' });
      return;
    }
    if (/^0x[0-9a-fA-F]{40}$/.test(raw)) {
      setSellerCheck({ status: 'address', address: raw.toLowerCase() });
      return;
    }
    setSellerCheck({ status: 'checking' });
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const user = await getUserByHandle(raw);
        if (cancelled) return;
        setSellerCheck(
          user
            ? { status: 'found', handle: user.handle ?? raw, address: user.walletAddress }
            : { status: 'notfound' },
        );
      } catch {
        // Network hiccup — don't block; submit will re-resolve authoritatively.
        if (!cancelled) setSellerCheck({ status: 'idle' });
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [sellerInput]);

  // Clear any prior submit error when the buyer navigates or edits a step, so a
  // stale "no user found" message doesn't linger after they go back to fix it.
  useEffect(() => {
    setSubmission({ status: 'idle' });
  }, [stepIdx]);

  // Verification step only exists when the staked verifier is deployed; otherwise
  // it's Trade Officer by default and the step is skipped.
  const steps = useMemo(() => {
    const s: { key: string; label: string }[] = [
      { key: 'counterparty', label: 'Counterparty' },
      { key: 'terms', label: 'Terms' },
    ];
    if (verifier?.configured) s.push({ key: 'verify', label: 'Verification' });
    s.push({ key: 'review', label: 'Review' });
    return s;
  }, [verifier?.configured]);

  const clampedIdx = Math.min(stepIdx, steps.length - 1);
  const current = steps[clampedIdx].key;
  const atFirst = clampedIdx === 0;
  const atLast = clampedIdx >= steps.length - 1;

  const fail = (m: string) => {
    setStepError(m);
    return false;
  };
  const validate = (key: string): boolean => {
    if (key === 'counterparty') {
      if (!sellerInput.trim()) return fail('Enter the seller’s handle or address.');
      if (sellerCheck.status === 'notfound')
        return fail('No Bezant user with that handle — paste their 0x wallet address instead.');
    }
    if (key === 'terms') {
      if (!amountUsdc || Number(amountUsdc) <= 0) return fail('Enter a positive bond amount.');
      if (!milestone.trim()) return fail('Describe the delivery milestone.');
      if (!deadlineValue || deadlineValue < 1) return fail('Set a deadline of at least 1.');
    }
    return true;
  };
  const goNext = () => {
    setStepError(null);
    if (validate(current)) setStepIdx((i) => i + 1);
  };
  const goBack = () => {
    setStepError(null);
    setStepIdx((i) => Math.max(0, i - 1));
  };

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
      setSubmission({ status: 'error', message: friendlyTxError(err) });
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

      <Stepper steps={steps} activeIdx={clampedIdx} />

      {!signer.isConnected && (
        <div className="mt-8 rounded-xl border border-warn/40 bg-warn/20 p-4 text-sm text-warn">
          Connect a wallet or sign in with a passkey first.{' '}
          <Link href="/" className="underline">
            Go to sign-in
          </Link>
        </div>
      )}

      <div className="mt-8">
        {/* STEP: counterparty */}
        {current === 'counterparty' && (
          <div className="bz-fadein">
            <label className="block">
              <span className="text-base font-medium text-fg">Who are you paying?</span>
              <p className="mt-1 text-sm text-muted">
                The seller&apos;s Bezant handle or their 0x wallet address. They agree to the terms before
                anything is funded.
              </p>
              <input
                value={sellerInput}
                onChange={(e) => setSellerInput(e.target.value)}
                placeholder="seller-handle or 0x…"
                autoFocus
                className={`mt-4 ${bigField}`}
              />
            </label>
            <div className="mt-2 min-h-5 text-sm">
              {sellerCheck.status === 'checking' && <span className="text-muted">Checking…</span>}
              {sellerCheck.status === 'found' && (
                <span className="flex items-center gap-1.5 text-primary">
                  <CheckIcon /> {sellerCheck.handle} · <span className="font-mono">{shortAddress(sellerCheck.address)}</span>
                </span>
              )}
              {sellerCheck.status === 'address' && (
                <span className="flex items-center gap-1.5 text-primary">
                  <CheckIcon /> Wallet address · <span className="font-mono">{shortAddress(sellerCheck.address)}</span>
                </span>
              )}
              {sellerCheck.status === 'notfound' && (
                <span className="text-warn">
                  No Bezant user “{sellerInput.trim()}”. Paste their 0x wallet address instead.
                </span>
              )}
            </div>
          </div>
        )}

        {/* STEP: terms */}
        {current === 'terms' && (
          <div className="bz-fadein space-y-6">
            <div>
              <label className="text-base font-medium text-fg">Bond amount</label>
              <div className="mt-2 flex items-center gap-3 rounded-none border border-line bg-surface-2 px-4 py-3 transition focus-within:border-primary">
                <input
                  value={amountUsdc}
                  onChange={(e) => setAmountUsdc(e.target.value)}
                  inputMode="decimal"
                  placeholder="0.00"
                  className="w-full bg-transparent font-mono text-2xl text-fg placeholder:text-muted focus:outline-none"
                />
                <span className="font-mono text-sm text-muted">USDC</span>
              </div>
            </div>

            <label className="block">
              <span className="text-base font-medium text-fg">Delivery milestone</span>
              <p className="mt-1 text-sm text-muted">What must be delivered for the bond to settle.</p>
              <input value={milestone} onChange={(e) => setMilestone(e.target.value)} className={`mt-2 ${bigField}`} />
            </label>

            <div>
              <span className="text-base font-medium text-fg">Deadline</span>
              <p className="mt-1 text-sm text-muted">If nothing is attested by then, the buyer can reclaim the deposit.</p>
              <div className="mt-2 flex gap-2">
                <input
                  type="number"
                  min={1}
                  value={deadlineValue}
                  onChange={(e) => setDeadlineValue(Number(e.target.value))}
                  className={`w-28 ${bigField}`}
                />
                <select
                  value={deadlineUnit}
                  onChange={(e) => setDeadlineUnit(e.target.value as DeadlineUnit)}
                  className={`w-auto ${bigField}`}
                >
                  <option value="minutes">minutes</option>
                  <option value="hours">hours</option>
                  <option value="days">days</option>
                </select>
              </div>
            </div>
          </div>
        )}

        {/* STEP: verify */}
        {current === 'verify' && verifier?.configured && (
          <div className="bz-fadein">
            <span className="text-base font-medium text-fg">How is delivery verified?</span>
            <p className="mt-1 text-sm text-muted">Pick who confirms the goods arrived before funds release.</p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setVerifyMode('officer')}
                className={`rounded-xl border px-4 py-4 text-left transition ${verifyMode === 'officer' ? 'border-primary bg-surface text-fg' : 'border-line text-muted hover:border-line-strong'}`}
              >
                <div className="text-base font-medium text-fg">Trade Officer</div>
                <div className="mt-1 text-sm text-muted">Fast — an automated agent attests delivery.</div>
              </button>
              <button
                type="button"
                onClick={() => setVerifyMode('panel')}
                className={`rounded-xl border px-4 py-4 text-left transition ${verifyMode === 'panel' ? 'border-primary bg-surface text-fg' : 'border-line text-muted hover:border-line-strong'}`}
              >
                <div className="text-base font-medium text-fg">Staked panel</div>
                <div className="mt-1 text-sm text-muted">
                  Decentralized — a {verifier.panelSize}-verifier panel votes. +{(verifier.feeBps ?? 0) / 100}% fee.
                </div>
              </button>
            </div>
          </div>
        )}

        {/* STEP: review */}
        {current === 'review' && (
          <div className="bz-fadein space-y-6">
            {signer.isConnected && <PassportPanel address={signer.address} />}

            <dl className="divide-y divide-line overflow-hidden bz-frame rounded-xl border border-line bg-surface">
              <SummaryRow label="Seller" onEdit={() => setStepIdx(0)}>
                {sellerCheck.status === 'found' ? (
                  <span>
                    {sellerCheck.handle}{' '}
                    <span className="font-mono text-muted">({shortAddress(sellerCheck.address)})</span>
                  </span>
                ) : sellerCheck.status === 'address' ? (
                  <span className="font-mono">{shortAddress(sellerCheck.address)}</span>
                ) : (
                  sellerInput || '—'
                )}
              </SummaryRow>
              <SummaryRow label="Amount" onEdit={() => setStepIdx(1)}>
                <span className="font-mono">{amountUsdc || '0'} USDC</span>
              </SummaryRow>
              <SummaryRow label="Milestone" onEdit={() => setStepIdx(1)}>{milestone || '—'}</SummaryRow>
              <SummaryRow label="Deadline" onEdit={() => setStepIdx(1)}>
                {deadlineValue} {deadlineUnit}
              </SummaryRow>
              {verifier?.configured && (
                <SummaryRow label="Verification" onEdit={() => setStepIdx(2)}>
                  {verifyMode === 'panel' ? 'Staked panel' : 'Trade Officer'}
                </SummaryRow>
              )}
            </dl>

            <div className="grid gap-4 bz-frame rounded-xl border border-line bg-surface p-5 sm:grid-cols-3">
              {STRIKE_STEPS.map(([t, d]) => (
                <div key={t}>
                  <div className="text-xs font-semibold uppercase tracking-wider text-brand">{t}</div>
                  <p className="mt-1.5 text-xs leading-relaxed text-muted">{d}</p>
                </div>
              ))}
            </div>

            {signer.isConnected && (
              <FundFromChain
                address={signer.address}
                signerMode={signer.mode}
                lockedAmount={amountUsdc && Number(amountUsdc) > 0 ? amountUsdc : undefined}
              />
            )}
          </div>
        )}
      </div>

      {/* Nav */}
      <div className="mt-8 flex items-center justify-between gap-3">
        {atFirst ? (
          <Link href="/trade" className="rounded-lg px-4 py-2 text-sm text-muted transition hover:text-fg">
            Cancel
          </Link>
        ) : (
          <button
            type="button"
            onClick={goBack}
            className="rounded-lg border border-line px-4 py-2 text-sm text-fg transition hover:border-line-strong"
          >
            ← Back
          </button>
        )}

        {atLast ? (
          isOffArc ? (
            <button
              type="button"
              onClick={() => switchChain({ chainId: arcTestnet.id })}
              className="inline-flex items-center gap-2 rounded-lg border border-warn/50 bg-warn/12 px-4 py-2 text-sm font-medium text-warn transition hover:bg-warn/60"
            >
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-warn" />
              Switch to Arc to strike →
            </button>
          ) : (
            <StruckButton onClick={submit} disabled={isBusy || !signer.isConnected} icon={<PlusIcon />}>
              {isBusy ? 'Striking…' : 'Strike the bond'}
            </StruckButton>
          )
        ) : (
          <StruckButton onClick={goNext} icon={<ArrowIcon />}>
            Continue
          </StruckButton>
        )}
      </div>

      {stepError && <p className="mt-3 text-right text-sm text-danger">{stepError}</p>}
      {submission.status === 'waiting' && (
        <p className="mt-3 text-right text-sm text-muted">Waiting for confirmation… {submission.hash.slice(0, 10)}…</p>
      )}
      {submission.status === 'error' && <p className="mt-3 text-right text-sm text-danger">{submission.message}</p>}
    </main>
  );
}

function Stepper({ steps, activeIdx }: { steps: { key: string; label: string }[]; activeIdx: number }) {
  return (
    <ol className="flex items-center gap-2">
      {steps.map((s, i) => {
        const done = i < activeIdx;
        const on = i === activeIdx;
        const last = i === steps.length - 1;
        return (
          <li key={s.key} className={`flex items-center gap-2 ${last ? '' : 'flex-1'}`}>
            <span
              className={[
                'flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-xs font-semibold transition',
                on ? 'border-primary bg-primary text-primary-fg' : done ? 'border-primary text-primary' : 'border-line text-muted',
              ].join(' ')}
            >
              {done ? <CheckIcon /> : i + 1}
            </span>
            <span className={`hidden whitespace-nowrap text-sm sm:inline ${on ? 'text-fg' : 'text-muted'}`}>{s.label}</span>
            {!last && <span className={`ml-1 h-px flex-1 ${done ? 'bg-primary' : 'bg-line'}`} />}
          </li>
        );
      })}
    </ol>
  );
}

function SummaryRow({ label, onEdit, children }: { label: string; onEdit: () => void; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="flex min-w-0 items-center gap-3 text-sm text-fg">
        <span className="truncate">{children}</span>
        <button type="button" onClick={onEdit} className="shrink-0 text-xs text-info transition hover:underline">
          Edit
        </button>
      </dd>
    </div>
  );
}
