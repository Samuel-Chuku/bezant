import { createPublicClient, http } from 'viem';

const ARC_RPC_URL = process.env.ARC_RPC_URL ?? 'https://rpc.testnet.arc.network';

export const ARC_TESTNET_CHAIN_ID = 5042002;

export const arcClient = createPublicClient({
  transport: http(ARC_RPC_URL),
});

// USDC on Arc Testnet (6 decimals, NOT 18 — common trap)
export const USDC_ADDRESS = '0x3600000000000000000000000000000000000000' as const;

// ERC-8183 reference deployment on Arc Testnet (read-only use for now)
export const ERC8183_ADDRESS = '0x0747EEf0706327138c69792bF28Cd525089e4583' as const;
