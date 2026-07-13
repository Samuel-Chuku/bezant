'use client';

// The user's Circle Gateway unified balance, fully integrated: one USDC balance
// spendable across chains. Top up from any chain, spend it to fund bonds on Arc,
// withdraw it out to any chain. EOA-only (Gateway rejects passkey/1271 sigs), so
// wagmi is always the active signer here and we drive source-chain txs directly.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { parseUnits, type Address, type Hex } from 'viem';
import { useConfig, useSignTypedData, useBalance } from 'wagmi';
import { switchChain, writeContract, waitForTransactionReceipt } from '@wagmi/core';
import { useToast } from '@/components/toast';
import { useOnChainRefresh } from '@/hooks/use-refresh-chain-data';
import { timeAgo } from '@/lib/relative-time';
import { addGatewayDeposit, getGatewayDeposits, onGatewayDepositsChange, type GatewayDeposit } from '@/lib/gateway-deposits';
import { useTxFlow, type FlowStep } from '@/components/tx-flow';
import { ChainLogo, type ChainLogoKey } from '@/components/chain-logo';
import { ExternalLinkIcon } from '@/components/external-link-icon';
import { BridgeIcon } from '@/components/bridge-icon';
import { UsdcIcon } from '@/components/usdc-icon';
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
  useOnChainRefresh(load); // reflect top-up / move / withdraw the instant they settle

  const total = bal ? Number(bal.totalUsdc) : 0;
  const pending = bal ? Number(bal.pendingUsdc) : 0;

  // Locally-tracked top-up deposits (reliable "confirming" state; see
  // lib/gateway-deposits). Synced from localStorage + across instances.
  const [deposits, setDeposits] = useState<GatewayDeposit[]>([]);
  const [showRecents, setShowRecents] = useState(false);
  useEffect(() => {
    const sync = () => setDeposits(getGatewayDeposits(address));
    sync();
    return onGatewayDepositsChange(sync);
  }, [address]);

  const availFor = useCallback(
    (chainKey: string) => Number(bal?.byChain.find((c) => c.key === chainKey)?.balanceUsdc ?? 0),
    [bal],
  );
  // A deposit is credited once that chain's available balance has risen to cover
  // it (baseline snapshot + amount). Until then it's confirming.
  const isCredited = useCallback(
    (d: GatewayDeposit) => availFor(d.chainKey) >= d.availableAtDeposit + d.amountUsdc - 0.01,
    [availFor],
  );
  const pendingDeposits = useMemo(() => deposits.filter((d) => !isCredited(d)), [deposits, isCredited]);
  const pendingByChain = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of pendingDeposits) m.set(d.chainKey, (m.get(d.chainKey) ?? 0) + d.amountUsdc);
    return m;
  }, [pendingDeposits]);
  const trackedPendingTotal = useMemo(() => pendingDeposits.reduce((s, d) => s + d.amountUsdc, 0), [pendingDeposits]);

  // Poll while ANY deposit is confirming (Circle's pendingBatch or our tracked
  // ones) so the balance credits itself with no manual refresh.
  useEffect(() => {
    if (pending <= 0 && pendingDeposits.length === 0) return;
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, [pending, pendingDeposits.length, load]);
  const funded = bal?.byChain.filter(
    (c) => Number(c.balanceUsdc) > 0 || Number(c.pendingUsdc) > 0 || (pendingByChain.get(c.key) ?? 0) > 0,
  ) ?? [];
  // Balance held OFF Arc - what "Move to Arc" can consolidate for use in Bezant.
  const offArc = funded.filter((c) => c.key !== ARC_KEY && Number(c.balanceUsdc) > 0);
  const offArcTotal = offArc.reduce((s, c) => s + Number(c.balanceUsdc), 0);

  // Balance already held in Gateway ON Arc. "Move to Arc" only consolidates
  // OFF-Arc chains, so this portion had no way out - it sat stuck in Gateway
  // custody, unusable for funding bonds. "Add to balance" withdraws it (Arc→Arc,
  // recipient = the user) into the Arc wallet where Bezant can spend it.
  const arcGatewayBal = availFor(ARC_KEY);
  const addToBalance = useCallback(async () => {
    const amt = arcGatewayBal - MOVE_FEE_BUFFER;
    if (amt <= 0) {
      toast.error('Arc balance is too small to move (a small Gateway fee is reserved).');
      return;
    }
    setBusy(true);
    try {
      const plan = await getWithdrawPlan(address, ARC_KEY, ARC_KEY, amt.toFixed(6));
      if (plan.needsMore) throw new Error(`short ${plan.shortfallUsdc} USDC`);
      const m = plan.typedData.message;
      const signature = (await signTypedDataAsync({
        domain: plan.typedData.domain,
        types: plan.typedData.types,
        primaryType: plan.typedData.primaryType,
        message: { maxBlockHeight: BigInt(m.maxBlockHeight), maxFee: BigInt(m.maxFee), spec: { ...m.spec, value: BigInt(m.spec.value as string) } },
      } as never)) as Hex;
      const res = await submitWithdraw(plan.typedData.message, signature);
      toast.success(`Added ${Number(res.deliveredUsdc).toFixed(2)} USDC to your Arc wallet.`);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [arcGatewayBal, address, signTypedDataAsync, toast, load]);

  return (
    <div className="bz-frame rounded-2xl border border-line bg-surface p-6">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-brand">Unified balance</div>
        <span className="text-[10px] text-muted">Circle Gateway</span>
      </div>

      <div className="mt-3">
        <div className="flex items-center gap-2 font-mono text-3xl font-semibold tabular-nums text-primary">
          <span>{bal ? total.toFixed(2) : '—'} <span className="text-sm font-normal text-muted">USDC</span></span>
          <UsdcIcon className="h-6 w-6 shrink-0" />
        </div>
        <div className="text-xs text-muted">spendable on any chain</div>
      </div>

      {/* Compact recents affordance - opens an overlay instead of growing the
          card. Shows a live "confirming" count while deposits finalize. */}
      {deposits.length > 0 && (
        <button
          type="button"
          onClick={() => setShowRecents(true)}
          className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-muted transition hover:text-fg"
        >
          {pendingDeposits.length > 0 ? (
            <>
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-warn opacity-70" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-warn" />
              </span>
              <span className="font-medium text-warn">{trackedPendingTotal.toFixed(2)} USDC confirming</span>
            </>
          ) : (
            <span>Recent deposits</span>
          )}
          <span aria-hidden>›</span>
        </button>
      )}

      {/* Per-chain Gateway balance (only chains that hold something) */}
      {funded.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {funded.map((c) => {
            const chainPending = Math.max(pendingByChain.get(c.key) ?? 0, Number(c.pendingUsdc));
            return (
              <li key={c.key} className="flex items-center gap-2 text-sm">
                <ChainLogo sourceKey={c.key as ChainLogoKey} className="h-4 w-4" />
                <span className="text-fg">{c.name}</span>
                <span className="ml-auto font-mono tabular-nums text-fg">{Number(c.balanceUsdc).toFixed(2)}</span>
                {chainPending > 0 && (
                  <span className="rounded bg-warn/12 px-1.5 py-0.5 font-mono text-[11px] text-warn">
                    +{chainPending.toFixed(2)} pending
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {funded.length === 0 && pending === 0 && (
        <p className="mt-2 text-xs text-muted">No unified balance yet — <span className="text-fg">Top up</span> from a chain where you hold USDC to get started.</p>
      )}

      {mode === 'idle' && (
        <div className="mt-4 space-y-2">
          {/* Withdraw the Arc-held Gateway balance into the Arc wallet so it can
              actually fund bonds / pool / stakes. Shown only when there's Arc
              unified balance sitting in Gateway. */}
          {arcGatewayBal > 0.01 && (
            <button
              onClick={addToBalance}
              disabled={busy || arcGatewayBal <= MOVE_FEE_BUFFER}
              className="w-full rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-fg transition hover:opacity-90 disabled:opacity-40"
            >
              {busy ? 'Working…' : `Add to balance · ${arcGatewayBal.toFixed(2)} USDC on Arc`}
            </button>
          )}
          {/* Consolidate off-Arc balance onto the Arc wallet, where it funds
              trades, pool deposits, and verifier stakes. */}
          <button
            onClick={() => setMode('movearc')}
            disabled={offArcTotal <= 0}
            className={`w-full rounded-lg px-3 py-2 text-sm font-medium transition disabled:opacity-40 ${
              arcGatewayBal > 0.01
                ? 'border border-line text-fg hover:border-line-strong'
                : 'bg-primary text-primary-fg hover:opacity-90'
            }`}
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
          onDeposited={(chainKey, chainName, amt) =>
            addGatewayDeposit(address, { chainKey, chainName, amountUsdc: amt, availableAtDeposit: availFor(chainKey) })
          }
          config={config}
          txFlow={txFlow}
          toast={toast}
          setBusy={setBusy}
          busy={busy}
        />
      )}

      {mode === 'movearc' && (
        <MoveToArc
          address={address}
          offArc={offArc}
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

      {showRecents && (
        <RecentDepositsOverlay deposits={deposits} isCredited={isCredited} onClose={() => setShowRecents(false)} />
      )}
    </div>
  );
}

// Overlay listing recent top-up deposits and whether each has credited yet.
// Portalled so it sits above the page without adding height to the card.
function RecentDepositsOverlay({
  deposits,
  isCredited,
  onClose,
}: {
  deposits: GatewayDeposit[];
  isCredited: (d: GatewayDeposit) => boolean;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-end justify-center px-4 py-4 sm:items-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div className="bz-frame relative w-full max-w-sm rounded-2xl border border-line bg-surface p-5 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-fg">Recent deposits</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1 text-muted hover:bg-surface-2 hover:text-fg">
            ×
          </button>
        </div>
        {deposits.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted">No recent deposits.</p>
        ) : (
          <ul className="divide-y divide-line/70">
            {deposits.map((d) => {
              const credited = isCredited(d);
              return (
                <li key={d.id} className="flex items-center gap-2.5 py-2.5">
                  <ChainLogo sourceKey={d.chainKey as ChainLogoKey} className="h-5 w-5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-fg">
                      <span className="font-mono">{d.amountUsdc.toFixed(2)}</span> USDC · {d.chainName}
                    </div>
                    <div className="text-[11px] text-muted">{timeAgo(d.ts)}</div>
                  </div>
                  {credited ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-primary/12 px-2 py-0.5 text-[11px] font-medium text-primary">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 6 9 17l-5-5" /></svg>
                      Credited
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-warn/12 px-2 py-0.5 text-[11px] font-medium text-warn">
                      <span className="relative flex h-1.5 w-1.5">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-warn opacity-70" />
                        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-warn" />
                      </span>
                      Confirming
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <p className="mt-3 text-[11px] leading-snug text-muted">
          Deposits credit your unified balance once they finalize on the source chain — a few minutes, up to ~15 on Ethereum.
        </p>
      </div>
    </div>,
    document.body,
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
  sources, onClose, onDone, onDeposited, config, txFlow, toast, setBusy, busy,
}: {
  sources: GatewaySource[];
  onClose: () => void;
  onDone: () => void;
  onDeposited: (chainKey: string, chainName: string, amountUsdc: number) => void;
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
        onDeposited(src.key, src.name, Number(amount)); // track as confirming until it credits
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

// ── Move to Arc: consolidate a chosen AMOUNT onto the Arc wallet ──
// The target is drawn greedily across the eligible chains (largest balance
// first), so e.g. "move 40" from balances of 20/15/15 pulls 20 + 15 + 5. Each
// contributing chain is one signature, run in sequence.
const MOVE_FEE_BUFFER = 0.11; // per-chain headroom for the Gateway maxFee (backend MAX_FEE=0.1)
type MoveStatus = 'idle' | 'running' | 'done' | 'error';
type Alloc = { key: string; name: string; amount: number };

// Max value movable out of one chain (balance minus the reserved fee).
const chainCap = (balanceUsdc: string) => Math.max(0, Number(balanceUsdc) - MOVE_FEE_BUFFER);

// Greedily allocate `target` across chains, biggest cap first.
function allocate(chains: UnifiedBalance['byChain'], target: number): { allocs: Alloc[]; shortfall: number } {
  const sorted = [...chains].sort((a, b) => chainCap(b.balanceUsdc) - chainCap(a.balanceUsdc));
  let remaining = target;
  const allocs: Alloc[] = [];
  for (const c of sorted) {
    if (remaining <= 1e-6) break;
    const cap = chainCap(c.balanceUsdc);
    if (cap <= 1e-6) continue;
    const take = Math.min(remaining, cap);
    allocs.push({ key: c.key, name: c.name, amount: take });
    remaining -= take;
  }
  return { allocs, shortfall: Math.max(0, remaining) };
}

function MoveToArc({
  address, offArc, onClose, onDone, signTypedDataAsync, toast, setBusy, busy,
}: {
  address: string;
  offArc: UnifiedBalance['byChain'];
  onClose: () => void;
  onDone: () => void;
  signTypedDataAsync: ReturnType<typeof useSignTypedData>['signTypedDataAsync'];
  toast: ReturnType<typeof useToast>;
  setBusy: (b: boolean) => void;
  busy: boolean;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(offArc.map((c) => c.key)));
  // Start empty so the user enters an amount - not a pre-filled sweep of everything.
  const [amount, setAmount] = useState<string>('');
  const [status, setStatus] = useState<Record<string, MoveStatus>>({});
  const [movedTotal, setMovedTotal] = useState<number | null>(null);

  const toggle = (k: string) =>
    setSelected((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  const selectedChains = offArc.filter((c) => selected.has(c.key));
  const maxMovable = selectedChains.reduce((s, c) => s + chainCap(c.balanceUsdc), 0);
  const amountNum = Number(amount) || 0;
  const { allocs, shortfall } = allocate(selectedChains, amountNum);
  const allocByKey = Object.fromEntries(allocs.map((a) => [a.key, a.amount]));
  const overCap = amountNum > maxMovable + 1e-6;

  const run = async () => {
    if (amountNum <= 0) { toast.error('Enter an amount.'); return; }
    if (overCap || shortfall > 1e-6) { toast.error(`Most you can move from the selected chains is ${maxMovable.toFixed(2)} USDC (a small fee is reserved per chain).`); return; }
    setBusy(true);
    let moved = 0;
    for (const a of allocs) {
      setStatus((s) => ({ ...s, [a.key]: 'running' }));
      try {
        const plan = await getWithdrawPlan(address, a.key, ARC_KEY, a.amount.toFixed(6));
        if (plan.needsMore) throw new Error(`short ${plan.shortfallUsdc} USDC`);
        const m = plan.typedData.message;
        const signature = (await signTypedDataAsync({
          domain: plan.typedData.domain,
          types: plan.typedData.types,
          primaryType: plan.typedData.primaryType,
          message: { maxBlockHeight: BigInt(m.maxBlockHeight), maxFee: BigInt(m.maxFee), spec: { ...m.spec, value: BigInt(m.spec.value as string) } },
        } as never)) as Hex;
        const res = await submitWithdraw(plan.typedData.message, signature);
        moved += Number(res.deliveredUsdc);
        setStatus((s) => ({ ...s, [a.key]: 'done' }));
        onDone();
      } catch (err) {
        setStatus((s) => ({ ...s, [a.key]: 'error' }));
        toast.error(`${a.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    setMovedTotal(moved);
    if (moved > 0) toast.success(`Moved ${moved.toFixed(2)} USDC to Arc.`);
    setBusy(false);
  };

  if (movedTotal !== null) {
    return (
      <div className="mt-4 rounded-lg border border-primary/40 bg-primary/20 p-3 text-sm">
        <p className="text-primary">✓ Moved <span className="font-medium">{movedTotal.toFixed(2)} USDC</span> to your Arc wallet — ready to fund bonds, pool, or verifier stakes.</p>
        <button onClick={onClose} className="mt-2 text-xs text-info hover:underline">Done</button>
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-3 rounded-lg border border-line bg-bg/40 p-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-fg">Move to Arc</p>
        {!busy && <CloseBtn onClick={onClose} />}
      </div>
      <p className="text-xs text-muted">
        Enter an amount — we draw it from your eligible chains (largest first). Each chain touched is one signature.
      </p>

      {/* Amount + Max */}
      <div className="flex items-end gap-2">
        <label className="flex flex-1 flex-col gap-1 text-xs text-muted">
          Amount (USDC)
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={busy}
            inputMode="decimal"
            className={`rounded-md border bg-bg px-2 py-1.5 text-sm text-fg ${overCap ? 'border-danger' : 'border-line'}`}
          />
        </label>
        <button
          type="button"
          onClick={() => setAmount(maxMovable.toFixed(2))}
          disabled={busy}
          className="rounded-md border border-line px-2.5 py-1.5 text-xs text-muted transition hover:text-fg"
        >
          Max {maxMovable.toFixed(2)}
        </button>
      </div>

      {/* Eligible chains + how much each contributes to the entered amount */}
      <ul className="space-y-1.5">
        {offArc.map((c) => {
          const st = status[c.key] ?? 'idle';
          const draw = allocByKey[c.key];
          return (
            <li key={c.key}>
              <label className={`flex cursor-pointer items-center gap-2.5 rounded-md border px-2.5 py-2 text-sm transition ${selected.has(c.key) ? 'border-primary bg-primary/10' : 'border-line hover:border-line-strong'}`}>
                <input
                  type="checkbox"
                  checked={selected.has(c.key)}
                  onChange={() => toggle(c.key)}
                  disabled={busy}
                  className="h-4 w-4 accent-primary"
                />
                <ChainLogo sourceKey={c.key as ChainLogoKey} className="h-4 w-4" />
                <span className="text-fg">{c.name}</span>
                <span className="ml-auto font-mono text-[11px] tabular-nums text-muted">{Number(c.balanceUsdc).toFixed(2)}</span>
                {draw ? <span className="font-mono text-[11px] tabular-nums text-primary">→ {draw.toFixed(2)}</span> : <span className="w-10" />}
                <MoveStatusIcon status={st} />
              </label>
            </li>
          );
        })}
      </ul>

      <button
        onClick={run}
        disabled={busy || amountNum <= 0 || overCap}
        className="w-full rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-fg transition hover:opacity-90 disabled:opacity-50"
      >
        {busy ? 'Moving…' : `Move ${amountNum > 0 ? amountNum.toFixed(2) : '0.00'} USDC to Arc${allocs.length > 1 ? ` · ${allocs.length} chains` : ''}`}
      </button>
      {overCap && <p className="text-[11px] text-danger">Max movable from the selected chains is {maxMovable.toFixed(2)} USDC (a small fee is reserved per chain).</p>}
      <p className="text-[11px] text-muted">A small Gateway fee (≈0.02 USDC) applies per chain touched.</p>
    </div>
  );
}

function MoveStatusIcon({ status }: { status: MoveStatus }) {
  if (status === 'running') return <span className="text-[11px] text-info">…</span>;
  if (status === 'done') return <span className="text-[11px] text-primary">✓</span>;
  if (status === 'error') return <span className="text-[11px] text-danger">✕</span>;
  return null;
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
