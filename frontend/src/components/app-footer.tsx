'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BezantWordmark } from './bezant-logo';

// Persistent app footer (bonds-branded), on every app page. Suppressed on the
// marketing landing, which ships its own larger footer.
const COLS: { title: string; links: { label: string; href: string; ext?: boolean }[] }[] = [
  {
    title: 'Product',
    links: [
      { label: 'Bonds', href: '/trade' },
      { label: 'Verify', href: '/verify' },
      { label: 'Pool', href: '/pool' },
      { label: 'Bridge', href: '/bridge' },
    ],
  },
  {
    title: 'Account',
    links: [
      { label: 'Profile', href: '/profile' },
      { label: 'Reputation', href: '/reputation' },
      { label: 'Activity', href: '/activity' },
      { label: 'Strike a bond', href: '/trade/create' },
    ],
  },
  {
    title: 'Network',
    links: [
      { label: 'Arc Docs', href: 'https://docs.arc.network/', ext: true },
      { label: 'Circle Docs', href: 'https://developers.circle.com/', ext: true },
      { label: 'Arc Explorer', href: 'https://testnet.arcscan.app/', ext: true },
      { label: 'USDC Faucet', href: 'https://faucet.circle.com/', ext: true },
    ],
  },
  {
    title: 'Protocol',
    links: [
      { label: 'Docs', href: 'https://github.com/Samuel-Chuku/bezant', ext: true },
      { label: 'Landing', href: '/landing' },
    ],
  },
];

// Social links — icons only. Placeholder hrefs (except GitHub) to be swapped later.
const SOCIALS: { label: string; href: string; icon: React.ReactNode }[] = [
  {
    label: 'X',
    href: 'https://x.com/bezant_trade',
    icon: (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>
    ),
  },
  {
    label: 'LinkedIn',
    href: '#',
    icon: (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden><path d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.34V9h3.42v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46zM5.34 7.43a2.07 2.07 0 1 1 0-4.14 2.07 2.07 0 0 1 0 4.14M7.12 20.45H3.56V9h3.56zM22.22 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.73V1.73C24 .77 23.2 0 22.22 0" /></svg>
    ),
  },
  {
    label: 'GitHub',
    href: 'https://github.com/Samuel-Chuku/bezant',
    icon: (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden><path d="M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58v-2.03c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.2.08 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.5.99.11-.78.42-1.3.76-1.6-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6.01 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.24 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.81 5.63-5.49 5.93.43.37.82 1.1.82 2.22v3.29c0 .32.21.7.83.58A12 12 0 0 0 24 12.5C24 5.87 18.63.5 12 .5" /></svg>
    ),
  },
  {
    label: 'Discord',
    href: '#',
    icon: (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden><path d="M20.32 4.37A19.8 19.8 0 0 0 15.45 3a13.7 13.7 0 0 0-.62 1.28 18.3 18.3 0 0 0-5.66 0A13 13 0 0 0 8.55 3a19.8 19.8 0 0 0-4.88 1.37C.55 9 .07 13.51.31 17.96a19.9 19.9 0 0 0 6.05 3.05c.49-.66.92-1.36 1.29-2.1-.71-.27-1.39-.6-2.03-.99.17-.12.34-.25.5-.38a14.2 14.2 0 0 0 12.16 0c.17.14.34.26.5.38-.64.39-1.32.72-2.03.99.37.74.8 1.44 1.29 2.1a19.9 19.9 0 0 0 6.05-3.05c.29-5.15-.5-9.62-3.77-13.59M8.02 15.33c-1.18 0-2.15-1.09-2.15-2.42s.95-2.42 2.15-2.42 2.17 1.09 2.15 2.42c0 1.33-.95 2.42-2.15 2.42m7.96 0c-1.18 0-2.15-1.09-2.15-2.42s.95-2.42 2.15-2.42 2.17 1.09 2.15 2.42c0 1.33-.94 2.42-2.15 2.42" /></svg>
    ),
  },
];

export function AppFooter() {
  const pathname = usePathname();
  if (pathname === '/landing') return null; // landing has its own footer

  return (
    <footer className="mt-24 border-t border-line">
      <div className="mx-auto max-w-6xl px-6 py-14">
        <div className="grid grid-cols-2 gap-8 md:grid-cols-[1.6fr_repeat(4,1fr)]">
          <div>
            <Link href="/" className="inline-flex" aria-label="Bezant home">
              <BezantWordmark markSize={30} textClassName="text-2xl" className="gap-2.5" />
            </Link>
            <p className="mt-3 max-w-[30ch] text-sm leading-relaxed text-muted">
              Trust infrastructure for stablecoin trade. Settlement you can weigh.
            </p>
          </div>
          {COLS.map((col) => (
            <div key={col.title}>
              <h4 className="mb-3.5 text-xs font-semibold uppercase tracking-[0.14em] text-muted">{col.title}</h4>
              {col.links.map((l) =>
                l.ext ? (
                  <a key={l.label} href={l.href} target="_blank" rel="noopener" className="block py-1.5 text-sm text-fg/90 transition hover:text-primary">
                    {l.label}
                  </a>
                ) : (
                  <Link key={l.label} href={l.href} className="block py-1.5 text-sm text-fg/90 transition hover:text-primary">
                    {l.label}
                  </Link>
                ),
              )}
            </div>
          ))}
        </div>
        <div className="mt-10 flex flex-wrap items-center gap-3 border-t border-line pt-6">
          {SOCIALS.map((s) => (
            <a
              key={s.label}
              href={s.href}
              target="_blank"
              rel="noopener"
              aria-label={s.label}
              className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-line text-muted transition hover:border-line-strong hover:text-fg"
            >
              {s.icon}
            </a>
          ))}
          <span className="ml-auto inline-flex items-center gap-2 font-mono text-xs text-muted">
            Built on
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/circle-icon.svg" alt="" className="h-4 w-4" aria-hidden />
            USDC +
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/arc-logo.svg" alt="" className="h-4 w-4" aria-hidden />
            Arc · testnet
          </span>
        </div>
      </div>
    </footer>
  );
}
