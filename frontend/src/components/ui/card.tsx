import type { ComponentProps } from 'react';

// Surface container. Default sits on --surface; `inset` drops to --bg for
// nested panels (the old neutral-950-on-neutral-900 pattern).
type Padding = 'none' | 'sm' | 'md' | 'lg';

const PAD: Record<Padding, string> = {
  none: '',
  sm: 'p-4',
  md: 'p-5',
  lg: 'p-6',
};

export function Card({
  inset = false,
  padding = 'md',
  className,
  ...rest
}: ComponentProps<'div'> & { inset?: boolean; padding?: Padding }) {
  return (
    <div
      className={[
        'rounded-2xl border',
        inset ? 'border-line bg-bg' : 'border-line bg-surface',
        PAD[padding],
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    />
  );
}
