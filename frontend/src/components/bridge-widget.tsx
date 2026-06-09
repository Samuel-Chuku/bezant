'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useAccount, useBalance, useChainId, useSwitchChain } from 'wagmi';
import { AppKit } from '@circle-fin/app-kit';
import { createAdapterFromProvider } from '@circle-fin/adapter-viem-v2';
import { useSigner } from '@/hooks/use-signer';
import { useRefreshChainData } from '@/hooks/use-refresh-chain-data';
import { ChainLogo } from '@/components/chain-logo';
import {
  BRIDGE_CHAINS,
  DEFAULT_DESTINATION_KEY,
  USDC_FAUCET_URL,
  chainByKey,
  type BridgeChain,
  type BridgeStepName,
} from '@/lib/bridge';
import { appendBridgeHistory } from '@/lib/bridge-history';
import { shortAddress, truncateBalance } from '@/lib/format';
import type { BridgeRun, StepState } from '@/lib/bridge-run';

// Any-to-any bridging across the chains in BRIDGE_CHAINS. Default destination
// is Arc — that's the focal chain. Source defaults to the wallet's current
// chain (or Ethereum Sepolia if it's not a supported source).
//
// Source = Arc is gated on Circle passkey wallet — injected wallets struggle
// with Arc's USDC-as-native gas model right now.
export function BridgeWidget({
  run,
  onRunChange,
  lockedAmount,
  lockToArc = false,
}: {
  run: BridgeRun;
  onRunChange: (updater: (prev: BridgeRun) => BridgeRun) => void;
  // "Fund this trade" mode: prefill the exact amount to bridge and fix the
  // destination to Arc, so the buyer only picks a source chain and clicks once.
  lockedAmount?: string;
  lockToArc?: boolean;
}) {
  const signer = useSigner();
  const wagmiChainId = useChainId();
  const { switchChain } = useSwitchChain();
  const { connector } = useAccount();
  const refreshChainData = useRefreshChainData();

  const [sourceKey, setSourceKey] = useState<BridgeChain['key']>('sepolia');
  const [destKey, setDestKey] = useState<BridgeChain['key']>(DEFAULT_DESTINATION_KEY);
  const [amount, setAmount] = useState(lockedAmount ?? '1.00');

  // Keep the prefilled amount in sync if it loads/changes (e.g. the deposit
  // estimate resolving on the trade page).
  useEffect(() => {
    if (lockedAmount && lockedAmount !== '0') setAmount(lockedAmount);
  }, [lockedAmount]);

  // Track the wallet's current chain only on first render so we don't reset
  // the user's manual source selection every time wagmi reports a switch.
  const initialSyncDone = useRef(false);
  useEffect(() => {
    if (initialSyncDone.current) return;
    if (!wagmiChainId) return;
    const match = BRIDGE_CHAINS.find((c) => c.wagmiChainId === wagmiChainId);
    if (match) setSourceKey(match.key);
    initialSyncDone.current = true;
  }, [wagmiChainId]);

  const source = useMemo(() => chainByKey(sourceKey), [sourceKey]);
  const destination = useMemo(() => chainByKey(destKey), [destKey]);

  const sourceHasWagmi = source.wagmiChainId !== undefined;
  const walletOnSourceChain = sourceHasWagmi && source.wagmiChainId === wagmiChainId;
  const userAddr = signer.isConnected ? signer.address : undefined;

  // Skip useBalance entirely for chains we can't query via wagmi (Solana, or
  // any chain we've flagged as coming soon).
  const balanceEnabled = !!userAddr && sourceHasWagmi && !source.comingSoon;
  const { data: sourceBalance } = useBalance({
    address: userAddr,
    token: source.usdcIsNative ? undefined : source.usdc,
    chainId: source.wagmiChainId,
    query: { enabled: balanceEnabled, refetchInterval: 15_000 },
  });

  // Outbound from a coming-soon chain (Solana, or Arc until the Modular
  // Wallet adapter ships) or inbound to a coming-soon chain blocks submit.
  // These take priority over wallet-mismatch messaging since the chain
  // itself isn't ready.
  const outboundComingSoon = source.outboundComingSoon;
  const destinationComingSoon = destination.comingSoon;

  // For supported sources, the user needs an injected wallet on the right
  // network. Once outbound-from-Arc ships, this gate will also accept
  // signer.mode === 'circle' for source = Arc.
  const walletMismatch =
    signer.isConnected &&
    !outboundComingSoon &&
    !destinationComingSoon &&
    signer.mode !== 'external';

  const sameChain = source.key === destination.key;

  if (!signer.isConnected) {
    return (
      <Shell>
        <p className="text-sm text-neutral-400">
          Connect a wallet to bridge USDC.
        </p>
      </Shell>
    );
  }

  const handleSelectSource = (next: BridgeChain) => {
    setSourceKey(next.key);
    if (next.key === destKey) {
      const alt = BRIDGE_CHAINS.find((c) => c.key !== next.key);
      if (alt) setDestKey(alt.key);
    }
    // Only prompt a wallet switch when the target chain is EVM and we have
    // an injected wallet to switch.
    if (
      signer.mode === 'external' &&
      next.wagmiChainId !== undefined &&
      next.wagmiChainId !== wagmiChainId
    ) {
      switchChain({ chainId: next.wagmiChainId });
    }
  };

  const handleSelectDestination = (next: BridgeChain) => {
    setDestKey(next.key);
    if (next.key === sourceKey) {
      const alt = BRIDGE_CHAINS.find((c) => c.key !== next.key);
      if (alt) setSourceKey(alt.key);
    }
  };

  const handleSwap = () => {
    setSourceKey(destKey);
    setDestKey(sourceKey);
    if (signer.mode === 'external') {
      const next = chainByKey(destKey);
      if (next.wagmiChainId !== undefined && next.wagmiChainId !== wagmiChainId) {
        switchChain({ chainId: next.wagmiChainId });
      }
    }
  };

  const handleMax = () => {
    if (sourceBalance) setAmount(truncateBalance(sourceBalance.formatted, 6));
  };

  const canSubmit =
    !sameChain &&
    !outboundComingSoon &&
    !destinationComingSoon &&
    !walletMismatch &&
    run.status !== 'running' &&
    walletOnSourceChain &&
    Number(amount) > 0 &&
    !!connector &&
    !!sourceBalance &&
    Number(amount) <= Number(sourceBalance.formatted);

  const handleBridge = async () => {
    if (!connector || !userAddr) return;
    if (signer.mode === 'external' && !walletOnSourceChain) return;
    onRunChange(() => ({
      status: 'running',
      steps: {},
      sourceKey: source.key,
      sourceFullName: source.fullName,
      destinationKey: destination.key,
      destinationFullName: destination.fullName,
      amount,
    }));
    try {
      const provider = await connector.getProvider();
      const adapter = await createAdapterFromProvider({
        provider: provider as Parameters<typeof createAdapterFromProvider>[0]['provider'],
      });

      const kit = new AppKit();
      const recordStep = (name: BridgeStepName) => (payload: { values: {
        state: StepState; txHash?: string; explorerUrl?: string; errorMessage?: string;
      } }) => {
        onRunChange((prev) => ({
          ...prev,
          steps: {
            ...prev.steps,
            [name]: {
              state: payload.values.state,
              txHash: payload.values.txHash,
              explorerUrl: payload.values.explorerUrl,
              errorMessage: payload.values.errorMessage,
            },
          },
        }));
        if (payload.values.state === 'success') refreshChainData();
      };
      kit.on('bridge.approve', recordStep('approve'));
      kit.on('bridge.burn', recordStep('burn'));
      kit.on('bridge.fetchAttestation', recordStep('fetchAttestation'));
      kit.on('bridge.mint', recordStep('mint'));

      const result = await kit.bridge({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        from: { adapter, chain: source.bridgeChain as any },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        to: { adapter, chain: destination.bridgeChain as any },
        amount,
      });

      const mintStep = result.steps.find((s) => s.name === 'mint');
      const errorStep = result.steps.find((s) => s.state === 'error');
      const finalStatus = result.state === 'success' ? 'success' : 'error';

      onRunChange((prev) => ({
        ...prev,
        status: finalStatus,
        errorMessage: finalStatus === 'error' ? errorStep?.errorMessage ?? 'Bridge failed' : undefined,
      }));

      appendBridgeHistory(userAddr, {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: Date.now(),
        sourceKey: source.key,
        sourceFullName: source.fullName,
        destinationKey: destination.key,
        destinationFullName: destination.fullName,
        amount,
        status: finalStatus,
        mintTxHash: mintStep?.txHash,
        mintExplorerUrl: mintStep?.explorerUrl,
        errorMessage: finalStatus === 'error' ? errorStep?.errorMessage : undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onRunChange((prev) => ({ ...prev, status: 'error', errorMessage: message }));
      refreshChainData();
      if (userAddr) {
        appendBridgeHistory(userAddr, {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          timestamp: Date.now(),
          sourceKey: source.key,
          sourceFullName: source.fullName,
          destinationKey: destination.key,
          destinationFullName: destination.fullName,
          amount,
          status: 'error',
          errorMessage: message,
        });
      }
    }
  };

  return (
    <Shell>
      {lockToArc ? (
        <div className="flex items-end gap-3">
          <div className="flex-1">
            <ChainPicker
              label="Bridge from"
              value={source}
              options={BRIDGE_CHAINS}
              excludeKey={destKey}
              balance={sourceBalance?.formatted}
              onSelect={handleSelectSource}
              disabled={run.status === 'running'}
            />
          </div>
          <div className="mb-3 text-sm text-neutral-400">→ {destination.shortName}</div>
        </div>
      ) : (
        <div className="grid grid-cols-[1fr_auto_1fr] items-stretch gap-2">
          <ChainPicker
            label="From"
            value={source}
            options={BRIDGE_CHAINS}
            excludeKey={destKey}
            balance={sourceBalance?.formatted}
            onSelect={handleSelectSource}
            disabled={run.status === 'running'}
          />
          <button
            type="button"
            onClick={handleSwap}
            disabled={run.status === 'running'}
            aria-label="Swap source and destination"
            title="Swap source and destination"
            className="mt-6 flex h-11 w-11 items-center justify-center self-center rounded-full border border-neutral-800 bg-neutral-950/60 text-neutral-400 transition hover:border-neutral-700 hover:text-neutral-200 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 3 4 7l4 4" />
              <path d="M4 7h16" />
              <path d="m16 21 4-4-4-4" />
              <path d="M20 17H4" />
            </svg>
          </button>
          <ChainPicker
            label="To"
            value={destination}
            options={BRIDGE_CHAINS}
            excludeKey={sourceKey}
            highlight={destination.key === DEFAULT_DESTINATION_KEY}
            onSelect={handleSelectDestination}
            disabled={run.status === 'running'}
          />
        </div>
      )}

      {sameChain && (
        <p className="mt-3 text-sm text-amber-400">
          Source and destination can&apos;t be the same chain.
        </p>
      )}

      {!sameChain && outboundComingSoon && (
        <div className="mt-4 rounded-lg border border-amber-900/50 bg-amber-950/30 px-3.5 py-2.5 text-sm text-amber-300">
          Bridging out of {source.shortName} is coming soon. For now you can only bridge into Arc.
        </div>
      )}

      {!sameChain && !outboundComingSoon && destinationComingSoon && (
        <div className="mt-4 rounded-lg border border-amber-900/50 bg-amber-950/30 px-3.5 py-2.5 text-sm text-amber-300">
          {destination.shortName} support is coming soon. Pick a different destination for now.
        </div>
      )}

      {!sameChain && !outboundComingSoon && !destinationComingSoon && walletMismatch && (
        <div className="mt-4 rounded-lg border border-amber-900/50 bg-amber-950/30 px-3.5 py-2.5 text-sm text-amber-300">
          Bridging into {destination.shortName} needs an injected wallet (MetaMask, Rabby)
          holding USDC on {source.fullName}.
        </div>
      )}

      {!sameChain && !outboundComingSoon && !destinationComingSoon && !walletMismatch && signer.mode === 'external' && !walletOnSourceChain && (
        <p className="mt-3 text-sm text-amber-400">
          Your wallet is on a different network. Click {source.fullName} to switch.
        </p>
      )}

      {!source.arcOnly && !source.comingSoon && (
        <div className="mt-4 flex flex-wrap gap-x-3.5 gap-y-1 text-xs text-neutral-500">
          <a
            href={source.gasFaucetUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-neutral-300"
          >
            Get {source.gasSymbol} for gas ↗
          </a>
          <span aria-hidden>·</span>
          <a
            href={USDC_FAUCET_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-neutral-300"
          >
            Get test USDC ↗
          </a>
        </div>
      )}

      <div className="mt-6">
        <div className="flex items-center justify-between text-[13px] uppercase tracking-wide text-neutral-500">
          <span>{lockedAmount ? 'Amount needed' : 'Amount'}</span>
          {!lockedAmount && sourceBalance && Number(sourceBalance.formatted) > 0 && (
            <button
              type="button"
              onClick={handleMax}
              disabled={run.status === 'running'}
              className="text-[13px] uppercase tracking-wide text-emerald-400 hover:text-emerald-300 disabled:opacity-50"
            >
              Max
            </button>
          )}
        </div>
        <div className="mt-2.5 flex items-center rounded-lg border border-neutral-800 bg-neutral-950/40 focus-within:border-neutral-600">
          <input
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={run.status === 'running' || !!lockedAmount}
            placeholder="0.00"
            className="flex-1 bg-transparent px-3.5 py-3 text-lg text-neutral-100 placeholder:text-neutral-700 focus:outline-none disabled:opacity-70"
          />
          <span className="pr-3.5 text-sm text-neutral-500">USDC</span>
        </div>
      </div>

      <p className="mt-3.5 text-sm text-neutral-500">
        Receives on {destination.shortName} as{' '}
        <span className="font-mono text-neutral-300">{shortAddress(signer.address)}</span>
      </p>

      <button
        type="button"
        disabled={!canSubmit}
        onClick={handleBridge}
        className="mt-5 w-full rounded-lg bg-neutral-100 px-4 py-3 text-base font-medium text-neutral-950 transition hover:bg-white disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
      >
        {run.status === 'running'
          ? 'Bridging…'
          : outboundComingSoon || destinationComingSoon
            ? 'Coming soon'
            : `Bridge ${source.shortName} → ${destination.shortName}`}
      </button>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-7">{children}</section>
  );
}

function ChainPicker({
  label,
  value,
  options,
  excludeKey,
  balance,
  highlight,
  disabled,
  onSelect,
}: {
  label: string;
  value: BridgeChain;
  options: BridgeChain[];
  excludeKey: BridgeChain['key'];
  balance?: string;
  highlight?: boolean;
  disabled?: boolean;
  onSelect: (next: BridgeChain) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <div className="mb-1.5 text-[11px] uppercase tracking-wide text-neutral-500">{label}</div>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={[
          'flex w-full items-center gap-3 rounded-xl border bg-neutral-950/40 p-3.5 text-left transition',
          highlight
            ? 'border-emerald-500/40 bg-emerald-950/20 hover:border-emerald-400/60'
            : 'border-neutral-800 hover:border-neutral-700',
          disabled ? 'cursor-not-allowed opacity-60' : '',
        ].join(' ')}
      >
        <ChainLogo sourceKey={value.key} className="h-10 w-10 flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-base text-neutral-100">{value.shortName}</div>
          <div className="truncate text-[11px] text-neutral-500">
            {value.comingSoon
              ? 'Coming soon'
              : balance !== undefined
                ? `${truncateBalance(balance, 2)} USDC`
                : value.fullName}
          </div>
        </div>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" className="text-neutral-500" aria-hidden>
          <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 right-0 z-20 mt-1.5 overflow-hidden rounded-xl border border-neutral-800 bg-neutral-950 shadow-xl">
          {options.map((opt) => {
            const isDisabled = opt.key === excludeKey;
            const isActive = opt.key === value.key;
            return (
              <button
                key={opt.key}
                type="button"
                disabled={isDisabled}
                onClick={() => {
                  onSelect(opt);
                  setOpen(false);
                }}
                className={[
                  'flex w-full items-center gap-3 px-3.5 py-2.5 text-left text-base transition',
                  isActive ? 'bg-neutral-900 text-neutral-100' : 'text-neutral-200',
                  isDisabled
                    ? 'cursor-not-allowed opacity-40'
                    : 'hover:bg-neutral-900',
                ].join(' ')}
              >
                <ChainLogo sourceKey={opt.key} className="h-7 w-7 flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="truncate">{opt.shortName}</div>
                  <div className="truncate text-[11px] text-neutral-500">{opt.fullName}</div>
                </div>
                {opt.arcOnly && (
                  <span className="rounded bg-emerald-950/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-emerald-300">
                    home
                  </span>
                )}
                {opt.comingSoon && (
                  <span className="rounded bg-amber-950/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-300">
                    soon
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
