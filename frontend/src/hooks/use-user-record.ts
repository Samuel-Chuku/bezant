'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Hex } from 'viem';
import {
  buildRegisterAgentUnsigned,
  claimHandle as claimHandleApi,
  getUserByAddress,
  linkAgentId as linkAgentIdApi,
  linkTelegram as linkTelegramApi,
  parseRegistration,
  registerExternalUser,
  unlinkTelegram as unlinkTelegramApi,
  type UserRecord,
} from '@/lib/api';
import { useSigner } from './use-signer';

// Cross-instance sync. useUserRecord is called independently in the nav pill,
// the profile page, banners, etc. - each kept its own copy, so a mutation in one
// (e.g. claiming a handle) left the others stale until a manual refresh. After a
// mutation we broadcast the fresh record; every mounted instance for the same
// address updates instantly. `user` omitted means "refetch" (when we don't hold
// the new record, e.g. after an out-of-band change).
export const USER_RECORD_EVENT = 'arc-trade:user-changed';
type UserChangedDetail = { address: string; user?: UserRecord | null };
function broadcastUserChanged(address: string | undefined, user?: UserRecord | null) {
  if (typeof window === 'undefined' || !address) return;
  window.dispatchEvent(
    new CustomEvent<UserChangedDetail>(USER_RECORD_EVENT, {
      detail: { address: address.toLowerCase(), user },
    }),
  );
}

// State machine:
//   idle:    no signer connected
//   loading: looking up the address in our backend
//   ready:   lookup done. user === null means connected but unregistered (no DB row yet)
//   error:   GET /users/by-address failed (network, CORS, etc.)
type State =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; user: UserRecord | null }
  | { status: 'error'; message: string };

export function useUserRecord() {
  const signer = useSigner();
  const [state, setState] = useState<State>({ status: 'idle' });
  // Bump to force a re-probe (e.g. after linking Telegram out-of-band).
  const [reloadTick, setReloadTick] = useState(0);
  const reload = useCallback(() => setReloadTick((t) => t + 1), []);

  // On connect: probe the backend to see if this address already has a row.
  // We do NOT auto-create. Registration only happens when the user claims a
  // handle (atomic - same call creates the row).
  useEffect(() => {
    if (!signer.isConnected) {
      setState({ status: 'idle' });
      return;
    }
    const address = signer.address.toLowerCase();
    let cancelled = false;
    setState({ status: 'loading' });
    void (async () => {
      try {
        const existing = await getUserByAddress(address);
        if (!cancelled) setState({ status: 'ready', user: existing });
      } catch (err) {
        if (!cancelled) {
          setState({
            status: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [signer.isConnected, signer.address, reloadTick]);

  // Sync from any other instance that just mutated this address's record.
  useEffect(() => {
    if (!signer.isConnected) return;
    const me = signer.address.toLowerCase();
    const onChanged = (e: Event) => {
      const detail = (e as CustomEvent<UserChangedDetail>).detail;
      if (!detail || detail.address !== me) return;
      if (detail.user === undefined) reload();
      else setState({ status: 'ready', user: detail.user });
    };
    window.addEventListener(USER_RECORD_EVENT, onChanged);
    return () => window.removeEventListener(USER_RECORD_EVENT, onChanged);
  }, [signer.isConnected, signer.address, reload]);

  // claimHandle is the single entry point for "I want a handle." It picks the
  // right backend call based on whether a row already exists:
  //   - no row yet  → POST /users/register-external creates the row + handle in one shot
  //   - legacy row with no handle → PATCH /users/:id { handle }
  // Backend uniqueness is enforced atomically in both cases.
  const claimHandle = useCallback(
    async (handle: string) => {
      if (state.status !== 'ready') {
        throw new Error('Not ready to claim a handle yet');
      }
      if (!signer.isConnected) {
        throw new Error('Not connected');
      }
      const signingMode = signer.mode === 'circle' ? 'circle-modular' : 'external';
      if (state.user === null) {
        const created = await registerExternalUser({
          walletAddress: signer.address.toLowerCase(),
          signingMode,
          handle,
        });
        setState({ status: 'ready', user: created });
        broadcastUserChanged(signer.address, created);
        return created;
      }
      if (state.user.handle === null) {
        const updated = await claimHandleApi(state.user.id, handle);
        setState({ status: 'ready', user: updated });
        broadcastUserChanged(signer.address, updated);
        return updated;
      }
      throw new Error('Handle already claimed');
    },
    [state, signer],
  );

  // linkAgentId attaches (or detaches via null) an ERC-8004 agentId. Backend
  // verifies on-chain that the signer's wallet is the agent owner or its
  // explicitly-set agentWallet before persisting; throws on failure.
  const linkAgentId = useCallback(
    async (agentId: string | null) => {
      if (state.status !== 'ready' || state.user === null) {
        throw new Error('Claim a handle first. AgentId links to your user record.');
      }
      const updated = await linkAgentIdApi(state.user.id, agentId);
      setState({ status: 'ready', user: updated });
      broadcastUserChanged(signer.address, updated);
      return updated;
    },
    [state, signer],
  );

  // registerAgent mints a fresh ERC-8004 agentId for the connected wallet
  // by calling IdentityRegistry.register(), then auto-links it via the
  // existing PATCH route (whose on-chain ownership check passes trivially
  // because the signer just minted the token).
  const registerAgent = useCallback(async (): Promise<{ agentId: string }> => {
    if (state.status !== 'ready' || state.user === null) {
      throw new Error('Claim a handle first. Agent registration links to your user record.');
    }
    if (!signer.isConnected) {
      throw new Error('Not connected');
    }
    const unsigned = await buildRegisterAgentUnsigned();
    const sent = await signer.sendCall({
      to: unsigned.to as Hex,
      data: unsigned.data as Hex,
      value: BigInt(unsigned.value),
    });
    const { txHash, status: txStatus } = await sent.wait();
    if (txStatus !== 'success') {
      throw new Error(`Registration tx ${txStatus}`);
    }
    const parsed = await parseRegistration(txHash);
    const updated = await linkAgentIdApi(state.user.id, parsed.agentId);
    setState({ status: 'ready', user: updated });
    broadcastUserChanged(signer.address, updated);
    return { agentId: parsed.agentId };
  }, [state, signer]);

  // Telegram alerts. linkTelegram returns a t.me deep link to open; the account
  // is bound server-side once the user taps Start, so callers should poll
  // `reload()` afterward to pick up telegramLinked. unlinkTelegram is immediate.
  const linkTelegram = useCallback(async (): Promise<string> => {
    if (!signer.isConnected) throw new Error('Not connected');
    const { url } = await linkTelegramApi(signer.address.toLowerCase());
    return url;
  }, [signer]);

  const unlinkTelegram = useCallback(async () => {
    if (!signer.isConnected) throw new Error('Not connected');
    await unlinkTelegramApi(signer.address.toLowerCase());
    broadcastUserChanged(signer.address); // no record in hand - tell instances to refetch
  }, [signer]);

  return { state, claimHandle, linkAgentId, registerAgent, reload, linkTelegram, unlinkTelegram };
}
