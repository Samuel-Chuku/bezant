'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSigner } from '@/hooks/use-signer';
import { useUserRecord } from '@/hooks/use-user-record';
import { HandlePrompt } from './handle-prompt';

const DISMISS_KEY = 'arc-trade:profile-banner-dismissed';

// Global, dismissible nudge to claim a handle. Replaces the inline handle
// prompt that used to persist on the home and profile pages - claiming a
// handle is optional, so it lives in an out-of-the-way banner + modal.
export function ProfileSetupBanner() {
  const signer = useSigner();
  const { state, claimHandle } = useUserRecord();
  const [dismissed, setDismissed] = useState(true); // hidden until we read storage (no flash)
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    setDismissed(window.localStorage.getItem(DISMISS_KEY) === '1');
  }, []);

  const user = state.status === 'ready' ? state.user : null;
  const needsHandle = state.status === 'ready' && (user === null || user.handle === null);

  if (!mounted || !signer.isConnected || !needsHandle || dismissed) return null;

  const dismiss = () => {
    window.localStorage.setItem(DISMISS_KEY, '1');
    setDismissed(true);
  };

  return (
    <>
      <div className="border-b border-line/80 bg-surface/40">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-2 sm:px-6">
          <span className="hidden h-6 w-6 shrink-0 items-center justify-center rounded-md bg-surface-2 text-fg sm:inline-flex" aria-hidden>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="8" r="4" />
              <path d="M4 21a8 8 0 0 1 16 0" />
            </svg>
          </span>
          <p className="flex-1 text-xs text-muted">
            <span className="font-medium text-fg">Set up a profile</span> to get a display name
            and build reputation faster. It stays optional - you can secure deals without one.
          </p>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-fg transition hover:bg-primary-hover"
          >
            Set up profile →
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
      </div>

      {open && <ClaimModal onClaim={claimHandle} onClose={() => setOpen(false)} />}
    </>
  );
}

function ClaimModal({
  onClaim,
  onClose,
}: {
  onClaim: (handle: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center px-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div className="relative w-full max-w-md">
        <HandlePrompt
          onClaim={async (handle) => {
            await onClaim(handle);
            onClose();
          }}
          onSkip={onClose}
        />
      </div>
    </div>,
    document.body,
  );
}
