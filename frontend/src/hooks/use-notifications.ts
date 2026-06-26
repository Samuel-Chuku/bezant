'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Address } from 'viem';
import {
  getNotificationFeed,
  getTradeNotifications,
  getPoolActivity,
  getVerifierActivity,
  type FeedRow,
  type PactEvent,
  type PactLiveState,
  type PactRole,
  type TradeNotification,
  type PoolActivity,
  type VerifierActivity,
} from '@/lib/api';
import { describeCurrentStep, isActionRequiredByMe } from '@/lib/pact-status';
import { getReadKeys, markReadKeysRemote } from '@/lib/api';
import { useSigner } from './use-signer';
import { CHAIN_REFRESH_EVENT } from './use-refresh-chain-data';

export type NotificationKind = 'action' | 'status' | 'event' | 'deadline' | 'pool';

// Broad source bucket, used by the Activities page filter.
export type NotificationCategory = 'pact' | 'trade' | 'pool' | 'verifier';

export type NotificationItem = {
  key: string;
  pactId: string;
  kind: NotificationKind;
  category: NotificationCategory;
  summary: string;
  // Sort key - milliseconds. Newer = bigger.
  whenMs: number;
  // Human-readable absolute or relative for display.
  whenIso: string | null;
  read: boolean;
  // Where clicking the item navigates. Defaults to the pact page; trade items set /trade/:id.
  href?: string;
  // On-chain tx hash, when the item corresponds to a single transaction (pool events).
  txHash?: string;
};

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; rows: FeedRow[] }
  | { status: 'error'; message: string };

const POLL_MS = 30_000;

// Effective status - soft-Expired any non-terminal that's past deadline,
// matching the pact-detail page's getEffectiveStatus inline.
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
//   action  - connected user is the actor up next ("Fund #N", "Submit on #N").
//   status  - connected user is involved but waiting on someone else
//             ("#N - Waiting for the client to fund"). Same identity as
//             action (one per pact/status/roles tuple) - kind just flips
//             based on whose turn it is.
//   event   - one per Submitted/Completed/Rejected/Funded/Refunded row in
//             pact_events (excludes user's own actions to avoid notifying
//             yourself about your own tx).
//   deadline- bucketed alerts as the deadline approaches: 24h / 1h / 15m
//             / expired. Each fires at most once per bucket per pact, only
//             when the user is the action party (urgency = their problem).
function deriveItems(rows: FeedRow[], myAddress: Address): NotificationItem[] {
  const me = myAddress.toLowerCase();
  const items: NotificationItem[] = [];
  const nowMs = Date.now();

  for (const row of rows) {
    if (!row.live) continue;
    const status = effectiveStatus(row.live);

    // Events fire regardless of terminal status: the provider needs to see
    // the Completed event ("Client released payment") when their pact settles,
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
        key: `pact:${row.pactId}:event:${ev.txHash}:${ev.logIndex}`,
        pactId: row.pactId,
        kind: 'event',
        category: 'pact',
        summary,
        whenMs: new Date(ev.indexedAt).getTime(),
        whenIso: ev.indexedAt,
        read: false,
      });
    }

    // Status, action, and deadline items only make sense while the pact is
    // still in flight - once it's terminal there's nothing left to do.
    if (isTerminal(status)) continue;

    const livePact: PactLiveState = {
      id: row.pactId,
      client: row.index.client,
      provider: row.index.provider,
      evaluator: row.index.evaluator,
      description: row.live.description,
      budget: row.live.budget,
      expiredAt: row.live.expiredAt,
      status: row.live.status,
      hook: '',
      // Not needed for notification-derived items (fund/dispute flows read the
      // full single-pact state); defaulted to satisfy the type.
      challengeWindow: 0,
      submittedAt: 0,
      disputeId: '0',
      createdAt: {
        blockNumber: row.index.blockNumber,
        txHash: row.index.txHash,
        indexedAt: row.index.indexedAt,
      },
    };
    const roles = row.roles as PactRole[];

    // Status/action item - always emit one for any non-terminal pact the
    // user is party to so the bell isn't silent on in-flight pacts you're
    // just waiting on. Kind flips to 'action' when it's your turn so the
    // visual weight (and unread count) reflects urgency.
    const sentence = describeCurrentStep(livePact, status, roles);
    const isMine = isActionRequiredByMe(livePact, status, roles);
    if (sentence) {
      items.push({
        key: `pact:${row.pactId}:status:${status}:${roles.sort().join('+')}`,
        pactId: row.pactId,
        kind: isMine ? 'action' : 'status',
        category: 'pact',
        summary: `Pact #${row.pactId}: ${sentence}`,
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
          key: `pact:${row.pactId}:deadline:${bucket.key}`,
          pactId: row.pactId,
          kind: 'deadline',
          category: 'pact',
          summary: `Pact #${row.pactId}: ${bucket.label}.`,
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

function formatEventSummary(ev: PactEvent, row: FeedRow, isSelf: boolean): string {
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
      return `${subject} funded pact #${row.pactId}.`;
    case 'Submitted':
      return `${subject} submitted the deliverable on pact #${row.pactId}.`;
    case 'Completed':
      return `${subject} released payment on pact #${row.pactId}.`;
    case 'Rejected': {
      // Client rejecting their own pact is a cancellation; surface that.
      const actorIsClient =
        ev.actor.toLowerCase() === row.index.client.toLowerCase();
      if (actorIsClient) {
        return isSelf
          ? `You cancelled pact #${row.pactId}.`
          : `Client cancelled pact #${row.pactId}.`;
      }
      return `${subject} rejected the deliverable on pact #${row.pactId}.`;
    }
    case 'Refunded':
      return `Refund returned to client on pact #${row.pactId}.`;
    case 'BudgetSet':
      return `Provider set a quote on pact #${row.pactId}.`;
    case 'DisputeOpened':
      return `${subject} opened a dispute on pact #${row.pactId}.`;
    case 'DisputeDefended':
      return `Dispute on pact #${row.pactId} was defended - evaluators are voting.`;
    case 'DisputeConceded':
      return `Dispute on pact #${row.pactId} was conceded.`;
    case 'DisputeResolved':
      return `Dispute on pact #${row.pactId} was resolved.`;
    case 'CommitSubmitted':
      return `An evaluator committed a vote on pact #${row.pactId}.`;
    case 'VoteRevealed':
      return `An evaluator revealed a vote on pact #${row.pactId}.`;
    default:
      return `Pact #${row.pactId}: ${ev.eventType}.`;
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
  const [tradeRaw, setTradeRaw] = useState<TradeNotification[]>([]);
  const [poolRaw, setPoolRaw] = useState<PoolActivity[]>([]);
  const [verifierRaw, setVerifierRaw] = useState<VerifierActivity[]>([]);
  const [readKeys, setReadKeys] = useState<Set<string>>(new Set());
  const addressRef = useRef<Address | null>(null);

  // Track current connected address for read-key persistence.
  const address = signer.isConnected ? signer.address : null;
  useEffect(() => {
    addressRef.current = address;
    if (!address) {
      setReadKeys(new Set());
      return;
    }
    let cancelled = false;
    getReadKeys(address)
      .then((keys) => !cancelled && setReadKeys(new Set(keys)))
      .catch(() => !cancelled && setReadKeys(new Set()));
    return () => {
      cancelled = true;
    };
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
    // Trade notifications are a separate source; failures here (e.g. escrow not
    // deployed) must not break the pact feed. On a transient error we KEEP the
    // last good data rather than clearing it - otherwise a single failed poll
    // makes already-shown items vanish until the next success (looks "stale").
    try {
      setTradeRaw(await getTradeNotifications(address));
    } catch {
      /* keep previous tradeRaw */
    }
    // Pool LP activity is a third independent source - same isolation, and the
    // chunked getLogs can time out on the RPC, so preserving prior data here is
    // what stops pool deposits/withdrawals from flickering out of the feed.
    try {
      setPoolRaw(await getPoolActivity(address));
    } catch {
      /* keep previous poolRaw */
    }
    // Verifier stake/unstake - fourth independent source (501 if not deployed).
    try {
      setVerifierRaw(await getVerifierActivity(address));
    } catch {
      /* keep previous verifierRaw */
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
    if (!address) return [];
    const pactItems =
      state.status === 'ready'
        ? deriveItems(state.rows, address).map((it) => ({
            ...it,
            read: readKeys.has(it.key),
            href: it.href ?? `/pacts/${it.pactId}`,
          }))
        : [];
    const tradeItems: NotificationItem[] = tradeRaw.map((t) => ({
      key: t.key,
      pactId: t.tradeId,
      kind: t.kind,
      category: 'trade',
      summary: t.summary,
      whenMs: t.whenMs,
      whenIso: null,
      read: readKeys.has(t.key),
      href: `/trade/${t.tradeId}`,
    }));
    const poolItems: NotificationItem[] = poolRaw.map((p) => ({
      key: p.key,
      pactId: '',
      kind: 'pool',
      category: 'pool',
      summary: p.summary,
      whenMs: p.whenMs,
      whenIso: new Date(p.whenMs).toISOString(),
      read: readKeys.has(p.key),
      href: '/pool',
      txHash: p.txHash,
    }));
    const verifierItems: NotificationItem[] = verifierRaw.map((vAct) => ({
      key: vAct.key,
      pactId: '',
      kind: 'event',
      category: 'verifier',
      summary: vAct.summary,
      whenMs: vAct.whenMs,
      whenIso: new Date(vAct.whenMs).toISOString(),
      read: readKeys.has(vAct.key),
      href: '/verify',
      txHash: vAct.txHash,
    }));
    return [...pactItems, ...tradeItems, ...poolItems, ...verifierItems].sort((a, b) => b.whenMs - a.whenMs);
  }, [state, tradeRaw, poolRaw, verifierRaw, address, readKeys]);

  const unreadCount = useMemo(() => items.filter((it) => !it.read).length, [items]);

  // Mark optimistically (snappy UI), then persist to the backend in the
  // background - a failed POST just means it re-shows as unread next load.
  const markAllRead = useCallback(() => {
    if (!address) return;
    const unreadKeys = items.filter((it) => !it.read).map((it) => it.key);
    if (unreadKeys.length === 0) return;
    setReadKeys((prev) => {
      const next = new Set(prev);
      for (const k of unreadKeys) next.add(k);
      return next;
    });
    void markReadKeysRemote(address, unreadKeys).catch(() => {});
  }, [address, items]);

  const markRead = useCallback(
    (key: string) => {
      if (!address) return;
      setReadKeys((prev) => {
        const next = new Set(prev);
        next.add(key);
        return next;
      });
      void markReadKeysRemote(address, [key]).catch(() => {});
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
