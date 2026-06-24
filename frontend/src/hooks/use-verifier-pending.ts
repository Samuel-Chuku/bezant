'use client';

// Pending verifications for the connected verifier — trades where they were
// drawn onto a panel and still owe a vote. Powers the /verify list and the
// subtle nav badge. Light poll (30s) + refetch on focus.
import { useCallback, useEffect, useState } from 'react';
import { useSigner } from './use-signer';
import { getVerifierPending, type VerifierPending } from '@/lib/api';

export function useVerifierPending() {
  const signer = useSigner();
  const [items, setItems] = useState<VerifierPending[]>([]);
  const address = signer.isConnected ? signer.address : null;

  const refresh = useCallback(async () => {
    if (!address) {
      setItems([]);
      return;
    }
    try {
      setItems(await getVerifierPending(address));
    } catch {
      /* leave as-is on a transient error */
    }
  }, [address]);

  useEffect(() => {
    void refresh();
    if (!address) return;
    const id = setInterval(() => void refresh(), 30_000);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener('focus', onFocus);
    };
  }, [address, refresh]);

  return { items, count: items.length, refresh };
}
