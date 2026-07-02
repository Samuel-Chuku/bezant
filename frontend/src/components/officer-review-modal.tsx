'use client';

// Transparency view for the officer (automated Trade Officer) route. Mirrors the
// staked-panel decision modal, but is explicit that this is a document-validity
// check - the delivery *information* was validated, not independently verified.
import { createPortal } from 'react-dom';
import type { OfficerReview } from '@/lib/api';

export function OfficerReviewModal({ review, onClose }: { review: OfficerReview; onClose: () => void }) {
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

        {/* The honest framing - validated info, not full verification. */}
        <div className="mt-4 rounded-lg border border-warn/40 bg-warn/15 p-3 text-xs leading-relaxed text-warn/90">
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

        {typeof review.confidence === 'number' && (
          <p className="mt-3 text-xs text-muted">Confidence: {Math.round(review.confidence * 100)}%</p>
        )}

        <button onClick={onClose} className="mt-4 w-full rounded-lg border border-line px-4 py-2 text-sm text-fg hover:border-line-strong">Close</button>
      </div>
    </div>,
    document.body,
  );
}
