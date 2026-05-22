// Bridge widget config: source chains the UI exposes for CCTP V2 bridging
// into Arc Testnet. Source-chain identifiers are wagmi chain IDs (used for
// switchChain + useBalance); destination is locked to Arc_Testnet.
import {
  arbitrumSepolia,
  baseSepolia,
  optimismSepolia,
  sepolia,
} from 'wagmi/chains';
import type { Address } from 'viem';

export type BridgeSource = {
  key: 'sepolia' | 'optimismSepolia' | 'arbitrumSepolia' | 'baseSepolia';
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
  // USDC ERC-20 contract address on the source chain.
  usdc: Address;
  // Native gas token symbol on this chain (used in the "Claim X gas" link).
  gasSymbol: string;
  // Faucet URL for the native gas token on this chain.
  gasFaucetUrl: string;
};

// Universal CCTP testnet USDC faucet — same URL across all source chains.
export const USDC_FAUCET_URL = 'https://faucet.circle.com';

export const BRIDGE_SOURCES: BridgeSource[] = [
  {
    key: 'sepolia',
    shortName: 'Ethereum',
    fullName: 'Ethereum Sepolia',
    wagmiChainId: sepolia.id,
    bridgeChain: 'Ethereum_Sepolia',
    cctpDomain: 0,
    usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    gasSymbol: 'ETH',
    gasFaucetUrl: 'https://www.alchemy.com/faucets/ethereum-sepolia',
  },
  {
    key: 'optimismSepolia',
    shortName: 'OP',
    fullName: 'OP Sepolia',
    wagmiChainId: optimismSepolia.id,
    bridgeChain: 'Optimism_Sepolia',
    cctpDomain: 2,
    usdc: '0x5fd84259d66Cd46123540766Be93DFE6D43130D7',
    gasSymbol: 'ETH',
    gasFaucetUrl: 'https://www.alchemy.com/faucets/optimism-sepolia',
  },
  {
    key: 'arbitrumSepolia',
    shortName: 'Arbitrum',
    fullName: 'Arbitrum Sepolia',
    wagmiChainId: arbitrumSepolia.id,
    bridgeChain: 'Arbitrum_Sepolia',
    cctpDomain: 3,
    usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
    gasSymbol: 'ETH',
    gasFaucetUrl: 'https://www.alchemy.com/faucets/arbitrum-sepolia',
  },
  {
    key: 'baseSepolia',
    shortName: 'Base',
    fullName: 'Base Sepolia',
    wagmiChainId: baseSepolia.id,
    bridgeChain: 'Base_Sepolia',
    cctpDomain: 6,
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    gasSymbol: 'ETH',
    gasFaucetUrl: 'https://www.alchemy.com/faucets/base-sepolia',
  },
];

export const BRIDGE_DESTINATION = 'Arc_Testnet' as const;

// CCTP step order — used by the progress UI even before any events arrive,
// so users see the full sequence ahead of time.
export const BRIDGE_STEP_ORDER = ['approve', 'burn', 'fetchAttestation', 'mint'] as const;
export type BridgeStepName = (typeof BRIDGE_STEP_ORDER)[number];

export const BRIDGE_STEP_LABELS: Record<BridgeStepName, string> = {
  approve: 'Approve USDC',
  burn: 'Burn on source chain',
  fetchAttestation: 'Wait for Circle attestation',
  mint: 'Mint on Arc',
};
