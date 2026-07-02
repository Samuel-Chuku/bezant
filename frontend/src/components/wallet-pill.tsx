'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePathname } from 'next/navigation';
import { useAccountModal, useConnectModal } from '@rainbow-me/rainbowkit';
import { useBalance } from 'wagmi';
import { useSigner } from '@/hooks/use-signer';
import { useUserRecord } from '@/hooks/use-user-record';
import { arcTestnet } from '@/lib/chains';
import { shortAddress, truncateBalance } from '@/lib/format';
import { Avatar } from './avatar';
import { EmailSignIn } from './email-sign-in';

// Top-nav wallet area.
//   Disconnected     → "Log in" button; click opens an anchored popover
//                       offering both the email/passkey path and the
//                       wallet path.
//   External (wagmi) → pill click opens RainbowKit's native account modal.
//   Circle (passkey) → pill click toggles an anchored popover (copy /
//                       disconnect) since RainbowKit doesn't manage the
//                       passkey-backed smart account.
export function WalletPill() {
  const signer = useSigner();
  const { openAccountModal } = useAccountModal();
  const [passkeyOpen, setPasskeyOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [handleCopied, setHandleCopied] = useState(false);
  const pathname = usePathname();
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const { state: userState } = useUserRecord();
  const handle = userState.status === 'ready' ? userState.user?.handle ?? null : null;

  const { data: balance } = useBalance({
    address: signer.isConnected ? signer.address : undefined,
    chainId: arcTestnet.id,
    // Poll every 15s so post-bridge / post-fund deltas show without a reload.
    query: { enabled: signer.isConnected, refetchInterval: 15_000 },
  });

  // Close any open popover on navigation.
  useEffect(() => {
    setPasskeyOpen(false);
    setLoginOpen(false);
  }, [pathname]);

  // Passkey popover only needs outside-click closing - it's anchored to
  // the pill in the same DOM subtree. Login modal is portal'd outside the
  // wrapper, so it manages its own dismissal via the backdrop click.
  useEffect(() => {
    if (!passkeyOpen) return;
    const onClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setPasskeyOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [passkeyOpen]);

  // Escape closes whichever menu is open.
  useEffect(() => {
    if (!passkeyOpen && !loginOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPasskeyOpen(false);
        setLoginOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [passkeyOpen, loginOpen]);

  if (!signer.isConnected) {
    return (
      <div ref={wrapperRef} className="relative">
        <button
          type="button"
          onClick={() => setLoginOpen((o) => !o)}
          aria-expanded={loginOpen}
          className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-fg transition hover:bg-primary-hover"
        >
          Log in
        </button>
        {loginOpen && <LoginPopover onClose={() => setLoginOpen(false)} />}
      </div>
    );
  }

  const balanceText = balance ? `${truncateBalance(balance.formatted, 2)} USDC` : '… USDC';

  const handleClick = () => {
    if (signer.mode === 'external') {
      openAccountModal?.();
    } else {
      setPasskeyOpen((o) => !o);
    }
  };

  const copyHandleOwner = async (e: React.MouseEvent) => {
    // Stop the click from bubbling to the pill button - clicking the
    // handle is a shortcut to copy the address it resolves to, not a
    // gesture to open the wallet menu.
    e.stopPropagation();
    if (!signer.isConnected) return;
    try {
      await navigator.clipboard.writeText(signer.address);
      setHandleCopied(true);
      setTimeout(() => setHandleCopied(false), 1500);
    } catch {
      // Clipboard blocked - silently no-op rather than alarming the user.
    }
  };

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={handleClick}
        className="group flex items-center gap-2 rounded-full border border-line bg-surface/60 py-1 pl-1.5 pr-1 transition hover:border-line-strong hover:bg-surface"
        aria-label="Open wallet menu"
        aria-expanded={passkeyOpen}
      >
        <ArcChainBadge />
        {handle ? (
          <>
            <span
              role="button"
              tabIndex={0}
              onClick={copyHandleOwner}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') copyHandleOwner(e as unknown as React.MouseEvent);
              }}
              title={handleCopied ? 'Copied!' : `Copy ${signer.address}`}
              className="cursor-pointer text-[11px] font-medium text-primary hover:text-primary"
            >
              {handleCopied ? 'Copied!' : `@${handle}`}
            </span>
            {/* Address row hides below md when a handle is present - the
                handle becomes the primary identifier. Always visible at md+
                or when no handle is set. */}
            <span className="hidden text-muted md:inline" aria-hidden>
              ·
            </span>
            <span className="hidden font-mono text-[11px] text-fg md:inline">
              {shortAddress(signer.address)}
            </span>
          </>
        ) : (
          <span className="font-mono text-[11px] text-fg">
            {shortAddress(signer.address)}
          </span>
        )}
        {/* Balance hides below sm to keep the pill compact on phones; the
            drawer + balances panel surface it elsewhere when needed. */}
        <span className="hidden text-muted sm:inline" aria-hidden>
          ·
        </span>
        <span className="hidden text-[13px] font-medium text-fg sm:inline">{balanceText}</span>
        <span className="ml-1">
          <Avatar address={signer.address} size={26} />
        </span>
      </button>

      {passkeyOpen && signer.mode === 'circle' && (
        <PasskeyPopover
          address={signer.address}
          balanceText={balanceText}
          onDisconnect={() => {
            signer.disconnect?.();
            setPasskeyOpen(false);
          }}
          onClose={() => setPasskeyOpen(false)}
        />
      )}
    </div>
  );
}

function LoginPopover({ onClose }: { onClose: () => void }) {
  const { openConnectModal } = useConnectModal();
  const [step, setStep] = useState<'choose' | 'email'>('choose');
  const [mounted, setMounted] = useState(false);

  // Portal both backdrop and dialog at <body> level so they share a clean
  // stacking context - otherwise the sticky header's backdrop-blur paints
  // over the dialog and the whole thing reads as "everything is blurred".
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center px-4">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />
      <div
        role="dialog"
        aria-label="Sign in"
        className="relative w-full max-w-sm rounded-xl border border-line bg-bg p-5 shadow-2xl"
      >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-surface hover:text-fg"
      >
        ×
      </button>

      {step === 'choose' ? (
        <>
          <div className="text-[10px] uppercase tracking-[0.18em] text-primary">Get on Arc</div>
          <h3 className="mt-1 text-lg font-semibold tracking-tight text-fg">
            How do you want to sign?
          </h3>
          <p className="mt-1 text-xs text-muted">
            Either path lands you with an address on Arc Testnet.
          </p>

          <button
            type="button"
            onClick={() => setStep('email')}
            className="mt-5 flex w-full items-center justify-between rounded-lg border border-line bg-surface px-4 py-3 text-sm text-fg transition hover:border-line-strong hover:bg-surface/80"
          >
            <span className="flex items-center gap-2.5">
              <MailGlyph />
              <span>Use email + passkey</span>
            </span>
            <span aria-hidden className="text-muted">→</span>
          </button>

          <div className="my-4 flex items-center gap-3 text-[10px] uppercase tracking-wider text-muted">
            <div className="h-px flex-1 bg-surface-2" />
            <span>or</span>
            <div className="h-px flex-1 bg-surface-2" />
          </div>

          <button
            type="button"
            disabled={!openConnectModal}
            onClick={() => {
              // RainbowKit's openConnectModal opens the SAME native connect
              // modal that the home page's <ConnectButton /> uses
              // (Installed / Popular wallet list + Learn More). It is briefly
              // undefined while RainbowKit is initializing - guard so the
              // click doesn't silently no-op in that window.
              if (!openConnectModal) return;
              openConnectModal();
              onClose();
            }}
            className="flex w-full items-center justify-between rounded-lg border border-line bg-surface px-4 py-3 text-sm text-fg transition hover:border-line-strong hover:bg-surface/80 disabled:cursor-wait disabled:opacity-60"
          >
            <span className="flex items-center gap-2.5">
              <WalletGlyph />
              <span>{openConnectModal ? 'Connect a browser wallet' : 'Preparing wallets…'}</span>
            </span>
            <span aria-hidden className="text-muted">→</span>
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            onClick={() => setStep('choose')}
            className="mb-3 inline-flex items-center gap-1 text-[11px] text-muted hover:text-fg"
          >
            ← Back
          </button>
          <h3 className="text-base font-medium text-fg">Email + passkey</h3>
          <p className="mt-1 text-xs text-muted">
            New here? Create one. Already have a passkey for Bezant? Sign in.
          </p>
          <div className="mt-4">
            <EmailSignIn />
          </div>
        </>
      )}
      </div>
    </div>,
    document.body,
  );
}

function PasskeyPopover({
  address,
  balanceText,
  onDisconnect,
  onClose,
}: {
  address: string;
  balanceText: string;
  onDisconnect: () => void;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignored
    }
  };

  return (
    <div
      role="dialog"
      aria-label="Wallet menu"
      className="absolute right-0 top-full z-50 mt-2 w-64 rounded-xl border border-line bg-bg p-4 shadow-2xl"
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="absolute right-2 top-2 inline-flex h-6 w-6 items-center justify-center rounded-md text-muted hover:bg-surface hover:text-fg"
      >
        ×
      </button>

      <div className="flex flex-col items-center pt-1">
        <Avatar address={address} size={48} />
        <div className="mt-3 font-mono text-sm text-fg">{shortAddress(address)}</div>
        <div className="mt-0.5 text-xs text-muted">{balanceText}</div>
        <div className="mt-0.5 text-[10px] uppercase tracking-wide text-muted">
          on Arc · passkey
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={handleCopy}
          className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-[11px] font-medium text-fg transition hover:border-line-strong hover:bg-surface/80"
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
        <button
          type="button"
          onClick={onDisconnect}
          className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-[11px] font-medium text-fg transition hover:border-danger/60 hover:bg-danger/30 hover:text-danger"
        >
          Disconnect
        </button>
      </div>
    </div>
  );
}

// Arc network badge on the left of the pill — the official Arc mark.
function ArcChainBadge() {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src="/arc-logo.svg" alt="Arc Testnet" className="h-6 w-6" />;
}

function WalletGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-fg"
      aria-hidden
    >
      <path d="M21 12V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2" />
      <path d="M16 12h4a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1h-4a2 2 0 0 1 0-4Z" />
    </svg>
  );
}

function MailGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-fg"
      aria-hidden
    >
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 7l9 6 9-6" />
    </svg>
  );
}
