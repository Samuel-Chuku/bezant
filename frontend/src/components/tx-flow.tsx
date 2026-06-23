'use client';

// Multi-step "Actions" transaction modal (Aave-style): one modal that shows the
// whole flow — amount, a before→after overview, and numbered steps (e.g. Approve
// → Lock deposit) with per-step status and Try Again on failure. Callers drive it
// via useTxFlow().start({...}); each step's `run` should send its tx with
// signer.sendCall(..., { review: false }) so this modal owns the review.
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

export type OverviewRow = { label: string; before: string; after: string };
export type FlowStep = { key: string; label: string; run: () => Promise<void> };
export type TxFlowSpec = {
  title: string;
  amountUsdc?: string;
  overview?: OverviewRow[];
  steps: FlowStep[];
};

type StepState = 'upcoming' | 'active' | 'done' | 'error';
type Phase = 'review' | 'running' | 'error' | 'done';

type TxFlowApi = { start: (spec: TxFlowSpec) => Promise<boolean> };

const Ctx = createContext<TxFlowApi | null>(null);

export function useTxFlow(): TxFlowApi {
  return useContext(Ctx) ?? { start: async () => false };
}

export function TxFlowProvider({ children }: { children: ReactNode }) {
  const [spec, setSpec] = useState<TxFlowSpec | null>(null);
  const [phase, setPhase] = useState<Phase>('review');
  const [states, setStates] = useState<StepState[]>([]);
  const [errorAt, setErrorAt] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const close = useCallback((ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setSpec(null);
  }, []);

  const runFrom = useCallback(
    async (start: number, s: TxFlowSpec) => {
      setPhase('running');
      setErrorAt(null);
      setErrorMsg(null);
      for (let i = start; i < s.steps.length; i++) {
        setStates((prev) => prev.map((st, idx) => (idx === i ? 'active' : st)));
        try {
          await s.steps[i].run();
          setStates((prev) => prev.map((st, idx) => (idx === i ? 'done' : st)));
        } catch (err) {
          setStates((prev) => prev.map((st, idx) => (idx === i ? 'error' : st)));
          setErrorAt(i);
          setErrorMsg(err instanceof Error ? err.message : String(err));
          setPhase('error');
          return;
        }
      }
      setPhase('done');
      resolver.current?.(true);
      resolver.current = null;
    },
    [],
  );

  const api = useMemo<TxFlowApi>(
    () => ({
      start: (s) =>
        new Promise<boolean>((resolve) => {
          resolver.current?.(false); // settle any orphan
          resolver.current = resolve;
          setSpec(s);
          setStates(s.steps.map(() => 'upcoming'));
          setErrorAt(null);
          setErrorMsg(null);
          setPhase('review');
        }),
    }),
    [],
  );

  const running = phase === 'running';

  return (
    <Ctx.Provider value={api}>
      {children}
      {spec && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => (running ? undefined : close(phase === 'done'))} />
          <div className="relative w-full max-w-md overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-line px-5 py-4">
              <h2 className="text-base font-semibold text-fg">{spec.title}</h2>
              {!running && (
                <button onClick={() => close(phase === 'done')} aria-label="Close" className="text-muted hover:text-fg">
                  <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6 6 18" />
                  </svg>
                </button>
              )}
            </div>

            <div className="space-y-5 px-5 py-5">
              {/* Amount */}
              {spec.amountUsdc && (
                <div>
                  <div className="text-xs uppercase tracking-wide text-muted">Amount</div>
                  <div className="mt-1.5 flex items-baseline gap-2 rounded-xl border border-line bg-surface-2 px-4 py-3">
                    <span className="text-2xl font-semibold tracking-tight text-fg">{spec.amountUsdc}</span>
                    <span className="text-sm text-muted">USDC</span>
                    <span className="ml-auto text-xs text-muted">≈ ${spec.amountUsdc}</span>
                  </div>
                </div>
              )}

              {/* Transaction overview */}
              {spec.overview && spec.overview.length > 0 && (
                <div>
                  <div className="text-xs uppercase tracking-wide text-muted">Transaction overview</div>
                  <dl className="mt-1.5 space-y-2 rounded-xl border border-line bg-surface-2 px-4 py-3 text-sm">
                    {spec.overview.map((row) => (
                      <div key={row.label} className="flex items-center justify-between gap-3">
                        <dt className="text-muted">{row.label}</dt>
                        <dd className="flex items-center gap-1.5 text-fg">
                          <span className="text-muted">{row.before}</span>
                          <svg className="h-3.5 w-3.5 text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M13 6l6 6-6 6" />
                          </svg>
                          <span className="font-medium">{row.after}</span>
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}

              {/* Actions / steps */}
              <div>
                <div className="text-xs uppercase tracking-wide text-muted">Actions</div>
                <ol className="mt-1.5 divide-y divide-line overflow-hidden rounded-xl border border-line">
                  {spec.steps.map((step, i) => (
                    <li key={step.key} className="flex items-center gap-3 bg-surface-2 px-4 py-3">
                      <StepBadge index={i + 1} state={states[i]} />
                      <div className="min-w-0">
                        <p className={states[i] === 'upcoming' ? 'text-sm text-muted' : 'text-sm text-fg'}>{step.label}</p>
                        {states[i] === 'error' && errorAt === i && <p className="mt-0.5 text-xs text-danger">{errorMsg ?? 'Failed.'}</p>}
                        {states[i] === 'active' && <p className="mt-0.5 text-xs text-info">Awaiting signature…</p>}
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
            </div>

            {/* Footer */}
            <div className="border-t border-line px-5 py-4">
              {phase === 'review' && spec && (
                <button onClick={() => void runFrom(0, spec)} className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-fg transition hover:bg-primary-hover">
                  Confirm
                </button>
              )}
              {running && (
                <button disabled className="w-full rounded-lg bg-surface-2 px-4 py-2.5 text-sm text-muted">Signing…</button>
              )}
              {phase === 'error' && spec && errorAt !== null && (
                <button onClick={() => void runFrom(errorAt, spec)} className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-fg transition hover:bg-primary-hover">
                  Try again
                </button>
              )}
              {phase === 'done' && (
                <button onClick={() => close(true)} className="w-full rounded-lg border border-line px-4 py-2.5 text-sm text-fg transition hover:border-line-strong">
                  Done
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}

function StepBadge({ index, state }: { index: number; state: StepState }) {
  if (state === 'done') {
    return (
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary-soft text-primary">
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      </span>
    );
  }
  if (state === 'error') {
    return (
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-danger-soft text-danger">
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v5M12 16.5v.5" />
          <circle cx="12" cy="12" r="9" strokeWidth="2" />
        </svg>
      </span>
    );
  }
  if (state === 'active') {
    return (
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary-soft text-primary">
        <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden>
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" className="opacity-20" />
          <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
      </span>
    );
  }
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-line text-xs font-medium text-muted">{index}</span>
  );
}
