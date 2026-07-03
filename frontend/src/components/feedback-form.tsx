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
        headers: { 'Content-Type': 'application/json' },
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
      <div className="space-y-3 py-2 text-center">
        <p className="text-sm font-medium text-fg">Thanks — feedback sent.</p>
        <p className="text-xs text-muted">We read every note.</p>
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
