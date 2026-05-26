'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Address } from 'viem';
import {
  getNotificationFeed,
  type FeedRow,
  type JobEvent,
  type JobLiveState,
  type JobRole,
} from '@/lib/api';
import { describeCurrentStep, isActionRequiredByMe } from '@/lib/job-status';
import { loadReadKeys, markReadKeys } from '@/lib/notifications-read';
import { useSigner } from './use-signer';
import { CHAIN_REFRESH_EVENT } from './use-refresh-chain-data';

export type NotificationKind = 'action' | 'status' | 'event' | 'deadline';

export type NotificationItem = {
  key: string;
  jobId: string;
  kind: NotificationKind;
  summary: string;
  // Sort key — milliseconds. Newer = bigger.
  whenMs: number;
  // Human-readable absolute or relative for display.
  whenIso: string | null;
  read: boolean;
};

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; rows: FeedRow[] }
  | { status: 'error'; message: string };

const POLL_MS = 30_000;

// Effective status — soft-Expired any non-terminal that's past deadline,
// matching the job-detail page's getEffectiveStatus inline.
function effectiveStatus(live: { status: string; expiredAt: { unix: number } }): string {
  if (
    (live.status === 'Open' || live.status === 'Funded' || live.status === 'Submitted') &&
    live.expiredAt.unix * 1000 < Date.now()
  ) {
    return 'Expired';
  }
  return live.status;
}

function isTerminal(status: string): boolean {
  return status === 'Completed' || status === 'Rejected';
}

// Four notification kinds derive from each FeedRow:
//   action  — connected user is the actor up next ("Fund #N", "Submit on #N").
//   status  — connected user is involved but waiting on someone else
//             ("#N — Waiting for the client to fund"). Same identity as
//             action (one per job/status/roles tuple) — kind just flips
//             based on whose turn it is.
//   event   — one per Submitted/Completed/Rejected/Funded/Refunded row in
//             job_events (excludes user's own actions to avoid notifying
//             yourself about your own tx).
//   deadline— bucketed alerts as the deadline approaches: 24h / 1h / 15m
//             / expired. Each fires at most once per bucket per job, only
//             when the user is the action party (urgency = their problem).
function deriveItems(rows: FeedRow[], myAddress: Address): NotificationItem[] {
  const me = myAddress.toLowerCase();
  const items: NotificationItem[] = [];
  const nowMs = Date.now();

  for (const row of rows) {
    if (!row.live) continue;
    const status = effectiveStatus(row.live);

    // Events fire regardless of terminal status: the provider needs to see
    // the Completed event ("Client released payment") when their job settles,
    // not have it silently dropped because the row is now terminal.
    //
    // Self-authored events are normally suppressed (you don't need a bell
    // alert for actions you just performed). Terminal events are the
    // exception: the cancellation / completion / refund is the closing
    // confirmation the user wants visible globally, even if they took the
    // action themselves. The summary swaps to "You ..." so it reads as a
    // confirmation rather than counter-party news.
    const TERMINAL_EVENT_TYPES = new Set([
      'Completed',
      'Rejected',
      'Refunded',
    ]);
    for (const ev of row.events) {
      const isSelf = ev.actor.toLowerCase() === me;
      const isTerminalEvent = TERMINAL_EVENT_TYPES.has(ev.eventType);
      if (isSelf && !isTerminalEvent) continue;
      const summary = formatEventSummary(ev, row, isSelf);
      items.push({
        key: `job:${row.jobId}:event:${ev.txHash}:${ev.logIndex}`,
        jobId: row.jobId,
        kind: 'event',
        summary,
        whenMs: new Date(ev.indexedAt).getTime(),
        whenIso: ev.indexedAt,
        read: false,
      });
    }

    // Status, action, and deadline items only make sense while the job is
    // still in flight — once it's terminal there's nothing left to do.
    if (isTerminal(status)) continue;

    const liveJob: JobLiveState = {
      id: row.jobId,
      client: row.index.client,
      provider: row.index.provider,
      evaluator: row.index.evaluator,
      description: row.live.description,
      budget: row.live.budget,
      expiredAt: row.live.expiredAt,
      status: row.live.status,
      hook: '',
      createdAt: {
        blockNumber: row.index.blockNumber,
        txHash: row.index.txHash,
        indexedAt: row.index.indexedAt,
      },
    };
    const roles = row.roles as JobRole[];

    // Status/action item — always emit one for any non-terminal job the
    // user is party to so the bell isn't silent on in-flight jobs you're
    // just waiting on. Kind flips to 'action' when it's your turn so the
    // visual weight (and unread count) reflects urgency.
    const sentence = describeCurrentStep(liveJob, status, roles);
    const isMine = isActionRequiredByMe(liveJob, status, roles);
    if (sentence) {
      items.push({
        key: `job:${row.jobId}:status:${status}:${roles.sort().join('+')}`,
        jobId: row.jobId,
        kind: isMine ? 'action' : 'status',
        summary: `Job #${row.jobId}: ${sentence}`,
        whenMs: row.live.expiredAt.unix * 1000,
        whenIso: row.live.expiredAt.iso,
        read: false,
      });
    }

    // Deadline buckets, only for the role whose action is pending.
    if (isMine) {
      const remainingMs = row.live.expiredAt.unix * 1000 - nowMs;
      const bucket = bucketFor(remainingMs);
      if (bucket) {
        items.push({
          key: `job:${row.jobId}:deadline:${bucket.key}`,
          jobId: row.jobId,
          kind: 'deadline',
          summary: `Job #${row.jobId}: ${bucket.label}.`,
          whenMs: row.live.expiredAt.unix * 1000,
          whenIso: row.live.expiredAt.iso,
          read: false,
        });
      }
    }
  }

  // Newest first.
  items.sort((a, b) => b.whenMs - a.whenMs);
  return items;
}

function formatEventSummary(ev: JobEvent, row: FeedRow, isSelf: boolean): string {
  const actorShort = `${ev.actor.slice(0, 6)}…${ev.actor.slice(-4)}`;
  const subject = isSelf
    ? 'You'
    : (() => {
        const a = ev.actor.toLowerCase();
        if (a === row.index.client.toLowerCase()) return 'Client';
        if (a === row.index.provider.toLowerCase()) return 'Provider';
        if (a === row.index.evaluator.toLowerCase()) return 'Evaluator';
        return actorShort;
      })();
  // Slightly different phrasing when subject is "You" so the sentence flows
  // (e.g. "You released payment" not "You released payment on..." mid-sentence).
  switch (ev.eventType) {
    case 'Funded':
      return `${subject} funded job #${row.jobId}.`;
    case 'Submitted':
      return `${subject} submitted the deliverable on job #${row.jobId}.`;
    case 'Completed':
      return `${subject} released payment on job #${row.jobId}.`;
    case 'Rejected': {
      // Client rejecting their own job is a cancellation; surface that.
      const actorIsClient =
        ev.actor.toLowerCase() === row.index.client.toLowerCase();
      if (actorIsClient) {
        return isSelf
          ? `You cancelled job #${row.jobId}.`
          : `Client cancelled job #${row.jobId}.`;
      }
      return `${subject} rejected the deliverable on job #${row.jobId}.`;
    }
    case 'Refunded':
      return `Refund returned to client on job #${row.jobId}.`;
    default:
      return `Job #${row.jobId}: ${ev.eventType}.`;
  }
}

function bucketFor(remainingMs: number): { key: string; label: string } | null {
  if (remainingMs <= 0) return { key: 'expired', label: 'deadline has passed' };
  const hours = remainingMs / 3_600_000;
  if (hours < 0.25) return { key: '15m', label: 'less than 15 minutes left' };
  if (hours < 1) return { key: '1h', label: 'less than 1 hour left' };
  if (hours < 24) return { key: '24h', label: 'less than 24 hours left' };
  return null;
}

export function useNotifications() {
  const signer = useSigner();
  const [state, setState] = useState<LoadState>({ status: 'idle' });
  const [readKeys, setReadKeys] = useState<Set<string>>(new Set());
  const addressRef = useRef<Address | null>(null);

  // Track current connected address for read-key persistence.
  const address = signer.isConnected ? signer.address : null;
  useEffect(() => {
    addressRef.current = address;
    if (address) {
      setReadKeys(loadReadKeys(address));
    } else {
      setReadKeys(new Set());
    }
  }, [address]);

  const fetchFeed = useCallback(async () => {
    if (!address) {
      setState({ status: 'idle' });
      return;
    }
    setState((prev) => (prev.status === 'ready' ? prev : { status: 'loading' }));
    try {
      const data = await getNotificationFeed(address, { limit: 100 });
      setState({ status: 'ready', rows: data.feed });
    } catch (err) {
      setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }, [address]);

  // Initial fetch + poll + refetch on window focus + refetch on tx settle.
  // The tx-settle event fires before the backend indexer has necessarily
  // caught up to the new block, so we kick a short burst (now, +2s, +5s)
  // to land the counter-party event without waiting on the 30s poll.
  useEffect(() => {
    void fetchFeed();
    if (!address) return;
    const id = setInterval(() => void fetchFeed(), POLL_MS);
    const onFocus = () => void fetchFeed();
    const timeouts: ReturnType<typeof setTimeout>[] = [];
    const onChainRefresh = () => {
      void fetchFeed();
      timeouts.push(setTimeout(() => void fetchFeed(), 2_000));
      timeouts.push(setTimeout(() => void fetchFeed(), 5_000));
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener(CHAIN_REFRESH_EVENT, onChainRefresh);
    return () => {
      clearInterval(id);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener(CHAIN_REFRESH_EVENT, onChainRefresh);
      for (const t of timeouts) clearTimeout(t);
    };
  }, [address, fetchFeed]);

  const items = useMemo<NotificationItem[]>(() => {
    if (state.status !== 'ready' || !address) return [];
    const derived = deriveItems(state.rows, address);
    return derived.map((it) => ({ ...it, read: readKeys.has(it.key) }));
  }, [state, address, readKeys]);

  const unreadCount = useMemo(() => items.filter((it) => !it.read).length, [items]);

  const markAllRead = useCallback(() => {
    if (!address) return;
    const allKeys = items.map((it) => it.key);
    markReadKeys(address, allKeys);
    setReadKeys((prev) => {
      const next = new Set(prev);
      for (const k of allKeys) next.add(k);
      return next;
    });
  }, [address, items]);

  const markRead = useCallback(
    (key: string) => {
      if (!address) return;
      markReadKeys(address, [key]);
      setReadKeys((prev) => {
        const next = new Set(prev);
        next.add(key);
        return next;
      });
    },
    [address],
  );

  return {
    items,
    unreadCount,
    isLoading: state.status === 'loading',
    isError: state.status === 'error',
    errorMessage: state.status === 'error' ? state.message : null,
    markAllRead,
    markRead,
    refresh: fetchFeed,
  };
}
