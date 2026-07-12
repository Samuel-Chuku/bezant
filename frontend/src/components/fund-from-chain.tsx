'use client';

// "Fund this bond from another chain?" — two Circle-branded options for getting
// USDC onto the buyer's Arc wallet: CCTP Bridge (burn-and-mint) or Unified
// Balance (Circle Gateway, EOA-only). Shared by the create + trade-detail pages.
import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { BridgeWidget } from '@/components/bridge-widget';
import { GatewayFundOption } from '@/components/gateway-fund-option';
import { PoweredByCircle } from '@/components/powered-by-circle';
import { getUnifiedBalance } from '@/lib/api';
import { INITIAL_RUN, type BridgeRun } from '@/lib/bridge-run';

export function FundFromChain({
  address,
  signerMode,
  lockedAmount,
  bridgeRun: bridgeRunProp,
  onBridgeRunChange,
}: {
  address: string;
  signerMode: 'external' | 'circle' | null;
  lockedAmount?: string;
  // When provided (trade-detail page), the BridgeWidget writes to the caller's
  // bridge-run state so its auto-fund + progress modal still work. Otherwise
  // (create page) an internal run is used.
  bridgeRun?: BridgeRun;
  onBridgeRunChange?: Dispatch<SetStateAction<BridgeRun>>;
}) {
  const [fundVia, setFundVia] = useState<'none' | 'bridge' | 'gateway'>('none');
  const [localRun, setLocalRun] = useState<BridgeRun>(INITIAL_RUN);
  const bridgeRun = bridgeRunProp ?? localRun;
  const setBridgeRun = onBridgeRunChange ?? setLocalRun;

  // Surface the unified balance up front when the (EOA) buyer already has one,
  // so "fund from unified balance" is the first thing they see rather than being
  // buried under the bridge toggle. Gateway is EOA-only, so gate on that.
  const [unifiedTotal, setUnifiedTotal] = useState(0);
  useEffect(() => {
    if (signerMode !== 'external' || !address) return;
    let live = true;
    getUnifiedBalance(address)
      .then((b) => live && setUnifiedTotal(Number(b.totalUsdc) || 0))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [address, signerMode]);
  const hasUnified = signerMode === 'external' && unifiedTotal > 0;

  return (
    <div className="space-y-3">
      {hasUnified ? (
        <>
          {/* Primary path - the buyer already holds a unified balance. */}
          <div className="rounded-xl border border-primary/40 bg-primary/5 p-3">
            <button
              type="button"
              onClick={() => setFundVia((v) => (v === 'gateway' ? 'none' : 'gateway'))}
              className="flex w-full items-center justify-between gap-3 text-left"
            >
              <span>
                <span className="block text-sm font-medium text-fg">Fund from your unified balance</span>
                <span className="block text-xs text-muted">
                  {unifiedTotal.toFixed(2)} USDC available across chains · Circle Gateway
                </span>
              </span>
              <span className="shrink-0 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-fg">
                {fundVia === 'gateway' ? 'Hide' : 'Use it →'}
              </span>
            </button>
            {fundVia === 'gateway' && (
              <div className="mt-3 border-t border-primary/20 pt-3">
                <GatewayFundOption address={address} defaultAmount={lockedAmount} />
                <PoweredByCircle product="Gateway" />
              </div>
            )}
          </div>

          {/* Secondary - bring USDC over via the CCTP bridge instead. */}
          <div>
            <button onClick={() => setFundVia((v) => (v === 'bridge' ? 'none' : 'bridge'))} className="text-sm text-info hover:underline">
              {fundVia === 'bridge' ? 'Hide' : 'Or bring USDC from another chain (CCTP)?'}
            </button>
            {fundVia === 'bridge' && (
              <div className="mt-3 rounded-xl border border-line bg-bg/40 p-3">
                <BridgeWidget run={bridgeRun} onRunChange={setBridgeRun} lockedAmount={lockedAmount} lockToArc />
                <PoweredByCircle product="CCTP" />
              </div>
            )}
          </div>
        </>
      ) : (
        /* No unified balance yet (or passkey wallet) - the original two-card chooser. */
        <>
          <button onClick={() => setFundVia((v) => (v === 'none' ? 'bridge' : 'none'))} className="text-sm text-info hover:underline">
            {fundVia !== 'none' ? 'Hide' : 'Fund this bond from another chain?'}
          </button>
          {fundVia !== 'none' && (
            <div className="mt-3 space-y-3 rounded-xl border border-line bg-bg/40 p-3">
              <p className="text-xs text-muted">
                Get USDC onto your Arc wallet so it&apos;s ready to fund{lockedAmount ? ` (${lockedAmount} USDC needed)` : ''}.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <FundCard
                  active={fundVia === 'bridge'}
                  onClick={() => setFundVia('bridge')}
                  title="CCTP Bridge"
                  desc="Burn-and-mint USDC from another chain to your Arc wallet."
                  product="CCTP"
                />
                {signerMode === 'external' && (
                  <FundCard
                    active={fundVia === 'gateway'}
                    onClick={() => setFundVia('gateway')}
                    title="Unified Balance"
                    desc="Route from your Circle Gateway balance held across chains."
                    product="Gateway"
                  />
                )}
              </div>
              {fundVia === 'bridge' && (
                <BridgeWidget run={bridgeRun} onRunChange={setBridgeRun} lockedAmount={lockedAmount} lockToArc />
              )}
              {fundVia === 'gateway' && signerMode === 'external' && (
                <GatewayFundOption address={address} defaultAmount={lockedAmount} />
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function FundCard({
  active, onClick, title, desc, product,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  desc: string;
  product: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-xl border px-4 py-3.5 text-left transition ${
        active ? 'border-primary bg-surface text-fg' : 'border-line text-muted hover:border-line-strong'
      }`}
    >
      <div className="text-sm font-medium text-fg">{title}</div>
      <div className="mt-1 text-xs text-muted">{desc}</div>
      <PoweredByCircle product={product} />
    </button>
  );
}
