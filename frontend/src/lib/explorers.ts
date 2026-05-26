// Single source of truth for block-explorer URL construction. Centralizes
// the testnet.arcscan.app base so switching networks (mainnet, alternate
// explorer) is a one-line change instead of a grep.

import { arcTestnet } from './chains';

// Strip a possible trailing slash from the chain's configured explorer URL
// so callers can safely append a path without double-slashing.
function arcExplorerBase(): string {
  const url = arcTestnet.blockExplorers?.default.url ?? 'https://testnet.arcscan.app';
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

export function arcExplorerTxUrl(txHash: string): string {
  return `${arcExplorerBase()}/tx/${txHash}`;
}

export function arcExplorerAddressUrl(address: string): string {
  return `${arcExplorerBase()}/address/${address}`;
}
