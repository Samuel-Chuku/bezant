// Small brand mark for the nav. A half-circle arc in our emerald accent —
// references the "arc" in arc-trade without leaning on Arc Network's
// (separate) corporate identity.
export function ArcLogo({ size = 22 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label="arc-trade"
      className="text-emerald-400"
    >
      <path
        d="M3 18 A 10 10 0 0 1 21 18"
        stroke="currentColor"
        strokeWidth="2.5"
        fill="none"
        strokeLinecap="round"
      />
      <circle cx="12" cy="20" r="1.5" fill="currentColor" />
    </svg>
  );
}
