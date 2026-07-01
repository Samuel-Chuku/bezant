'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

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
      { label: 'Activity', href: '/activity' },
      { label: 'Strike a bond', href: '/trade/create' },
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

const SOCIALS = ['X.com', 'LinkedIn', 'GitHub', 'Farcaster', 'Arc'];

export function AppFooter() {
  const pathname = usePathname();
  if (pathname === '/landing') return null; // landing has its own footer

  return (
    <footer className="mt-24 border-t border-line">
      <div className="mx-auto max-w-6xl px-6 py-14">
        <div className="grid grid-cols-2 gap-8 md:grid-cols-[1.6fr_repeat(3,1fr)]">
          <div>
            <Link href="/" className="font-brand text-2xl font-medium tracking-tight text-brand">
              bezant<span className="text-primary">.</span>
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
        <div className="mt-10 flex flex-wrap items-center gap-5 border-t border-line pt-6">
          {SOCIALS.map((s) => (
            <a key={s} href="#" className="text-xs uppercase tracking-[0.14em] text-muted transition hover:text-brand">
              {s}
            </a>
          ))}
          <span className="ml-auto font-mono text-xs text-muted">Built on Circle USDC + Arc · testnet</span>
        </div>
      </div>
    </footer>
  );
}
