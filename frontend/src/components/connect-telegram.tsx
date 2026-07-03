'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSigner } from '@/hooks/use-signer';
import { useUserRecord } from '@/hooks/use-user-record';
import { Button } from '@/components/ui';

// Full Telegram-alerts control for the profile page: link status +
// connect/disconnect. Alerts fire when a trade needs the user's action.
export function ConnectTelegram() {
  const signer = useSigner();
  const { state, reload, linkTelegram, unlinkTelegram } = useUserRecord();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [awaiting, setAwaiting] = useState(false);

  const user = state.status === 'ready' ? state.user : null;
  const linked = user?.telegramLinked ?? false;

  // Linking happens out-of-band (in Telegram), so poll for the updated status
  // for a minute after the deep link is opened.
  useEffect(() => {
    if (!awaiting) return;
    let ticks = 0;
    const id = window.setInterval(() => {
      ticks += 1;
      reload();
      if (ticks >= 20) {
        setAwaiting(false);
        window.clearInterval(id);
      }
    }, 3000);
    return () => window.clearInterval(id);
  }, [awaiting, reload]);

  useEffect(() => {
    if (linked && awaiting) setAwaiting(false);
  }, [linked, awaiting]);

  const connect = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const url = await linkTelegram();
      window.open(url, '_blank', 'noopener');
      setAwaiting(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start link');
    } finally {
      setBusy(false);
    }
  }, [linkTelegram]);

  const disconnect = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      await unlinkTelegram();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect');
    } finally {
      setBusy(false);
    }
  }, [unlinkTelegram]);

  if (!signer.isConnected) return null;

  return (
    <div className="rounded-2xl border border-line bg-surface p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <TelegramIcon />
            <h3 className="font-medium text-fg">Telegram alerts</h3>
            {linked && (
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">Connected</span>
            )}
          </div>
          <p className="mt-1 max-w-sm text-xs text-muted">
            Get a ping when a trade needs your action — fund, deliver, respond, or vote.
          </p>
        </div>
        {user === null ? (
          <span className="shrink-0 text-xs text-muted">Set up a profile first</span>
        ) : linked ? (
          <Button variant="secondary" size="sm" onClick={disconnect} disabled={busy}>
            {busy ? '…' : 'Disconnect'}
          </Button>
        ) : (
          <Button size="sm" onClick={connect} disabled={busy}>
            {busy ? 'Opening…' : 'Connect Telegram'}
          </Button>
        )}
      </div>
      {awaiting && !linked && (
        <p className="mt-3 text-xs text-muted">
          Waiting for you to tap <span className="text-fg">Start</span> in Telegram…
        </p>
      )}
      {error && <p className="mt-3 text-xs text-danger">{error}</p>}
    </div>
  );
}

function TelegramIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="text-primary" aria-hidden>
      <path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z" />
    </svg>
  );
}
