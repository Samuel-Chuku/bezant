'use client';

// Optional cross-chain seller payout via Circle Gateway. Two modes:
//   • "prefer"  - shown while the trade is still active (Funded): the seller
//     picks where they want to be paid; the choice is saved locally.
//   • "settle"  - shown once Released: if a chain was pre-chosen it offers a
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
import { useTxFlow, type FlowStep } from '@/components/tx-flow';
import { PoweredByCircle } from '@/components/powered-by-circle';
import {
  getGatewayDestinations,
  getGatewayPayoutPlan,
  getGatewayBalance,
  submitGatewayPayout,
  getGatewayPayout,
  getPayoutPref,
  setPayoutPref,
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  const txFlow = useTxFlow();
  const [destinations, setDestinations] = useState<GatewayDestination[]>([]);
  const [destKey, setDestKey] = useState('');
  const [amount, setAmount] = useState(defaultAmountUsdc);
  const [pref, setPref] = useState<string | null>(null);
  const [open, setOpen] = useState(false); // full chain picker (change / fallback)
  const [routing, setRouting] = useState(false);
  const [result, setResult] = useState<GatewayPayoutResult | null>(null);
  const [existing, setExisting] = useState<GatewayPayoutRecord | null>(null);
  const [loaded, setLoaded] = useState(false);

  const isSeller = signer.isConnected && signer.address.toLowerCase() === sellerAddress.toLowerCase();
  const busy = routing;

  // Load supported chains once, the saved preference, and (settle mode) any
  // already-recorded payout so a refresh shows "done" instead of re-routing.
  useEffect(() => {
    getPayoutPref(tradeId, sellerAddress)
      .then((p) => { setPref(p); if (p) setDestKey(p); })
      .catch(() => {});
    getGatewayDestinations().then((list) => setDestinations(list.filter((d) => d.supported))).catch(() => {});
    if (mode === 'settle') {
      getGatewayPayout(tradeId).then(setExisting).catch(() => {}).finally(() => setLoaded(true));
    } else {
      setLoaded(true);
    }
  }, [tradeId, sellerAddress, mode]);

  const destName = (key: string) => destinations.find((d) => d.key === key)?.name ?? key;

  const choosePref = (key: string | null) => {
    setPayoutPref(tradeId, sellerAddress, key).catch(() => {});
    setPref(key);
    if (key) {
      setDestKey(key);
      toast.success(`You'll be paid on ${destName(key)} after this settles.`);
    }
  };

  const run = useCallback(async () => {
    if (!signer.isConnected) return;
    if (signer.mode !== 'external') {
      toast.error('Connect an external wallet (MetaMask, Rabby, etc.) to route your payout - passkey wallets aren’t supported for this yet.');
      return;
    }
    if (!destKey) { toast.error('Pick a destination chain.'); return; }
    if (!amount || Number(amount) <= 0) { toast.error('Enter an amount to route.'); return; }

    setRouting(true);
    try {
      const plan = await getGatewayPayoutPlan(tradeId, destKey, { amountUsdc: amount });
      const sendStep = async (to: `0x${string}`, data: `0x${string}`) => {
        const sent = await signer.sendCall({ to, data }, { review: false });
        if ((await sent.wait()).status !== 'success') throw new Error('Transaction reverted.');
      };

      const steps: FlowStep[] = [];
      if (plan.needsDeposit) {
        const depositRaw = parseUnits(plan.depositUsdc, 6);
        steps.push({
          key: 'approve', label: 'Approve USDC', action: 'Approve',
          run: async () => sendStep(plan.contracts.arcUsdc, encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: 'approve', args: [plan.contracts.gatewayWallet, depositRaw] })),
        });
        steps.push({
          key: 'deposit', label: 'Deposit into Gateway', action: 'Deposit',
          run: async () => {
            await sendStep(plan.contracts.gatewayWallet, encodeFunctionData({ abi: GATEWAY_DEPOSIT_ABI, functionName: 'deposit', args: [plan.contracts.arcUsdc, depositRaw] }));
            // Wait for Gateway to credit the unified balance (no signature).
            const required = Number(plan.requiredUsdc);
            const deadline = Date.now() + 120_000;
            let credited = Number(plan.unifiedBalanceUsdc);
            while (Date.now() < deadline && credited < required) {
              await sleep(3_000);
              credited = Number(await getGatewayBalance(sellerAddress));
            }
            if (credited < required) throw new Error('Gateway hasn’t credited the deposit yet - try again in a moment.');
          },
        });
      }
      steps.push({
        key: 'route', label: `Sign & route to ${plan.destination.name}`, action: 'Sign',
        run: async () => {
          const m = plan.typedData.message;
          const signature = (await signer.signTypedData({
            domain: plan.typedData.domain,
            types: plan.typedData.types,
            primaryType: plan.typedData.primaryType,
            message: { maxBlockHeight: BigInt(m.maxBlockHeight), maxFee: BigInt(m.maxFee), spec: { ...m.spec, value: BigInt(m.spec.value as string) } },
          })) as Hex;
          const res = await submitGatewayPayout(tradeId, plan.typedData.message, signature);
          setResult(res);
          setPayoutPref(tradeId, sellerAddress, null).catch(() => {}); // consume the preference
        },
      });

      const ok = await txFlow.start({ title: `Route ${amount} USDC to ${plan.destination.name}`, amountUsdc: amount, steps });
      if (ok) toast.success(`Routed to ${plan.destination.name}.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setRouting(false);
    }
  }, [signer, amount, destKey, tradeId, sellerAddress, toast, txFlow]);

  if (!isSeller || !loaded) return null;

  // ── Active trade: pick where to be paid (saved for settlement) ──
  if (mode === 'prefer') {
    return (
      <div className="space-y-2.5 rounded-lg border border-info/40 bg-info/20 p-4">
        <p className="text-sm text-info">Get paid on another chain? <span className="text-muted">(optional)</span></p>
        <p className="text-xs text-muted">
          You&apos;re paid in USDC on Arc by default when this settles. Prefer another chain? Pick one now and we&apos;ll route it for you right after settlement.
        </p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <ChainChip label="Arc (default)" chainKey="arcTestnet" selected={!pref} onClick={() => choosePref(null)} />
          {destinations.map((d) => (
            <ChainChip key={d.key} label={d.name} chainKey={d.key as ChainLogoKey} selected={pref === d.key} onClick={() => choosePref(d.key)} />
          ))}
        </div>
        {pref && (
          <p className="text-xs text-primary">✓ We&apos;ll route your payout to {destName(pref)} right after settlement.</p>
        )}
        <PoweredByCircle product="Gateway" />
      </div>
    );
  }

  // ── Settled: complete / route to the pre-chosen chain / stay clean ──
  const done = result ?? existing;
  if (done) {
    return (
      <div className="rounded-lg border border-primary/40 bg-primary/20 p-4 text-sm">
        <div className="flex items-center gap-2 text-primary">
          <ChainLogo sourceKey={done.destination.key as ChainLogoKey} className="h-5 w-5" />
          <span>Routed <span className="font-medium">{done.deliveredUsdc} USDC</span> to {done.destination.name}.</span>
        </div>
        <p className="mt-1 text-xs text-muted">
          {done.mintTxUrl ? (
            <a href={done.mintTxUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-info hover:text-info underline">
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
      <button onClick={() => setOpen(true)} className="text-xs text-info/80 hover:text-info">
        Receive your payout on another chain →
      </button>
    );
  }

  // Pre-chosen chain → streamlined one-click route (unless the picker is open).
  if (pref && !open) {
    return (
      <div className="space-y-3 rounded-lg border border-info/40 bg-info/20 p-4">
        <div>
          <p className="text-sm text-info">Route your payout to another chain</p>
          <p className="mt-1 text-xs text-muted">You were paid on Arc. Send it to your chosen chain via Circle Gateway.</p>
        </div>
        <div className="flex items-center gap-2 rounded-md border border-info/50 bg-info/20 px-3 py-2 text-sm text-fg">
          <ChainLogo sourceKey={pref as ChainLogoKey} className="h-5 w-5" />
          <span className="font-medium">{destName(pref)}</span>
          {!busy && (
            <button onClick={() => setOpen(true)} className="ml-auto text-xs text-info hover:text-info">change</button>
          )}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-muted">
            Amount (USDC)
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={busy}
              inputMode="decimal"
              className="w-32 rounded-md border border-line bg-bg px-2 py-1.5 text-sm text-fg"
            />
          </label>
          <button onClick={run} disabled={busy} className="rounded-md bg-info px-3 py-1.5 text-sm font-medium text-white hover:bg-info disabled:opacity-50">
            {busy ? 'Routing…' : 'Route now'}
          </button>
        </div>
        <RouteFootnote signerMode={signer.isConnected ? signer.mode : null} />
      </div>
    );
  }

  // Full chain picker (change chain, or the fallback opened from the link).
  return (
    <div className="space-y-3 rounded-lg border border-info/40 bg-info/20 p-4">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-info">Pick a chain to be paid on</p>
          <p className="mt-1 text-xs text-muted">You were paid on Arc. Route some or all of it to another chain via Circle Gateway.</p>
        </div>
        {!busy && (
          <button onClick={() => setOpen(false)} className="text-muted hover:text-fg" aria-label="Close">
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {destinations.length === 0 && <p className="col-span-full text-xs text-muted">Loading chains…</p>}
        {destinations.map((d) => (
          <ChainChip key={d.key} label={d.name} chainKey={d.key as ChainLogoKey} selected={destKey === d.key} disabled={busy} onClick={() => setDestKey(d.key)} />
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-muted">
          Amount (USDC)
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={busy}
            inputMode="decimal"
            className="w-32 rounded-md border border-line bg-bg px-2 py-1.5 text-sm text-fg"
          />
        </label>
        <button onClick={run} disabled={busy || !destKey} className="rounded-md bg-info px-3 py-1.5 text-sm font-medium text-white hover:bg-info disabled:opacity-50">
          {busy ? 'Routing…' : 'Route payout'}
        </button>
      </div>

      <RouteFootnote signerMode={signer.isConnected ? signer.mode : null} />
    </div>
  );
}

function ChainChip({ label, chainKey, selected, disabled, onClick }: { label: string; chainKey: ChainLogoKey; selected: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition disabled:opacity-50 ${
        selected ? 'border-info bg-info/12 text-white' : 'border-line bg-bg text-fg hover:border-line-strong'
      }`}
    >
      <ChainLogo sourceKey={chainKey} className="h-5 w-5" />
      <span className="truncate">{label}</span>
    </button>
  );
}

function RouteFootnote({ signerMode }: { signerMode: 'external' | 'circle' | null }) {
  return (
    <>
      {signerMode !== null && signerMode !== 'external' && (
        <p className="text-xs text-warn">Passkey wallets can’t route cross-chain yet - connect an external wallet.</p>
      )}
      <p className="text-[11px] text-muted">A small Gateway fee (≈0.02 USDC) is taken on top of the amount.</p>
      <PoweredByCircle product="Gateway" />
    </>
  );
}
