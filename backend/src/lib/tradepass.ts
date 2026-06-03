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
  'Created',
  'Funded',
  'Attested',
  'Released',
  'Disputed',
  'Refunded',
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
    amount: t[3],
    deposit: t[4],
    shares: t[5],
    financedRepay: t[6],
    milestoneHash: t[7],
    deadline: t[8],
    financingAdvanced: t[9],
    status: TRADE_STATUS[t[10]] ?? 'None',
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

/// depositBps the passport will price a buyer's next trade at (10000 = 100%).
export async function passportDepositBps(buyer: `0x${string}`): Promise<number> {
  return (await arcClient.readContract({
    address: TRADE_PASSPORT_ADDRESS,
    abi: tradePassportAbi,
    functionName: 'depositBps',
    args: [buyer],
  })) as number;
}

export async function passportTier(account: `0x${string}`): Promise<number> {
  return (await arcClient.readContract({
    address: TRADE_PASSPORT_ADDRESS,
    abi: tradePassportAbi,
    functionName: 'tier',
    args: [account],
  })) as number;
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

export function releaseSpec(id: bigint | number): ExecSpec {
  return {
    contractAddress: TRADE_ESCROW_ADDRESS,
    abiFunctionSignature: 'release(uint256)',
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

/// USDC approval the buyer must grant the escrow before `fund`.
export function approveEscrowSpec(amount: bigint): ExecSpec {
  return {
    contractAddress: (process.env.TP_USDC ?? '0x3600000000000000000000000000000000000000') as `0x${string}`,
    abiFunctionSignature: 'approve(address,uint256)',
    abiParameters: [TRADE_ESCROW_ADDRESS, amount.toString()],
  };
}
