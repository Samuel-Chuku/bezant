'use client';

import { useEffect, useRef, useState } from 'react';
import { useSigner } from '@/hooks/use-signer';
import { ensureSession, getSessionAddress, onSessionChange } from '@/lib/session';

// Bumps whenever the session is established or cleared. Views include it in
// their fetch deps to refetch owner-only data (e.g. volume) right after sign-in.
export function useSessionVersion(): number {
  const [v, setV] = useState(0);
  useEffect(() => onSessionChange(() => setV((x) => x + 1)), []);
  return v;
}

// Establishes a SIWE session once a wallet is connected: prompts a single
// signature and stores the returned bearer token. Attempts once per address -
// if the user cancels or the account can't be verified (e.g. a brand-new
// counterfactual passkey account with no history), it does not re-prompt in a
// loop; a page reload or reconnect starts fresh.
export function SessionManager() {
  const signer = useSigner();
  const signRef = useRef(signer.signMessage);
  signRef.current = signer.signMessage;
  const attempted = useRef<string | null>(null);

  useEffect(() => {
    if (!signer.isConnected || !signer.address) return;
    const addr = signer.address.toLowerCase();
    if (getSessionAddress() === addr) {
      attempted.current = addr;
      return;
    }
    if (attempted.current === addr) return;
    const sign = signRef.current;
    if (!sign) return;
    attempted.current = addr;
    void ensureSession(addr, sign).catch(() => {
      /* leave unauthenticated; gated reads return empty until next reload */
    });
  }, [signer.isConnected, signer.address]);

  return null;
}
