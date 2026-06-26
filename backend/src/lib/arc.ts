import { createPublicClient, http } from 'viem';

const ARC_RPC_URL = process.env.ARC_RPC_URL ?? 'https://rpc.testnet.arc.network';

export const ARC_TESTNET_CHAIN_ID = 5042002;

export const arcClient = createPublicClient({
  transport: http(ARC_RPC_URL),
});

// USDC on Arc Testnet (6 decimals, NOT 18 - common trap)
export const USDC_ADDRESS = '0x3600000000000000000000000000000000000000' as const;

// ERC-8183 reference deployment on Arc Testnet. The wrapper proxies all
// pact-lifecycle calls through this contract; client-facing routes target
// WRAPPER_ADDRESS instead.
export const ERC8183_ADDRESS = '0x0747EEf0706327138c69792bF28Cd525089e4583' as const;

// PactWrapper deployment on Arc Testnet. Source of truth for all pact state
// going forward - backend reads Pact* events from here, not Job* events from
// the reference contract. Override via env if redeploying.
export const WRAPPER_ADDRESS = (process.env.WRAPPER_ADDRESS ??
  '0x4183b1429eE2467772b4612a94Ef253210312F02') as `0x${string}`;

// ERC-8004 ReputationRegistry. The canonical EIP-8004 address starts with
// 0x8004 across deployments; override via env if Arc moves it.
export const ERC8004_REPUTATION_ADDRESS = (process.env.ARC_REPUTATION_REGISTRY_ADDRESS ??
  '0x8004B663056A597Dffe9eCcC1965A193B7388713') as `0x${string}`;

// StakedVerifierModule (Arm 2 decentralized attester). Empty until deployed +
// `escrow.setAttester(module,true)`; routes guard on it being set.
export const STAKED_VERIFIER_ADDRESS = (process.env.STAKED_VERIFIER_ADDRESS ?? '') as `0x${string}` | '';

// CCTP V2 contracts on Arc Testnet - used by the bridge-event indexer.
// Verified 2026-05-26 against @circle-fin/app-kit chains.d.ts (Arc CCTP V2,
// domain 26, type "split"). Both addressable separately; we watch the
// MessageTransmitter for inbound-mint detection.
export const CCTP_MESSAGE_TRANSMITTER_ADDRESS =
  '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275' as const;
export const CCTP_TOKEN_MESSENGER_ADDRESS =
  '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA' as const;
