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

const NAV_ITEMS: NavItem[] = [
  { href: '/', label: 'Home' },
  { href: '/trade', label: 'Trade' },
  { href: '/create', label: 'Create' },
  // Pacts hub: 'Mine' + 'Browse' tabs. 'Browse' absorbed the old /market page.
  { href: '/pacts', label: 'Pacts' },
  { href: '/evaluators', label: 'Evaluate' },
  { href: '/bridge', label: 'Bridge' },
  { href: '/reputation', label: 'Reputation' },
];

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
            {NAV_ITEMS.map((item) => {
              const active = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={[
                    'rounded-md px-3 py-1.5 text-sm transition',
                    active
                      ? 'bg-neutral-900 text-neutral-100'
                      : 'text-neutral-400 hover:text-neutral-100',
                  ].join(' ')}
                >
                  {item.label}
                </Link>
              );
            })}
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
