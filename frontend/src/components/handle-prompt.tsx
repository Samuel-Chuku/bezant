'use client';

import { useState } from 'react';

type HandlePromptProps = {
  onClaim: (handle: string) => Promise<unknown>;
  onSkip: () => void;
};

export function HandlePrompt({ onClaim, onSkip }: HandlePromptProps) {
  const [handle, setHandle] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = handle.trim();
    if (!trimmed) return;
    setIsSubmitting(true);
    setError(null);
    try {
      await onClaim(trimmed);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="rounded-2xl border border-neutral-800 bg-neutral-900/50 p-6">
      <h3 className="font-medium">Want to claim a handle?</h3>
      <p className="mt-1 text-sm text-neutral-400">
        Pick a short name people can use to find or address you. It's optional — you can keep
        trading just with your wallet address — but a handle gives you a few things:
      </p>
      <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-neutral-400">
        <li>Other users can post jobs to you by handle instead of a 0x address.</li>
        <li>Your reputation accrues against a stable identity, not an opaque address.</li>
        <li>You're easier to recognize in trade history and on-chain logs.</li>
      </ul>
      <p className="mt-3 text-xs text-amber-400/80">
        Handles are <strong>permanent once claimed</strong> — choose carefully. You can't rename or
        release one later.
      </p>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <input
          type="text"
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          placeholder="your-handle"
          disabled={isSubmitting}
          className="flex-1 rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
        />
        <button
          type="button"
          onClick={submit}
          disabled={isSubmitting || handle.trim().length === 0}
          className="rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-950 transition hover:bg-white disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
        >
          {isSubmitting ? 'Claiming…' : 'Claim handle'}
        </button>
        <button
          type="button"
          onClick={onSkip}
          disabled={isSubmitting}
          className="rounded-lg border border-neutral-800 px-4 py-2 text-sm text-neutral-400 hover:text-neutral-100 disabled:opacity-50"
        >
          Skip
        </button>
      </div>

      {error && <p className="mt-3 text-xs text-red-400 break-words">{error}</p>}
    </div>
  );
}
