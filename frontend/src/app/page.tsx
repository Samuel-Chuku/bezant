'use client';

import { useState } from 'react';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useBalance } from 'wagmi';
import { useSigner } from '@/hooks/use-signer';
import { useUserRecord } from '@/hooks/use-user-record';
import { EmailSignIn } from '@/components/email-sign-in';
import { HandlePrompt } from '@/components/handle-prompt';

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export default function Home() {
  const signer = useSigner();
  const { data: balance } = useBalance({ address: signer.address });
  const { state: userState, claimHandle } = useUserRecord();
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
              <h3 className="font-medium">Sign in with passkey</h3>
              <p className="mt-1 text-xs text-neutral-500">
                Backed by a Circle smart account on Arc. No wallet required.
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
