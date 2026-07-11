'use client';

import { useState } from 'react';
import { keccak256 } from 'viem';
import { useSigner } from '@/hooks/use-signer';
import { useToast } from '@/components/toast';
import { downloadTradeDeliveryFile, getOrCreateTradeReadAuth } from '@/lib/api';

function PaperclipIcon({ className = 'h-3.5 w-3.5' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21.44 11.05 12.25 20.24a5 5 0 0 1-7.07-7.07l9.19-9.19a3 3 0 0 1 4.24 4.24l-9.2 9.19a1 1 0 0 1-1.41-1.41l8.48-8.49" />
    </svg>
  );
}

// Download + hash-verify a trade's delivery file attachment. Any trade party
// (buyer/seller/panelist/arbitrator) can use it; the backend gates the bytes and
// we re-check keccak256 against the committed hash before saving, so a tampered
// or wrong file never reaches disk.
export function DeliveryFileButton({
  tradeId,
  fileHash,
  fileName,
}: {
  tradeId: string;
  fileHash: string;
  fileName: string;
}) {
  const signer = useSigner();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const download = async () => {
    if (!signer.isConnected || !signer.signMessage) {
      toast.error('Connect your wallet to download the delivery file.');
      return;
    }
    setBusy(true);
    try {
      const auth = await getOrCreateTradeReadAuth(tradeId, signer.address, signer.signMessage);
      const blob = await downloadTradeDeliveryFile(tradeId, fileHash, auth);
      const recomputed = keccak256(new Uint8Array(await blob.arrayBuffer()));
      if (recomputed.toLowerCase() !== fileHash.toLowerCase()) {
        throw new Error('file failed the integrity check — hash mismatch, not saving');
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={download}
      disabled={busy}
      className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface/60 px-2.5 py-1 text-xs font-medium text-fg transition hover:border-line-strong hover:bg-surface disabled:opacity-50"
      title="Download and verify the delivery file"
    >
      <PaperclipIcon className="h-3.5 w-3.5" />
      {busy ? 'Verifying…' : `Delivery file · ${fileName}`}
    </button>
  );
}
