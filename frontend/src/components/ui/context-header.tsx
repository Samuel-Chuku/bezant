import type { ReactNode } from 'react';
import Link from 'next/link';
import { StatePill } from './state-pill';

// Standard context header: optional back link + eyebrow, a display title with an
// optional bond-state pill, a muted meta line, and a right-aligned primary action.
// Railway app-shell pattern; keeps Pool / Verify / detail tops consistent.
export function ContextHeader({
  eyebrow,
  title,
  state,
  meta,
  actions,
  back,
}: {
  eyebrow?: string;
  title: string;
  state?: string;
  meta?: ReactNode;
  actions?: ReactNode;
  back?: { href: string; label: string };
}) {
  return (
    <header>
      {back && (
        <Link href={back.href} className="text-xs text-muted transition hover:text-fg">
          ← {back.label}
        </Link>
      )}
      <div className={`flex flex-wrap items-start justify-between gap-4 ${back ? 'mt-3' : ''}`}>
        <div className="min-w-0">
          {eyebrow && <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-brand">{eyebrow}</div>}
          <div className={`flex flex-wrap items-center gap-3 ${eyebrow ? 'mt-1' : ''}`}>
            <h1 className="font-display text-4xl font-semibold tracking-tight">{title}</h1>
            {state && <StatePill status={state} />}
          </div>
          {meta && <div className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">{meta}</div>}
        </div>
        {actions && <div className="shrink-0">{actions}</div>}
      </div>
    </header>
  );
}
