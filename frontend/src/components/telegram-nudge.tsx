'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSigner } from '@/hooks/use-signer';
import { useUserRecord } from '@/hooks/use-user-record';

const DISMISS_KEY = 'bezant:telegram-nudge-dismissed';

// Compact inline suggestion to turn on Telegram alerts, for action-heavy pages
// (verify, pool, trades). Hidden once linked, dismissed, or if there's no
// account yet. The full control lives on the profile page.
export function TelegramNudge() {
  const signer = useSigner();
  const { state, linkTelegram } = useUserRecord();
  const [mounted, setMounted] = useState(false);
  const [dismissed, setDismissed] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setMounted(true);
    try {
      setDismissed(window.localStorage.getItem(DISMISS_KEY) === '1');
    } catch {
      /* storage blocked */
    }
  }, []);

  const user = state.status === 'ready' ? state.user : null;

  const connect = useCallback(async () => {
    setBusy(true);
    try {
      const url = await linkTelegram();
      window.open(url, '_blank', 'noopener');
    } catch {
      /* errors are surfaced on the profile control */
    } finally {
      setBusy(false);
    }
  }, [linkTelegram]);

  const dismiss = () => {
    try {
      window.localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* ignore */
    }
    setDismissed(true);
  };

  if (!mounted || dismissed) return null;
  if (!signer.isConnected || user === null || user.telegramLinked) return null;

  return (
    <div className="mb-4 flex items-center gap-3 rounded-xl border border-line bg-surface/60 px-4 py-2.5">
      <span className="text-sm" aria-hidden>🔔</span>
      <p className="flex-1 text-xs text-muted">
        <span className="font-medium text-fg">Get alerts on Telegram</span> when a trade needs your action.
      </p>
      <button
        type="button"
        onClick={connect}
        disabled={busy}
        className="shrink-0 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-fg transition hover:bg-primary-hover disabled:opacity-50"
      >
        {busy ? 'Opening…' : 'Connect'}
      </button>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="shrink-0 rounded-md p-1 text-muted hover:bg-surface-2 hover:text-fg"
      >
        ×
      </button>
    </div>
  );
}
