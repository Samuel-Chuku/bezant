'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  claimHandle as claimHandleApi,
  getUserByAddress,
  linkAgentId as linkAgentIdApi,
  registerExternalUser,
  type UserRecord,
} from '@/lib/api';
import { useSigner } from './use-signer';

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

  // On connect: probe the backend to see if this address already has a row.
  // We do NOT auto-create. Registration only happens when the user claims a
  // handle (atomic — same call creates the row).
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
  }, [signer.isConnected, signer.address]);

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
        return created;
      }
      if (state.user.handle === null) {
        const updated = await claimHandleApi(state.user.id, handle);
        setState({ status: 'ready', user: updated });
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
        throw new Error('Claim a handle first — agentId links to your user record');
      }
      const updated = await linkAgentIdApi(state.user.id, agentId);
      setState({ status: 'ready', user: updated });
      return updated;
    },
    [state],
  );

  return { state, claimHandle, linkAgentId };
}
