'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useChainId, useSwitchChain } from 'wagmi';
import { useSigner } from '@/hooks/use-signer';
import { arcTestnet } from '@/lib/chains';
import { shortAddress } from '@/lib/format';
import { ArcLogo } from './arc-logo';
import { MobileDrawer, type NavItem } from './mobile-drawer';
import { NotificationsBell } from './notifications-bell';
import { WalletPill } from './wallet-pill';

// Mobile drawer (flat list). Desktop renders a Trades hover menu + My trades.
const NAV_ITEMS: NavItem[] = [
  { href: '/', label: 'Home' },
  { href: '/trade/create', label: 'New trade' },
  { href: '/trade', label: 'My trades' },
  { href: '/pool', label: 'Pool' },
  { href: '/bridge', label: 'Bridge' },
  { href: '/profile', label: 'Profile' },
  // Parked (pact/wrapper era) — pages still live in the repo, just unlinked from
  // nav while the standalone trade flow is the active product. Restore as needed.
  // { href: '/create', label: 'Create' },
  // { href: '/pacts', label: 'Pacts' },
  // { href: '/evaluators', label: 'Evaluate' },
  // { href: '/reputation', label: 'Reputation' },
];

function NavLink({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={[
        'rounded-md px-3 py-1.5 text-sm transition',
        active ? 'bg-neutral-900 text-neutral-100' : 'text-neutral-400 hover:text-neutral-100',
      ].join(' ')}
    >
      {label}
    </Link>
  );
}

// Trades button with a hover menu → create a new trade / perform an action.
function TradesMenu({ active }: { active: boolean }) {
  return (
    <div className="group relative">
      <Link
        href="/trade"
        className={[
          'inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-sm transition',
          active ? 'bg-neutral-900 text-neutral-100' : 'text-neutral-400 hover:text-neutral-100',
        ].join(' ')}
      >
        Trades
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </Link>
      {/* pt-2 keeps a hover bridge so the menu doesn't close in the gap */}
      <div className="invisible absolute left-0 top-full z-50 w-60 pt-2 opacity-0 transition group-hover:visible group-hover:opacity-100">
        <div className="rounded-lg border border-neutral-800 bg-neutral-950 p-1 shadow-xl">
          <Link href="/trade/create" className="block rounded-md px-3 py-2 text-sm text-neutral-300 hover:bg-neutral-900 hover:text-neutral-100">
            + Create a new trade
          </Link>
          <Link href="/trade" className="block rounded-md px-3 py-2 text-sm text-neutral-300 hover:bg-neutral-900 hover:text-neutral-100">
            Perform an action in a trade
          </Link>
        </div>
      </div>
    </div>
  );
}

export function TopNav() {
  const signer = useSigner();
  const wagmiChainId = useChainId();
  const { switchChain } = useSwitchChain();
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);

  // External-mode users can drift off Arc via the bridge widget; passkey
  // users stay on Arc by construction so we don't pester them.
  const showSwitchCTA =
    signer.isConnected && signer.mode === 'external' && wagmiChainId !== arcTestnet.id;

  return (
    <>
      <header className="sticky top-0 z-40 border-b border-neutral-800/80 bg-neutral-950/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              className="-ml-1 inline-flex h-9 w-9 items-center justify-center rounded-lg text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100 md:hidden"
              aria-label="Open menu"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M3 6h18M3 12h18M3 18h18" />
              </svg>
            </button>
            <Link
              href="/"
              className="inline-flex items-center gap-2 text-sm font-semibold tracking-tight text-neutral-100"
            >
              <ArcLogo size={22} />
              <span>arc-trade</span>
            </Link>
          </div>

          <nav className="hidden flex-1 items-center gap-1 md:flex">
            <NavLink href="/" label="Home" active={pathname === '/'} />
            <TradesMenu active={pathname === '/trade' || pathname.startsWith('/trade/')} />
            <NavLink href="/trade" label="My trades" active={pathname === '/trade'} />
            <NavLink href="/pool" label="Pool" active={pathname === '/pool'} />
            <NavLink href="/bridge" label="Bridge" active={pathname === '/bridge'} />
            <NavLink href="/profile" label="Profile" active={pathname === '/profile'} />
          </nav>

          <div className="ml-auto flex items-center gap-2">
            {showSwitchCTA && (
              // Hidden below sm to ease header crowding on phones; the mobile
              // drawer carries its own Switch-to-Arc button so users on the
              // wrong chain still have a clear escape hatch.
              <button
                type="button"
                onClick={() => switchChain({ chainId: arcTestnet.id })}
                className="hidden items-center gap-1.5 rounded-md border border-amber-700/50 bg-amber-950/40 px-2.5 py-1 text-[11px] font-medium text-amber-200 transition hover:bg-amber-950/60 sm:inline-flex"
              >
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400" />
                Switch to Arc →
              </button>
            )}
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
            <div className="space-y-2 text-xs text-neutral-400">
              <div className="font-mono text-neutral-300">{shortAddress(signer.address)}</div>
              <div className="text-neutral-500">
                Signed in via {signer.mode === 'external' ? 'wallet' : 'passkey'}
              </div>
              {showSwitchCTA && (
                <button
                  type="button"
                  onClick={() => switchChain({ chainId: arcTestnet.id })}
                  className="mt-1 w-full rounded-md border border-amber-700/50 bg-amber-950/40 px-2.5 py-1.5 text-[11px] font-medium text-amber-200 hover:bg-amber-950/60"
                >
                  Switch to Arc →
                </button>
              )}
              <button
                type="button"
                onClick={() => signer.disconnect?.()}
                className="w-full rounded-md border border-neutral-800 px-2.5 py-1.5 text-xs text-neutral-300 hover:text-neutral-100"
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
