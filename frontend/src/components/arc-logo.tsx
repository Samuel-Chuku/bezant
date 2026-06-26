// Small brand mark for the nav, in our emerald accent. Placeholder mark until
// the Bezant brand gets a proper logo in the design pass (a bezant is a
// Byzantine gold coin - a roundel could fit later).
export function ArcLogo({ size = 22 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label="Bezant"
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
