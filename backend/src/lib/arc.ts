import { createPublicClient, http } from 'viem';

const ARC_RPC_URL = process.env.ARC_RPC_URL ?? 'https://rpc.testnet.arc.network';

export const arcClient = createPublicClient({
  transport: http(ARC_RPC_URL),
});

// USDC on Arc Testnet (6 decimals, NOT 18 — common trap)
export const USDC_ADDRESS = '0x3600000000000000000000000000000000000000' as const;
