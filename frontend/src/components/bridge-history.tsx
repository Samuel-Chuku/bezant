'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSigner } from '@/hooks/use-signer';
import { loadBridgeHistory, type BridgeHistoryEntry } from '@/lib/bridge-history';
import { shortHash } from '@/lib/format';
import { ChainLogo } from '@/components/chain-logo';
import { ExternalLinkIcon } from '@/components/external-link-icon';
import {
  BRIDGE_STEP_LABELS,
  BRIDGE_STEP_ORDER,
  chainByCctpDomain,
  type BridgeChain,
  type BridgeStepName,
} from '@/lib/bridge';
import type { BridgeRun } from '@/lib/bridge-run';
import { getBridgeHistory, type BridgeHistoryRow as BackendRow } from '@/lib/api';
import { CHAIN_REFRESH_EVENT } from '@/hooks/use-refresh-chain-data';
import { arcExplorerTxUrl } from '@/lib/explorers';

// Right-column transaction feed. Three layered sources:
//   1. Live run state - what the user is doing right now (lifted from page).
//   2. Backend GET /bridge/history/:address - authoritative for inbound
//      CCTP arrivals; survives browser clears, syncs across devices.
//   3. localStorage history - outbound bridges (backend doesn't watch off-Arc
//      mints) and very recent inbound that the indexer hasn't caught yet.
// Backend + localStorage merge by tx hash; backend wins on amount + timestamp,
// localStorage contributes source/destination metadata when present.
const BACKEND_POLL_MS = 30_000;

type MergedRow = {
  txHash: string;
  amount: string;
  sourceKey: BridgeChain['key'] | null;
  sourceLabel: string;
  destinationLabel: string;
  status: 'success' | 'error';
  timestampMs: number;
  mintTxHash?: string;
  mintExplorerUrl?: string;
  errorMessage?: string;
};

export function BridgeHistory({
  run,
  onResetRun,
}: {
  run: BridgeRun;
  onResetRun: () => void;
}) {
  const signer = useSigner();
  const [local, setLocal] = useState<BridgeHistoryEntry[]>([]);
  const [backend, setBackend] = useState<BackendRow[]>([]);

  // Reload localStorage on signer change + on focus + when a run finishes.
  useEffect(() => {
    if (!signer.isConnected) {
      setLocal([]);
      return;
    }
    setLocal(loadBridgeHistory(signer.address));
    const onFocus = () => {
      if (signer.isConnected) setLocal(loadBridgeHistory(signer.address));
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [signer.isConnected, signer.isConnected ? signer.address : null]);

  useEffect(() => {
    if (!signer.isConnected) return;
    if (run.status === 'success' || run.status === 'error') {
      setLocal(loadBridgeHistory(signer.address));
    }
  }, [run.status, signer.isConnected, signer.isConnected ? signer.address : null]);

  // Fetch + poll the backend's authoritative inbound history. Refetched on
  // tx-settle so a fresh bridge lands within seconds of the indexer catching
  // up (10s poll interval on the indexer side).
  const fetchBackend = useCallback(async () => {
    if (!signer.isConnected) {
      setBackend([]);
      return;
    }
    try {
      const data = await getBridgeHistory(signer.address, { limit: 20 });
      setBackend(data.history);
    } catch {
      // Silently swallow - the localStorage fallback keeps the panel useful.
    }
  }, [signer.isConnected, signer.isConnected ? signer.address : null]);

  useEffect(() => {
    void fetchBackend();
    if (!signer.isConnected) return;
    const id = setInterval(() => void fetchBackend(), BACKEND_POLL_MS);
    const onChainRefresh = () => {
      void fetchBackend();
      // Indexer hasn't necessarily seen the new block when the wallet receipt
      // arrives - try again at +3s and +8s.
      const t1 = setTimeout(() => void fetchBackend(), 3_000);
      const t2 = setTimeout(() => void fetchBackend(), 8_000);
      return () => {
        clearTimeout(t1);
        clearTimeout(t2);
      };
    };
    window.addEventListener(CHAIN_REFRESH_EVENT, onChainRefresh);
    return () => {
      clearInterval(id);
      window.removeEventListener(CHAIN_REFRESH_EVENT, onChainRefresh);
    };
  }, [signer.isConnected, fetchBackend]);

  if (!signer.isConnected) return null;

  const merged = mergeRows(local, backend);
  const liveVisible = run.status === 'running';
  const cap = liveVisible ? 4 : 5;
  const visible = merged.slice(0, cap);
  const empty = !liveVisible && visible.length === 0;

  return (
    <section className="rounded-2xl border border-line bg-surface/40 p-6">
      <h2 className="text-lg font-medium text-fg">Recent bridges</h2>
      <p className="mt-1.5 text-sm text-muted">
        Inbound arrivals are indexed server-side and survive browser clears.
        Outbound runs are remembered locally.
      </p>

      {empty ? (
        <p className="mt-5 text-sm text-muted">No recent bridges yet.</p>
      ) : (
        <ul className="mt-5 space-y-2.5">
          {liveVisible && <LiveRow run={run} onReset={onResetRun} />}
          {visible.map((row) => (
            <HistoryRow key={`${row.txHash}:${row.timestampMs}`} row={row} />
          ))}
        </ul>
      )}
    </section>
  );
}

function mergeRows(local: BridgeHistoryEntry[], backend: BackendRow[]): MergedRow[] {
  const byTx = new Map<string, MergedRow>();

  // Seed from backend - authoritative for inbound, but lacks source-chain
  // metadata when sourceDomain doesn't resolve to a chain we model.
  for (const r of backend) {
    const tx = r.txHash.toLowerCase();
    const chain =
      r.sourceDomain != null ? chainByCctpDomain(r.sourceDomain) : null;
    byTx.set(tx, {
      txHash: tx,
      amount: r.amount.usdc,
      sourceKey: chain?.key ?? null,
      sourceLabel:
        chain?.fullName ??
        (r.sourceDomain != null
          ? `Unknown chain (CCTP ${r.sourceDomain})`
          : 'Unknown source'),
      destinationLabel: 'Arc Testnet',
      status: 'success',
      timestampMs: new Date(r.indexedAt).getTime(),
      mintTxHash: r.txHash,
      mintExplorerUrl: arcExplorerTxUrl(r.txHash),
    });
  }

  // Layer localStorage on top - both as a fallback when backend hasn't yet
  // seen a fresh inbound, and as the sole source for outbound bridges +
  // failed runs (which never produced a mint event).
  for (const r of local) {
    const tx = (r.mintTxHash ?? `local:${r.id}`).toLowerCase();
    const existing = byTx.get(tx);
    if (existing) {
      // Backend already has it - enrich with localStorage's source/dest
      // metadata since the user knows which chains they picked.
      existing.sourceKey = r.sourceKey;
      existing.sourceLabel = r.sourceFullName;
      existing.destinationLabel = r.destinationFullName ?? 'Arc Testnet';
      continue;
    }
    byTx.set(tx, {
      txHash: tx,
      amount: r.amount,
      sourceKey: r.sourceKey,
      sourceLabel: r.sourceFullName,
      destinationLabel: r.destinationFullName ?? 'Arc Testnet',
      status: r.status,
      timestampMs: r.timestamp,
      mintTxHash: r.mintTxHash,
      mintExplorerUrl: r.mintExplorerUrl,
      errorMessage: r.errorMessage,
    });
  }

  return Array.from(byTx.values()).sort((a, b) => b.timestampMs - a.timestampMs);
}

function LiveRow({ run, onReset }: { run: BridgeRun; onReset: () => void }) {
  const currentStep = currentRunningStep(run);
  return (
    <li className="rounded-lg border border-primary/40 bg-primary/10 p-3.5">
      <div className="flex items-start gap-3">
        {run.sourceKey && (
          <ChainLogo sourceKey={run.sourceKey} className="mt-0.5 h-8 w-8 flex-shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-base text-fg">
            {run.amount} USDC · {run.sourceFullName} → {run.destinationFullName}
          </div>
          <div className="mt-0.5 text-xs text-primary">
            {currentStep ? BRIDGE_STEP_LABELS[currentStep] : 'Starting…'}
          </div>
        </div>
        <span className="shrink-0 rounded-md bg-primary/12 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-primary">
          Live
        </span>
      </div>

      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-surface">
        <div
          className="h-full bg-primary transition-all duration-500"
          style={{ width: `${computeProgress(run)}%` }}
        />
      </div>

      <div className="mt-2.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
        {BRIDGE_STEP_ORDER.map((name) => {
          const step = run.steps[name];
          const color =
            step?.state === 'success'
              ? 'text-primary'
              : step?.state === 'error'
                ? 'text-danger'
                : step?.state === 'pending'
                  ? 'text-warn'
                  : 'text-muted';
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
          className="mt-2 text-xs text-muted hover:text-fg"
        >
          Dismiss
        </button>
      )}
      {run.status === 'error' && run.errorMessage && (
        <p className="mt-1 text-xs text-danger">{run.errorMessage}</p>
      )}
    </li>
  );
}

function HistoryRow({ row }: { row: MergedRow }) {
  const ok = row.status === 'success';
  return (
    <li className="rounded-lg border border-line bg-bg/40 p-3.5">
      <div className="flex items-start gap-3">
        {row.sourceKey ? (
          <ChainLogo sourceKey={row.sourceKey} className="mt-0.5 h-8 w-8 flex-shrink-0" />
        ) : (
          <div className="mt-0.5 h-8 w-8 flex-shrink-0 rounded-full border border-line" />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-base text-fg">
            {row.amount} USDC · {row.sourceLabel} → {row.destinationLabel}
          </div>
          <div className="mt-0.5 text-xs text-muted">{relativeTime(row.timestampMs)}</div>
        </div>
        <span
          className={[
            'shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide',
            ok ? 'bg-primary/12 text-primary' : 'bg-danger/12 text-danger',
          ].join(' ')}
        >
          {ok ? 'Success' : 'Failed'}
        </span>
      </div>
      {row.mintTxHash && row.mintExplorerUrl && (
        <a
          href={row.mintExplorerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1.5 inline-flex items-center gap-1 font-mono text-[11px] text-muted hover:text-fg"
        >
          Mint {shortHash(row.mintTxHash)} <ExternalLinkIcon />
        </a>
      )}
      {!ok && row.errorMessage && (
        <p className="mt-1.5 text-xs text-danger">{row.errorMessage}</p>
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
