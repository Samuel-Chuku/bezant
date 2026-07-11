// Bridge widget config: chains the UI exposes for CCTP V2 bridging. Both
// source and destination are picked from this set. Arc is the default
// destination and the focal chain of arc-trade.
import {
  arbitrumSepolia,
  avalancheFuji,
  baseSepolia,
  optimismSepolia,
  sepolia,
} from 'wagmi/chains';
import type { Address } from 'viem';
import { arcTestnet, USDC_ADDRESS as ARC_USDC } from './chains';

export type BridgeChain = {
  key:
    | 'sepolia'
    | 'optimismSepolia'
    | 'arbitrumSepolia'
    | 'baseSepolia'
    | 'avalancheFuji'
    | 'arcTestnet'
    | 'solanaDevnet';
  // Short name for the chain card (e.g. "Ethereum", "Base").
  shortName: string;
  // Full display name used in copy ("Ethereum Sepolia").
  fullName: string;
  // wagmi chain id for switchChain + useBalance. Optional because non-EVM
  // chains (Solana) don't have one.
  wagmiChainId?: number;
  // Bridge Kit chain identifier string (matches the BridgeChain enum).
  bridgeChain: string;
  // CCTP V2 domain ID, shown in the chain card subtitle.
  cctpDomain: number;
  // USDC ERC-20 contract address. On Arc USDC is the native gas token.
  // Solana USDC is an SPL mint, not ERC-20, but we keep the field populated
  // for display consistency.
  usdc: Address;
  // True when USDC is the native gas token (Arc). Tells useBalance not to
  // pass `token`, since the L1 native USDC balance is what we want.
  usdcIsNative: boolean;
  // Native gas token symbol on this chain.
  gasSymbol: string;
  // Faucet URL for the native gas token.
  gasFaucetUrl: string;
  // True for Arc, the home chain. Used for "home" styling on the balances
  // panel and the destination chip default.
  arcOnly: boolean;
  // Chain is coming soon. Pickable so users know it's planned, but submit
  // is blocked and balances are not fetched.
  comingSoon: boolean;
  // Bridging OUT of this chain is coming soon. True for Arc today
  // (Modular Wallet adapter not yet wired into Bridge Kit) and for Solana
  // (non-EVM signing path not built).
  outboundComingSoon: boolean;
};

// Back-compat alias - some files still reference BridgeSource. New code
// should use BridgeChain.
export type BridgeSource = BridgeChain;

// Universal CCTP testnet USDC faucet - same URL across all source chains.
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
    comingSoon: false,
    outboundComingSoon: true,
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
    comingSoon: false,
    outboundComingSoon: false,
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
    comingSoon: false,
    outboundComingSoon: false,
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
    comingSoon: false,
    outboundComingSoon: false,
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
    comingSoon: false,
    outboundComingSoon: false,
  },
  {
    key: 'avalancheFuji',
    shortName: 'Avalanche',
    fullName: 'Avalanche Fuji',
    wagmiChainId: avalancheFuji.id,
    bridgeChain: 'Avalanche_Fuji',
    cctpDomain: 1,
    usdc: '0x5425890298aed601595a70AB815c96711a31Bc65',
    usdcIsNative: false,
    gasSymbol: 'AVAX',
    gasFaucetUrl: 'https://faucet.circle.com',
    arcOnly: false,
    comingSoon: false,
    outboundComingSoon: false,
  },
  {
    key: 'solanaDevnet',
    shortName: 'Solana',
    fullName: 'Solana Devnet',
    // No wagmi chain id - Solana is non-EVM. Code that touches wagmi must
    // guard on this being undefined.
    wagmiChainId: undefined,
    bridgeChain: 'Solana_Devnet',
    cctpDomain: 5,
    // Solana USDC is an SPL mint, not ERC-20. Address kept as a placeholder
    // so the type stays uniform; nothing reads it while comingSoon is true.
    usdc: '0x0000000000000000000000000000000000000000',
    usdcIsNative: false,
    gasSymbol: 'SOL',
    gasFaucetUrl: 'https://faucet.solana.com/',
    arcOnly: false,
    comingSoon: true,
    outboundComingSoon: true,
  },
];

// Default destination - Arc is the focal chain of arc-trade.
export const DEFAULT_DESTINATION_KEY: BridgeChain['key'] = 'arcTestnet';

// Source-chain subset used by panels that only want the actually-queryable
// EVM chains (excludes Arc as home + Solana / any comingSoon chain since
// those don't have wagmi IDs to drive useBalance / switchChain).
export const BRIDGE_SOURCES: BridgeChain[] = BRIDGE_CHAINS.filter(
  (c) => !c.arcOnly && !c.comingSoon,
);

export function chainByKey(key: BridgeChain['key']): BridgeChain {
  const c = BRIDGE_CHAINS.find((x) => x.key === key);
  if (!c) throw new Error(`Unknown bridge chain: ${key}`);
  return c;
}

// Resolve a CCTP V2 source domain (uint32 from MessageReceived) back to the
// chain in BRIDGE_CHAINS. Returns null when we don't model that chain - the
// caller should fall back to a generic "Unknown chain (domain N)" label.
export function chainByCctpDomain(domain: number): BridgeChain | null {
  return BRIDGE_CHAINS.find((c) => c.cctpDomain === domain) ?? null;
}

// CCTP step order - used by the progress UI even before any events arrive,
// so users see the full sequence ahead of time.
export const BRIDGE_STEP_ORDER = ['approve', 'burn', 'fetchAttestation', 'mint'] as const;
export type BridgeStepName = (typeof BRIDGE_STEP_ORDER)[number];

export const BRIDGE_STEP_LABELS: Record<BridgeStepName, string> = {
  approve: 'Approve USDC',
  burn: 'Burn on source chain',
  fetchAttestation: 'Wait for Circle attestation',
  mint: 'Mint on destination',
};
