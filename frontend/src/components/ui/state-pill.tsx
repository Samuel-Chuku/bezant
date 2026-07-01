import { Badge } from './badge';
import { labelForStatus, toneForStatus } from '@/lib/bond-language';

// The bond-state pill: one status-dot vocabulary reused everywhere a bond's
// lifecycle state is shown (Struck / Funded / Settled / Contested / …). Maps the
// on-chain status through bond-language so label + tone stay consistent.
export function StatePill({ status, className }: { status: string; className?: string }) {
  return (
    <Badge tone={toneForStatus(status)} dot className={className}>
      {labelForStatus(status)}
    </Badge>
  );
}
