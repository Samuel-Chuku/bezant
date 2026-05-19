'use client';

import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount, useBalance } from 'wagmi';

export default function Home() {
  const { address, isConnected, chain } = useAccount();
  const { data: balance } = useBalance({ address });

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <header className="mb-12">
        <h1 className="text-4xl font-semibold tracking-tight">arc-trade</h1>
        <p className="mt-2 text-neutral-400">
          Agentic commerce on Arc — escrow-backed trades between humans and agents.
        </p>
      </header>

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

          <div className="rounded-xl border border-neutral-800 bg-neutral-950/40 p-5 opacity-60">
            <h3 className="font-medium">Sign in with email</h3>
            <p className="mt-1 text-xs text-neutral-500">
              Passkey-backed smart account via Circle. No wallet required.
            </p>
            <button
              type="button"
              disabled
              className="mt-4 w-full rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-2 text-sm text-neutral-500"
            >
              Coming next milestone
            </button>
          </div>
        </div>
      </section>

      {isConnected && address && (
        <section className="mt-8 rounded-2xl border border-emerald-900/40 bg-emerald-950/20 p-6">
          <h2 className="text-sm font-medium uppercase tracking-wide text-emerald-400">
            Connected
          </h2>
          <dl className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-neutral-500">Address</dt>
              <dd className="font-mono text-xs text-neutral-200 break-all">{address}</dd>
            </div>
            <div>
              <dt className="text-neutral-500">Chain</dt>
              <dd className="text-neutral-200">
                {chain ? `${chain.name} (id ${chain.id})` : 'unknown'}
              </dd>
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
        </section>
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
