'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { createPortal } from 'react-dom';
import { FeedbackForm } from './feedback-form';

// Persistent floating "Feedback" button, mounted globally. Opens the same
// FeedbackForm as /feedback in a modal so users can send from any page.
export function FeedbackWidget() {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => setMounted(true), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  if (!mounted) return null;
  // Landing has its own chrome; the dedicated page already shows the form.
  if (pathname === '/landing' || pathname === '/feedback') return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Send feedback"
        className="group fixed bottom-4 left-4 z-40 inline-flex items-center gap-2 rounded-full border border-line bg-surface/90 py-1.5 pl-1.5 pr-3.5 text-xs font-medium text-fg shadow-lg backdrop-blur transition hover:border-primary/40 hover:bg-surface"
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-fg">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        </span>
        Feedback
      </button>

      {open &&
        createPortal(
          <div className="fixed inset-0 z-[70] flex items-end justify-center px-4 py-4 sm:items-center">
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setOpen(false)} aria-hidden />
            <div className="relative w-full max-w-md rounded-2xl border border-line bg-surface p-5 shadow-xl">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-fg">Send feedback</h2>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close"
                  className="rounded-md p-1 text-muted hover:bg-surface-2 hover:text-fg"
                >
                  ×
                </button>
              </div>
              <FeedbackForm onDone={() => setOpen(false)} />
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
