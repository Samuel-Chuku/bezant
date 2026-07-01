// Route-transition loading UI (Next App Router Suspense boundary for every
// segment). Shows the DS "bezanting" loader — the brand as a verb, champagne
// dots striking in sequence — so navigation reads as loading, not an abrupt swap.
export default function Loading() {
  return (
    <div className="mx-auto flex min-h-[70vh] max-w-6xl items-center justify-center px-6" role="status" aria-label="Loading">
      <span className="bz-loading font-brand text-4xl font-medium tracking-tight text-brand">
        bezanting
        <span className="dot">.</span>
        <span className="dot">.</span>
        <span className="dot">.</span>
      </span>
    </div>
  );
}
