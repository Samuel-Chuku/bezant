// String-level truncation (not rounding) so we never inflate the displayed
// balance - wagmi gives us the formatted value as a string already. Lifted
// from the home page wallet card; three components consume it now.
export function truncateBalance(formatted: string, decimals = 3): string {
  const [intPart, decimalPart] = formatted.split('.');
  if (!decimalPart) return intPart;
  return `${intPart}.${decimalPart.slice(0, decimals)}`;
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function shortHash(hash: string): string {
  return `${hash.slice(0, 8)}…${hash.slice(-6)}`;
}
