// Turns a raw {to, data} call into a human-readable review for the pre-sign
// modal. Decodes against the known arc-trade function set; anything unrecognized
// falls back to a generic "Confirm transaction" so every tx still gets a review.
import { decodeFunctionData, formatUnits, parseAbi } from 'viem';

const ABI = parseAbi([
  // USDC (ERC-20)
  'function approve(address spender, uint256 value)',
  'function transfer(address to, uint256 value)',
  // Financing pool
  'function deposit(uint256 amount)',
  'function redeem(uint256 shares)',
  // Circle Gateway wallet
  'function deposit(address token, uint256 value)',
  // TradeEscrow
  'function createTrade(address seller, uint256 amount, bytes32 milestone, uint48 deadline, address attester)',
  'function fund(uint256 id)',
  'function accept(uint256 id)',
  'function counter(uint256 id, uint256 amount)',
  'function cancel(uint256 id)',
  'function requestFinancing(uint256 id)',
  'function attest(uint256 id, bytes32 proof, bool passed)',
  'function raiseDispute(uint256 id)',
  'function refund(uint256 id)',
  'function resolveDispute(uint256 id, bool releaseToSeller)',
]);

export type TxReviewMeta = {
  title: string;
  amountUsdc?: string;
  token?: string;
  network: string;
  contract?: string;
};

export function describeTx(to: string, data: string): TxReviewMeta {
  const base: TxReviewMeta = { title: 'Confirm transaction', network: 'Arc Testnet', contract: to };
  if (!data || data.length < 10) return base;

  try {
    const { functionName, args } = decodeFunctionData({ abi: ABI, data: data as `0x${string}` });
    const usdc = (v: unknown) => formatUnits(v as bigint, 6);
    switch (functionName) {
      case 'approve':
        return { ...base, title: 'Approve USDC', amountUsdc: usdc(args[1]), token: 'USDC' };
      case 'transfer':
        return { ...base, title: 'Send USDC', amountUsdc: usdc(args[1]), token: 'USDC' };
      case 'deposit':
        return args.length === 2
          ? { ...base, title: 'Deposit to Gateway', amountUsdc: usdc(args[1]), token: 'USDC' }
          : { ...base, title: 'Deposit to pool', amountUsdc: usdc(args[0]), token: 'USDC' };
      case 'redeem':
        return { ...base, title: 'Withdraw from pool' };
      case 'createTrade':
        return { ...base, title: 'Create trade', amountUsdc: usdc(args[1]), token: 'USDC' };
      case 'counter':
        return { ...base, title: 'Counter-offer', amountUsdc: usdc(args[1]), token: 'USDC' };
      case 'fund':
        return { ...base, title: 'Fund trade' };
      case 'accept':
        return { ...base, title: 'Accept offer' };
      case 'cancel':
        return { ...base, title: 'Cancel trade' };
      case 'requestFinancing':
        return { ...base, title: 'Draw financing' };
      case 'attest':
        return { ...base, title: 'Attest delivery' };
      case 'raiseDispute':
        return { ...base, title: 'Raise dispute' };
      case 'refund':
        return { ...base, title: 'Refund' };
      case 'resolveDispute':
        return { ...base, title: 'Resolve dispute' };
      default:
        return base;
    }
  } catch {
    return base;
  }
}
