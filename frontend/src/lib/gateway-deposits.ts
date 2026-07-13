// Client-side record of Gateway top-up deposits. Circle's /balances pendingBatch
// is unreliable on testnet (often empty, or finalizes before a poll catches it),
// so we can't lean on it to show "X confirming". Instead we log the deposit the
// instant its tx confirms - we know the exact chain + amount - and treat it as
// confirming until that chain's available balance rises to cover it
// (availableAtDeposit + amount), at which point it's credited. localStorage,
// keyed per address; pruned by age on read.
const STORAGE_PREFIX = 'bezant:gw-deposits:';
const MAX = 12;
const MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6h

export type GatewayDeposit = {
  id: string;
  chainKey: string;
  chainName: string;
  amountUsdc: number;
  availableAtDeposit: number; // that chain's Gateway available balance when we deposited
  ts: number;
};

function keyFor(address: string) {
  return STORAGE_PREFIX + address.toLowerCase();
}

function read(address: string): GatewayDeposit[] {
  if (typeof window === 'undefined' || !address) return [];
  try {
    const raw = localStorage.getItem(keyFor(address));
    if (!raw) return [];
    const list = JSON.parse(raw) as GatewayDeposit[];
    return list.filter((d) => Date.now() - d.ts < MAX_AGE_MS);
  } catch {
    return [];
  }
}

function write(address: string, list: GatewayDeposit[]) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(keyFor(address), JSON.stringify(list.slice(0, MAX)));
  notify();
}

const listeners = new Set<() => void>();
export function onGatewayDepositsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
function notify() {
  listeners.forEach((fn) => fn());
}

export function getGatewayDeposits(address: string): GatewayDeposit[] {
  return read(address);
}

export function addGatewayDeposit(address: string, rec: Omit<GatewayDeposit, 'id' | 'ts'>): void {
  const entry: GatewayDeposit = {
    ...rec,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
  };
  write(address, [entry, ...read(address)]);
}

export function removeGatewayDeposit(address: string, id: string): void {
  write(address, read(address).filter((d) => d.id !== id));
}
