'use client';

// Optional cross-chain seller payout via Circle Gateway. Two modes:
//   • "prefer"  — shown while the trade is still active (Funded): the seller
//     picks where they want to be paid; the choice is saved locally.
//   • "settle"  — shown once Released: if a chain was pre-chosen it offers a
//     one-click route there; otherwise the closed trade stays clean.
// The actual transfer can only run after settlement (the funds sit in escrow
// until then), so this is "choose early, route at settlement". External (EOA)
// wallets only: the seller's wallet signs approve + deposit + the burn intent;
// the backend relays the destination mint.
import { useCallback, useEffect, useState } from 'react';
import { encodeFunctionData, parseUnits, type Hex } from 'viem';
import { useSigner } from '@/hooks/use-signer';
import { useToast } from '@/components/toast';
import { ChainLogo, type ChainLogoKey } from '@/components/chain-logo';
import { ExternalLinkIcon } from '@/components/external-link-icon';
import {
  getGatewayDestinations,
  getGatewayPayoutPlan,
  getGatewayBalance,
  submitGatewayPayout,
  getGatewayPayout,
  type GatewayDestination,
  type GatewayPayoutResult,
  type GatewayPayoutRecord,
} from '@/lib/api';

const ERC20_APPROVE_ABI = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const;
const GATEWAY_DEPOSIT_ABI = [
  { type: 'function', name: 'deposit', stateMutability: 'nonpayable', inputs: [{ name: 'token', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [] },
] as const;

type Phase = 'idle' | 'approving' | 'depositing' | 'crediting' | 'signing' | 'settling' | 'done';
const PHASE_ORDER: Phase[] = ['approving', 'depositing', 'crediting', 'signing', 'settling'];
const PHASE_LABEL: Record<Exclude<Phase, 'idle' | 'done'>, string> = {
  approving: 'Approve USDC on Arc',
  depositing: 'Deposit into Gateway',
  crediting: 'Wait for Gateway to credit',
  signing: 'Sign the transfer',
  settling: 'Mint on destination',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Payout-chain preference, saved locally from the active-trade step and read back
// at settlement. Per trade + seller; no backend needed for a per-device choice.
const prefKey = (tradeId: string, seller: string) => `arc-trade:payout-pref:${tradeId}:${seller.toLowerCase()}`;
const readPref = (tradeId: string, seller: string): string | null => {
  try { return localStorage.getItem(prefKey(tradeId, seller)); } catch { return null; }
};
const writePref = (tradeId: string, seller: string, key: string | null) => {
  try {
    if (key) localStorage.setItem(prefKey(tradeId, seller), key);
    else localStorage.removeItem(prefKey(tradeId, seller));
  } catch { /* ignore */ }
};

export function GatewayPayoutPanel({
  tradeId,
  sellerAddress,
  defaultAmountUsdc,
  mode,
}: {
  tradeId: string;
  sellerAddress: string;
  defaultAmountUsdc: string;
  mode: 'prefer' | 'settle';
}) {
  const signer = useSigner();
  const toast = useToast();
  const [destinations, setDestinations] = useState<GatewayDestination[]>([]);
  const [destKey, setDestKey] = useState('');
  const [amount, setAmount] = useState(defaultAmountUsdc);
  const [pref, setPref] = useState<string | null>(null);
  const [open, setOpen] = useState(false); // full chain picker (change / fallback)
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GatewayPayoutResult | null>(null);
  const [existing, setExisting] = useState<GatewayPayoutRecord | null>(null);
  const [loaded, setLoaded] = useState(false);

  const isSeller = signer.isConnected && signer.address.toLowerCase() === sellerAddress.toLowerCase();
  const busy = phase !== 'idle' && phase !== 'done';

  // Load supported chains once, the saved preference, and (settle mode) any
  // already-recorded payout so a refresh shows "done" instead of re-routing.
  useEffect(() => {
    const p = readPref(tradeId, sellerAddress);
    setPref(p);
    if (p) setDestKey(p);
    getGatewayDestinations().then((list) => setDestinations(list.filter((d) => d.supported))).catch(() => {});
    if (mode === 'settle') {
      getGatewayPayout(tradeId).then(setExisting).catch(() => {}).finally(() => setLoaded(true));
    } else {
      setLoaded(true);
    }
  }, [tradeId, sellerAddress, mode]);

  const destName = (key: string) => destinations.find((d) => d.key === key)?.name ?? key;

  const choosePref = (key: string | null) => {
    writePref(tradeId, sellerAddress, key);
    setPref(key);
    if (key) {
      setDestKey(key);
      toast.success(`You'll be paid on ${destName(key)} after this settles.`);
    }
  };

  const run = useCallback(async () => {
    if (!signer.isConnected) return;
    setError(null);
    setResult(null);
    try {
      if (signer.mode !== 'external') {
        throw new Error('Connect an external wallet (MetaMask, Rabby, etc.) to route your payout — passkey wallets aren’t supported for this yet.');
      }
      if (!destKey) throw new Error('Pick a destination chain.');
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
      writePref(tradeId, sellerAddress, null); // consume the preference
      toast.success(`Routed ${res.deliveredUsdc} USDC to ${res.destination.name}.`);
    } catch (err) {
      setPhase('idle');
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      toast.error(msg);
    }
  }, [signer, amount, destKey, tradeId, sellerAddress, toast]);

  if (!isSeller || !loaded) return null;

  // ── Active trade: pick where to be paid (saved for settlement) ──
  if (mode === 'prefer') {
    return (
      <div className="space-y-2.5 rounded-lg border border-sky-900/40 bg-sky-950/20 p-4">
        <p className="text-sm text-sky-100">Get paid on another chain? <span className="text-neutral-500">(optional)</span></p>
        <p className="text-xs text-neutral-500">
          You&apos;re paid in USDC on Arc by default when this settles. Prefer another chain? Pick one now and we&apos;ll route it for you right after settlement.
        </p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <ChainChip label="Arc (default)" chainKey="arcTestnet" selected={!pref} onClick={() => choosePref(null)} />
          {destinations.map((d) => (
            <ChainChip key={d.key} label={d.name} chainKey={d.key as ChainLogoKey} selected={pref === d.key} onClick={() => choosePref(d.key)} />
          ))}
        </div>
        {pref && (
          <p className="text-xs text-emerald-300">✓ We&apos;ll route your payout to {destName(pref)} right after settlement.</p>
        )}
      </div>
    );
  }

  // ── Settled: complete / route to the pre-chosen chain / stay clean ──
  const done = result ?? existing;
  if (done) {
    return (
      <div className="rounded-lg border border-emerald-900/40 bg-emerald-950/20 p-4 text-sm">
        <div className="flex items-center gap-2 text-emerald-200">
          <ChainLogo sourceKey={done.destination.key as ChainLogoKey} className="h-5 w-5" />
          <span>Routed <span className="font-medium">{done.deliveredUsdc} USDC</span> to {done.destination.name}.</span>
        </div>
        <p className="mt-1 text-xs text-neutral-500">
          {done.mintTxUrl ? (
            <a href={done.mintTxUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sky-400 hover:text-sky-300 underline">
              View mint transaction <ExternalLinkIcon />
            </a>
          ) : (
            <span className="break-all">mint tx: {done.mintTxHash}</span>
          )}
        </p>
      </div>
    );
  }

  // No chain pre-chosen and the picker isn't open → keep the closed trade clean,
  // with just a subtle escape hatch.
  if (!pref && !open) {
    return (
      <button onClick={() => setOpen(true)} className="text-xs text-sky-400/80 hover:text-sky-300">
        Receive your payout on another chain →
      </button>
    );
  }

  // Pre-chosen chain → streamlined one-click route (unless the picker is open).
  if (pref && !open) {
    return (
      <div className="space-y-3 rounded-lg border border-sky-900/40 bg-sky-950/20 p-4">
        <div>
          <p className="text-sm text-sky-100">Route your payout to another chain</p>
          <p className="mt-1 text-xs text-neutral-500">You were paid on Arc. Send it to your chosen chain via Circle Gateway.</p>
        </div>
        <div className="flex items-center gap-2 rounded-md border border-sky-800/50 bg-sky-900/20 px-3 py-2 text-sm text-neutral-100">
          <ChainLogo sourceKey={pref as ChainLogoKey} className="h-5 w-5" />
          <span className="font-medium">{destName(pref)}</span>
          {!busy && (
            <button onClick={() => setOpen(true)} className="ml-auto text-xs text-sky-400 hover:text-sky-300">change</button>
          )}
        </div>
        <div className="flex flex-wrap items-end gap-3">
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
          <button onClick={run} disabled={busy} className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50">
            {busy ? 'Routing…' : 'Route now'}
          </button>
        </div>
        <RouteStatus phase={phase} error={error} signerMode={signer.isConnected ? signer.mode : null} />
      </div>
    );
  }

  // Full chain picker (change chain, or the fallback opened from the link).
  return (
    <div className="space-y-3 rounded-lg border border-sky-900/40 bg-sky-950/20 p-4">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-sky-100">Pick a chain to be paid on</p>
          <p className="mt-1 text-xs text-neutral-500">You were paid on Arc. Route some or all of it to another chain via Circle Gateway.</p>
        </div>
        {!busy && (
          <button onClick={() => setOpen(false)} className="text-neutral-500 hover:text-neutral-300" aria-label="Close">
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {destinations.length === 0 && <p className="col-span-full text-xs text-neutral-500">Loading chains…</p>}
        {destinations.map((d) => (
          <ChainChip key={d.key} label={d.name} chainKey={d.key as ChainLogoKey} selected={destKey === d.key} disabled={busy} onClick={() => setDestKey(d.key)} />
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-3">
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
        <button onClick={run} disabled={busy || !destKey} className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50">
          {busy ? 'Routing…' : 'Route payout'}
        </button>
      </div>

      <RouteStatus phase={phase} error={error} signerMode={signer.isConnected ? signer.mode : null} />
    </div>
  );
}

function ChainChip({ label, chainKey, selected, disabled, onClick }: { label: string; chainKey: ChainLogoKey; selected: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition disabled:opacity-50 ${
        selected ? 'border-sky-500 bg-sky-900/30 text-white' : 'border-neutral-800 bg-neutral-950 text-neutral-300 hover:border-neutral-700'
      }`}
    >
      <ChainLogo sourceKey={chainKey} className="h-5 w-5" />
      <span className="truncate">{label}</span>
    </button>
  );
}

function RouteStatus({ phase, error, signerMode }: { phase: Phase; error: string | null; signerMode: 'external' | 'circle' | null }) {
  const busy = phase !== 'idle' && phase !== 'done';
  return (
    <>
      {signerMode !== null && signerMode !== 'external' && (
        <p className="text-xs text-amber-300">Passkey wallets can’t route cross-chain yet — connect an external wallet.</p>
      )}
      {busy && (
        <ol className="space-y-1 text-xs">
          {PHASE_ORDER.map((p) => {
            const active = phase === p;
            const passed = PHASE_ORDER.indexOf(phase) > PHASE_ORDER.indexOf(p);
            return (
              <li key={p} className={active ? 'text-sky-300' : passed ? 'text-emerald-400' : 'text-neutral-600'}>
                {passed ? '✓' : active ? '•' : '○'} {PHASE_LABEL[p as Exclude<Phase, 'idle' | 'done'>]}
              </li>
            );
          })}
        </ol>
      )}
      {error && <p className="text-xs text-red-300">{error}</p>}
      <p className="text-[11px] text-neutral-600">A small Gateway fee (≈0.02 USDC) is taken on top of the amount.</p>
    </>
  );
}
