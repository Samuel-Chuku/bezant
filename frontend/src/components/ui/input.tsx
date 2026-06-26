import type { ComponentProps } from 'react';

// The repeated input style, tokenized. Mint focus border for a clear affordance.
export const inputClass =
  'w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm text-fg placeholder:text-muted focus:border-primary focus:outline-none disabled:opacity-50';

export function Input({ className, ...rest }: ComponentProps<'input'>) {
  return <input className={[inputClass, className].filter(Boolean).join(' ')} {...rest} />;
}
