'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { BundlerClient, SmartAccount } from 'viem/account-abstraction';
import type { Address } from 'viem';
import {
  buildSmartAccountFromCredential,
  clearCredential,
  loadCredential,
  loginPasskey,
  registerPasskey,
  saveCredential,
  type P256Credential,
} from '@/lib/circle-modular';

type State =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'connected'; address: Address; smartAccount: SmartAccount; bundlerClient: BundlerClient };

type CircleAccountContextValue = {
  state: State;
  register: (username: string) => Promise<void>;
  login: () => Promise<void>;
  disconnect: () => void;
};

const CircleAccountContext = createContext<CircleAccountContextValue | null>(null);

export function CircleAccountProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: 'idle' });

  const hydrateFromCredential = useCallback(async (credential: P256Credential) => {
    setState({ status: 'loading' });
    try {
      const { smartAccount, bundlerClient } = await buildSmartAccountFromCredential(credential);
      setState({
        status: 'connected',
        address: smartAccount.address,
        smartAccount,
        bundlerClient,
      });
    } catch (err) {
      setState({
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  // Re-hydrate the smart account from a saved credential on first mount.
  // The credential metadata is in localStorage; the private key is in the authenticator.
  useEffect(() => {
    const stored = loadCredential();
    if (stored) {
      void hydrateFromCredential(stored);
    }
  }, [hydrateFromCredential]);

  const register = useCallback(
    async (username: string) => {
      setState({ status: 'loading' });
      try {
        const credential = await registerPasskey(username);
        saveCredential(credential);
        await hydrateFromCredential(credential);
      } catch (err) {
        setState({
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [hydrateFromCredential],
  );

  const login = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const credential = await loginPasskey();
      saveCredential(credential);
      await hydrateFromCredential(credential);
    } catch (err) {
      setState({
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [hydrateFromCredential]);

  const disconnect = useCallback(() => {
    clearCredential();
    setState({ status: 'idle' });
  }, []);

  const value = useMemo<CircleAccountContextValue>(
    () => ({ state, register, login, disconnect }),
    [state, register, login, disconnect],
  );

  return <CircleAccountContext.Provider value={value}>{children}</CircleAccountContext.Provider>;
}

export function useCircleAccount(): CircleAccountContextValue {
  const ctx = useContext(CircleAccountContext);
  if (!ctx) {
    throw new Error('useCircleAccount must be used within a CircleAccountProvider');
  }
  return ctx;
}
