'use client';

import { useEffect, useRef, useState } from 'react';

// Compact pill dropdown for panel-header filters / ranges. Closes on outside
// click or Escape. Keyboard: Enter/Space toggles, options are buttons.
export type PillOption = { value: string; label: string; badge?: number };

export function PillSelect({
  options,
  value,
  onChange,
  className,
}: {
  options: PillOption[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const active = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className={`relative ${className ?? ''}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-2 px-3 py-1.5 text-xs text-fg transition hover:border-line-strong"
      >
        {active?.label ?? 'Select'}
        <svg className={`h-3.5 w-3.5 text-muted transition-transform ${open ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <ul role="listbox" className="absolute right-0 z-30 mt-1 min-w-40 overflow-hidden rounded-lg border border-line bg-bg p-1 shadow-xl">
          {options.map((o) => {
            const on = o.value === value;
            return (
              <li key={o.value}>
                <button
                  type="button"
                  role="option"
                  aria-selected={on}
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-xs transition ${on ? 'bg-surface text-fg' : 'text-muted hover:bg-surface hover:text-fg'}`}
                >
                  <span>{o.label}</span>
                  {o.badge != null && o.badge > 0 && <span className="text-[10px] text-muted">{o.badge}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
