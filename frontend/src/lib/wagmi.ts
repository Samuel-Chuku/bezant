import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import {
  arbitrumSepolia,
  avalancheFuji,
  baseSepolia,
  optimismSepolia,
  sepolia,
} from 'wagmi/chains';
import { arcTestnet } from './chains';

export const wagmiConfig = getDefaultConfig({
  appName: 'Bezant',
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? 'PLACEHOLDER_PROJECT_ID',
  // Arc is the canonical app chain; the testnets below are source chains the
  // user can switch into via wagmi to fund Arc (CCTP V2) or deposit into their
  // Circle Gateway unified balance.
  chains: [arcTestnet, sepolia, optimismSepolia, arbitrumSepolia, baseSepolia, avalancheFuji],
  ssr: true,
});
