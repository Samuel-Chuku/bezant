'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui';

// Home-only, anchored spotlight tour. It highlights the real sections of the
// dashboard (each tagged with `data-tour="..."` in app/page.tsx) and floats a
// brand-styled tip card beside them. Auto-runs once on the first home visit
// (localStorage flag), and can be re-triggered via `window`-event
// `bezant:start-tour`. Steps whose anchor isn't rendered (e.g. "Your money"
// when signed out) are skipped automatically.
const DONE_KEY = 'bezant:onboarding-tour-done';

type Step = { sel: string[]; title: string; body: string };

const STEPS: Step[] = [
  {
    sel: ['[data-tour="hero"]'],
    title: 'This is your desk',
    body: 'Bezant is escrow that releases on proof. Striking, funding, and settling a deal all start here.',
  },
  {
    sel: ['[data-tour="start"]', '[data-tour="signin"]'],
    title: 'Start a deal',
    body: 'Strike a bond: set your terms and fund a passport-priced deposit. It releases to the seller on verified delivery.',
  },
  {
    sel: ['[data-tour="money"]'],
    title: 'Your money',
    body: 'Available to spend, locked in escrow, and settled to date — always in view.',
  },
  {
    sel: ['[data-tour="protocol"]'],
    title: 'Every deal, on chain',
    body: 'Read straight from the escrow contract, refreshed every 15 seconds. Nothing here is off-chain.',
  },
  {
    sel: ['[data-tour="pool"]'],
    title: 'The financing pool',
    body: 'LPs front sellers the moment a buyer funds escrow, and earn the fees. Deposit to earn, or get financed on a funded bond.',
  },
  {
    sel: ['[data-tour="quickstart"]'],
    title: 'Pick a path',
    body: 'Strike a bond, browse the market, or stake to verify and earn the fee. That’s the whole loop.',
  },
];

type Rect = { top: number; left: number; width: number; height: number };

export function OnboardingTour() {
  const pathname = usePathname();
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const elRef = useRef<Element | null>(null);

  useEffect(() => setMounted(true), []);

  // Resolve the DOM element for a step (first matching selector), or null.
  const stepEl = useCallback((idx: number): Element | null => {
    for (const s of STEPS[idx].sel) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    return null;
  }, []);

  // Next existing step index in a direction, or -1 if none.
  const seek = useCallback(
    (from: number, dir: 1 | -1): number => {
      let n = from + dir;
      while (n >= 0 && n < STEPS.length) {
        if (stepEl(n)) return n;
        n += dir;
      }
      return -1;
    },
    [stepEl],
  );

  const finish = useCallback(() => {
    try {
      window.localStorage.setItem(DONE_KEY, '1');
    } catch {
      /* storage blocked — nothing to persist */
    }
    setOpen(false);
    setRect(null);
    elRef.current = null;
  }, []);

  const start = useCallback(() => {
    const first = stepEl(0) ? 0 : seek(0, 1);
    if (first < 0) return; // no anchors on the page yet
    setI(first);
    setOpen(true);
  }, [stepEl, seek]);

  // Auto-run once, on the first visit to the home page.
  useEffect(() => {
    if (pathname !== '/') return;
    try {
      if (!window.localStorage.getItem(DONE_KEY)) start();
    } catch {
      /* ignore */
    }
  }, [pathname, start]);

  // Manual re-trigger from anywhere (e.g. a "Take the tour" link).
  useEffect(() => {
    window.addEventListener('bezant:start-tour', start);
    return () => window.removeEventListener('bezant:start-tour', start);
  }, [start]);

  // On step change: bind the target element and scroll it into view.
  useEffect(() => {
    if (!open) return;
    const el = stepEl(i);
    if (!el) {
      finish();
      return;
    }
    elRef.current = el;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [open, i, stepEl, finish]);

  // Track the target's rect each frame so the spotlight follows scroll/layout.
  useEffect(() => {
    if (!open) return;
    let raf = 0;
    const tick = () => {
      const el = elRef.current;
      if (el) {
        const r = el.getBoundingClientRect();
        setRect((prev) =>
          prev && prev.top === r.top && prev.left === r.left && prev.width === r.width && prev.height === r.height
            ? prev
            : { top: r.top, left: r.left, width: r.width, height: r.height },
        );
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [open]);

  // Esc closes the tour.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && finish();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, finish]);

  if (!mounted || !open || pathname !== '/' || !rect) return null;

  const step = STEPS[i];
  const isLast = seek(i, 1) < 0;
  const next = () => {
    const n = seek(i, 1);
    if (n < 0) finish();
    else setI(n);
  };
  const back = () => {
    const p = seek(i, -1);
    if (p >= 0) setI(p);
  };

  // Place the tip card below the target if there's room, else above; clamp to
  // the viewport. Card width shrinks on narrow screens.
  const margin = 14;
  const cardW = Math.min(340, window.innerWidth - margin * 2);
  const estCardH = 210;
  const spaceBelow = window.innerHeight - (rect.top + rect.height);
  const cardTop =
    spaceBelow > estCardH + margin
      ? rect.top + rect.height + margin
      : Math.max(margin, rect.top - estCardH - margin);
  const cardLeft = Math.min(
    Math.max(margin, rect.left + rect.width / 2 - cardW / 2),
    window.innerWidth - cardW - margin,
  );

  return createPortal(
    <>
      {/* Click-catcher: blocks the dimmed page so only the tip controls act. */}
      <div className="fixed inset-0 z-[78]" aria-hidden onClick={(e) => e.stopPropagation()} />

      {/* Spotlight: a ring whose huge box-shadow dims everything around it. */}
      <div
        aria-hidden
        className="pointer-events-none fixed rounded-2xl border-2 border-primary"
        style={{
          top: rect.top - 6,
          left: rect.left - 6,
          width: rect.width + 12,
          height: rect.height + 12,
          boxShadow: '0 0 0 9999px rgba(0,0,0,0.72)',
          transition: 'top 0.2s ease, left 0.2s ease, width 0.2s ease, height 0.2s ease',
          zIndex: 80,
        }}
      />

      {/* Tip card. */}
      <div
        className="fixed rounded-2xl border border-line bg-surface p-5 shadow-2xl"
        style={{ top: cardTop, left: cardLeft, width: cardW, zIndex: 81 }}
      >
        <div className="mb-2 flex items-center justify-between">
          <span className="font-mono text-[11px] uppercase tracking-wider text-brand">
            Tip {i + 1} / {STEPS.length}
          </span>
          <button type="button" onClick={finish} className="text-xs text-muted transition hover:text-fg">
            Skip tour
          </button>
        </div>
        <h3 className="font-display text-lg font-semibold tracking-tight text-fg">{step.title}</h3>
        <p className="mt-1.5 text-sm leading-relaxed text-muted">{step.body}</p>
        <div className="mt-4 flex items-center justify-between gap-3">
          <div className="flex gap-1.5">
            {STEPS.map((_, d) => (
              <span
                key={d}
                className={[
                  'h-1.5 w-1.5 rounded-full transition',
                  d === i ? 'bg-primary' : d < i ? 'bg-primary/40' : 'bg-line',
                ].join(' ')}
              />
            ))}
          </div>
          <div className="flex gap-2">
            {seek(i, -1) >= 0 && (
              <Button variant="secondary" size="sm" onClick={back}>
                Back
              </Button>
            )}
            <Button size="sm" onClick={next}>
              {isLast ? 'Done' : 'Next →'}
            </Button>
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}
