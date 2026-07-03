'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useNotifications, type NotificationItem } from '@/hooks/use-notifications';
import { useSigner } from '@/hooks/use-signer';

const DROPDOWN_MAX = 8;

export function NotificationsBell() {
  const signer = useSigner();
  const { items, unreadCount, markAllRead, markRead, isLoading } = useNotifications();
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [coords, setCoords] = useState<{ top: number; right: number } | null>(null);
  const router = useRouter();

  // Close on route change.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Close on outside click + Escape. The panel is portaled to <body>, so the
  // outside check must exclude both the button wrapper and the panel itself.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapperRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Anchor the portaled panel under the bell (right-aligned). Recompute while
  // open so it tracks scroll/resize.
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const r = buttonRef.current?.getBoundingClientRect();
      if (r) setCoords({ top: r.bottom + 8, right: Math.max(8, window.innerWidth - r.right) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  // Hide bell entirely when not connected - there's nothing to show.
  if (!signer.isConnected) return null;

  const visible = items.slice(0, DROPDOWN_MAX);

  return (
    <div ref={wrapperRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Notifications"
        aria-expanded={open}
        className="relative inline-flex h-8 w-8 items-center justify-center rounded-full border border-line bg-surface/60 text-fg transition hover:border-line-strong hover:bg-surface hover:text-fg"
      >
        <BellGlyph />
        {unreadCount > 0 && (
          <span
            className="absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[9px] font-medium text-white"
            aria-label={`${unreadCount} unread`}
          >
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open &&
        coords &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label="Notifications"
            style={{ position: 'fixed', top: coords.top, right: coords.right }}
            className="bz-frame z-50 w-80 rounded-xl border border-line bg-bg shadow-2xl"
          >
          <header className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <h3 className="text-sm font-medium text-fg">Notifications</h3>
            {items.length > 0 && unreadCount > 0 && (
              <button
                type="button"
                onClick={markAllRead}
                className="text-[11px] text-primary hover:text-primary"
              >
                Mark all read
              </button>
            )}
          </header>

          <div className="max-h-96 overflow-y-auto">
            {isLoading && items.length === 0 && (
              <p className="px-4 py-6 text-center text-xs text-muted">Loading…</p>
            )}
            {!isLoading && items.length === 0 && (
              <p className="px-4 py-6 text-center text-xs text-muted">
                No notifications yet.
              </p>
            )}
            {visible.length > 0 && (
              <ul className="divide-y divide-line/80">
                {visible.map((item, i) => (
                  <NotificationRow
                    key={`${item.key}-${i}`}
                    item={item}
                    onClick={() => {
                      markRead(item.key);
                      setOpen(false);
                      router.push(item.href ?? `/pacts/${encodeURIComponent(item.pactId)}`);
                    }}
                  />
                ))}
              </ul>
            )}
          </div>

          <footer className="border-t border-line px-4 py-2.5">
            <Link
              href="/activity"
              className="block text-center text-[11px] text-muted hover:text-fg"
              onClick={() => setOpen(false)}
            >
              See all Activities →
            </Link>
          </footer>
          </div>,
          document.body,
        )}
    </div>
  );
}

function NotificationRow({
  item,
  onClick,
}: {
  item: NotificationItem;
  onClick: () => void;
}) {
  const kindStyles: Record<NotificationItem['kind'], string> = {
    action: 'bg-primary',
    deadline: 'bg-warn',
    event: 'bg-muted',
    status: 'bg-info',
    pool: 'bg-info',
  };
  const kindLabels: Record<NotificationItem['kind'], string> = {
    action: 'Action',
    deadline: 'Deadline',
    event: 'Event',
    status: 'Status',
    pool: 'Pool',
  };

  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={`flex w-full items-start gap-2.5 px-4 py-3 text-left transition hover:bg-surface/60 ${
          item.read ? 'opacity-60' : ''
        }`}
      >
        <span
          className={`mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full ${kindStyles[item.kind]}`}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="text-xs text-fg">{item.summary}</div>
          <div className="mt-0.5 text-[10px] uppercase tracking-wider text-muted">
            {kindLabels[item.kind]}
            {item.whenIso && ` · ${relativeOrAbsolute(item.whenIso)}`}
          </div>
        </div>
      </button>
    </li>
  );
}

function relativeOrAbsolute(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (Math.abs(diff) < 60_000) return 'just now';
  if (diff > 0 && diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff > 0 && diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff > 0 && diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  // Future deadline or older than a week → show absolute.
  return new Date(iso).toLocaleString();
}

function BellGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}
