'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  claimHandle as claimHandleApi,
  getUserByAddress,
  registerExternalUser,
  type UserRecord,
} from '@/lib/api';
import { useSigner } from './use-signer';

type State =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; user: UserRecord }
  | { status: 'error'; message: string };

export function useUserRecord() {
  const signer = useSigner();
  const [state, setState] = useState<State>({ status: 'idle' });

  const ensureRecord = useCallback(
    async (address: string, signingMode: 'external' | 'circle-modular') => {
      setState({ status: 'loading' });
      try {
        const existing = await getUserByAddress(address);
        if (existing) {
          setState({ status: 'ready', user: existing });
          return;
        }
        const created = await registerExternalUser({
          walletAddress: address,
          signingMode,
        });
        setState({ status: 'ready', user: created });
      } catch (err) {
        setState({
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [],
  );

  useEffect(() => {
    if (!signer.isConnected) {
      setState({ status: 'idle' });
      return;
    }
    const signingMode = signer.mode === 'circle' ? 'circle-modular' : 'external';
    void ensureRecord(signer.address.toLowerCase(), signingMode);
  }, [signer.isConnected, signer.address, signer.mode, ensureRecord]);

  const claimHandle = useCallback(
    async (handle: string) => {
      if (state.status !== 'ready') {
        throw new Error('Cannot claim handle before user record is ready');
      }
      const updated = await claimHandleApi(state.user.id, handle);
      setState({ status: 'ready', user: updated });
      return updated;
    },
    [state],
  );

  return { state, claimHandle };
}
