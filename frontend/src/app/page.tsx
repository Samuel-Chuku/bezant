'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useBalance } from 'wagmi';
import { useSigner } from '@/hooks/use-signer';
import { useUserRecord } from '@/hooks/use-user-record';
import { EmailSignIn } from '@/components/email-sign-in';
import { HandlePrompt } from '@/components/handle-prompt';
import { AgentLinkCard } from '@/components/agent-link-card';

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export default function Home() {
  const signer = useSigner();
  const { data: balance } = useBalance({ address: signer.address });
  const { state: userState, claimHandle, linkAgentId, registerAgent } = useUserRecord();
  const [handlePromptDismissed, setHandlePromptDismissed] = useState(false);

  const user = userState.status === 'ready' ? userState.user : null;
  const displayName = user?.handle ?? (signer.isConnected ? shortAddress(signer.address) : null);
  // Show the "claim a handle?" prompt when the user is connected and either
  // (a) has no backend record yet, or (b) has a record but no handle (legacy).
  const shouldShowHandlePrompt =
    userState.status === 'ready' &&
    (user === null || user.handle === null) &&
    !handlePromptDismissed;

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <header className="mb-12">
        <h1 className="text-4xl font-semibold tracking-tight">arc-trade</h1>
        <p className="mt-2 text-neutral-400">
          Agentic commerce on Arc — escrow-backed trades between humans and agents.
        </p>
      </header>

      {!signer.isConnected && (
        <section className="rounded-2xl border border-neutral-800 bg-neutral-900/50 p-6">
          <h2 className="text-lg font-medium">Get started</h2>
          <p className="mt-1 text-sm text-neutral-400">
            Choose how you want to sign. Both paths use the same backend; the only difference is who
            holds your key.
          </p>

          <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="rounded-xl border border-neutral-800 bg-neutral-950/40 p-5">
              <h3 className="font-medium">Connect a wallet</h3>
              <p className="mt-1 text-xs text-neutral-500">
                MetaMask, Coinbase, WalletConnect. You keep your own keys.
              </p>
              <div className="mt-4">
                <ConnectButton />
              </div>
            </div>

            <div className="rounded-xl border border-neutral-800 bg-neutral-950/40 p-5">
              <h3 className="font-medium">Sign in with email</h3>
              <p className="mt-1 text-xs text-neutral-500">
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
        <section className="rounded-2xl border border-emerald-900/40 bg-emerald-950/20 p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-sm font-medium uppercase tracking-wide text-emerald-400">
                Connected ({signer.mode === 'external' ? 'wallet' : 'passkey'})
              </h2>
              <p className="mt-1 text-xs text-neutral-500">
                {signer.mode === 'external'
                  ? 'Signing locally via your browser wallet.'
                  : 'Signing via your Circle smart account. Gas sponsored by Circle paymaster.'}
              </p>
            </div>
            <button
              type="button"
              onClick={() => signer.disconnect?.()}
              className="rounded-lg border border-neutral-800 px-3 py-1.5 text-xs text-neutral-400 hover:text-neutral-100"
            >
              Disconnect
            </button>
          </div>

          <dl className="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            {displayName && (
              <div>
                <dt className="text-neutral-500">Signed in as</dt>
                <dd className="text-neutral-100">
                  {user?.handle ? (
                    <span className="font-medium">{user.handle}</span>
                  ) : (
                    <span className="font-mono text-xs text-neutral-300">{displayName}</span>
                  )}
                </dd>
              </div>
            )}
            <div>
              <dt className="text-neutral-500">Address</dt>
              <dd className="font-mono text-xs text-neutral-200 break-all">{signer.address}</dd>
            </div>
            {user?.agentId && (
              <div>
                <dt className="inline-flex items-center gap-1.5 text-neutral-500">
                  Agent ID
                  <AgentIdTooltip />
                </dt>
                <dd className="text-neutral-200">
                  <Link
                    href={`/reputation/agent/${encodeURIComponent(user.agentId)}`}
                    className="inline-flex items-center gap-1 hover:text-neutral-100"
                  >
                    <span className="font-mono text-xs">#{user.agentId}</span>
                    <span className="text-neutral-500" aria-hidden>
                      ›
                    </span>
                  </Link>
                </dd>
              </div>
            )}
            {balance && (
              <div className="sm:col-span-2">
                <dt className="text-neutral-500">{balance.symbol} balance</dt>
                <dd className="text-neutral-200">
                  {balance.formatted} {balance.symbol}
                </dd>
              </div>
            )}
          </dl>

          {userState.status === 'loading' && (
            <p className="mt-3 text-xs text-neutral-500">Looking up your account…</p>
          )}
          {userState.status === 'error' && (
            <p className="mt-3 text-xs text-red-400">
              Couldn&apos;t reach the backend: {userState.message}
            </p>
          )}

          <div className="mt-6 flex flex-wrap gap-2 border-t border-emerald-900/30 pt-4">
            <Link
              href="/create"
              className="rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-950 transition hover:bg-white"
            >
              Create a job
            </Link>
            <Link
              href="/jobs"
              className="rounded-lg border border-neutral-800 px-4 py-2 text-sm text-neutral-300 transition hover:text-neutral-100"
            >
              My jobs
            </Link>
          </div>
        </section>
      )}

      {shouldShowHandlePrompt && (
        <div className="mt-6">
          <HandlePrompt
            onClaim={async (handle) => {
              await claimHandle(handle);
              setHandlePromptDismissed(true);
            }}
            onSkip={() => setHandlePromptDismissed(true)}
          />
        </div>
      )}

      {/* Show the agent-link card once the user actually has a backend
          record (i.e. they've already claimed a handle). Linking before
          that point would 404 — see the hook. */}
      {signer.isConnected && userState.status === 'ready' && userState.user && (
        <div className="mt-6">
          <AgentLinkCard
            currentAgentId={userState.user.agentId}
            onLink={(agentId) => linkAgentId(agentId)}
            onRegister={() => registerAgent()}
          />
        </div>
      )}

      <footer className="mt-16 text-xs text-neutral-600">
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
      title="An ERC-8004 agentId is your portable, ERC-721-backed identity. Reputation accrues to the ID, not your wallet, so your trust history travels with you across apps and wallet rotations. Linking it lets arc-trade surface your reputation badge next to your name on every job."
    >
      <span className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-neutral-700 text-[10px] text-neutral-500 group-hover:text-neutral-300">
        ?
      </span>
      <span className="invisible absolute left-0 top-full z-10 mt-2 w-72 rounded-lg border border-neutral-800 bg-neutral-950 p-3 text-xs font-sans normal-case text-neutral-300 shadow-xl group-hover:visible group-focus:visible">
        <span className="block font-medium text-neutral-100">What's an Agent ID?</span>
        <span className="mt-1 block">
          An ERC-8004 <span className="font-mono">agentId</span> is your portable,
          ERC-721-backed identity. Reputation accrues to the ID, not your wallet —
          your trust history follows you across apps and wallet rotations.
        </span>
        <span className="mt-2 block text-neutral-400">
          Linking it surfaces your <span className="text-amber-300">★ score</span>{' '}
          next to your name on every job in arc-trade.
        </span>
      </span>
    </span>
  );
}
