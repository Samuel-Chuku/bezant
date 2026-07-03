'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';

// Static launcher for the onboarding tour. Home-only, stacked just above the
// feedback pill, and styled to match it. Clicking fires the `bezant:start-tour`
// event that OnboardingTour listens for.
export function TourButton() {
  const [mounted, setMounted] = useState(false);
  const pathname = usePathname();

  useEffect(() => setMounted(true), []);

  if (!mounted || pathname !== '/') return null;

  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event('bezant:start-tour'))}
      aria-label="Take the tour"
      className="group fixed bottom-[4.5rem] left-4 z-40 inline-flex items-center gap-2 rounded-full border border-line bg-surface/90 py-1.5 pl-1.5 pr-3.5 text-xs font-medium text-fg shadow-lg backdrop-blur transition hover:border-primary/40 hover:bg-surface"
    >
      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-[13px] font-bold leading-none text-primary-fg">
        ?
      </span>
      Tour
    </button>
  );
}
