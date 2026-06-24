'use client';

// Full panel-assignment history for the connected verifier (pending/voted/
// resolved/expired), for the /verify list + filter. Light poll (30s) + focus.
import { useCallback, useEffect, useState } from 'react';
import { useSigner } from './use-signer';
import { getVerifierAssignments, type VerifierAssignment } from '@/lib/api';

export function useVerifierAssignments() {
  const signer = useSigner();
  const [items, setItems] = useState<VerifierAssignment[]>([]);
  const [loaded, setLoaded] = useState(false);
  const address = signer.isConnected ? signer.address : null;

  const refresh = useCallback(async () => {
    if (!address) {
      setItems([]);
      setLoaded(true);
      return;
    }
    try {
      setItems(await getVerifierAssignments(address));
    } catch {
      /* leave as-is on a transient error */
    } finally {
      setLoaded(true);
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

  return { items, loaded, refresh };
}
