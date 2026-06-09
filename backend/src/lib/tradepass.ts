// TradePass standalone-escrow access layer.
//
// Mirrors the existing wrapper wiring: reads go through viem (`arcClient`),
// writes are handed to Circle Developer-Controlled Wallets in server.ts via
// `circle.createContractExecutionTransaction(...)`. This module stays decoupled
// from the Circle client — write helpers return an *exec spec* (contract +
// function signature + params) that the route passes straight to Circle, so the
// same shape used for PactWrapper applies here.
//
// Addresses come from env after `forge script DeployTradePass`. Until then they
// default to the zero address (reads will revert; that's expected pre-deploy).

import { arcClient } from './arc.js';
import { tradeEscrowAbi } from './abis/trade-escrow.js';
import { tradePassportAbi } from './abis/trade-passport.js';
import { financingPoolAbi } from './abis/financing-pool.js';

const ZERO = '0x0000000000000000000000000000000000000000' as const;

export const TRADE_ESCROW_ADDRESS = (process.env.TRADE_ESCROW_ADDRESS ?? ZERO) as `0x${string}`;
export const TRADE_PASSPORT_ADDRESS = (process.env.TRADE_PASSPORT_ADDRESS ?? ZERO) as `0x${string}`;
export const FINANCING_POOL_ADDRESS = (process.env.FINANCING_POOL_ADDRESS ?? ZERO) as `0x${string}`;

// Trade lifecycle status — index matches TradeEscrow.Status.
export const TRADE_STATUS = [
  'None',
  'Proposing',
  'Agreed',
  'Funded',
  'Released',
  'Disputed',
  'Refunded',
  'Cancelled',
] as const;
export type TradeStatus = (typeof TRADE_STATUS)[number];

// ----------------------------------------------------------------- reads ----

export async function getTrade(id: bigint | number) {
  const t = (await arcClient.readContract({
    address: TRADE_ESCROW_ADDRESS,
    abi: tradeEscrowAbi,
    functionName: 'trades',
    args: [BigInt(id)],
  })) as readonly [
    `0x${string}`, // buyer
    `0x${string}`, // seller
    `0x${string}`, // attester
    `0x${string}`, // lastProposer
    bigint, // amount
    bigint, // deposit
    bigint, // shares
    bigint, // financedRepay
    `0x${string}`, // milestoneHash
    number, // deadline (uint48)
    boolean, // financingAdvanced
    number, // status (enum)
  ];
  return {
    buyer: t[0],
    seller: t[1],
    attester: t[2],
    lastProposer: t[3],
    amount: t[4],
    deposit: t[5],
    shares: t[6],
    financedRepay: t[7],
    milestoneHash: t[8],
    deadline: t[9],
    financingAdvanced: t[10],
    status: TRADE_STATUS[t[11]] ?? 'None',
  };
}

export async function depositOf(id: bigint | number): Promise<bigint> {
  return (await arcClient.readContract({
    address: TRADE_ESCROW_ADDRESS,
    abi: tradeEscrowAbi,
    functionName: 'depositOf',
    args: [BigInt(id)],
  })) as bigint;
}

/// Deposit the buyer would lock if funding now (passport-priced) — the actual
/// deposit is only set inside fund(), so use this to size the pre-fund approval.
export async function estimatedDepositOf(id: bigint | number): Promise<bigint> {
  return (await arcClient.readContract({
    address: TRADE_ESCROW_ADDRESS,
    abi: tradeEscrowAbi,
    functionName: 'estimatedDeposit',
    args: [BigInt(id)],
  })) as bigint;
}

/// The address allowed to resolve a disputed trade (deployer EOA by default).
export async function getArbitrator(): Promise<`0x${string}`> {
  return (await arcClient.readContract({
    address: TRADE_ESCROW_ADDRESS,
    abi: tradeEscrowAbi,
    functionName: 'arbitrator',
  })) as `0x${string}`;
}

/// depositBps the passport will price a buyer's next trade at (10000 = 100%).
export async function passportDepositBps(buyer: `0x${string}`): Promise<number> {
  return (await arcClient.readContract({
    address: TRADE_PASSPORT_ADDRESS,
    abi: tradePassportAbi,
    functionName: 'depositBps',
    args: [buyer],
  })) as number;
}

/// Advance size as bps of the trade amount (e.g. 8000 = 80%).
export async function financeBps(): Promise<number> {
  return Number(
    (await arcClient.readContract({
      address: TRADE_ESCROW_ADDRESS,
      abi: tradeEscrowAbi,
      functionName: 'financeBps',
    })) as number,
  );
}

/// Pool fee in bps for a buyer tier. The pool clamps to its last tier entry;
/// the deployed pool has 3 (idx 0/1/2 = 3%/2%/1%), so min(tier,2) is always a
/// valid index and matches the pool's internal _feeBps.
export async function poolFeeBps(tier: number): Promise<number> {
  return Number(
    (await arcClient.readContract({
      address: FINANCING_POOL_ADDRESS,
      abi: financingPoolAbi,
      functionName: 'feeBpsByTier',
      args: [BigInt(Math.max(0, Math.min(tier, 2)))],
    })) as number,
  );
}

export async function passportTier(account: `0x${string}`): Promise<number> {
  return (await arcClient.readContract({
    address: TRADE_PASSPORT_ADDRESS,
    abi: tradePassportAbi,
    functionName: 'tier',
    args: [account],
  })) as number;
}

/// Full passport snapshot for the UI panel.
export async function getPassport(address: `0x${string}`) {
  const [completed, failed, depositBps] = (await Promise.all([
    arcClient.readContract({ address: TRADE_PASSPORT_ADDRESS, abi: tradePassportAbi, functionName: 'completed', args: [address] }),
    arcClient.readContract({ address: TRADE_PASSPORT_ADDRESS, abi: tradePassportAbi, functionName: 'failed', args: [address] }),
    arcClient.readContract({ address: TRADE_PASSPORT_ADDRESS, abi: tradePassportAbi, functionName: 'depositBps', args: [address] }),
  ])) as [number, number, number];
  return {
    address,
    completedTrades: Number(completed),
    failedTrades: Number(failed),
    depositBps: Number(depositBps),
    depositPct: Number(depositBps) / 100,
  };
}

// ------------------------------------------------------------ write specs ---
// Each returns the args for `circle.createContractExecutionTransaction`.

export type ExecSpec = {
  contractAddress: `0x${string}`;
  abiFunctionSignature: string;
  abiParameters: (string | boolean)[];
};

export function createTradeSpec(
  seller: `0x${string}`,
  amount: bigint,
  milestoneHash: `0x${string}`,
  deadline: number,
  attester: `0x${string}`,
): ExecSpec {
  return {
    contractAddress: TRADE_ESCROW_ADDRESS,
    abiFunctionSignature: 'createTrade(address,uint256,bytes32,uint48,address)',
    abiParameters: [seller, amount.toString(), milestoneHash, deadline.toString(), attester],
  };
}

export function fundSpec(id: bigint | number): ExecSpec {
  return {
    contractAddress: TRADE_ESCROW_ADDRESS,
    abiFunctionSignature: 'fund(uint256)',
    abiParameters: [id.toString()],
  };
}

export function attestSpec(id: bigint | number, proofHash: `0x${string}`, passed: boolean): ExecSpec {
  return {
    contractAddress: TRADE_ESCROW_ADDRESS,
    abiFunctionSignature: 'attest(uint256,bytes32,bool)',
    abiParameters: [id.toString(), proofHash, passed],
  };
}

export function acceptSpec(id: bigint | number): ExecSpec {
  return {
    contractAddress: TRADE_ESCROW_ADDRESS,
    abiFunctionSignature: 'accept(uint256)',
    abiParameters: [id.toString()],
  };
}

export function counterSpec(id: bigint | number, newAmount: bigint): ExecSpec {
  return {
    contractAddress: TRADE_ESCROW_ADDRESS,
    abiFunctionSignature: 'counter(uint256,uint256)',
    abiParameters: [id.toString(), newAmount.toString()],
  };
}

export function cancelSpec(id: bigint | number): ExecSpec {
  return {
    contractAddress: TRADE_ESCROW_ADDRESS,
    abiFunctionSignature: 'cancel(uint256)',
    abiParameters: [id.toString()],
  };
}

export function requestFinancingSpec(id: bigint | number): ExecSpec {
  return {
    contractAddress: TRADE_ESCROW_ADDRESS,
    abiFunctionSignature: 'requestFinancing(uint256)',
    abiParameters: [id.toString()],
  };
}

export function raiseDisputeSpec(id: bigint | number): ExecSpec {
  return {
    contractAddress: TRADE_ESCROW_ADDRESS,
    abiFunctionSignature: 'raiseDispute(uint256)',
    abiParameters: [id.toString()],
  };
}

export function refundSpec(id: bigint | number): ExecSpec {
  return {
    contractAddress: TRADE_ESCROW_ADDRESS,
    abiFunctionSignature: 'refund(uint256)',
    abiParameters: [id.toString()],
  };
}

export function resolveDisputeSpec(id: bigint | number, releaseToSeller: boolean): ExecSpec {
  return {
    contractAddress: TRADE_ESCROW_ADDRESS,
    abiFunctionSignature: 'resolveDispute(uint256,bool)',
    abiParameters: [id.toString(), releaseToSeller],
  };
}

export const TP_USDC = (process.env.TP_USDC ?? '0x3600000000000000000000000000000000000000') as `0x${string}`;

/// USDC approval for an arbitrary spender.
export function approveSpec(spender: `0x${string}`, amount: bigint): ExecSpec {
  return {
    contractAddress: TP_USDC,
    abiFunctionSignature: 'approve(address,uint256)',
    abiParameters: [spender, amount.toString()],
  };
}

/// USDC approval the buyer must grant the escrow before `fund`.
export function approveEscrowSpec(amount: bigint): ExecSpec {
  return approveSpec(TRADE_ESCROW_ADDRESS, amount);
}

/// Top up the financing pool's USDC reserve (LP / treasury).
export function poolFundSpec(amount: bigint): ExecSpec {
  return {
    contractAddress: FINANCING_POOL_ADDRESS,
    abiFunctionSignature: 'fund(uint256)',
    abiParameters: [amount.toString()],
  };
}
