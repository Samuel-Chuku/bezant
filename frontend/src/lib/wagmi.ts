import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import {
  arbitrumSepolia,
  baseSepolia,
  optimismSepolia,
  sepolia,
} from 'wagmi/chains';
import { arcTestnet } from './chains';

export const wagmiConfig = getDefaultConfig({
  appName: 'arc-trade',
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? 'PLACEHOLDER_PROJECT_ID',
  // Arc is the canonical app chain; the testnets below are bridge source
  // chains the user can switch into via wagmi to fund Arc through CCTP V2.
  chains: [arcTestnet, sepolia, optimismSepolia, arbitrumSepolia, baseSepolia],
  ssr: true,
});
