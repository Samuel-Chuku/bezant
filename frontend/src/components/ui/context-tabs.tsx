'use client';

// A context sub-tab strip: swaps views within a single context (e.g. a bond)
// without leaving it. Underline-style, active tab carries a mint indicator.
// Railway app-shell pattern, adapted to Ink & Mint. Horizontal-scroll on narrow
// screens; arrow-key nav between tabs.
export type ContextTab = { key: string; label: string; badge?: number };

export function ContextTabs({
  tabs,
  active,
  onChange,
}: {
  tabs: ContextTab[];
  active: string;
  onChange: (key: string) => void;
}) {
  const move = (dir: 1 | -1) => {
    const i = tabs.findIndex((t) => t.key === active);
    const next = tabs[(i + dir + tabs.length) % tabs.length];
    if (next) onChange(next.key);
  };

  return (
    <div role="tablist" className="flex gap-1 overflow-x-auto border-b border-line">
      {tabs.map((t) => {
        const on = t.key === active;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(t.key)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight') { e.preventDefault(); move(1); }
              if (e.key === 'ArrowLeft') { e.preventDefault(); move(-1); }
            }}
            className={[
              'relative -mb-px inline-flex items-center gap-1.5 whitespace-nowrap px-3.5 py-2.5 text-sm transition',
              on ? 'text-fg' : 'text-muted hover:text-fg',
            ].join(' ')}
          >
            {t.label}
            {t.badge ? (
              <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary/15 px-1 text-[10px] font-medium text-primary">
                {t.badge > 9 ? '9+' : t.badge}
              </span>
            ) : null}
            {on && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-primary" />}
          </button>
        );
      })}
    </div>
  );
}
