'use client';

// The user's Circle Gateway unified balance, fully integrated: one USDC balance
// spendable across chains. Top up from any chain, spend it to fund bonds on Arc,
// withdraw it out to any chain. EOA-only (Gateway rejects passkey/1271 sigs), so
// wagmi is always the active signer here and we drive source-chain txs directly.
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { parseUnits, type Address, type Hex } from 'viem';
import { useConfig, useSignTypedData, useBalance } from 'wagmi';
import { switchChain, writeContract, waitForTransactionReceipt } from '@wagmi/core';
import { useToast } from '@/components/toast';
import { useTxFlow, type FlowStep } from '@/components/tx-flow';
import { ChainLogo, type ChainLogoKey } from '@/components/chain-logo';
import { ExternalLinkIcon } from '@/components/external-link-icon';
import { BridgeIcon } from '@/components/bridge-icon';
import { BRIDGE_CHAINS, type BridgeChain } from '@/lib/bridge';
import { truncateBalance } from '@/lib/format';
import {
  getUnifiedBalance,
  getGatewaySources,
  getWithdrawPlan,
  submitWithdraw,
  type UnifiedBalance,
  type GatewaySource,
} from '@/lib/api';

const APPROVE_ABI = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const;
const DEPOSIT_ABI = [
  { type: 'function', name: 'deposit', stateMutability: 'nonpayable', inputs: [{ name: 'token', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [] },
] as const;

type Mode = 'idle' | 'topup' | 'movearc' | 'withdraw';

const ARC_KEY = 'arcTestnet';

export function UnifiedBalancePanel({ address }: { address: string }) {
  const config = useConfig();
  const toast = useToast();
  const txFlow = useTxFlow();
  const { signTypedDataAsync } = useSignTypedData();

  const [bal, setBal] = useState<UnifiedBalance | null>(null);
  const [sources, setSources] = useState<GatewaySource[]>([]);
  const [mode, setMode] = useState<Mode>('idle');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    getUnifiedBalance(address).then(setBal).catch(() => {});
  }, [address]);

  useEffect(() => {
    load();
    getGatewaySources().then(setSources).catch(() => {});
  }, [load]);

  const total = bal ? Number(bal.totalUsdc) : 0;
  const pending = bal ? Number(bal.pendingUsdc) : 0;
  const funded = bal?.byChain.filter((c) => Number(c.balanceUsdc) > 0 || Number(c.pendingUsdc) > 0) ?? [];
  // Balance held OFF Arc - what "Move to Arc" can consolidate for use in Bezant.
  const offArc = funded.filter((c) => c.key !== ARC_KEY && Number(c.balanceUsdc) > 0);
  const offArcTotal = offArc.reduce((s, c) => s + Number(c.balanceUsdc), 0);

  return (
    <div className="bz-frame rounded-2xl border border-line bg-surface p-6">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-brand">Unified balance</div>
        <span className="text-[10px] text-muted">Circle Gateway</span>
      </div>

      <div className="mt-3">
        <div className="font-mono text-3xl font-semibold tabular-nums text-primary">
          {bal ? total.toFixed(2) : '—'} <span className="text-sm font-normal text-muted">USDC</span>
        </div>
        <div className="text-xs text-muted">spendable on any chain</div>
      </div>

      {/* Confirming: Circle credits deposits only after on-chain finality. */}
      {pending > 0 && (
        <div className="mt-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
          <span className="font-mono font-medium">{pending.toFixed(2)} USDC</span> confirming on-chain — shows once finalized (a few min; up to ~15 on Ethereum).
        </div>
      )}

      {/* Per-chain Gateway balance (only chains that hold something) */}
      {funded.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {funded.map((c) => (
            <li key={c.key} className="flex items-center gap-2 text-sm">
              <ChainLogo sourceKey={c.key as ChainLogoKey} className="h-4 w-4" />
              <span className="text-fg">{c.name}</span>
              <span className="ml-auto font-mono tabular-nums text-fg">{Number(c.balanceUsdc).toFixed(2)}</span>
              {Number(c.pendingUsdc) > 0 && <span className="font-mono text-[11px] text-warn">+{Number(c.pendingUsdc).toFixed(2)} confirming</span>}
            </li>
          ))}
        </ul>
      )}
      {funded.length === 0 && pending === 0 && (
        <p className="mt-2 text-xs text-muted">No unified balance yet — <span className="text-fg">Top up</span> from a chain where you hold USDC to get started.</p>
      )}

      {mode === 'idle' && (
        <div className="mt-4 space-y-2">
          {/* Consolidate off-Arc balance onto the Arc wallet, where it funds
              trades, pool deposits, and verifier stakes. */}
          <button
            onClick={() => setMode('movearc')}
            disabled={offArcTotal <= 0}
            className="w-full rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-fg transition hover:opacity-90 disabled:opacity-40"
          >
            Move to Arc{offArcTotal > 0 ? ` · ${offArcTotal.toFixed(2)} available` : ''}
          </button>
          <div className="flex gap-2">
            <button onClick={() => setMode('topup')} className="flex-1 rounded-lg border border-line px-3 py-2 text-sm font-medium text-fg transition hover:border-line-strong">
              Top up
            </button>
            <button onClick={() => setMode('withdraw')} disabled={total <= 0} className="flex-1 rounded-lg border border-line px-3 py-2 text-sm font-medium text-fg transition hover:border-line-strong disabled:opacity-40">
              Withdraw
            </button>
          </div>
        </div>
      )}

      {mode === 'topup' && (
        <TopUp
          sources={sources}
          onClose={() => setMode('idle')}
          onDone={load}
          config={config}
          txFlow={txFlow}
          toast={toast}
          setBusy={setBusy}
          busy={busy}
        />
      )}

      {mode === 'movearc' && (
        <Withdraw
          address={address}
          funded={offArc}
          allChains={sources}
          lockDest={{ key: ARC_KEY, name: 'Arc Testnet' }}
          title="Move to Arc"
          onClose={() => setMode('idle')}
          onDone={load}
          signTypedDataAsync={signTypedDataAsync}
          toast={toast}
          setBusy={setBusy}
          busy={busy}
        />
      )}

      {mode === 'withdraw' && (
        <Withdraw
          address={address}
          funded={funded}
          allChains={sources}
          onClose={() => setMode('idle')}
          onDone={load}
          signTypedDataAsync={signTypedDataAsync}
          toast={toast}
          setBusy={setBusy}
          busy={busy}
        />
      )}

      <p className="mt-3 text-[11px] leading-snug text-muted">
        One USDC balance, any chain. Top up from another chain, <span className="text-fg">move it to Arc</span> to fund bonds / pool / verifier stakes, or withdraw it out. A small Gateway fee (≈0.02 USDC) applies per move.
      </p>

      {/* Wallet balances per chain - what's in your wallet (not yet in Gateway).
          Top up moves wallet USDC into the unified balance above. */}
      {mode === 'idle' && (
        <div className="mt-4 border-t border-line pt-3">
          <div className="flex items-center justify-between">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted">In your wallet</div>
            <Link href="/bridge" className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline">
              <BridgeIcon className="h-3 w-3" /> Bridge
            </Link>
          </div>
          <ul className="mt-2 space-y-0.5">
            {BRIDGE_CHAINS.map((chain) => (
              <WalletRow key={chain.key} chain={chain} address={address as Address} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// One chain's USDC balance held in the user's wallet (distinct from the Gateway
// unified balance above). Mirrors ChainBalancesCard's row, compact.
function WalletRow({ chain, address }: { chain: BridgeChain; address: Address }) {
  const queryable = chain.wagmiChainId !== undefined && !chain.comingSoon;
  const { data, isLoading } = useBalance({
    address,
    chainId: chain.wagmiChainId,
    token: chain.usdcIsNative ? undefined : chain.usdc,
    query: { enabled: queryable, refetchInterval: 15_000 },
  });
  const formatted = isLoading ? '…' : data ? truncateBalance(data.formatted, 2) : '0';
  const has = !!data && Number(data.formatted) > 0;
  return (
    <li className="flex items-center gap-2 rounded-md px-1.5 py-1 text-xs">
      <ChainLogo sourceKey={chain.key} className="h-4 w-4 flex-shrink-0" />
      <span className="truncate text-fg">{chain.fullName}</span>
      {chain.comingSoon ? (
        <span className="ml-auto rounded bg-warn/12 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-warn">Soon</span>
      ) : (
        <span className={`ml-auto font-mono tabular-nums ${has ? 'text-fg' : 'text-muted'}`}>{formatted} <span className="text-[9px] text-muted">USDC</span></span>
      )}
    </li>
  );
}

// ── Top up: deposit USDC into Gateway on a source chain (approve + deposit) ──
function TopUp({
  sources, onClose, onDone, config, txFlow, toast, setBusy, busy,
}: {
  sources: GatewaySource[];
  onClose: () => void;
  onDone: () => void;
  config: ReturnType<typeof useConfig>;
  txFlow: ReturnType<typeof useTxFlow>;
  toast: ReturnType<typeof useToast>;
  setBusy: (b: boolean) => void;
  busy: boolean;
}) {
  const [sourceKey, setSourceKey] = useState('');
  const [amount, setAmount] = useState('');

  const run = async () => {
    const src = sources.find((s) => s.key === sourceKey);
    if (!src) { toast.error('Pick a chain to top up from.'); return; }
    if (!amount || Number(amount) <= 0) { toast.error('Enter an amount.'); return; }
    setBusy(true);
    try {
      const amt = parseUnits(amount, 6);
      const steps: FlowStep[] = [
        {
          key: 'approve', label: `Approve USDC on ${src.name}`, action: 'Approve',
          run: async () => {
            await switchChain(config, { chainId: src.chainId });
            const hash = await writeContract(config, { chainId: src.chainId, address: src.usdc, abi: APPROVE_ABI, functionName: 'approve', args: [src.gatewayWallet, amt] });
            await waitForTransactionReceipt(config, { chainId: src.chainId, hash });
          },
        },
        {
          key: 'deposit', label: 'Deposit into Gateway', action: 'Deposit',
          run: async () => {
            const hash = await writeContract(config, { chainId: src.chainId, address: src.gatewayWallet, abi: DEPOSIT_ABI, functionName: 'deposit', args: [src.usdc, amt] });
            await waitForTransactionReceipt(config, { chainId: src.chainId, hash });
          },
        },
      ];
      const ok = await txFlow.start({ title: `Top up ${amount} USDC from ${src.name}`, amountUsdc: amount, steps });
      if (ok) {
        toast.success(`Deposited ${amount} USDC — it credits your balance shortly.`);
        onDone();
        onClose();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 space-y-3 rounded-lg border border-line bg-bg/40 p-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-fg">Top up from another chain</p>
        {!busy && <CloseBtn onClick={onClose} />}
      </div>
      <ChainGrid chains={sources} selected={sourceKey} onSelect={setSourceKey} disabled={busy} />
      <AmountRow amount={amount} setAmount={setAmount} disabled={busy} onGo={run} busy={busy} verb="Top up" />
    </div>
  );
}

// ── Withdraw: sign a burn intent to route balance out; backend relays the mint ──
function Withdraw({
  address, funded, allChains, onClose, onDone, signTypedDataAsync, toast, setBusy, busy, lockDest, title,
}: {
  address: string;
  funded: UnifiedBalance['byChain'];
  allChains: GatewaySource[];
  onClose: () => void;
  onDone: () => void;
  signTypedDataAsync: ReturnType<typeof useSignTypedData>['signTypedDataAsync'];
  toast: ReturnType<typeof useToast>;
  setBusy: (b: boolean) => void;
  busy: boolean;
  lockDest?: { key: string; name: string }; // when set, destination is fixed (e.g. Arc) and the "To" picker is hidden
  title?: string;
}) {
  const [sourceKey, setSourceKey] = useState(funded[0]?.key ?? '');
  const [destKey, setDestKey] = useState(lockDest?.key ?? '');
  const [amount, setAmount] = useState('');
  const [result, setResult] = useState<{ deliveredUsdc: string; destName: string; mintTxUrl?: string; mintTxHash: string } | null>(null);

  const dests = allChains.filter((c) => c.key !== sourceKey && c.key !== lockDest?.key);
  const effectiveDestKey = lockDest?.key ?? destKey;

  const run = async () => {
    if (!sourceKey) { toast.error('Pick where to move from.'); return; }
    if (!effectiveDestKey) { toast.error('Pick a destination chain.'); return; }
    if (!amount || Number(amount) <= 0) { toast.error('Enter an amount.'); return; }
    setBusy(true);
    try {
      const plan = await getWithdrawPlan(address, sourceKey, effectiveDestKey, amount);
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
      setResult({ deliveredUsdc: res.deliveredUsdc, destName: res.destination.name, mintTxUrl: res.mintTxUrl, mintTxHash: res.mintTxHash });
      toast.success(`Withdrew ${res.deliveredUsdc} USDC to ${res.destination.name}.`);
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <div className="mt-4 rounded-lg border border-primary/40 bg-primary/20 p-3 text-sm">
        <div className="flex items-center gap-2 text-primary">
          <ChainLogo sourceKey={effectiveDestKey as ChainLogoKey} className="h-5 w-5" />
          <span>Moved <span className="font-medium">{result.deliveredUsdc} USDC</span> to {result.destName}.</span>
        </div>
        <p className="mt-1 text-xs text-muted">
          {result.mintTxUrl ? (
            <a href={result.mintTxUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-info underline">
              View transaction <ExternalLinkIcon />
            </a>
          ) : (
            <span className="break-all">tx: {result.mintTxHash}</span>
          )}
        </p>
        <button onClick={onClose} className="mt-2 text-xs text-info hover:underline">Done</button>
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-3 rounded-lg border border-line bg-bg/40 p-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-fg">{title ?? 'Withdraw to another chain'}</p>
        {!busy && <CloseBtn onClick={onClose} />}
      </div>
      {lockDest && (
        <p className="text-xs text-muted">
          Consolidate your balance onto Arc — then use it to fund bonds, deposit into the pool, or stake as a verifier.
        </p>
      )}
      <div>
        <p className="mb-1 text-[11px] uppercase tracking-wide text-muted">From</p>
        <ChainGrid chains={funded.map((c) => ({ key: c.key, name: c.name }))} selected={sourceKey} onSelect={setSourceKey} disabled={busy} />
      </div>
      {lockDest ? (
        <div className="flex items-center gap-2 rounded-md border border-primary/40 bg-primary/10 px-2.5 py-2 text-sm">
          <span className="text-[11px] uppercase tracking-wide text-muted">To</span>
          <ChainLogo sourceKey={lockDest.key as ChainLogoKey} className="h-4 w-4" />
          <span className="text-fg">{lockDest.name}</span>
        </div>
      ) : (
        <div>
          <p className="mb-1 text-[11px] uppercase tracking-wide text-muted">To</p>
          <ChainGrid chains={dests} selected={destKey} onSelect={setDestKey} disabled={busy} />
        </div>
      )}
      <AmountRow amount={amount} setAmount={setAmount} disabled={busy} onGo={run} busy={busy} verb={lockDest ? 'Move to Arc' : 'Withdraw'} />
    </div>
  );
}

// ── Small shared UI ──
function ChainGrid({ chains, selected, onSelect, disabled }: { chains: Array<{ key: string; name: string }>; selected: string; onSelect: (k: string) => void; disabled?: boolean }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {chains.length === 0 && <p className="col-span-full text-xs text-muted">No chains.</p>}
      {chains.map((c) => (
        <button
          key={c.key}
          onClick={() => onSelect(c.key)}
          disabled={disabled}
          className={`flex items-center gap-2 rounded-md border px-2.5 py-2 text-sm transition disabled:opacity-50 ${
            selected === c.key ? 'border-primary bg-primary/12 text-fg' : 'border-line bg-bg text-fg hover:border-line-strong'
          }`}
        >
          <ChainLogo sourceKey={c.key as ChainLogoKey} className="h-4 w-4" />
          <span className="truncate">{c.name}</span>
        </button>
      ))}
    </div>
  );
}

function AmountRow({ amount, setAmount, disabled, onGo, busy, verb }: { amount: string; setAmount: (v: string) => void; disabled: boolean; onGo: () => void; busy: boolean; verb: string }) {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1 text-xs text-muted">
        Amount (USDC)
        <input value={amount} onChange={(e) => setAmount(e.target.value)} disabled={disabled} inputMode="decimal" placeholder="0.00" className="w-32 rounded-md border border-line bg-bg px-2 py-1.5 text-sm text-fg" />
      </label>
      <button onClick={onGo} disabled={disabled} className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-fg transition hover:opacity-90 disabled:opacity-50">
        {busy ? 'Working…' : verb}
      </button>
    </div>
  );
}

function CloseBtn({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="text-muted hover:text-fg" aria-label="Close">
      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6 6 18" />
      </svg>
    </button>
  );
}
