'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useChainId, useSwitchChain } from 'wagmi';
import { useSigner } from '@/hooks/use-signer';
import { useVerifierPending } from '@/hooks/use-verifier-pending';
import { arcTestnet } from '@/lib/chains';
import { shortAddress } from '@/lib/format';
import { BezantWordmark } from './bezant-logo';
import { MobileDrawer, type NavItem } from './mobile-drawer';
import { NotificationsBell } from './notifications-bell';
import { ThemeToggle } from './theme-toggle';
import { WalletPill } from './wallet-pill';

// "Trades" is a dropdown housing both sub-actions, so there's no separate
// top-level "New trade" item.
const TRADE_LINKS: NavItem[] = [
  { href: '/trade/create', label: 'Strike a bond' },
  { href: '/trade', label: 'Your bonds' },
];

// Desktop destinations that flank the Trades dropdown.
const PRIMARY_AFTER: NavItem[] = [
  { href: '/pool', label: 'Pool' },
  { href: '/verify', label: 'Verify' },
  { href: '/bridge', label: 'Bridge' },
  { href: '/profile', label: 'Profile' },
];

// Mobile drawer is a flat list - expand the Trades group inline.
const NAV_ITEMS: NavItem[] = [
  { href: '/', label: 'Home' },
  ...TRADE_LINKS,
  ...PRIMARY_AFTER,
  // Parked (pact/wrapper era) - pages still live in the repo, just unlinked from
  // nav while the standalone trade flow is the active product. Restore as needed.
  // { href: '/create', label: 'Create' },
  // { href: '/pacts', label: 'Pacts' },
  // { href: '/evaluators', label: 'Evaluate' },
  // { href: '/reputation', label: 'Reputation' },
];

function NavLink({ href, label, active, badge = 0 }: { href: string; label: string; active: boolean; badge?: number }) {
  return (
    <Link
      href={href}
      className={[
        'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition',
        active ? 'bg-primary/15 text-primary ring-1 ring-inset ring-primary/25' : 'text-muted hover:text-fg',
      ].join(' ')}
    >
      {label}
      {badge > 0 && (
        // Subtle pending-verifications counter - muted emerald, not the bell's red.
        <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary/15 px-1 text-[10px] font-medium text-primary" aria-label={`${badge} pending`}>
          {badge > 9 ? '9+' : badge}
        </span>
      )}
    </Link>
  );
}

// Desktop-only "Trades" dropdown: opens on hover or click, houses New trade +
// My trades. Stays highlighted on any /trade* route.
function TradesMenu({ pathname }: { pathname: string }) {
  const [open, setOpen] = useState(false);
  const active = pathname.startsWith('/trade');
  return (
    <div className="relative" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={[
          'inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-sm transition',
          active ? 'bg-primary/15 text-primary ring-1 ring-inset ring-primary/25' : 'text-muted hover:text-fg',
        ].join(' ')}
      >
        Bonds
        <svg className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div role="menu" className="absolute left-0 top-full z-30 mt-1 min-w-44 rounded-lg border border-line bg-bg p-1 shadow-xl">
          {TRADE_LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              role="menuitem"
              onClick={() => setOpen(false)}
              className="block rounded-md px-3 py-2 text-sm text-fg transition hover:bg-surface hover:text-fg"
            >
              {l.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export function TopNav() {
  const signer = useSigner();
  const wagmiChainId = useChainId();
  const { switchChain } = useSwitchChain();
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { count: verifyPending } = useVerifierPending();

  // The marketing landing has its own nav; suppress the app header there.
  if (pathname === '/landing') return null;

  // External-mode users can drift off Arc via the bridge widget; passkey
  // users stay on Arc by construction so we don't pester them.
  const showSwitchCTA =
    signer.isConnected && signer.mode === 'external' && wagmiChainId !== arcTestnet.id;

  return (
    <>
      <header className="sticky top-0 z-40 border-b border-line/80 bg-bg/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1440px] items-center gap-4 px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              className="-ml-1 inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted hover:bg-surface hover:text-fg md:hidden"
              aria-label="Open menu"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M3 6h18M3 12h18M3 18h18" />
              </svg>
            </button>
            <Link
              href="/landing"
              className="inline-flex items-center transition-transform duration-200 will-change-transform hover:-translate-y-0.5 hover:scale-[1.03] active:scale-100"
              aria-label="Bezant landing"
            >
              <BezantWordmark markSize={24} textClassName="text-lg" />
            </Link>
          </div>

          <nav className="hidden flex-1 items-center gap-1 md:flex">
            <NavLink href="/" label="Home" active={pathname === '/'} />
            <TradesMenu pathname={pathname} />
            {PRIMARY_AFTER.map((item) => (
              <NavLink key={item.href} href={item.href} label={item.label} active={pathname.startsWith(item.href)} badge={item.href === '/verify' ? verifyPending : 0} />
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            {showSwitchCTA && (
              // Hidden below sm to ease header crowding on phones; the mobile
              // drawer carries its own Switch-to-Arc button so users on the
              // wrong chain still have a clear escape hatch.
              <button
                type="button"
                onClick={() => switchChain({ chainId: arcTestnet.id })}
                className="hidden items-center gap-1.5 rounded-md border border-warn/50 bg-warn/12 px-2.5 py-1 text-[11px] font-medium text-warn transition hover:bg-warn/60 sm:inline-flex"
              >
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-warn" />
                Switch to Arc →
              </button>
            )}
            <button
              type="button"
              onClick={() => window.dispatchEvent(new Event('bezant:open-cmdk'))}
              className="hidden items-center gap-1.5 rounded-md border border-line px-2 py-1 text-xs text-muted transition hover:border-line-strong hover:text-fg sm:inline-flex"
              aria-label="Open command menu"
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <circle cx="11" cy="11" r="7" /><path strokeLinecap="round" d="m21 21-4.3-4.3" />
              </svg>
              <kbd className="font-sans">⌘K</kbd>
            </button>
            <ThemeToggle />
            <NotificationsBell />
            <WalletPill />
          </div>
        </div>
      </header>

      <MobileDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        items={NAV_ITEMS}
        footer={
          signer.isConnected ? (
            <div className="space-y-2 text-xs text-muted">
              <div className="font-mono text-fg">{shortAddress(signer.address)}</div>
              <div className="text-muted">
                Signed in via {signer.mode === 'external' ? 'wallet' : 'passkey'}
              </div>
              {showSwitchCTA && (
                <button
                  type="button"
                  onClick={() => switchChain({ chainId: arcTestnet.id })}
                  className="mt-1 w-full rounded-md border border-warn/50 bg-warn/12 px-2.5 py-1.5 text-[11px] font-medium text-warn hover:bg-warn/60"
                >
                  Switch to Arc →
                </button>
              )}
              <button
                type="button"
                onClick={() => signer.disconnect?.()}
                className="w-full rounded-md border border-line px-2.5 py-1.5 text-xs text-fg hover:text-fg"
              >
                Disconnect
              </button>
            </div>
          ) : null
        }
      />
    </>
  );
}
