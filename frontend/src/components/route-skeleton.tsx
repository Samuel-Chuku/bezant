// Instant loading fallback for route transitions. Rendered by each segment's
// loading.tsx the moment a nav link is clicked, so pages feel responsive rather
// than freezing on the old view until the new one's data resolves. Pure markup,
// no hooks - safe as a Server Component.
export function RouteSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <main className="mx-auto max-w-[1440px] px-6 py-16" aria-busy="true" aria-label="Loading">
      <div className="animate-pulse space-y-6">
        <div className="space-y-3">
          <div className="h-3 w-24 rounded bg-surface-2" />
          <div className="h-9 w-64 max-w-full rounded bg-surface-2" />
          <div className="h-4 w-96 max-w-full rounded bg-surface-2/70" />
        </div>
        <div className="space-y-3">
          {Array.from({ length: rows }).map((_, i) => (
            <div key={i} className="bz-frame rounded-xl border border-line bg-surface/40 p-4">
              <div className="h-3 w-20 rounded bg-surface-2" />
              <div className="mt-2.5 h-4 w-3/4 rounded bg-surface-2/70" />
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
