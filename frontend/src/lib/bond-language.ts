import type { BadgeTone } from '@/components/ui';

// Bonds vocabulary: the on-chain trade lifecycle (Proposing / Agreed / Funded /
// Released / Disputed / Refunded / Cancelled) surfaced in the DS's "bonds"
// language. UI copy only - routes, backend, and arc-trade: strings are unchanged.
export const bondStatusLabel: Record<string, string> = {
  Proposing: 'Proposing',
  Agreed: 'Struck',
  Funded: 'Funded',
  Released: 'Settled',
  Disputed: 'Contested',
  Refunded: 'Refunded',
  Cancelled: 'Cancelled',
};

export const bondStatusTone: Record<string, BadgeTone> = {
  Proposing: 'info',
  Agreed: 'pending',
  Funded: 'info',
  Released: 'settled',
  Disputed: 'contested',
  Refunded: 'neutral',
  Cancelled: 'neutral',
};

export function labelForStatus(status: string): string {
  return bondStatusLabel[status] ?? status;
}
export function toneForStatus(status: string): BadgeTone {
  return bondStatusTone[status] ?? 'neutral';
}
