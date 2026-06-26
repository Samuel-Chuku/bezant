import type { ComponentProps } from 'react';

// Status / label badge. Tones map to the semantic tokens.
export type PillTone = 'neutral' | 'primary' | 'warn' | 'danger' | 'info' | 'brand';

const TONE: Record<PillTone, string> = {
  neutral: 'border-line bg-surface-2 text-muted',
  primary: 'border-primary/20 bg-primary-soft text-primary',
  warn: 'border-warn/20 bg-warn-soft text-warn',
  danger: 'border-danger/20 bg-danger-soft text-danger',
  info: 'border-info/25 bg-info/10 text-info',
  brand: 'border-brand/25 bg-brand/10 text-brand',
};

export function Pill({
  tone = 'neutral',
  className,
  ...rest
}: ComponentProps<'span'> & { tone?: PillTone }) {
  return (
    <span
      className={[
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium',
        TONE[tone],
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    />
  );
}
