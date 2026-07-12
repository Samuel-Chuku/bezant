'use client';

import { useState } from 'react';
import { usePathname } from 'next/navigation';
import { useSigner } from '@/hooks/use-signer';
import { useUserRecord } from '@/hooks/use-user-record';
import { inputClass } from '@/components/ui/input';
import { Button } from '@/components/ui';

// Pure passthrough: the form POSTs straight to an n8n webhook (which fans out
// to Google Sheet + Telegram). No backend route, no stored copy. If the env
// var isn't set yet, submit fails gracefully with a clear note.
const WEBHOOK_URL = process.env.NEXT_PUBLIC_FEEDBACK_WEBHOOK_URL ?? '';

const TYPES = ['Bug', 'Idea', 'Other'] as const;
type FeedbackType = (typeof TYPES)[number];

type Status = 'idle' | 'sending' | 'sent' | 'error';

export function FeedbackForm({ onDone }: { onDone?: () => void }) {
  const signer = useSigner();
  const { state } = useUserRecord();
  const pathname = usePathname();
  const [type, setType] = useState<FeedbackType>('Idea');
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState('');

  const handle = state.status === 'ready' ? state.user?.handle ?? null : null;
  const address = signer.isConnected ? signer.address : null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim()) return;
    if (!WEBHOOK_URL) {
      setStatus('error');
      setError('Feedback isn’t configured yet.');
      return;
    }
    setStatus('sending');
    setError('');
    try {
      const res = await fetch(WEBHOOK_URL, {
        method: 'POST',
        // text/plain keeps this a CORS "simple request" so the browser skips the
        // preflight OPTIONS call - the usual cause of a bare "Failed to fetch"
        // against an n8n webhook. The body is still a JSON string; n8n exposes it
        // under $json.body (parse with JSON.parse if your workflow reads fields).
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({
          app: 'bezant',
          type,
          message: message.trim(),
          email: email.trim() || null,
          handle,
          address,
          page: pathname,
          url: typeof window !== 'undefined' ? window.location.href : null,
          userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
          ts: new Date().toISOString(),
        }),
      });
      if (!res.ok) throw new Error(`Webhook ${res.status}`);
      setStatus('sent');
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Failed to send');
    }
  };

  if (status === 'sent') {
    return (
      <div className="flex flex-col items-center gap-3 py-4 text-center bz-fadein">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/15 text-primary">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </span>
        <div>
          <p className="text-sm font-semibold text-fg">Feedback sent</p>
          <p className="mt-1 text-xs text-muted">Thanks — we read every note.</p>
        </div>
        {onDone && (
          <Button variant="secondary" size="sm" onClick={onDone}>
            Close
          </Button>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <p className="mb-1.5 text-xs font-medium text-muted">Type</p>
        <div className="flex gap-2">
          {TYPES.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setType(t)}
              className={[
                'rounded-lg border px-3 py-1.5 text-xs font-medium transition',
                type === t
                  ? 'border-primary bg-primary/10 text-fg'
                  : 'border-line text-muted hover:border-line-strong hover:text-fg',
              ].join(' ')}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label htmlFor="fb-message" className="mb-1.5 block text-xs font-medium text-muted">
          What’s on your mind?
        </label>
        <textarea
          id="fb-message"
          required
          rows={4}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Bug, idea, anything…"
          className={`${inputClass} resize-y`}
        />
      </div>

      <div>
        <label htmlFor="fb-email" className="mb-1.5 block text-xs font-medium text-muted">
          Email <span className="text-muted/70">(optional, for a reply)</span>
        </label>
        <input
          id="fb-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className={inputClass}
        />
      </div>

      {status === 'error' && <p className="text-xs text-danger">{error}</p>}

      <div className="flex items-center justify-end gap-2">
        {onDone && (
          <Button type="button" variant="ghost" size="sm" onClick={onDone}>
            Cancel
          </Button>
        )}
        <Button type="submit" size="sm" disabled={status === 'sending' || !message.trim()}>
          {status === 'sending' ? 'Sending…' : 'Send feedback'}
        </Button>
      </div>
    </form>
  );
}
