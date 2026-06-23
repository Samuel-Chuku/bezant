// USDC coin mark — Circle blue disc with a white dollar glyph. Inline so it
// matches the chain logos (no asset pipeline).
export function UsdcIcon({ className = 'h-6 w-6' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <circle cx="16" cy="16" r="16" fill="#2775CA" />
      <path
        fill="#fff"
        d="M15.15 25.3v-1.86c-2.2-.23-3.86-1.3-4.27-3.39l2.18-.62c.3 1.2 1.05 1.9 2.45 2.02v-3.86c-2.4-.5-4.27-1.4-4.27-3.92 0-2.07 1.57-3.4 4.06-3.6V6.7h1.6v1.8c1.98.22 3.36 1.3 3.78 3.1l-2.1.6c-.22-.9-.78-1.5-1.86-1.66v3.55c2.48.5 4.4 1.42 4.4 3.98 0 2.18-1.6 3.5-4.18 3.7v1.93h-1.6Zm0-11.55v-3.27c-1.05.13-1.76.66-1.76 1.55 0 .9.7 1.4 1.76 1.72Zm1.6 2.94v3.46c1.16-.13 1.9-.68 1.9-1.66 0-1-.74-1.5-1.9-1.8Z"
      />
    </svg>
  );
}
