'use client';

import { useEffect, useState } from 'react';

// App light/dark toggle. Dark is the default brand experience; light is parity.
// The chosen theme is persisted and applied to <html data-theme> before paint
// by the inline script in layout.tsx (so there's no flash on reload).
const KEY = 'bezant-theme';

export function ThemeToggle() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');

  useEffect(() => {
    setTheme((document.documentElement.dataset.theme as 'dark' | 'light') || 'dark');
  }, []);

  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* private mode / storage blocked - theme still applies for the session */
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
      title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
      className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-line bg-surface/60 text-fg transition hover:border-line-strong hover:bg-surface"
    >
      <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden>
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" />
      </svg>
    </button>
  );
}
