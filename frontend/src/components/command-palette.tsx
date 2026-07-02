'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

// Global ⌘K / Ctrl+K launcher: fuzzy-jump to any section. Also opens on the
// 'bezant:open-cmdk' window event (dispatched by the nav button).
type Cmd = { label: string; href: string; hint: string };
const COMMANDS: Cmd[] = [
  { label: 'Strike a bond', href: '/trade/create', hint: 'New' },
  { label: 'Your bonds', href: '/trade', hint: 'Bonds' },
  { label: 'Financing pool', href: '/pool', hint: 'Pool' },
  { label: 'Verify', href: '/verify', hint: 'Panel' },
  { label: 'Bridge', href: '/bridge', hint: 'CCTP' },
  { label: 'Profile', href: '/profile', hint: 'You' },
  { label: 'Activity', href: '/activity', hint: 'Feed' },
  { label: 'Home', href: '/', hint: 'Dashboard' },
];

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('bezant:open-cmdk', onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('bezant:open-cmdk', onOpen);
    };
  }, []);

  useEffect(() => {
    if (open) {
      setQ('');
      setIdx(0);
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [open]);

  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return COMMANDS;
    return COMMANDS.filter((c) => c.label.toLowerCase().includes(s) || c.hint.toLowerCase().includes(s));
  }, [q]);

  useEffect(() => setIdx(0), [q]);

  if (!open) return null;

  const run = (c?: Cmd) => {
    if (!c) return;
    setOpen(false);
    router.push(c.href);
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center bg-black/50 px-4 pt-[12vh] backdrop-blur-sm"
      onMouseDown={() => setOpen(false)}
    >
      <div
        className="bz-frame bz-fadein w-full max-w-lg overflow-hidden rounded-2xl border border-line bg-bg shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-line px-4">
          <svg className="h-4 w-4 shrink-0 text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <circle cx="11" cy="11" r="7" /><path strokeLinecap="round" d="m21 21-4.3-4.3" />
          </svg>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(results.length - 1, i + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
              else if (e.key === 'Enter') { e.preventDefault(); run(results[idx]); }
              else if (e.key === 'Escape') setOpen(false);
            }}
            placeholder="Jump to…"
            className="w-full bg-transparent py-3.5 text-base text-fg placeholder:text-muted focus:outline-none"
          />
          <kbd className="hidden rounded border border-line px-1.5 py-0.5 text-[10px] text-muted sm:block">esc</kbd>
        </div>
        <ul className="max-h-80 overflow-y-auto p-2">
          {results.length === 0 ? (
            <li className="px-3 py-6 text-center text-sm text-muted">No matches.</li>
          ) : (
            results.map((c, i) => (
              <li key={c.href}>
                <button
                  type="button"
                  onMouseEnter={() => setIdx(i)}
                  onClick={() => run(c)}
                  className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition ${i === idx ? 'bg-surface text-fg' : 'text-muted hover:text-fg'}`}
                >
                  <span className="flex-1 text-fg">{c.label}</span>
                  <span className="text-xs text-muted">{c.hint}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
