'use client';

import { useState } from 'react';
import Link from 'next/link';

// Lets the connected user link an ERC-8004 agentId to their arc-trade
// profile. Two paths:
//   - link an agentId they already own (verified on-chain by the backend)
//   - register a brand-new agent in one click (M32 — backend builds the
//     calldata, the wallet signs, then the new agentId is auto-linked)
// onRegister returns the new agentId after a successful mint + link;
// component just renders the state machine around it.
export function AgentLinkCard({
  currentAgentId,
  onLink,
  onRegister,
}: {
  currentAgentId: string | null;
  onLink: (agentId: string | null) => Promise<unknown>;
  onRegister: () => Promise<{ agentId: string }>;
}) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [registering, setRegistering] = useState<null | 'signing' | 'parsing' | 'linking'>(null);
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
          disabled={registering !== null}
          className="flex-1 rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none disabled:opacity-50"
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
          disabled={busy || registering !== null || !input.trim()}
          className="rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-950 hover:bg-white disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
        >
          {busy ? 'Verifying…' : 'Link'}
        </button>
      </div>

      <div className="mt-4 border-t border-neutral-800/60 pt-4">
        <p className="text-xs text-neutral-500">
          Don&apos;t have one yet? Register a fresh agent for your wallet in one
          click. One on-chain transaction, then it&apos;s auto-linked.
        </p>
        <button
          type="button"
          onClick={async () => {
            setError(null);
            setRegistering('signing');
            try {
              setRegistering('signing');
              const result = await onRegister();
              // onRegister wraps the full build → sign → parse → link flow.
              // If it resolves with an agentId, the parent's user state has
              // already been updated; we just need to surface success.
              void result;
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            } finally {
              setRegistering(null);
            }
          }}
          disabled={busy || registering !== null}
          className="mt-2 w-full rounded-lg border border-emerald-900/40 bg-emerald-950/30 px-4 py-2 text-sm font-medium text-emerald-200 hover:bg-emerald-950/50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {registering === 'signing'
            ? 'Waiting for signature…'
            : registering === 'parsing'
              ? 'Parsing receipt…'
              : registering === 'linking'
                ? 'Linking…'
                : 'Register a new agent'}
        </button>
      </div>

      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </section>
  );
}
