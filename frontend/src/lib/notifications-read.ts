// localStorage-backed read-state for notifications. Stores the set of
// notification keys this wallet has already seen, capped FIFO so the file
// doesn't grow forever as old jobs accumulate.
import type { Address } from 'viem';

const MAX_KEYS = 200;
const KEY_PREFIX = 'arc-trade:notifs-read:';

function storageKey(address: Address): string {
  return `${KEY_PREFIX}${address.toLowerCase()}`;
}

export function loadReadKeys(address: Address): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(storageKey(address));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((k): k is string => typeof k === 'string'));
  } catch {
    return new Set();
  }
}

export function saveReadKeys(address: Address, keys: Set<string>): void {
  if (typeof window === 'undefined') return;
  // Newest first when written; cap to MAX_KEYS so a long-lived account
  // doesn't grow unbounded.
  const arr = [...keys].slice(-MAX_KEYS);
  try {
    window.localStorage.setItem(storageKey(address), JSON.stringify(arr));
  } catch {
    // Quota or disabled storage — silently drop.
  }
}

export function markReadKeys(address: Address, keys: string[]): void {
  const current = loadReadKeys(address);
  for (const k of keys) current.add(k);
  saveReadKeys(address, current);
}
