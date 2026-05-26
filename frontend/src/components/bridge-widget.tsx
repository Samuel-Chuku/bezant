'use client';

import { useMemo, useState } from 'react';
import type { Address } from 'viem';
import { useAccount, useBalance, useChainId, useSwitchChain } from 'wagmi';
import { AppKit } from '@circle-fin/app-kit';
import { createAdapterFromProvider } from '@circle-fin/adapter-viem-v2';
import { useSigner } from '@/hooks/use-signer';
import { useRefreshChainData } from '@/hooks/use-refresh-chain-data';
import {
  BRIDGE_DESTINATION,
  BRIDGE_SOURCES,
  BRIDGE_STEP_LABELS,
  BRIDGE_STEP_ORDER,
  USDC_FAUCET_URL,
  type BridgeSource,
  type BridgeStepName,
} from '@/lib/bridge';
import { appendBridgeHistory } from '@/lib/bridge-history';
import { shortAddress, shortHash, truncateBalance } from '@/lib/format';

type StepState = 'pending' | 'success' | 'error' | 'noop';

type StepStatus = {
  state: StepState;
  txHash?: string;
  explorerUrl?: string;
  errorMessage?: string;
};

type BridgeRun = {
  status: 'idle' | 'running' | 'success' | 'error';
  steps: Partial<Record<BridgeStepName, StepStatus>>;
  errorMessage?: string;
};

const INITIAL_RUN: BridgeRun = { status: 'idle', steps: {} };

// Per-chain visual data lives here (not in lib/bridge.ts) since it's pure
// presentation. Keyed by BridgeSource['key'].
const CHAIN_VISUAL: Record<BridgeSource['key'], { brand: string; initial: string }> = {
  sepolia: { brand: '#627EEA', initial: 'E' },
  optimismSepolia: { brand: '#FF0420', initial: 'O' },
  arbitrumSepolia: { brand: '#28A0F0', initial: 'A' },
  baseSepolia: { brand: '#0052FF', initial: 'B' },
};

export function BridgeWidget() {
  const signer = useSigner();
  const wagmiChainId = useChainId();
  const { switchChain } = useSwitchChain();
  const { connector } = useAccount();

  const [selectedKey, setSelectedKey] = useState<BridgeSource['key']>(BRIDGE_SOURCES[0].key);
  const [amount, setAmount] = useState('1.00');
  const [run, setRun] = useState<BridgeRun>(INITIAL_RUN);
  const refreshChainData = useRefreshChainData();

  const activeSource = useMemo<BridgeSource>(() => {
    const byWallet = BRIDGE_SOURCES.find((s) => s.wagmiChainId === wagmiChainId);
    return byWallet ?? BRIDGE_SOURCES.find((s) => s.key === selectedKey) ?? BRIDGE_SOURCES[0];
  }, [wagmiChainId, selectedKey]);

  const walletOnActiveChain = activeSource.wagmiChainId === wagmiChainId;
  const userAddr = signer.isConnected ? signer.address : undefined;

  const { data: activeBalance } = useBalance({
    address: userAddr,
    token: activeSource.usdc,
    chainId: activeSource.wagmiChainId,
    // 15s polling so balance reflects the post-burn drop without a reload.
    query: { enabled: !!userAddr, refetchInterval: 15_000 },
  });

  if (!signer.isConnected) {
    return (
      <Shell>
        <p className="text-sm text-neutral-400">
          Connect a wallet to bridge USDC into Arc from another testnet.
        </p>
      </Shell>
    );
  }
  if (signer.mode === 'circle') {
    return (
      <Shell>
        <p className="text-sm text-neutral-300">
          Bridging in needs a wallet that holds USDC on another chain. Your
          passkey account only exists on Arc.
        </p>
        <p className="mt-2 text-xs text-neutral-500">
          Connect MetaMask or Rabby with funds on Sepolia, Base Sepolia, OP
          Sepolia, or Arbitrum Sepolia.
        </p>
      </Shell>
    );
  }

  const canSubmit =
    run.status !== 'running' &&
    walletOnActiveChain &&
    Number(amount) > 0 &&
    !!connector &&
    !!activeBalance &&
    Number(amount) <= Number(activeBalance.formatted);

  const handleSelect = (source: BridgeSource) => {
    setSelectedKey(source.key);
    if (source.wagmiChainId !== wagmiChainId) {
      switchChain({ chainId: source.wagmiChainId });
    }
  };

  const handleMax = () => {
    if (activeBalance) setAmount(truncateBalance(activeBalance.formatted, 6));
  };

  const handleBridge = async () => {
    if (!connector || !walletOnActiveChain || !userAddr) return;
    setRun({ status: 'running', steps: {} });
    try {
      const provider = await connector.getProvider();
      const adapter = await createAdapterFromProvider({
        provider: provider as Parameters<typeof createAdapterFromProvider>[0]['provider'],
      });

      const kit = new AppKit();
      const recordStep = (name: BridgeStepName) => (payload: { values: {
        state: StepState; txHash?: string; explorerUrl?: string; errorMessage?: string;
      } }) => {
        setRun((prev) => ({
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
        // Refresh on each step success so source balance drops the moment
        // the burn confirms (not 15s later), then destination balance rises
        // the moment the mint confirms.
        if (payload.values.state === 'success') refreshChainData();
      };
      kit.on('bridge.approve', recordStep('approve'));
      kit.on('bridge.burn', recordStep('burn'));
      kit.on('bridge.fetchAttestation', recordStep('fetchAttestation'));
      kit.on('bridge.mint', recordStep('mint'));

      const result = await kit.bridge({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        from: { adapter, chain: activeSource.bridgeChain as any },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        to: { adapter, chain: BRIDGE_DESTINATION as any },
        amount,
      });

      const mintStep = result.steps.find((s) => s.name === 'mint');
      const errorStep = result.steps.find((s) => s.state === 'error');
      const finalStatus = result.state === 'success' ? 'success' : 'error';

      setRun((prev) => ({
        ...prev,
        status: finalStatus,
        errorMessage: finalStatus === 'error' ? errorStep?.errorMessage ?? 'Bridge failed' : undefined,
      }));

      // Persist to localStorage history (capped at 3). We save both
      // success and error rows so the user can see recent attempts.
      appendBridgeHistory(userAddr, {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: Date.now(),
        sourceKey: activeSource.key,
        sourceFullName: activeSource.fullName,
        amount,
        status: finalStatus,
        mintTxHash: mintStep?.txHash,
        mintExplorerUrl: mintStep?.explorerUrl,
        errorMessage: finalStatus === 'error' ? errorStep?.errorMessage : undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setRun((prev) => ({ ...prev, status: 'error', errorMessage: message }));
      // A failed bridge may still have burned on the source chain before
      // throwing — refresh so the dropped source balance is reflected.
      refreshChainData();
      if (userAddr) {
        appendBridgeHistory(userAddr, {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          timestamp: Date.now(),
          sourceKey: activeSource.key,
          sourceFullName: activeSource.fullName,
          amount,
          status: 'error',
          errorMessage: message,
        });
      }
    }
  };

  return (
    <Shell>
      <div>
        <div className="text-xs uppercase tracking-wide text-neutral-500">Source chain</div>
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {BRIDGE_SOURCES.map((source) => (
            <ChainCard
              key={source.key}
              source={source}
              address={userAddr}
              active={activeSource.key === source.key}
              disabled={run.status === 'running'}
              onSelect={handleSelect}
            />
          ))}
        </div>
        {!walletOnActiveChain && (
          <p className="mt-2 text-xs text-amber-400">
            Your wallet is on a different network. Click {activeSource.fullName} to switch.
          </p>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-neutral-500">
        <a
          href={activeSource.gasFaucetUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-neutral-300"
        >
          Get {activeSource.gasSymbol} for gas ↗
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

      <div className="mt-5">
        <div className="flex items-center justify-between text-xs uppercase tracking-wide text-neutral-500">
          <span>Amount</span>
          {activeBalance && Number(activeBalance.formatted) > 0 && (
            <button
              type="button"
              onClick={handleMax}
              disabled={run.status === 'running'}
              className="text-xs uppercase tracking-wide text-emerald-400 hover:text-emerald-300 disabled:opacity-50"
            >
              Max
            </button>
          )}
        </div>
        <div className="mt-2 flex items-center rounded-lg border border-neutral-800 bg-neutral-950/40 focus-within:border-neutral-600">
          <input
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={run.status === 'running'}
            placeholder="0.00"
            className="flex-1 bg-transparent px-3 py-2.5 text-base text-neutral-100 placeholder:text-neutral-700 focus:outline-none disabled:opacity-50"
          />
          <span className="pr-3 text-xs text-neutral-500">USDC</span>
        </div>
      </div>

      <p className="mt-3 text-xs text-neutral-500">
        Bridges to Arc as{' '}
        <span className="font-mono text-neutral-300">{shortAddress(signer.address)}</span>
      </p>

      <button
        type="button"
        disabled={!canSubmit}
        onClick={handleBridge}
        className="mt-4 w-full rounded-lg bg-neutral-100 px-4 py-2.5 text-sm font-medium text-neutral-950 transition hover:bg-white disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
      >
        {run.status === 'running' ? 'Bridging…' : `Bridge from ${activeSource.fullName}`}
      </button>

      {run.status !== 'idle' && (
        <div className="mt-5 border-t border-neutral-800 pt-4">
          <div className="mb-3 h-1.5 w-full overflow-hidden rounded-full bg-neutral-900">
            <div
              className={`h-full transition-all duration-500 ${
                run.status === 'error' ? 'bg-red-500' : 'bg-emerald-500'
              }`}
              style={{ width: `${computeProgress(run)}%` }}
            />
          </div>
          <ul className="space-y-1.5">
            {BRIDGE_STEP_ORDER.map((name) => {
              const step = run.steps[name];
              return (
                <li key={name} className="flex items-start gap-2 text-xs">
                  <StepIcon state={step?.state} running={run.status === 'running' && !step} />
                  <div className="flex-1">
                    <div className="text-neutral-200">{BRIDGE_STEP_LABELS[name]}</div>
                    {step?.txHash && step.explorerUrl && (
                      <a
                        href={step.explorerUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono text-[10px] text-neutral-500 hover:text-neutral-300"
                      >
                        {shortHash(step.txHash)} ↗
                      </a>
                    )}
                    {step?.state === 'error' && step.errorMessage && (
                      <div className="text-[11px] text-red-400">{step.errorMessage}</div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          {run.status === 'success' && (
            <p className="mt-3 text-xs text-emerald-400">Done. USDC should land on Arc shortly.</p>
          )}
          {run.status === 'error' && run.errorMessage && (
            <p className="mt-3 text-xs text-red-400">{run.errorMessage}</p>
          )}
          {(run.status === 'success' || run.status === 'error') && (
            <button
              type="button"
              onClick={() => setRun(INITIAL_RUN)}
              className="mt-3 text-xs text-neutral-500 hover:text-neutral-300"
            >
              Reset
            </button>
          )}
        </div>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-6">{children}</section>
  );
}

function ChainCard({
  source,
  address,
  active,
  disabled,
  onSelect,
}: {
  source: BridgeSource;
  address: Address | undefined;
  active: boolean;
  disabled: boolean;
  onSelect: (s: BridgeSource) => void;
}) {
  const { data: balance, isLoading } = useBalance({
    address,
    token: source.usdc,
    chainId: source.wagmiChainId,
    query: { enabled: !!address, refetchInterval: 15_000 },
  });

  const balanceText = isLoading ? '…' : balance ? truncateBalance(balance.formatted, 2) : '0';
  const hasBalance = !!balance && Number(balance.formatted) > 0;
  const visual = CHAIN_VISUAL[source.key];

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onSelect(source)}
      className={[
        'flex items-center gap-3 rounded-xl border bg-neutral-950/40 p-3 text-left transition',
        active
          ? 'border-l-2 border-l-emerald-500 border-y-neutral-800 border-r-neutral-800 bg-emerald-950/20'
          : 'border-neutral-800 hover:border-neutral-700',
        disabled ? 'cursor-not-allowed opacity-60' : '',
      ].join(' ')}
    >
      {/* Ringed circle icon — brand color as the ring only, not a solid
          fill. Distinguishes our cards from the reference design. */}
      <div
        className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full border-2 bg-neutral-950 text-xs font-semibold text-neutral-100"
        style={{ borderColor: visual.brand }}
      >
        {visual.initial}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-neutral-100">{source.shortName}</div>
        <div className="text-[10px] text-neutral-500">Sepolia · CCTP domain {source.cctpDomain}</div>
      </div>
      <div className={`text-right font-mono text-xs ${hasBalance ? 'text-neutral-200' : 'text-neutral-600'}`}>
        {balanceText}
        <span className="ml-1 text-neutral-500">USDC</span>
      </div>
    </button>
  );
}

function StepIcon({ state, running }: { state?: StepState; running: boolean }) {
  if (state === 'success') return <span className="mt-[2px] text-emerald-400">✓</span>;
  if (state === 'error') return <span className="mt-[2px] text-red-400">×</span>;
  if (state === 'pending' || running) {
    return (
      <span className="mt-[5px] inline-block h-2 w-2 animate-pulse rounded-full bg-amber-400" />
    );
  }
  return <span className="mt-[5px] inline-block h-2 w-2 rounded-full border border-neutral-700" />;
}

function computeProgress(run: BridgeRun): number {
  if (run.status === 'idle') return 0;
  const total = BRIDGE_STEP_ORDER.length;
  const done = BRIDGE_STEP_ORDER.filter((n) => run.steps[n]?.state === 'success').length;
  return Math.round((done / total) * 100);
}
