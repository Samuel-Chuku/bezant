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
        <div className="rounded-xl border border-info/30 bg-info/10 p-4">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-info">Agent linked</div>
          <p className="mt-1 font-mono text-sm text-info">#{currentAgentId}</p>
          <div className="mt-2 flex items-center gap-3 text-[11px]">
            <Link href={`/reputation/agent/${encodeURIComponent(currentAgentId)}`} className="text-primary underline hover:text-primary-hover">
              View reputation
            </Link>
            <button type="button" onClick={doUnlink} disabled={busy} className="text-muted hover:text-fg disabled:opacity-50">
              {busy ? 'Unlinking…' : 'Unlink'}
            </button>
          </div>
          {error && <p className="mt-2 text-[11px] text-danger">{error}</p>}
        </div>
      );
    }
    return (
      <div className="rounded-xl border border-info/30 bg-info/10 p-4">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-info">ERC-8004 agent</div>
        <p className="mt-1 text-[11px] leading-snug text-info/70">Optional - link or mint an agent to carry your reputation across Bezant.</p>
        <div className="mt-2 flex gap-1.5">
          <input
            type="text"
            inputMode="numeric"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="agentId"
            disabled={registering !== null}
            className="w-full min-w-0 rounded-md border border-line bg-bg px-2 py-1.5 font-mono text-xs text-fg placeholder:text-muted focus:border-primary focus:outline-none disabled:opacity-50"
          />
          <button
            type="button"
            onClick={doLink}
            disabled={busy || registering !== null || !input.trim()}
            className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-fg hover:bg-primary-hover disabled:opacity-50"
          >
            {busy ? '…' : 'Link'}
          </button>
        </div>
        <button
          type="button"
          onClick={doRegister}
          disabled={busy || registering !== null}
          className="mt-2 w-full rounded-md border border-primary/40 bg-primary/12 px-3 py-1.5 text-xs font-medium text-primary transition hover:bg-primary/25 disabled:opacity-50"
        >
          {registering ? registerLabel : 'Register a new agent'}
        </button>
        {error && <p className="mt-2 text-[11px] text-danger">{error}</p>}
      </div>
    );
  }

  // ── Full standalone card ──
  if (currentAgentId !== null) {
    return (
      <section className="rounded-2xl border border-line bg-surface/40 p-5">
        <h2 className="text-sm font-medium text-fg">ERC-8004 agent linked</h2>
        <p className="mt-1 text-xs text-muted">
          Reputation reads on this address will resolve to agent <span className="font-mono">#{currentAgentId}</span>.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link
            href={`/reputation/agent/${encodeURIComponent(currentAgentId)}`}
            className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-fg hover:bg-primary-hover"
          >
            View reputation
          </Link>
          <button
            type="button"
            onClick={doUnlink}
            disabled={busy}
            className="rounded-lg border border-line-strong px-3 py-1.5 text-xs text-fg hover:bg-surface-2 disabled:opacity-50"
          >
            {busy ? 'Unlinking…' : 'Unlink'}
          </button>
        </div>
        {error && <p className="mt-2 text-xs text-danger">{error}</p>}
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-line bg-surface/40 p-5">
      <h2 className="text-sm font-medium text-fg">Link your ERC-8004 agent</h2>
      <p className="mt-1 text-xs text-muted">
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
          className="flex-1 rounded-lg border border-line bg-bg px-3 py-2 font-mono text-sm text-fg placeholder:text-muted focus:border-primary focus:outline-none disabled:opacity-50"
        />
        <button
          type="button"
          onClick={doLink}
          disabled={busy || registering !== null || !input.trim()}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-fg hover:bg-primary-hover disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-muted"
        >
          {busy ? 'Verifying…' : 'Link'}
        </button>
      </div>

      <div className="mt-4 border-t border-line/60 pt-4">
        <p className="text-xs text-muted">
          Don&apos;t have one yet? Register a fresh agent for your wallet in one click. One on-chain transaction, then it&apos;s auto-linked.
        </p>
        <button
          type="button"
          onClick={doRegister}
          disabled={busy || registering !== null}
          className="mt-2 w-full rounded-lg border border-primary/40 bg-primary/12 px-4 py-2 text-sm font-medium text-primary hover:bg-primary/50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {registerLabel}
        </button>
      </div>

      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
    </section>
  );
}
