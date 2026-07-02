'use client';

import { useState } from 'react';
import { BridgeWidget } from '@/components/bridge-widget';
import { BridgeHistory } from '@/components/bridge-history';
import { BridgeBalancesPanel } from '@/components/bridge-balances-panel';
import { INITIAL_RUN, type BridgeRun } from '@/lib/bridge-run';

export default function BridgePage() {
  // Single source of truth for an in-progress run - read by the form
  // (left → middle column) and the recent-bridges feed (right column).
  const [run, setRun] = useState<BridgeRun>(INITIAL_RUN);

  return (
    <main className="mx-auto max-w-[1400px] px-6 py-12">
      <header className="mb-10">
        <h1 className="font-display text-4xl font-semibold tracking-tight">Bridge to Arc</h1>
        <p className="mt-3 text-base text-muted">
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

      {/* "Powered by Circle" band (Circle CCTP powers the bridge) between the
          cards and the footer. Width sized ~65% so its height reads calmer. */}
      <section className="mt-20 border-t border-line pt-12">
        <div className="text-center text-base font-semibold uppercase tracking-[0.4em] text-muted">Powered by</div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/circle-logo-2021.svg" alt="Circle" className="circle-mark mx-auto mt-6 w-full max-w-[900px]" />
      </section>
    </main>
  );
}
