'use client';

// Transparency view for the officer (automated Trade Officer) route. Mirrors the
// staked-panel decision modal, but is explicit that this is a document-validity
// check - the delivery *information* was validated, not independently verified.
import { createPortal } from 'react-dom';
import type { OfficerReview } from '@/lib/api';
import { DeliveryFileButton } from '@/components/delivery-file-button';

export function OfficerReviewModal({ review, tradeId, onClose }: { review: OfficerReview; tradeId: string; onClose: () => void }) {
  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center px-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div role="dialog" aria-label="Trade Officer review" className="bz-frame relative w-full max-w-md rounded-2xl border border-line bg-bg p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold tracking-tight text-fg">Trade Officer review</h3>
            <p className="mt-0.5 text-sm text-primary">Delivery information validated</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="rounded-md p-1 text-muted hover:bg-surface hover:text-fg">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Verdict summary: the outcome + which examiner produced it. This is the
            short report the buyer/seller asked for - why it was accepted, and by
            what (the LLM examiner or the deterministic fallback). */}
        <div className="mt-4 rounded-lg border border-primary/40 bg-primary/10 p-3 text-sm">
          <div className="flex items-center gap-2 font-medium text-primary">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M20 6 9 17l-5-5" />
            </svg>
            Verdict: Accepted
          </div>
          <p className="mt-1 text-xs text-fg/90">
            The document was accepted as a coherent, authentic-looking shipping/customs record with a valid reference, so
            the bond was cleared to settle to the seller.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
            <span className="uppercase tracking-wide">Reviewed by</span>
            {review.engine === 'llm' ? (
              <span className="rounded-full bg-info/15 px-2 py-0.5 font-medium text-info">
                AI examiner{review.model ? ` · ${review.model}` : ''}
              </span>
            ) : review.engine === 'deterministic' ? (
              <span className="rounded-full bg-muted/30 px-2 py-0.5 font-medium text-fg">Deterministic rules</span>
            ) : (
              <span className="rounded-full bg-muted/30 px-2 py-0.5 font-medium text-fg">Trade Officer</span>
            )}
            {typeof review.confidence === 'number' && <span>· {Math.round(review.confidence * 100)}% confidence</span>}
          </div>
        </div>

        {/* The honest framing - validated info, not full verification. */}
        <div className="mt-3 rounded-lg border border-warn/40 bg-warn/15 p-3 text-xs leading-relaxed text-warn/90">
          The Trade Officer is an <strong>automated agent</strong>. It checks the delivery document is well-formed and
          plausible - the right document type with a real reference. This validates the delivery <strong>information</strong>;
          it is <strong>not</strong> an independent, multi-party verification of the goods. For that, the buyer can choose
          the <strong>Staked panel</strong> at bond creation.
        </div>

        {review.reasons && review.reasons.length > 0 && (
          <div className="mt-4">
            <div className="text-[11px] uppercase tracking-wide text-muted">What it checked</div>
            <ul className="mt-1.5 list-disc space-y-1 pl-5 text-xs text-fg">
              {review.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </div>
        )}

        {review.document && (
          <details className="mt-4 rounded-md border border-line bg-bg/60 p-2">
            <summary className="cursor-pointer text-xs text-muted">Submitted document</summary>
            <pre className="mt-2 whitespace-pre-wrap break-words text-xs text-fg">{review.document}</pre>
          </details>
        )}

        {review.fileHash && review.fileName && (
          <div className="mt-3">
            <DeliveryFileButton tradeId={tradeId} fileHash={review.fileHash} fileName={review.fileName} fileMime={review.fileMime} fileSize={review.fileSize} />
          </div>
        )}

        <button onClick={onClose} className="mt-4 w-full rounded-lg border border-line px-4 py-2 text-sm text-fg hover:border-line-strong">Close</button>
      </div>
    </div>,
    document.body,
  );
}
