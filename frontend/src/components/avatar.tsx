'use client';

import { useId } from 'react';

// Deterministic gradient avatar generated from an address. Distinct from
// karwan-style illustrated characters — three HSL hues picked from address
// bytes, rendered as a circle with a smooth two-stop gradient.
export function Avatar({ address, size = 32 }: { address: string; size?: number }) {
  const id = useId();
  const { from, to } = colorsFor(address);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      role="img"
      aria-label={`Avatar for ${address}`}
      className="rounded-full"
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={from} />
          <stop offset="100%" stopColor={to} />
        </linearGradient>
      </defs>
      <circle cx="20" cy="20" r="20" fill={`url(#${id})`} />
      {/* Soft highlight to give a touch of depth */}
      <circle cx="13" cy="13" r="6" fill="white" opacity="0.15" />
    </svg>
  );
}

function colorsFor(address: string): { from: string; to: string } {
  const hex = address.toLowerCase().replace(/^0x/, '');
  const safe = hex.padEnd(24, '0');
  const h1 = parseInt(safe.slice(0, 6), 16) % 360;
  const h2 = parseInt(safe.slice(12, 18), 16) % 360;
  return {
    from: `hsl(${h1}, 70%, 58%)`,
    to: `hsl(${h2}, 75%, 45%)`,
  };
}
