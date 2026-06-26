import type { ReactNode } from 'react';
import { Card } from './card';

// Label + big value + optional hint. Used in the profile stats strip, pool,
// and the verifier economics block.
export function StatCard({
  label,
  value,
  hint,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  className?: string;
}) {
  return (
    <Card padding="md" className={className}>
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-fg">{value}</div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </Card>
  );
}
