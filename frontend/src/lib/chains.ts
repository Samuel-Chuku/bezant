import { defineChain } from 'viem';

// Arc Testnet — Circle's USDC-native L1.
// Note: USDC is the native gas token (6 decimals, not 18).
export const arcTestnet = defineChain({
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 6 },
  rpcUrls: {
    default: { http: ['https://rpc.testnet.arc.network'] },
  },
  blockExplorers: {
    default: { name: 'Arcscan', url: 'https://testnet.arcscan.app' },
  },
  testnet: true,
});

// Contract addresses on Arc Testnet — mirrored from backend's lib/arc.ts.
export const USDC_ADDRESS = '0x3600000000000000000000000000000000000000' as const;
export const ERC8183_ADDRESS = '0x0747EEf0706327138c69792bF28Cd525089e4583' as const;
