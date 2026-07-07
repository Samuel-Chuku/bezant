// Suspension-bridge glyph used on the bridge access points (profile card +
// floating balances widget).
export function BridgeIcon({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M2 18h20" />
      <path d="M5 18V9M19 18V9" />
      <path d="M5 10c4.5 3.6 9.5 3.6 14 0" />
      <path d="M9 18v-3.4M12 18v-4.2M15 18v-3.4" />
    </svg>
  );
}
