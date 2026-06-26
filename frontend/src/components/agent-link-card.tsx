'use client';

import { useState } from 'react';
import Link from 'next/link';

// Lets the connected user link an ERC-8004 agentId to their arc-trade
// profile. Two paths:
//   - link an agentId they already own (verified on-chain by the backend)
//   - register a brand-new agent in one click (M32 - backend builds the
//     calldata, the wallet signs, then the new agentId is auto-linked)
// `variant='compact'` renders a tight, violet-tinted panel that tucks into the
// identity card's spare space; 'full' is the original standalone card.
export function AgentLinkCard({
  currentAgentId,
  onLink,
  onRegister,
  variant = 'full',
}: {
  currentAgentId: string | null;
  onLink: (agentId: string | null) => Promise<unknown>;
  onRegister: () => Promise<{ agentId: string }>;
  variant?: 'full' | 'compact';
}) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [registering, setRegistering] = useState<null | 'signing' | 'parsing' | 'linking'>(null);
  const [error, setError] = useState<string | null>(null);

  const doLink = async () => {
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
  };

  const doUnlink = async () => {
    setBusy(true);
    setError(null);
    try {
      await onLink(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const doRegister = async () => {
    setError(null);
    setRegistering('signing');
    try {
      await onRegister();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRegistering(null);
    }
  };

  const registerLabel =
    registering === 'signing'
      ? 'Waiting for signature…'
      : registering === 'parsing'
        ? 'Parsing receipt…'
        : registering === 'linking'
          ? 'Linking…'
          : 'Register a new agent';

  // ── Compact, violet-tinted variant for the identity card corner ──
  if (variant === 'compact') {
    if (currentAgentId !== null) {
      return (
        <div className="rounded-xl border border-violet-800/50 bg-violet-950/25 p-4">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-violet-300">Agent linked</div>
          <p className="mt-1 font-mono text-sm text-violet-100">#{currentAgentId}</p>
          <div className="mt-2 flex items-center gap-3 text-[11px]">
            <Link href={`/reputation/agent/${encodeURIComponent(currentAgentId)}`} className="text-violet-300 underline hover:text-violet-200">
              View reputation
            </Link>
            <button type="button" onClick={doUnlink} disabled={busy} className="text-violet-300/70 hover:text-violet-200 disabled:opacity-50">
              {busy ? 'Unlinking…' : 'Unlink'}
            </button>
          </div>
          {error && <p className="mt-2 text-[11px] text-red-400">{error}</p>}
        </div>
      );
    }
    return (
      <div className="rounded-xl border border-violet-800/50 bg-violet-950/25 p-4">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-violet-300">ERC-8004 agent</div>
        <p className="mt-1 text-[11px] leading-snug text-violet-300/70">Optional - link or mint an agent to carry your reputation across Bezant.</p>
        <div className="mt-2 flex gap-1.5">
          <input
            type="text"
            inputMode="numeric"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="agentId"
            disabled={registering !== null}
            className="w-full min-w-0 rounded-md border border-violet-800/50 bg-violet-950/40 px-2 py-1.5 font-mono text-xs text-violet-100 placeholder:text-violet-300/40 focus:border-violet-600 focus:outline-none disabled:opacity-50"
          />
          <button
            type="button"
            onClick={doLink}
            disabled={busy || registering !== null || !input.trim()}
            className="shrink-0 rounded-md bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-500 disabled:opacity-50"
          >
            {busy ? '…' : 'Link'}
          </button>
        </div>
        <button
          type="button"
          onClick={doRegister}
          disabled={busy || registering !== null}
          className="mt-2 w-full rounded-md border border-violet-700/60 px-3 py-1.5 text-xs font-medium text-violet-200 transition hover:bg-violet-900/40 disabled:opacity-50"
        >
          {registering ? registerLabel : 'Register a new agent'}
        </button>
        {error && <p className="mt-2 text-[11px] text-red-400">{error}</p>}
      </div>
    );
  }

  // ── Full standalone card ──
  if (currentAgentId !== null) {
    return (
      <section className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-5">
        <h2 className="text-sm font-medium text-neutral-300">ERC-8004 agent linked</h2>
        <p className="mt-1 text-xs text-neutral-500">
          Reputation reads on this address will resolve to agent <span className="font-mono">#{currentAgentId}</span>.
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
            onClick={doUnlink}
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
        Optional. If you own an agent on the IdentityRegistry, link its agentId here to surface your reputation across Bezant.
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
          onClick={doLink}
          disabled={busy || registering !== null || !input.trim()}
          className="rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-950 hover:bg-white disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
        >
          {busy ? 'Verifying…' : 'Link'}
        </button>
      </div>

      <div className="mt-4 border-t border-neutral-800/60 pt-4">
        <p className="text-xs text-neutral-500">
          Don&apos;t have one yet? Register a fresh agent for your wallet in one click. One on-chain transaction, then it&apos;s auto-linked.
        </p>
        <button
          type="button"
          onClick={doRegister}
          disabled={busy || registering !== null}
          className="mt-2 w-full rounded-lg border border-emerald-900/40 bg-emerald-950/30 px-4 py-2 text-sm font-medium text-emerald-200 hover:bg-emerald-950/50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {registerLabel}
        </button>
      </div>

      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </section>
  );
}
