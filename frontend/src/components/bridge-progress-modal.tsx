'use client';

// Step-by-step bridge progress, shown while a CCTP bridge runs (and after).
// Reads the shared BridgeRun the widget updates, so it reflects approve → burn →
// attestation → mint live. `tail` lets the caller append a follow-on message
// (e.g. "funding your trade…") once the bridge succeeds.
import type { ReactNode } from 'react';
import { BRIDGE_STEP_ORDER, BRIDGE_STEP_LABELS } from '@/lib/bridge';
import type { BridgeRun, StepState } from '@/lib/bridge-run';
import { ExternalLinkIcon } from '@/components/external-link-icon';

export function BridgeProgressModal({ run, onClose, tail }: { run: BridgeRun; onClose: () => void; tail?: ReactNode }) {
  if (run.status === 'idle') return null;
  const running = run.status === 'running';

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => (running ? undefined : onClose())} />
      <div className="bz-frame relative w-full max-w-sm overflow-hidden rounded-2xl border border-line bg-bg shadow-2xl">
        <span className="bz-livebar" aria-hidden />
        <div className="border-b border-line px-5 py-3.5">
          <p className="text-sm font-medium text-fg">
            {run.status === 'success' ? 'Bridge complete' : run.status === 'error' ? 'Bridge failed' : `Bridging ${run.amount} USDC`}
          </p>
          <p className="mt-0.5 text-xs text-muted">
            {run.sourceFullName} → {run.destinationFullName}
          </p>
        </div>

        {run.status === 'success' ? (
          <div className="px-5 py-8 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-primary/15 text-primary">
              <svg className="h-7 w-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <p className="font-mono text-3xl font-semibold tabular-nums text-fg">
              {run.amount} <span className="text-base font-normal text-muted">USDC</span>
            </p>
            <p className="mt-1.5 text-sm text-muted">arrived on {run.destinationFullName}</p>
            {tail && <div className="mt-4 text-sm text-primary">{tail}</div>}
          </div>
        ) : (
          <>
            <ol className="space-y-2.5 px-5 py-4">
              {BRIDGE_STEP_ORDER.map((name) => {
                const step = run.steps[name];
                const state: StepState | 'upcoming' = step?.state ?? 'upcoming';
                return (
                  <li key={name} className="flex items-center justify-between gap-3 text-sm">
                    <span className="flex items-center gap-2.5">
                      <StepIcon state={state} />
                      <span className={LABEL_COLOR[state]}>{BRIDGE_STEP_LABELS[name]}</span>
                    </span>
                    {step?.explorerUrl && (
                      <a href={step.explorerUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-info hover:text-info">
                        tx <ExternalLinkIcon />
                      </a>
                    )}
                  </li>
                );
              })}
            </ol>

            <div className="px-5 pb-2 text-center text-xs">
              {running && <span className="text-muted">This can take a couple of minutes - keep this open.</span>}
              {run.status === 'error' && <span className="text-danger">{run.errorMessage ?? 'Bridge failed.'}</span>}
            </div>
          </>
        )}

        <div className="border-t border-line px-5 py-3.5">
          <button
            onClick={onClose}
            disabled={running}
            className="w-full rounded-lg border border-line px-4 py-2 text-sm text-fg hover:text-fg disabled:opacity-50"
          >
            {running ? 'Bridging…' : 'Close'}
          </button>
        </div>
      </div>
    </div>
  );
}

const LABEL_COLOR: Record<StepState | 'upcoming', string> = {
  success: 'text-fg',
  pending: 'text-info',
  error: 'text-danger',
  noop: 'text-muted line-through',
  upcoming: 'text-muted',
};

function StepIcon({ state }: { state: StepState | 'upcoming' }) {
  if (state === 'success') {
    return (
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/15 text-primary">
        <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      </span>
    );
  }
  if (state === 'error') {
    return (
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-danger/15 text-danger">
        <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6 6 18" />
        </svg>
      </span>
    );
  }
  if (state === 'pending') {
    return (
      <span className="flex h-5 w-5 items-center justify-center text-info">
        <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden>
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" className="opacity-20" />
          <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        </svg>
      </span>
    );
  }
  return <span className="flex h-5 w-5 items-center justify-center"><span className="h-2 w-2 rounded-full border border-line-strong" /></span>;
}
