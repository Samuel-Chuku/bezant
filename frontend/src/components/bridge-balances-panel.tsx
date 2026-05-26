'use client';

import type { Address } from 'viem';
import { useBalance } from 'wagmi';
import { useSigner } from '@/hooks/use-signer';
import { BRIDGE_CHAINS, type BridgeChain } from '@/lib/bridge';
import { truncateBalance } from '@/lib/format';
import { ChainLogo } from '@/components/chain-logo';

// Static (non-draggable) left-column balances panel. Lists every chain in
// BRIDGE_CHAINS so users can see Arc + the 4 CCTP sources at a glance.
export function BridgeBalancesPanel() {
  const signer = useSigner();
  if (!signer.isConnected) return null;

  return (
    <aside className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-6 shadow-sm">
      <div>
        <h2 className="text-lg font-medium text-neutral-100">
          Your USDC balances across chains
        </h2>
        <p className="mt-1.5 text-sm text-neutral-500">
          Live, polled every 15s. Click a row in the bridge to switch into it.
        </p>
      </div>

      <ul className="mt-5 space-y-2">
        {BRIDGE_CHAINS.map((chain) => (
          <BalanceRow key={chain.key} chain={chain} address={signer.address} />
        ))}
      </ul>
    </aside>
  );
}

function BalanceRow({ chain, address }: { chain: BridgeChain; address: Address }) {
  const { data, isLoading } = useBalance({
    address,
    chainId: chain.wagmiChainId,
    token: chain.usdcIsNative ? undefined : chain.usdc,
    query: { refetchInterval: 15_000 },
  });
  const formatted = isLoading ? '…' : data ? truncateBalance(data.formatted, 2) : '0';
  const has = !!data && Number(data.formatted) > 0;
  const isArc = chain.arcOnly;

  return (
    <li
      className={[
        'flex items-center gap-3 rounded-lg px-3.5 py-3',
        isArc
          ? 'border border-emerald-900/40 bg-emerald-950/20'
          : 'hover:bg-neutral-900/60',
      ].join(' ')}
    >
      <ChainLogo sourceKey={chain.key} className="h-9 w-9 flex-shrink-0" />
      <div className="min-w-0 flex-1">
        <div className={`truncate text-base ${isArc ? 'text-emerald-300' : 'text-neutral-200'}`}>
          {chain.fullName}
        </div>
        <div className="text-[11px] text-neutral-500">
          {isArc ? 'home chain' : `CCTP domain ${chain.cctpDomain}`}
        </div>
      </div>
      <div className={`text-right font-mono text-base ${has ? 'text-neutral-100' : 'text-neutral-600'}`}>
        {formatted} <span className="text-[11px] text-neutral-500">USDC</span>
      </div>
    </li>
  );
}
