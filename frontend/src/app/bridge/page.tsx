'use client';

import { BridgeWidget } from '@/components/bridge-widget';
import { BridgeHistory } from '@/components/bridge-history';

export default function BridgePage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <header className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight">Bridge to Arc</h1>
        <p className="mt-2 text-sm text-neutral-400">
          Move USDC from any supported CCTP V2 testnet into Arc. Pick a source,
          switch your wallet, and sign the burn — Circle&apos;s relayer mints on Arc.
        </p>
      </header>

      <BridgeWidget />

      <div className="mt-8">
        <BridgeHistory />
      </div>
    </main>
  );
}
