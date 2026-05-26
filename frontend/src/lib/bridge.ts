// Bridge widget config: chains the UI exposes for CCTP V2 bridging. Both
// source and destination are picked from this set. Arc is the default
// destination and the focal chain of arc-trade.
import {
  arbitrumSepolia,
  baseSepolia,
  optimismSepolia,
  sepolia,
} from 'wagmi/chains';
import type { Address } from 'viem';
import { arcTestnet, USDC_ADDRESS as ARC_USDC } from './chains';

export type BridgeChain = {
  key: 'sepolia' | 'optimismSepolia' | 'arbitrumSepolia' | 'baseSepolia' | 'arcTestnet';
  // Short name for the chain card (e.g. "Ethereum", "Base").
  shortName: string;
  // Full display name used in copy ("Ethereum Sepolia").
  fullName: string;
  // wagmi chain id for switchChain + useBalance.
  wagmiChainId: number;
  // Bridge Kit chain identifier string (matches the BridgeChain enum).
  bridgeChain: string;
  // CCTP V2 domain ID — surfaced in the chain card subtitle.
  cctpDomain: number;
  // USDC ERC-20 contract address. On Arc USDC is the native gas token, so we
  // also use useBalance(... no token) — the precompile address still works
  // here for ERC-20 calls if needed.
  usdc: Address;
  // True when USDC is the native gas token (Arc). Tells useBalance not to
  // pass `token`, since the L1 native USDC balance is what we want.
  usdcIsNative: boolean;
  // Native gas token symbol on this chain (used in the "Get X for gas" link).
  gasSymbol: string;
  // Faucet URL for the native gas token on this chain. Empty for Arc — user
  // is already on Arc when bridging out, so no out-of-chain faucet is needed.
  gasFaucetUrl: string;
  // When true, bridging OUT of this chain requires a Circle passkey wallet —
  // injected EVM wallets don't smoothly handle Arc's USDC-as-native model yet.
  // Set on Arc only.
  arcOnly: boolean;
};

// Back-compat alias — some files still reference BridgeSource. New code
// should use BridgeChain.
export type BridgeSource = BridgeChain;

// Universal CCTP testnet USDC faucet — same URL across all source chains.
export const USDC_FAUCET_URL = 'https://faucet.circle.com';

export const BRIDGE_CHAINS: BridgeChain[] = [
  {
    key: 'arcTestnet',
    shortName: 'Arc',
    fullName: 'Arc Testnet',
    wagmiChainId: arcTestnet.id,
    bridgeChain: 'Arc_Testnet',
    cctpDomain: 26,
    usdc: ARC_USDC,
    usdcIsNative: true,
    gasSymbol: 'USDC',
    gasFaucetUrl: '',
    arcOnly: true,
  },
  {
    key: 'sepolia',
    shortName: 'Ethereum',
    fullName: 'Ethereum Sepolia',
    wagmiChainId: sepolia.id,
    bridgeChain: 'Ethereum_Sepolia',
    cctpDomain: 0,
    usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    usdcIsNative: false,
    gasSymbol: 'ETH',
    gasFaucetUrl: 'https://www.alchemy.com/faucets/ethereum-sepolia',
    arcOnly: false,
  },
  {
    key: 'optimismSepolia',
    shortName: 'OP',
    fullName: 'OP Sepolia',
    wagmiChainId: optimismSepolia.id,
    bridgeChain: 'Optimism_Sepolia',
    cctpDomain: 2,
    usdc: '0x5fd84259d66Cd46123540766Be93DFE6D43130D7',
    usdcIsNative: false,
    gasSymbol: 'ETH',
    gasFaucetUrl: 'https://www.alchemy.com/faucets/optimism-sepolia',
    arcOnly: false,
  },
  {
    key: 'arbitrumSepolia',
    shortName: 'Arbitrum',
    fullName: 'Arbitrum Sepolia',
    wagmiChainId: arbitrumSepolia.id,
    bridgeChain: 'Arbitrum_Sepolia',
    cctpDomain: 3,
    usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
    usdcIsNative: false,
    gasSymbol: 'ETH',
    gasFaucetUrl: 'https://www.alchemy.com/faucets/arbitrum-sepolia',
    arcOnly: false,
  },
  {
    key: 'baseSepolia',
    shortName: 'Base',
    fullName: 'Base Sepolia',
    wagmiChainId: baseSepolia.id,
    bridgeChain: 'Base_Sepolia',
    cctpDomain: 6,
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    usdcIsNative: false,
    gasSymbol: 'ETH',
    gasFaucetUrl: 'https://www.alchemy.com/faucets/base-sepolia',
    arcOnly: false,
  },
];

// Default destination — Arc is the focal chain of arc-trade.
export const DEFAULT_DESTINATION_KEY: BridgeChain['key'] = 'arcTestnet';

// Source-chain subset used by panels that only want non-Arc chains (the
// bridge balances panel still shows Arc separately).
export const BRIDGE_SOURCES: BridgeChain[] = BRIDGE_CHAINS.filter((c) => !c.arcOnly);

export function chainByKey(key: BridgeChain['key']): BridgeChain {
  const c = BRIDGE_CHAINS.find((x) => x.key === key);
  if (!c) throw new Error(`Unknown bridge chain: ${key}`);
  return c;
}

// CCTP step order — used by the progress UI even before any events arrive,
// so users see the full sequence ahead of time.
export const BRIDGE_STEP_ORDER = ['approve', 'burn', 'fetchAttestation', 'mint'] as const;
export type BridgeStepName = (typeof BRIDGE_STEP_ORDER)[number];

export const BRIDGE_STEP_LABELS: Record<BridgeStepName, string> = {
  approve: 'Approve USDC',
  burn: 'Burn on source chain',
  fetchAttestation: 'Wait for Circle attestation',
  mint: 'Mint on destination',
};
