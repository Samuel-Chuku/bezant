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

// ERC-8004 ReputationRegistry. The canonical EIP-8004 address starts with
// 0x8004 across deployments; override via env if Arc moves it.
export const ERC8004_REPUTATION_ADDRESS = (process.env.ARC_REPUTATION_REGISTRY_ADDRESS ??
  '0x8004B663056A597Dffe9eCcC1965A193B7388713') as `0x${string}`;
