'use client';

import type { Address } from 'viem';
import Link from 'next/link';
import { useBalance } from 'wagmi';
import { BRIDGE_CHAINS, type BridgeChain } from '@/lib/bridge';
import { truncateBalance } from '@/lib/format';
import { ChainLogo } from '@/components/chain-logo';

// Dashboard card: the user's USDC balance on every chain in BRIDGE_CHAINS
// (Arc + the CCTP sources), with chain logos. Polled every 15s.
export function ChainBalancesCard({ address }: { address: Address }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-6">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-brand">USDC across chains</div>
        <Link href="/bridge" className="text-xs text-muted hover:text-fg">
          Bridge ›
        </Link>
      </div>
      <ul className="mt-4 space-y-1">
        {BRIDGE_CHAINS.map((chain) => (
          <BalanceRow key={chain.key} chain={chain} address={address} />
        ))}
      </ul>
    </div>
  );
}

function BalanceRow({ chain, address }: { chain: BridgeChain; address: Address }) {
  // Solana is non-EVM and comingSoon chains shouldn't render a live balance.
  const wagmiQueryable = chain.wagmiChainId !== undefined && !chain.comingSoon;
  const { data, isLoading } = useBalance({
    address,
    chainId: chain.wagmiChainId,
    token: chain.usdcIsNative ? undefined : chain.usdc,
    query: { enabled: wagmiQueryable, refetchInterval: 15_000 },
  });
  const formatted = isLoading ? '…' : data ? truncateBalance(data.formatted, 2) : '0';
  const has = !!data && Number(data.formatted) > 0;
  const isArc = chain.arcOnly;

  return (
    <li className={`flex items-center gap-3 rounded-lg px-2 py-2 ${isArc ? 'bg-primary/10' : ''}`}>
      <ChainLogo sourceKey={chain.key} className="h-7 w-7 flex-shrink-0" />
      <div className="min-w-0 flex-1">
        <div className={`truncate text-sm ${isArc ? 'text-primary' : 'text-fg'}`}>{chain.fullName}</div>
        {isArc && <div className="text-[10px] text-muted">home chain</div>}
      </div>
      {chain.comingSoon ? (
        <span className="rounded bg-warn/12 px-2 py-0.5 text-[10px] uppercase tracking-wide text-warn">Soon</span>
      ) : (
        <div className={`text-right font-mono text-sm tabular-nums ${has ? 'text-fg' : 'text-muted'}`}>
          {formatted} <span className="text-[10px] text-muted">USDC</span>
        </div>
      )}
    </li>
  );
}
