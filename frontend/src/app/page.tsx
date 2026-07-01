'use client';

import Link from 'next/link';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useSigner } from '@/hooks/use-signer';
import { useUserRecord } from '@/hooks/use-user-record';
import { EmailSignIn } from '@/components/email-sign-in';
import { BezantWordmark } from '@/components/bezant-logo';
import { buttonClass } from '@/components/ui';
import { shortAddress } from '@/lib/format';

export default function Home() {
  const signer = useSigner();
  const { state: userState } = useUserRecord();

  const user = userState.status === 'ready' ? userState.user : null;
  const displayName = user?.handle ?? (signer.isConnected ? shortAddress(signer.address) : null);

  return (
    <main className="mx-auto max-w-5xl px-6 py-16">
      <header className="mb-12">
        <h1>
          <BezantWordmark markSize={44} textClassName="text-5xl" className="gap-3" />
        </h1>
        <p className="mt-3 text-muted">
          Trade finance for stablecoins. Escrow that releases on verified delivery.
        </p>
      </header>

      {!signer.isConnected && (
        <section className="rounded-2xl border border-line bg-surface/50 p-6">
          <h2 className="text-lg font-medium">Get started</h2>
          <p className="mt-1 text-sm text-muted">
            Choose how you want to sign. Both paths use the same backend; the only difference is who
            holds your key.
          </p>

          <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="rounded-xl border border-line bg-bg/40 p-5">
              <h3 className="font-medium">Connect a wallet</h3>
              <p className="mt-1 text-xs text-muted">
                MetaMask, Coinbase, WalletConnect. You keep your own keys.
              </p>
              <div className="mt-4">
                <ConnectButton />
              </div>
            </div>

            <div className="rounded-xl border border-line bg-bg/40 p-5">
              <h3 className="font-medium">Sign in with email</h3>
              <p className="mt-1 text-xs text-muted">
                Backed by a Circle smart account on Arc. Your email is your identifier; a passkey
                (Bitwarden, Touch ID, etc.) signs your transactions. No wallet required.
              </p>
              <div className="mt-4">
                <EmailSignIn />
              </div>
            </div>
          </div>
        </section>
      )}

      {signer.isConnected && (
        <section className="rounded-2xl border border-primary/40 bg-primary/20 p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-sm font-medium uppercase tracking-wide text-primary">
                Connected ({signer.mode === 'external' ? 'wallet' : 'passkey'})
              </h2>
              <p className="mt-1 text-xs text-muted">
                {signer.mode === 'external'
                  ? 'Signing locally via your browser wallet.'
                  : 'Signing via your Circle smart account. Gas sponsored by Circle paymaster.'}
              </p>
            </div>
            <button
              type="button"
              onClick={() => signer.disconnect?.()}
              className="rounded-lg border border-line px-3 py-1.5 text-xs text-muted hover:text-fg"
            >
              Disconnect
            </button>
          </div>

          {/* Address + USDC balance now live in the top-nav wallet pill /
              modal - keeping them here would be redundant. Home shows just
              the handle (if any) and the linked Agent ID. */}
          <dl className="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            {displayName && (
              <div>
                <dt className="text-muted">Signed in as</dt>
                <dd className="text-fg">
                  {user?.handle ? (
                    <span className="font-medium">{user.handle}</span>
                  ) : (
                    <span className="font-mono text-xs text-fg">{displayName}</span>
                  )}
                </dd>
              </div>
            )}
            {user?.agentId && (
              <div>
                <dt className="inline-flex items-center gap-1.5 text-muted">
                  Agent ID
                  <AgentIdTooltip />
                </dt>
                <dd className="text-fg">
                  <Link
                    href={`/reputation/agent/${encodeURIComponent(user.agentId)}`}
                    className="inline-flex items-center gap-1 hover:text-fg"
                  >
                    <span className="font-mono text-xs">#{user.agentId}</span>
                    <span className="text-muted" aria-hidden>
                      ›
                    </span>
                  </Link>
                </dd>
              </div>
            )}
          </dl>

          {userState.status === 'loading' && (
            <p className="mt-3 text-xs text-muted">Looking up your account…</p>
          )}
          {userState.status === 'error' && (
            <p className="mt-3 text-xs text-danger">
              Couldn&apos;t reach the backend: {userState.message}
            </p>
          )}

          <div className="mt-6 flex flex-wrap gap-2 border-t border-primary/30 pt-4">
            <Link href="/trade/create" className={buttonClass('primary')}>
              Strike a bond
            </Link>
            <Link href="/trade" className={buttonClass('secondary')}>
              Your bonds
            </Link>
          </div>
        </section>
      )}

      {/* Agent linking (optional, advanced) lives on the profile page now,
          not on the landing surface. */}

      <footer className="mt-16 text-xs text-muted">
        Connected to{' '}
        <span className="font-mono">
          {process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3001'}
        </span>
        . Make sure the backend dev server is running.
      </footer>
    </main>
  );
}

// Hoverable "?" with a small popover explaining the ERC-8004 agentId
// concept and why it matters for arc-trade. Falls back to `title` for
// touch / keyboard users since the hover popover isn't focusable.
function AgentIdTooltip() {
  return (
    <span
      className="group relative inline-block cursor-help"
      tabIndex={0}
      role="button"
      aria-label="What is an Agent ID?"
      title="An ERC-8004 agentId is your portable, ERC-721-backed identity. Reputation accrues to the ID, not your wallet, so your trust history travels with you across apps and wallet rotations. Linking it lets Bezant surface your reputation badge next to your name on every trade."
    >
      <span className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-line-strong text-[10px] text-muted group-hover:text-fg">
        ?
      </span>
      <span className="invisible absolute left-0 top-full z-10 mt-2 w-72 rounded-lg border border-line bg-bg p-3 text-xs font-sans normal-case text-fg shadow-xl group-hover:visible group-focus:visible">
        <span className="block font-medium text-fg">What&apos;s an Agent ID?</span>
        <span className="mt-1 block">
          An ERC-8004 <span className="font-mono">agentId</span> is your portable,
          ERC-721-backed identity. Reputation accrues to the ID, not your wallet, so
          your trust history follows you across apps and wallet rotations.
        </span>
        <span className="mt-2 block text-muted">
          Linking it surfaces your <span className="text-warn">★ score</span>{' '}
          next to your name on every trade in Bezant.
        </span>
      </span>
    </span>
  );
}
