'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useSigner } from '@/hooks/use-signer';
import { useUserRecord } from '@/hooks/use-user-record';
import { AgentLinkCard } from '@/components/agent-link-card';
import { Skeleton } from '@/components/async-state';

// Index route - sends the user to their own reputation page when their
// address has an agentId linked. Otherwise renders the linking prompt or
// a connect-wallet hint.
export default function ReputationIndexPage() {
  const router = useRouter();
  const signer = useSigner();
  const { state: userState, linkAgentId, registerAgent } = useUserRecord();

  const user = userState.status === 'ready' ? userState.user : null;
  const linkedAgentId = user?.agentId ?? null;

  useEffect(() => {
    if (linkedAgentId) {
      router.replace(`/reputation/agent/${encodeURIComponent(linkedAgentId)}`);
    }
  }, [linkedAgentId, router]);

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <header className="mb-8">
        <h1 className="font-display text-3xl font-semibold tracking-tight">Reputation</h1>
        <p className="mt-2 text-sm text-muted">
          ERC-8004 reputation feedback for any agent on Arc. Link your own
          agent to surface your record here and on every pact page.
        </p>
      </header>

      {!signer.isConnected && (
        <section className="bz-frame rounded-2xl border border-line bg-surface/40 p-6">
          <p className="text-sm text-fg">
            Connect a wallet to see your linked agent&apos;s reputation.
          </p>
          <p className="mt-2 text-xs text-muted">
            You can browse any agent&apos;s feedback at{' '}
            <span className="font-mono text-fg">/reputation/agent/[id]</span>{' '}
            once you know the agentId.
          </p>
        </section>
      )}

      {signer.isConnected && userState.status === 'loading' && (
        <div className="space-y-3">
          <Skeleton className="h-4 w-64" />
          <Skeleton className="h-32 w-full rounded-2xl" />
        </div>
      )}

      {signer.isConnected && userState.status === 'ready' && !linkedAgentId && (
        <section className="space-y-6">
          <p className="text-sm text-fg">
            You haven&apos;t linked an ERC-8004 agent yet. Link an existing one
            or register a new agent below. Your reputation will surface here
            once linked.
          </p>
          <AgentLinkCard
            currentAgentId={null}
            onLink={(agentId) => linkAgentId(agentId)}
            onRegister={() => registerAgent()}
          />
          <p className="text-xs text-muted">
            Already know an agentId? Visit{' '}
            <Link href="/reputation/agent/1" className="text-fg hover:text-fg">
              /reputation/agent/&lt;id&gt;
            </Link>{' '}
            directly.
          </p>
        </section>
      )}

      {linkedAgentId && (
        <p className="text-sm text-muted">
          Redirecting to{' '}
          <Link
            href={`/reputation/agent/${encodeURIComponent(linkedAgentId)}`}
            className="text-fg hover:text-fg"
          >
            agent #{linkedAgentId}
          </Link>
          …
        </p>
      )}
    </main>
  );
}
