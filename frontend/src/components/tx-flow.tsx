'use client';

// Multi-step "Actions" transaction modal (Spark/Aave-style): one modal showing
// amount, a before→after overview, and numbered steps - each with its OWN action
// button on the right. Steps unlock in order (later buttons stay disabled until
// earlier ones complete); a failed step's button becomes "Try again". Callers
// drive it via useTxFlow().start({...}); each step's `run` should send its tx
// with signer.sendCall(..., { review: false }) so this modal owns the review.
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { UsdcIcon } from '@/components/usdc-icon';

export type OverviewRow = { label: string; before: string; after: string };
export type FlowStep = {
  key: string;
  label: string; // descriptive ("Approve USDC")
  action: string; // button verb ("Approve")
  run: () => Promise<void>;
  icon?: ReactNode; // small glyph shown in the row
};
export type TxFlowSpec = {
  title: string;
  amountUsdc?: string;
  overview?: OverviewRow[];
  steps: FlowStep[];
};

type StepState = 'upcoming' | 'active' | 'done' | 'error';

type TxFlowApi = { start: (spec: TxFlowSpec) => Promise<boolean> };

const Ctx = createContext<TxFlowApi | null>(null);

export function useTxFlow(): TxFlowApi {
  return useContext(Ctx) ?? { start: async () => false };
}

export function TxFlowProvider({ children }: { children: ReactNode }) {
  const [spec, setSpec] = useState<TxFlowSpec | null>(null);
  const [states, setStates] = useState<StepState[]>([]);
  const [runningIndex, setRunningIndex] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const running = runningIndex !== null;
  const allDone = states.length > 0 && states.every((s) => s === 'done');
  // First step that isn't done yet - the only one whose button is live.
  const currentIndex = states.findIndex((s) => s !== 'done');

  const close = useCallback((ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setSpec(null);
  }, []);

  const runStep = useCallback(
    async (i: number) => {
      if (!spec) return;
      setErrorMsg(null);
      setRunningIndex(i);
      setStates((prev) => prev.map((s, idx) => (idx === i ? 'active' : s)));
      try {
        await spec.steps[i].run();
        setRunningIndex(null);
        setStates((prev) => {
          const next = prev.map((s, idx) => (idx === i ? ('done' as StepState) : s));
          if (next.every((s) => s === 'done')) {
            resolver.current?.(true);
            resolver.current = null;
          }
          return next;
        });
      } catch (err) {
        setRunningIndex(null);
        setStates((prev) => prev.map((s, idx) => (idx === i ? 'error' : s)));
        setErrorMsg(err instanceof Error ? err.message : String(err));
      }
    },
    [spec],
  );

  const api = useMemo<TxFlowApi>(
    () => ({
      start: (s) =>
        new Promise<boolean>((resolve) => {
          resolver.current?.(false);
          resolver.current = resolve;
          setSpec(s);
          setStates(s.steps.map(() => 'upcoming'));
          setRunningIndex(null);
          setErrorMsg(null);
        }),
    }),
    [],
  );

  return (
    <Ctx.Provider value={api}>
      {children}
      {spec && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => (running ? undefined : close(allDone))} />
          <div className="bz-frame relative w-full max-w-2xl overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl">
            <span className="bz-livebar" aria-hidden />
            {/* Header */}
            <div className="flex items-center justify-between border-b border-line px-6 py-4">
              <h2 className="text-lg font-semibold text-fg">{spec.title}</h2>
              {!running && (
                <button onClick={() => close(allDone)} aria-label="Close" className="text-muted hover:text-fg">
                  <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6 6 18" />
                  </svg>
                </button>
              )}
            </div>

            <div className="space-y-6 px-6 py-6">
              {/* Amount */}
              {spec.amountUsdc && (
                <section>
                  <div className="text-sm text-muted">Amount</div>
                  <div className="mt-2 flex items-center gap-3 rounded-xl border border-line bg-surface-2 px-4 py-4">
                    <span className="flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5">
                      <UsdcIcon className="h-5 w-5" />
                      <span className="text-sm font-medium text-fg">USDC</span>
                    </span>
                    <div className="ml-auto text-right">
                      <div className="text-2xl font-semibold tracking-tight text-fg">{spec.amountUsdc}</div>
                      <div className="text-xs text-muted">≈ ${spec.amountUsdc}</div>
                    </div>
                  </div>
                </section>
              )}

              {/* Transaction overview */}
              {spec.overview && spec.overview.length > 0 && (
                <section>
                  <div className="text-sm text-muted">Transaction overview</div>
                  <dl className="mt-2 divide-y divide-line overflow-hidden rounded-xl border border-line">
                    {spec.overview.map((row) => (
                      <div key={row.label} className="flex items-center justify-between gap-3 bg-surface-2 px-4 py-3.5 text-sm">
                        <dt className="text-muted">{row.label}</dt>
                        <dd className="flex items-center gap-2 text-fg">
                          <span className="text-muted">{row.before}</span>
                          <svg className="h-3.5 w-3.5 text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M13 6l6 6-6 6" />
                          </svg>
                          <span className="font-medium">{row.after}</span>
                        </dd>
                      </div>
                    ))}
                  </dl>
                </section>
              )}

              {/* Actions */}
              <section>
                <div className="text-sm text-muted">Actions</div>
                <ol className="mt-2 divide-y divide-line overflow-hidden rounded-xl border border-line">
                  {spec.steps.map((step, i) => {
                    const state = states[i];
                    const isCurrent = i === currentIndex;
                    return (
                      <li key={step.key} className="flex items-center gap-3 bg-surface-2 px-4 py-4">
                        <StepBadge index={i + 1} state={state} />
                        {step.icon && <span className="text-muted">{step.icon}</span>}
                        <UsdcIcon className="h-5 w-5" />
                        <div className="min-w-0">
                          <p className={state === 'upcoming' ? 'text-sm text-muted' : 'text-sm font-medium text-fg'}>{step.label}</p>
                          {state === 'error' && errorMsg && <p className="mt-0.5 text-xs text-danger">{errorMsg}</p>}
                        </div>
                        <div className="ml-auto">
                          <StepButton
                            state={state}
                            action={step.action}
                            enabled={isCurrent && !running}
                            running={running && runningIndex === i}
                            onClick={() => runStep(i)}
                          />
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </section>
            </div>

            {allDone && (
              <div className="border-t border-line px-6 py-4">
                <button onClick={() => close(true)} className="w-full rounded-xl border border-line px-4 py-3 text-sm font-medium text-fg transition hover:border-line-strong">
                  Done
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}

function StepButton({ state, action, enabled, running, onClick }: { state: StepState; action: string; enabled: boolean; running: boolean; onClick: () => void }) {
  if (state === 'done') {
    return <span className="text-sm font-medium text-primary">Done</span>;
  }
  if (running) {
    return (
      <span className="inline-flex items-center gap-2 rounded-lg bg-surface px-4 py-2 text-sm text-muted">
        <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden>
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" className="opacity-20" />
          <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
        Signing…
      </span>
    );
  }
  if (state === 'error') {
    return (
      <button onClick={onClick} className="rounded-lg bg-gradient-to-b from-primary-hover to-primary px-4 py-2 text-sm font-semibold text-primary-fg shadow-md shadow-primary/20 transition hover:brightness-110">
        Try again
      </button>
    );
  }
  return (
    <button
      onClick={onClick}
      disabled={!enabled}
      className={
        enabled
          ? 'rounded-lg bg-gradient-to-b from-primary-hover to-primary px-4 py-2 text-sm font-semibold text-primary-fg shadow-md shadow-primary/20 transition hover:brightness-110'
          : 'cursor-not-allowed rounded-lg border border-line bg-surface px-4 py-2 text-sm text-muted'
      }
    >
      {action}
    </button>
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
          <circle cx="12" cy="12" r="9" strokeWidth="2" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v5M12 16.5v.5" />
        </svg>
      </span>
    );
  }
  return (
    <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md border text-xs font-medium ${state === 'active' ? 'border-primary/40 bg-primary-soft text-primary' : 'border-line text-muted'}`}>
      {index}
    </span>
  );
}
