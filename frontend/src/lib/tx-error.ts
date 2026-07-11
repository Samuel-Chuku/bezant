// Turn raw wallet/viem errors into a short, human line. viem dumps a multi-line
// blob (args, versions) that must never surface bare in the UI - the classic
// culprit being a chain mismatch when the wallet is on the wrong network.
export function friendlyTxError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();
  if (
    lower.includes('does not match the target chain') ||
    lower.includes('chain of the wallet') ||
    lower.includes('chain mismatch')
  ) {
    return 'Your wallet is on the wrong network. Switch to Arc Testnet and try again.';
  }
  if (
    lower.includes('user rejected') ||
    lower.includes('user denied') ||
    lower.includes('rejected the request') ||
    lower.includes('4001')
  ) {
    return 'Request cancelled in your wallet.';
  }
  if (lower.includes('insufficient funds')) {
    return 'Insufficient funds to cover this transaction.';
  }
  // Fallback: first line only, capped - never the full viem blob.
  return raw.split('\n')[0].slice(0, 200);
}
