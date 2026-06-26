// Bezant brand mark: a B+Z monogram (the upper bowl is a B, the diagonal is the
// Z of beZant). Strokes use currentColor so the same mark works in champagne
// (brand), near-white, or flat monochrome (favicon). Font-independent: the
// wordmark sets "bezant" in the brand serif but the mark never depends on it.

export function BezantMark({
  size = 24,
  className,
  decorative = false,
}: {
  size?: number;
  className?: string;
  decorative?: boolean;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="20 13 56 76"
      fill="none"
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : 'Bezant'}
      aria-hidden={decorative || undefined}
      className={className}
    >
      <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
        <path d="M33 21 H62" strokeWidth="12" />
        <path d="M33 21 V79" strokeWidth="12" />
        <path d="M33 50 H53 a15 15 0 0 1 0 30 H33" strokeWidth="12" />
        <path d="M60 24 L35 71" strokeWidth="11" />
      </g>
    </svg>
  );
}

// Full lockup: champagne mark + "bezant" in the brand serif + a mint status dot
// (the one accent). markSize tunes the glyph; textClassName tunes the wordmark
// size so nav and hero can share the component.
export function BezantWordmark({
  markSize = 22,
  textClassName = 'text-lg',
  showDot = true,
  className,
}: {
  markSize?: number;
  textClassName?: string;
  showDot?: boolean;
  className?: string;
}) {
  return (
    <span className={['inline-flex items-center gap-2', className].filter(Boolean).join(' ')}>
      <BezantMark size={markSize} decorative className="text-brand" />
      <span className={['font-brand lowercase leading-none text-fg', textClassName].join(' ')}>
        bezant
        {showDot && <span className="text-primary">.</span>}
      </span>
    </span>
  );
}
