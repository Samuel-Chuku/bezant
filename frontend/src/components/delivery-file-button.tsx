'use client';

import { useEffect, useState } from 'react';
import { keccak256 } from 'viem';
import { useSigner } from '@/hooks/use-signer';
import { useToast } from '@/components/toast';
import { downloadTradeDeliveryFile, getOrCreateTradeReadAuth } from '@/lib/api';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function PaperclipIcon({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21.44 11.05 12.25 20.24a5 5 0 0 1-7.07-7.07l9.19-9.19a3 3 0 0 1 4.24 4.24l-9.2 9.19a1 1 0 0 1-1.41-1.41l8.48-8.49" />
    </svg>
  );
}

// A trade delivery file attachment: shows name + type + size, a verified
// download for any type, and an inline preview for images. Every fetch goes
// through the parties-only endpoint and re-checks keccak256 against the
// committed hash before the bytes are used — a tampered/wrong file never
// reaches disk or the preview.
export function DeliveryFileButton({
  tradeId,
  fileHash,
  fileName,
  fileMime,
  fileSize,
}: {
  tradeId: string;
  fileHash: string;
  fileName: string;
  fileMime?: string | null;
  fileSize?: number | null;
}) {
  const signer = useSigner();
  const toast = useToast();
  const [busy, setBusy] = useState<false | 'download' | 'preview'>(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const isImage = (fileMime ?? '').startsWith('image/');

  // Release any object URL we created when the preview toggles off / unmounts.
  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const fetchVerified = async (): Promise<Blob> => {
    if (!signer.isConnected || !signer.signMessage) {
      throw new Error('Connect your wallet to access the delivery file.');
    }
    const auth = await getOrCreateTradeReadAuth(tradeId, signer.address, signer.signMessage);
    const blob = await downloadTradeDeliveryFile(tradeId, fileHash, auth);
    const recomputed = keccak256(new Uint8Array(await blob.arrayBuffer()));
    if (recomputed.toLowerCase() !== fileHash.toLowerCase()) {
      throw new Error('file failed the integrity check — hash mismatch, not opening');
    }
    return blob;
  };

  const download = async () => {
    setBusy('download');
    try {
      const blob = await fetchVerified();
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

  const togglePreview = async () => {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
      return;
    }
    setBusy('preview');
    try {
      const blob = await fetchVerified();
      setPreviewUrl(URL.createObjectURL(blob));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const typeLabel = fileMime && fileMime !== 'application/octet-stream' ? fileMime : 'file';

  return (
    <div className="rounded-md border border-line bg-surface/40 p-2.5">
      <div className="flex items-center gap-2">
        <PaperclipIcon className="h-4 w-4 flex-shrink-0 text-muted" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-fg" title={fileName}>{fileName}</div>
          <div className="text-[10px] text-muted">
            {typeLabel}
            {typeof fileSize === 'number' && fileSize > 0 ? ` · ${formatBytes(fileSize)}` : ''}
          </div>
        </div>
        {isImage && (
          <button
            type="button"
            onClick={togglePreview}
            disabled={!!busy}
            className="rounded-md border border-line px-2 py-1 text-[11px] text-fg transition hover:border-line-strong disabled:opacity-50"
          >
            {busy === 'preview' ? '…' : previewUrl ? 'Hide' : 'Preview'}
          </button>
        )}
        <button
          type="button"
          onClick={download}
          disabled={!!busy}
          className="rounded-md border border-line bg-surface/60 px-2 py-1 text-[11px] font-medium text-fg transition hover:border-line-strong disabled:opacity-50"
        >
          {busy === 'download' ? 'Verifying…' : 'Download'}
        </button>
      </div>
      {previewUrl && (
        // Object URL of verified bytes; next/image can't take a blob URL.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={previewUrl} alt={fileName} className="mt-2 max-h-64 w-auto rounded-md border border-line" />
      )}
    </div>
  );
}
