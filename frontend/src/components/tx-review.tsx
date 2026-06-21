'use client';

// Pre-sign transaction review — a single global modal that shows what the user
// is about to sign (action, amount, network, contract), drives the signature,
// and reflects submission/confirmation. Every on-chain action flows through it
// because useSigner.sendCall calls begin()/submitted()/confirmed()/failed().
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { ExternalLinkIcon } from '@/components/external-link-icon';
import type { TxReviewMeta } from '@/lib/tx-decode';

type Phase = 'review' | 'signing' | 'submitted' | 'confirmed' | 'failed';

type TxReviewApi = {
  begin: (meta: TxReviewMeta) => Promise<boolean>;
  signing: () => void;
  submitted: (txHash: string, txUrl: string) => void;
  confirmed: () => void;
  failed: (message: string) => void;
};

const Ctx = createContext<TxReviewApi | null>(null);

// Safe to call without a provider (returns no-op approvals) so useSigner never
// crashes if the tree changes — but the provider is mounted app-wide.
export function useTxReview(): TxReviewApi {
  return (
    useContext(Ctx) ?? {
      begin: async () => true,
      signing: () => {},
      submitted: () => {},
      confirmed: () => {},
      failed: () => {},
    }
  );
}

function short(addr?: string) {
  return addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : '';
}

export function TxReviewProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>('review');
  const [meta, setMeta] = useState<TxReviewMeta | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [txUrl, setTxUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearCloseTimer = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  const close = useCallback(() => {
    clearCloseTimer();
    setOpen(false);
    resolver.current = null;
  }, []);

  const api = useMemo<TxReviewApi>(
    () => ({
      begin: (m) =>
        new Promise<boolean>((resolve) => {
          // A previous tx's auto-close could still be pending (multi-step flows
          // like approve→deposit); cancel it so it can't close THIS modal, and
          // settle any orphaned resolver.
          clearCloseTimer();
          resolver.current?.(false);
          resolver.current = resolve;
          setMeta(m);
          setError(null);
          setTxHash(null);
          setTxUrl(null);
          setPhase('review');
          setOpen(true);
        }),
      signing: () => setPhase('signing'),
      submitted: (hash, url) => {
        setTxHash(hash);
        setTxUrl(url);
        setPhase('submitted');
      },
      confirmed: () => {
        setPhase('confirmed');
        clearCloseTimer();
        closeTimer.current = setTimeout(() => {
          setOpen(false);
          closeTimer.current = null;
        }, 1600);
      },
      failed: (message) => {
        clearCloseTimer();
        setError(message);
        setPhase('failed');
      },
    }),
    [],
  );

  const onSign = () => {
    resolver.current?.(true);
    resolver.current = null;
    setPhase('signing');
  };
  const onCancel = () => {
    resolver.current?.(false);
    close();
  };

  const inFlight = phase === 'signing' || phase === 'submitted';

  return (
    <Ctx.Provider value={api}>
      {children}
      {open && meta && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            onClick={() => (inFlight ? undefined : onCancel())}
          />
          <div className="relative w-full max-w-sm overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-950 shadow-2xl">
            <div className="flex items-center justify-between border-b border-neutral-800 px-5 py-3.5">
              <span className="text-sm font-medium text-neutral-200">{meta.title}</span>
              {!inFlight && (
                <button onClick={onCancel} aria-label="Close" className="text-neutral-500 hover:text-neutral-200">
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6 6 18" />
                  </svg>
                </button>
              )}
            </div>

            <div className="px-5 py-5">
              {/* Status icon */}
              <div className="mb-4 flex justify-center">
                <StatusIcon phase={phase} />
              </div>

              {/* Amount */}
              {meta.amountUsdc ? (
                <div className="text-center">
                  <div className="text-3xl font-semibold tracking-tight text-neutral-100">
                    {meta.amountUsdc} <span className="text-lg text-neutral-400">{meta.token ?? 'USDC'}</span>
                  </div>
                </div>
              ) : (
                <p className="text-center text-sm text-neutral-400">{meta.title}</p>
              )}

              {/* Detail rows */}
              <dl className="mt-5 space-y-2.5 rounded-xl border border-neutral-800/80 bg-neutral-900/40 p-3.5 text-xs">
                <Row label="Network" value={meta.network} />
                {meta.contract && (
                  <Row
                    label="Contract"
                    value={<span className="font-mono">{short(meta.contract)}</span>}
                  />
                )}
                {txHash && txUrl && (
                  <Row
                    label="Transaction"
                    value={
                      <a href={txUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sky-400 hover:text-sky-300">
                        {short(txHash)} <ExternalLinkIcon />
                      </a>
                    }
                  />
                )}
              </dl>

              <div className="mt-3 min-h-[1rem] text-center text-xs">
                {phase === 'signing' && <span className="text-neutral-400">Awaiting your signature…</span>}
                {phase === 'submitted' && <span className="text-sky-300">Submitted — confirming on Arc…</span>}
                {phase === 'confirmed' && <span className="text-emerald-400">Confirmed ✓</span>}
                {phase === 'failed' && <span className="text-red-400">{error ?? 'Transaction failed.'}</span>}
              </div>
            </div>

            {/* Footer actions */}
            <div className="border-t border-neutral-800 px-5 py-3.5">
              {phase === 'review' && (
                <div className="flex gap-2">
                  <button onClick={onCancel} className="flex-1 rounded-lg border border-neutral-800 px-4 py-2 text-sm text-neutral-300 hover:text-neutral-100">
                    Cancel
                  </button>
                  <button onClick={onSign} className="flex-1 rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-950 hover:bg-white">
                    Sign transaction
                  </button>
                </div>
              )}
              {inFlight && (
                <button disabled className="w-full rounded-lg bg-neutral-800 px-4 py-2 text-sm text-neutral-400">
                  {phase === 'signing' ? 'Waiting for signature…' : 'Confirming…'}
                </button>
              )}
              {(phase === 'confirmed' || phase === 'failed') && (
                <button onClick={close} className="w-full rounded-lg border border-neutral-800 px-4 py-2 text-sm text-neutral-300 hover:text-neutral-100">
                  Close
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-neutral-500">{label}</dt>
      <dd className="text-neutral-200">{value}</dd>
    </div>
  );
}

function StatusIcon({ phase }: { phase: Phase }) {
  if (phase === 'confirmed') {
    return (
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400">
        <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      </span>
    );
  }
  if (phase === 'failed') {
    return (
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-red-500/15 text-red-400">
        <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6 6 18" />
        </svg>
      </span>
    );
  }
  if (phase === 'signing' || phase === 'submitted') {
    return (
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-sky-500/10 text-sky-400">
        <svg className="h-6 w-6 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden>
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" className="opacity-20" />
          <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
      </span>
    );
  }
  return (
    <span className="flex h-12 w-12 items-center justify-center rounded-full bg-neutral-800 text-neutral-300">
      <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" />
      </svg>
    </span>
  );
}
