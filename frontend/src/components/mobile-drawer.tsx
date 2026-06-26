'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BezantWordmark } from './bezant-logo';

export type NavItem = { href: string; label: string };

export function MobileDrawer({
  open,
  onClose,
  items,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  items: NavItem[];
  footer?: React.ReactNode;
}) {
  const pathname = usePathname();

  // Close on route change.
  useEffect(() => {
    onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 md:hidden">
      <button
        type="button"
        aria-label="Close menu"
        onClick={onClose}
        className="absolute inset-0 bg-black/60"
      />
      <aside className="absolute left-0 top-0 flex h-full w-72 flex-col border-r border-line bg-bg p-6 shadow-2xl">
        <div className="flex items-center justify-between">
          <BezantWordmark markSize={20} textClassName="text-base" />
          <button
            type="button"
            onClick={onClose}
            className="text-xl leading-none text-muted hover:text-fg"
            aria-label="Close menu"
          >
            ×
          </button>
        </div>
        <nav className="mt-8 flex flex-col gap-1">
          {items.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={[
                  'rounded-lg px-3 py-2 text-sm transition',
                  active
                    ? 'bg-surface text-fg'
                    : 'text-muted hover:bg-surface/60 hover:text-fg',
                ].join(' ')}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        {footer && <div className="mt-auto border-t border-line pt-4">{footer}</div>}
      </aside>
    </div>
  );
}
