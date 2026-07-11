// "Powered by Circle <product>" badge for the funding cards. Uses Circle's mark
// (circle-icon.svg); .circle-mark inverts it to white in dark mode, kept as-is
// in light (see globals.css).
export function PoweredByCircle({ product }: { product: string }) {
  return (
    <div className="mt-2.5 flex items-center gap-1.5 border-t border-line/60 pt-2 text-[10px] text-muted">
      <span className="uppercase tracking-wider">Powered by</span>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/circle-icon.svg" alt="Circle" className="circle-mark h-3 w-3" />
      <span className="font-medium text-fg">Circle {product}</span>
    </div>
  );
}
