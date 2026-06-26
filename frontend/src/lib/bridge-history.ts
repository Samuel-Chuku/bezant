// localStorage-backed bridge history. Keyed per address so switching wallets
// shows that wallet's own runs. Cap at 3 entries (FIFO) - the /bridge page
// displays the most recent first.
import type { Address } from 'viem';
import type { BridgeSource } from './bridge';

export type BridgeHistoryEntry = {
  id: string;
  timestamp: number;
  sourceKey: BridgeSource['key'];
  sourceFullName: string;
  // Destination metadata - older entries (pre-any-to-any) may lack these;
  // readers should default to Arc when reading legacy rows.
  destinationKey?: BridgeSource['key'];
  destinationFullName?: string;
  amount: string;
  status: 'success' | 'error';
  mintTxHash?: string;
  mintExplorerUrl?: string;
  errorMessage?: string;
};

const MAX_ENTRIES = 3;
const KEY_PREFIX = 'arc-trade:bridge-history:';

function keyFor(address: Address): string {
  return `${KEY_PREFIX}${address.toLowerCase()}`;
}

export function loadBridgeHistory(address: Address): BridgeHistoryEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(keyFor(address));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

export function appendBridgeHistory(address: Address, entry: BridgeHistoryEntry): void {
  if (typeof window === 'undefined') return;
  const existing = loadBridgeHistory(address);
  const next = [entry, ...existing].slice(0, MAX_ENTRIES);
  try {
    window.localStorage.setItem(keyFor(address), JSON.stringify(next));
  } catch {
    // Quota or disabled storage - silently drop the write rather than
    // crashing the bridge success path.
  }
}
