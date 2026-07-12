// "Powered by Circle <product>" strip for the funding + payout cards. Mirrors the
// footer's "Built on …" bar (full-width top rule, centered, letter-spaced) but at
// a smaller scale so it reads as a branded footer for the card. Uses Circle's mark
// (circle-icon.svg); .circle-mark inverts it to white in dark mode, kept as-is in
// light (see globals.css).
export function PoweredByCircle({ product }: { product: string }) {
  return (
    <div className="mt-3 flex items-center justify-center gap-2.5 border-t border-line/60 pt-3 text-[11px] uppercase tracking-[0.22em] text-muted">
      <span>Powered by</span>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/circle-icon.svg" alt="Circle" className="circle-mark h-4 w-4" />
      <span className="font-semibold text-fg">Circle {product}</span>
    </div>
  );
}
