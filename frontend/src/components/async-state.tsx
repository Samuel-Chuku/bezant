// Shared primitives for loading + error UI. Pages were rolling their own
// inconsistent treatments (some swallowed errors silently, some showed
// nothing while loading), which this consolidates.

import { type ReactNode } from 'react';

// Animated placeholder block. Sized via className.
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={[
        'animate-pulse rounded-md bg-neutral-800/70',
        className ?? 'h-4 w-full',
      ].join(' ')}
    />
  );
}

// A row that approximates a job/list card while content loads. Reused across
// /jobs, /market, etc. so loading states feel consistent.
export function ListItemSkeleton() {
  return (
    <div className="space-y-2 rounded-xl border border-neutral-800 bg-neutral-900/30 p-4">
      <div className="flex items-center gap-3">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-4 w-20" />
      </div>
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-3/4" />
      <div className="flex gap-4 pt-1">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-3 w-32" />
      </div>
    </div>
  );
}

// Visible error surface for failed fetches. Pages were previously logging
// to console + showing nothing; this puts the failure in front of the user
// with a retry path.
export function ErrorBanner({
  title,
  message,
  onRetry,
  retryLabel = 'Try again',
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div className="rounded-xl border border-red-900/40 bg-red-950/20 p-4">
      {title && <p className="text-sm font-medium text-red-200">{title}</p>}
      <p className={title ? 'mt-1 text-xs text-red-300/80' : 'text-sm text-red-300'}>
        {message}
      </p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 rounded-md border border-red-800/60 px-3 py-1 text-xs font-medium text-red-200 hover:bg-red-900/30"
        >
          {retryLabel}
        </button>
      )}
    </div>
  );
}

// Wrapper for the common pattern of "loading? error? empty? content?".
// Pages can pass each branch as a render prop and not redo the conditional
// nesting every time.
export function AsyncState<T>({
  state,
  loadingFallback,
  errorFallback,
  emptyFallback,
  children,
}: {
  state:
    | { kind: 'loading' }
    | { kind: 'error'; message: string; retry?: () => void }
    | { kind: 'empty' }
    | { kind: 'ready'; data: T };
  loadingFallback: ReactNode;
  errorFallback?: (message: string, retry?: () => void) => ReactNode;
  emptyFallback: ReactNode;
  children: (data: T) => ReactNode;
}) {
  if (state.kind === 'loading') return <>{loadingFallback}</>;
  if (state.kind === 'error') {
    if (errorFallback) return <>{errorFallback(state.message, state.retry)}</>;
    return <ErrorBanner message={state.message} onRetry={state.retry} />;
  }
  if (state.kind === 'empty') return <>{emptyFallback}</>;
  return <>{children(state.data)}</>;
}
