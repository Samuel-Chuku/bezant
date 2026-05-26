'use client';

import { useState } from 'react';
import { BridgeWidget } from '@/components/bridge-widget';
import { BridgeHistory } from '@/components/bridge-history';
import { BridgeBalancesPanel } from '@/components/bridge-balances-panel';
import { INITIAL_RUN, type BridgeRun } from '@/lib/bridge-run';

export default function BridgePage() {
  // Single source of truth for an in-progress run — read by the form
  // (left → middle column) and the recent-bridges feed (right column).
  const [run, setRun] = useState<BridgeRun>(INITIAL_RUN);

  return (
    <main className="mx-auto max-w-[1400px] px-6 py-12">
      <header className="mb-10">
        <h1 className="text-4xl font-semibold tracking-tight">Bridge to Arc</h1>
        <p className="mt-3 text-base text-neutral-400">
          Move USDC across CCTP V2 testnets. Arc is the default destination.
          Flip the chips to bridge any direction.
        </p>
      </header>

      <div className="grid gap-7 lg:grid-cols-[370px_minmax(0,1fr)_390px]">
        <aside>
          <BridgeBalancesPanel />
        </aside>

        <div>
          <BridgeWidget run={run} onRunChange={setRun} />
        </div>

        <aside>
          <BridgeHistory run={run} onResetRun={() => setRun(INITIAL_RUN)} />
        </aside>
      </div>
    </main>
  );
}
