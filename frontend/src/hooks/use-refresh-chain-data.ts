'use client';

import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';

/**
 * Returns a function that invalidates every wagmi-cached chain read.
 *
 * Call after any transaction whose effects might change something the UI
 * is currently displaying — most commonly USDC balances (post-bridge,
 * post-fund, post-complete) and allowance reads (post-approve).
 *
 * The 15s polling on useBalance is a safety net; this is the snappy path
 * so the user sees the new number the instant the tx confirms.
 *
 * Used by:
 *   - hooks/use-signer.ts → after sendCall().wait() resolves successfully,
 *     covering every job action (setBudget, fund, submit, complete, reject,
 *     claimRefund, register-agent).
 *   - components/bridge-widget.tsx → after kit.bridge() settles. Bridge Kit
 *     bypasses useSigner, so it needs the explicit call.
 */
export function useRefreshChainData() {
  const qc = useQueryClient();
  return useCallback(() => {
    // wagmi v2 keys: useBalance → ['balance', {...}], useReadContract →
    // ['readContract', {...}], useReadContracts → ['readContracts', {...}].
    // Prefix-match invalidates every variant in a single sweep.
    qc.invalidateQueries({ queryKey: ['balance'] });
    qc.invalidateQueries({ queryKey: ['readContract'] });
    qc.invalidateQueries({ queryKey: ['readContracts'] });
  }, [qc]);
}
