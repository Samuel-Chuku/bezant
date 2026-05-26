'use client';

import { useEffect, useState } from 'react';
import { useSigner } from '@/hooks/use-signer';
import { loadBridgeHistory, type BridgeHistoryEntry } from '@/lib/bridge-history';
import { shortHash } from '@/lib/format';
import { ChainLogo } from '@/components/chain-logo';
import { BRIDGE_STEP_LABELS, BRIDGE_STEP_ORDER, type BridgeStepName } from '@/lib/bridge';
import type { BridgeRun } from '@/lib/bridge-run';

// Right-column transaction feed. Shows a live row at the top while a run is
// in progress (with progress bar + per-step status), then falls back to the
// localStorage history (capped at 3) for completed/failed runs. The lifted
// `run` state lives in BridgePage so the form and this feed share it.
export function BridgeHistory({
  run,
  onResetRun,
}: {
  run: BridgeRun;
  onResetRun: () => void;
}) {
  const signer = useSigner();
  const [entries, setEntries] = useState<BridgeHistoryEntry[]>([]);

  useEffect(() => {
    if (!signer.isConnected) {
      setEntries([]);
      return;
    }
    setEntries(loadBridgeHistory(signer.address));
    const onFocus = () => {
      if (signer.isConnected) setEntries(loadBridgeHistory(signer.address));
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [signer.isConnected, signer.isConnected ? signer.address : null]);

  // When a run finishes, re-read history so the persisted row replaces the
  // live row without waiting for a focus event.
  useEffect(() => {
    if (!signer.isConnected) return;
    if (run.status === 'success' || run.status === 'error') {
      setEntries(loadBridgeHistory(signer.address));
    }
  }, [run.status, signer.isConnected, signer.isConnected ? signer.address : null]);

  if (!signer.isConnected) return null;

  const liveVisible = run.status === 'running';
  const recentEntries = liveVisible ? entries.slice(0, 2) : entries.slice(0, 3);
  const empty = !liveVisible && entries.length === 0;

  return (
    <section className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-6">
      <h2 className="text-lg font-medium text-neutral-100">Recent bridges</h2>
      <p className="mt-1.5 text-sm text-neutral-500">
        In-progress and recent runs from this browser.
      </p>

      {empty ? (
        <p className="mt-5 text-sm text-neutral-500">No recent bridges yet.</p>
      ) : (
        <ul className="mt-5 space-y-2.5">
          {liveVisible && <LiveRow run={run} onReset={onResetRun} />}
          {recentEntries.map((entry) => (
            <HistoryRow key={entry.id} entry={entry} />
          ))}
        </ul>
      )}
    </section>
  );
}

function LiveRow({ run, onReset }: { run: BridgeRun; onReset: () => void }) {
  const currentStep = currentRunningStep(run);
  return (
    <li className="rounded-lg border border-emerald-900/40 bg-emerald-950/10 p-3.5">
      <div className="flex items-start gap-3">
        {run.sourceKey && (
          <ChainLogo sourceKey={run.sourceKey} className="mt-0.5 h-8 w-8 flex-shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-base text-neutral-100">
            {run.amount} USDC · {run.sourceFullName} → {run.destinationFullName}
          </div>
          <div className="mt-0.5 text-xs text-emerald-300">
            {currentStep ? BRIDGE_STEP_LABELS[currentStep] : 'Starting…'}
          </div>
        </div>
        <span className="shrink-0 rounded-md bg-emerald-950/40 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-emerald-300">
          Live
        </span>
      </div>

      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-neutral-900">
        <div
          className="h-full bg-emerald-500 transition-all duration-500"
          style={{ width: `${computeProgress(run)}%` }}
        />
      </div>

      <div className="mt-2.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
        {BRIDGE_STEP_ORDER.map((name) => {
          const step = run.steps[name];
          const color =
            step?.state === 'success'
              ? 'text-emerald-400'
              : step?.state === 'error'
                ? 'text-red-400'
                : step?.state === 'pending'
                  ? 'text-amber-300'
                  : 'text-neutral-600';
          return (
            <span key={name} className={color}>
              {dotFor(step?.state)} {BRIDGE_STEP_LABELS[name].toLowerCase()}
            </span>
          );
        })}
      </div>

      {(run.status === 'success' || run.status === 'error') && (
        <button
          type="button"
          onClick={onReset}
          className="mt-2 text-xs text-neutral-500 hover:text-neutral-300"
        >
          Dismiss
        </button>
      )}
      {run.status === 'error' && run.errorMessage && (
        <p className="mt-1 text-xs text-red-400">{run.errorMessage}</p>
      )}
    </li>
  );
}

function HistoryRow({ entry }: { entry: BridgeHistoryEntry }) {
  const ok = entry.status === 'success';
  return (
    <li className="rounded-lg border border-neutral-800 bg-neutral-950/40 p-3.5">
      <div className="flex items-start gap-3">
        <ChainLogo sourceKey={entry.sourceKey} className="mt-0.5 h-8 w-8 flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-base text-neutral-100">
            {entry.amount} USDC · {entry.sourceFullName} → {entry.destinationFullName ?? 'Arc Testnet'}
          </div>
          <div className="mt-0.5 text-xs text-neutral-500">{relativeTime(entry.timestamp)}</div>
        </div>
        <span
          className={[
            'shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide',
            ok ? 'bg-emerald-950/40 text-emerald-300' : 'bg-red-950/40 text-red-300',
          ].join(' ')}
        >
          {ok ? 'Success' : 'Failed'}
        </span>
      </div>
      {entry.mintTxHash && entry.mintExplorerUrl && (
        <a
          href={entry.mintExplorerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1.5 inline-block font-mono text-[11px] text-neutral-500 hover:text-neutral-300"
        >
          Mint {shortHash(entry.mintTxHash)} ↗
        </a>
      )}
      {!ok && entry.errorMessage && (
        <p className="mt-1.5 text-xs text-red-400">{entry.errorMessage}</p>
      )}
    </li>
  );
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function computeProgress(run: BridgeRun): number {
  if (run.status === 'idle') return 0;
  const total = BRIDGE_STEP_ORDER.length;
  const done = BRIDGE_STEP_ORDER.filter((n) => run.steps[n]?.state === 'success').length;
  return Math.round((done / total) * 100);
}

function currentRunningStep(run: BridgeRun): BridgeStepName | null {
  for (const name of BRIDGE_STEP_ORDER) {
    const step = run.steps[name];
    if (!step || step.state === 'pending') return name;
    if (step.state === 'error') return name;
  }
  return null;
}

function dotFor(state?: string): string {
  if (state === 'success') return '✓';
  if (state === 'error') return '×';
  if (state === 'pending') return '●';
  return '○';
}
