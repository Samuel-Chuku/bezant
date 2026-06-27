'use client';

import { useEffect } from 'react';

// Reveal-on-scroll: observes every `.reveal` in the page and adds `.in-view`
// once it enters the viewport (globals.css transitions opacity + translateY).
// One-shot per element. Reduced-motion users get them visible immediately
// (handled in CSS), so this is purely additive.
export function useReveal() {
  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>('.reveal:not(.in-view)'));
    if (els.length === 0) return;
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add('in-view');
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: '0px 0px -8% 0px' },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
}
