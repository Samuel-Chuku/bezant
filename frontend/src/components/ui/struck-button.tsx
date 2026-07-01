'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

// The Bezant signature action: a struck-coin pill (colored cap + diagonal cut +
// coin face + optional mono meta chip). Styles live in globals.css (.bz-coin).
// Mint = action; champagne is never used here. Renders a <Link> when `href` is
// set, otherwise a <button>.
type Variant = 'mint' | 'danger' | 'neutral';

export function StruckButton({
  variant = 'mint',
  size,
  icon,
  meta,
  children,
  href,
  onClick,
  disabled,
  type = 'button',
  className,
  'aria-label': ariaLabel,
}: {
  variant?: Variant;
  size?: 'sm';
  icon: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
  type?: 'button' | 'submit';
  className?: string;
  'aria-label'?: string;
}) {
  const cls = ['bz-coin', variant, size === 'sm' ? 'sm' : '', className].filter(Boolean).join(' ');
  const inner = (
    <>
      <span className="cap" aria-hidden>{icon}</span>
      <span className="face">
        {children}
        {meta != null && <span className="meta">{meta}</span>}
      </span>
    </>
  );
  if (href) {
    return (
      <Link href={href} className={cls} aria-label={ariaLabel}>
        {inner}
      </Link>
    );
  }
  return (
    <button type={type} className={cls} onClick={onClick} disabled={disabled} aria-label={ariaLabel}>
      {inner}
    </button>
  );
}
