import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { arcTestnet } from './chains';

export const wagmiConfig = getDefaultConfig({
  appName: 'arc-trade',
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? 'PLACEHOLDER_PROJECT_ID',
  chains: [arcTestnet],
  ssr: true,
});
