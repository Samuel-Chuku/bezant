import type { ComponentProps } from 'react';

// DS status badge: transparent bg, 1px colored border, colored uppercase
// eyebrow text. Verified = champagne (brand); everything else is semantic.
export type BadgeTone = 'verified' | 'settled' | 'pending' | 'contested' | 'info' | 'neutral';

const TONE: Record<BadgeTone, string> = {
  verified: 'border-brand text-brand',
  settled: 'border-primary text-primary',
  pending: 'border-warn text-warn',
  contested: 'border-danger text-danger',
  info: 'border-info text-info',
  neutral: 'border-line-strong text-muted',
};

export function Badge({
  tone = 'neutral',
  className,
  ...rest
}: ComponentProps<'span'> & { tone?: BadgeTone }) {
  return (
    <span
      className={[
        'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider',
        TONE[tone],
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    />
  );
}
