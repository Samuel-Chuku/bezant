'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useSigner } from '@/hooks/use-signer';
import { useUserRecord } from '@/hooks/use-user-record';
import { PassportPanel } from '@/components/passport-panel';
import { HandlePrompt } from '@/components/handle-prompt';
import { AgentLinkCard } from '@/components/agent-link-card';
import { Avatar } from '@/components/avatar';
import { getPoolStats, type PoolStats } from '@/lib/api';
import { shortAddress } from '@/lib/format';

// Profile hub: identity (handle / address / signing mode / agent ID), credit
// passport, and the user's LP position in the financing pool. Identity-
// management actions (claim handle, link agent) live here too.
export default function ProfilePage() {
  const signer = useSigner();
  const { state: userState, claimHandle, linkAgentId, registerAgent } = useUserRecord();

  const user = userState.status === 'ready' ? userState.user : null;
  const showHandlePrompt =
    userState.status === 'ready' && (user === null || user.handle === null);

  if (!signer.isConnected) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-3xl font-semibold tracking-tight">Profile</h1>
        <p className="mt-6 text-sm text-neutral-400">
          Connect a wallet or sign in to see your profile.{' '}
          <Link href="/" className="underline">
            Sign in
          </Link>
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Profile</h1>

      <div className="mt-6 space-y-6">
        {/* Identity */}
        <section className="rounded-xl border border-neutral-800 bg-neutral-950/50 p-5">
          <div className="flex items-center gap-4">
            <Avatar address={signer.address} size={48} />
            <div className="min-w-0">
              <div className="truncate text-lg font-medium text-neutral-100">
                {user?.handle ? `@${user.handle}` : shortAddress(signer.address)}
              </div>
              <div className="font-mono text-xs text-neutral-500">{signer.address}</div>
            </div>
          </div>

          <dl className="mt-5 grid grid-cols-2 gap-4 text-sm">
            <Field label="Signing">
              {signer.mode === 'external' ? 'Browser wallet' : 'Email + passkey'}
            </Field>
            {user?.createdAt && (
              <Field label="Member since">
                {new Date(user.createdAt).toLocaleDateString(undefined, {
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
                })}
              </Field>
            )}
            {user?.agentId && (
              <Field label="Agent ID">
                <Link
                  href={`/reputation/agent/${encodeURIComponent(user.agentId)}`}
                  className="font-mono text-neutral-200 hover:text-neutral-100"
                >
                  #{user.agentId} ›
                </Link>
              </Field>
            )}
          </dl>

          {userState.status === 'loading' && (
            <p className="mt-3 text-xs text-neutral-500">Looking up your account…</p>
          )}
          {userState.status === 'error' && (
            <p className="mt-3 text-xs text-red-400">Couldn&apos;t reach the backend: {userState.message}</p>
          )}
        </section>

        {/* Credit passport */}
        <PassportPanel address={signer.address} />

        {/* LP position */}
        <LpPositionCard address={signer.address} />

        {/* Claim a handle if none yet */}
        {showHandlePrompt && (
          <HandlePrompt onClaim={(handle) => claimHandle(handle)} onSkip={() => {}} />
        )}

        {/* Agent linking — only once a backend record exists */}
        {userState.status === 'ready' && user && (
          <AgentLinkCard
            currentAgentId={user.agentId}
            onLink={(agentId) => linkAgentId(agentId)}
            onRegister={() => registerAgent()}
          />
        )}
      </div>
    </main>
  );
}

// Compact read-only view of the user's stake in the financing pool. Deposits
// and withdrawals happen on the /pool page; this just surfaces the position.
function LpPositionCard({ address }: { address: string }) {
  const [stats, setStats] = useState<PoolStats | null>(null);

  useEffect(() => {
    let live = true;
    getPoolStats(address)
      .then((s) => live && setStats(s))
      .catch(() => {
        /* pool unreachable — leave null */
      });
    return () => {
      live = false;
    };
  }, [address]);

  const hasPosition = stats?.myShares && stats.myShares !== '0';

  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-950/50 p-5">
      <div className="flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-wide text-neutral-500">Financing pool (LP)</div>
        <Link href="/pool" className="text-xs text-neutral-400 hover:text-neutral-100">
          Manage ›
        </Link>
      </div>

      {!stats ? (
        <p className="mt-3 text-sm text-neutral-500">Pool unavailable.</p>
      ) : hasPosition ? (
        <div className="mt-3 flex items-end gap-8 text-sm">
          <div>
            <div className="text-2xl font-semibold text-emerald-300">{stats.myValueUsdc} USDC</div>
            <div className="text-xs text-neutral-500">your position</div>
          </div>
          <div>
            <div className={stats.sharePrice >= 1 ? 'text-lg text-emerald-300' : 'text-lg text-red-300'}>
              {stats.sharePrice >= 1 ? '+' : ''}
              {((stats.sharePrice - 1) * 100).toFixed(2)}%
            </div>
            <div className="text-xs text-neutral-500">pool yield</div>
          </div>
        </div>
      ) : (
        <p className="mt-3 text-sm text-neutral-400">
          You haven&apos;t deposited yet.{' '}
          <Link href="/pool" className="underline hover:text-neutral-200">
            Learn about the pool →
          </Link>
        </p>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-neutral-500">{label}</dt>
      <dd className="mt-0.5 text-neutral-200">{children}</dd>
    </div>
  );
}
