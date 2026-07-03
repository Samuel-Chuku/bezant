'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSigner } from '@/hooks/use-signer';
import { useUserRecord } from '@/hooks/use-user-record';

// Compact inline Telegram-alerts control for the profile header — a small pill
// that reads "Connect Telegram", shows "Connected" once linked, and disconnects
// on click when connected. Alerts fire when a trade needs the user's action.
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

  const base =
    'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition disabled:opacity-50';

  // No account row yet — Telegram needs one; nudge to set up a profile.
  if (user === null) {
    return (
      <span className={`${base} border-line text-muted`} title="Set up a profile first to enable alerts">
        <TelegramIcon /> Telegram
      </span>
    );
  }

  if (linked) {
    return (
      <button
        type="button"
        onClick={disconnect}
        disabled={busy}
        title="Telegram connected — click to disconnect"
        className={`${base} border-primary/40 bg-primary/10 text-primary hover:bg-primary/15`}
      >
        <TelegramIcon /> {busy ? '…' : 'Connected'} <CheckIcon />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={connect}
      disabled={busy}
      title={error || 'Get a Telegram ping when a trade needs your action'}
      className={`${base} border-line text-fg hover:border-line-strong hover:bg-surface-2`}
    >
      <TelegramIcon /> {busy ? 'Opening…' : awaiting ? 'Waiting…' : 'Connect Telegram'}
    </button>
  );
}

function TelegramIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}
