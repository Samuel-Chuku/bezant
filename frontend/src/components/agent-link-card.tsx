'use client';

import { useState } from 'react';
import Link from 'next/link';

// Lets the connected user link an ERC-8004 agentId to their arc-trade
// profile. The backend verifies on-chain ownership before persisting, so
// errors here typically mean: wallet isn't the owner, agent doesn't exist,
// or someone else already claimed it.
export function AgentLinkCard({
  currentAgentId,
  onLink,
}: {
  currentAgentId: string | null;
  onLink: (agentId: string | null) => Promise<unknown>;
}) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (currentAgentId !== null) {
    return (
      <section className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-5">
        <h2 className="text-sm font-medium text-neutral-300">ERC-8004 agent linked</h2>
        <p className="mt-1 text-xs text-neutral-500">
          Reputation reads on this address will resolve to agent{' '}
          <span className="font-mono">#{currentAgentId}</span>.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link
            href={`/reputation/agent/${encodeURIComponent(currentAgentId)}`}
            className="rounded-lg bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-950 hover:bg-white"
          >
            View reputation
          </Link>
          <button
            type="button"
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onLink(null);
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              } finally {
                setBusy(false);
              }
            }}
            disabled={busy}
            className="rounded-lg border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
          >
            {busy ? 'Unlinking…' : 'Unlink'}
          </button>
        </div>
        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-5">
      <h2 className="text-sm font-medium text-neutral-300">Link your ERC-8004 agent</h2>
      <p className="mt-1 text-xs text-neutral-500">
        Optional. If you own an agent on the IdentityRegistry, link its agentId
        here to surface your reputation across arc-trade.
      </p>
      <div className="mt-3 flex gap-2">
        <input
          type="text"
          inputMode="numeric"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="e.g. 42"
          className="flex-1 rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
        />
        <button
          type="button"
          onClick={async () => {
            const trimmed = input.trim();
            if (!/^\d+$/.test(trimmed)) {
              setError('agentId must be a positive integer');
              return;
            }
            setBusy(true);
            setError(null);
            try {
              await onLink(trimmed);
              setInput('');
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            } finally {
              setBusy(false);
            }
          }}
          disabled={busy || !input.trim()}
          className="rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-950 hover:bg-white disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
        >
          {busy ? 'Verifying…' : 'Link'}
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </section>
  );
}
