'use client';

import type { Address, Hex } from 'viem';
import {
  useAccount,
  useDisconnect,
  usePublicClient,
  useSendTransaction,
  useSignMessage,
} from 'wagmi';
import { arcTestnet } from '@/lib/chains';
import { useCircleAccount } from './use-circle-account';

export type SignerMode = 'external' | 'circle';

export type SendCallParams = {
  to: Hex;
  data: Hex;
  value?: bigint;
};

export type SendCallResult = {
  hash: Hex;
  wait: () => Promise<{ txHash: Hex; status: 'success' | 'reverted' }>;
};

type ConnectedState = {
  isConnected: true;
  mode: SignerMode;
  address: Address;
  sendCall: (params: SendCallParams) => Promise<SendCallResult>;
  signMessage: (message: string) => Promise<Hex>;
  disconnect: () => void;
};

type DisconnectedState = {
  isConnected: false;
  mode: null;
  address: undefined;
  sendCall: undefined;
  signMessage: undefined;
  disconnect: undefined;
};

export function useSigner(): ConnectedState | DisconnectedState {
  // External (wagmi) — RainbowKit / MetaMask / Rabby / etc.
  const wagmi = useAccount();
  // Always wait for receipts on Arc — the bridge widget can switch the
  // wagmi chain temporarily, but every tx we hand back here was meant for
  // Arc. (Bridge txs go through Bridge Kit's own flow, not this signer.)
  const wagmiPublic = usePublicClient({ chainId: arcTestnet.id });
  const { sendTransactionAsync } = useSendTransaction();
  const { signMessageAsync: wagmiSignMessageAsync } = useSignMessage();
  const { disconnect: wagmiDisconnect } = useDisconnect();

  // Circle Modular Wallets — passkey-backed smart account.
  const circle = useCircleAccount();

  const wagmiActive = wagmi.isConnected && wagmi.address;
  const circleActive = circle.state.status === 'connected';

  // If both are somehow connected, prefer external (more explicit user action).
  if (wagmiActive) {
    return {
      isConnected: true,
      mode: 'external',
      address: wagmi.address!,
      sendCall: async ({ to, data, value }) => {
        // Force Arc — wagmi will prompt a switch if the wallet is elsewhere
        // (e.g. user just bridged and is still on Base). Page-level guards
        // try to prevent the click, but this is belt-and-suspenders.
        const hash = await sendTransactionAsync({
          to,
          data,
          value: value ?? 0n,
          chainId: arcTestnet.id,
        });
        return {
          hash,
          wait: async () => {
            if (!wagmiPublic) throw new Error('No wagmi public client available');
            const receipt = await wagmiPublic.waitForTransactionReceipt({ hash });
            return { txHash: hash, status: receipt.status };
          },
        };
      },
      signMessage: async (message) => wagmiSignMessageAsync({ message }),
      disconnect: () => wagmiDisconnect(),
    };
  }

  if (circleActive && circle.state.status === 'connected') {
    const { smartAccount, bundlerClient } = circle.state;
    return {
      isConnected: true,
      mode: 'circle',
      address: smartAccount.address,
      sendCall: async ({ to, data, value }) => {
        // Circle's bundler enforces a 1 gwei minimum priority fee on UserOps;
        // viem's default uses Arc's chain-reported priority (~0.002 gwei) which
        // fails precheck. Set explicit fees safely above the floor.
        const userOpHash = await bundlerClient.sendUserOperation({
          calls: [{ to, data, value: value ?? 0n }],
          paymaster: true,
          maxPriorityFeePerGas: 1_000_000_000n, // 1 gwei
          maxFeePerGas: 50_000_000_000n,        // 50 gwei ceiling
        });
        return {
          hash: userOpHash,
          wait: async () => {
            const receipt = await bundlerClient.waitForUserOperationReceipt({ hash: userOpHash });
            return {
              txHash: receipt.receipt.transactionHash,
              status: receipt.success ? 'success' : 'reverted',
            };
          },
        };
      },
      // Smart-account sig is ERC-1271; backend verifies via on-chain
      // isValidSignature, so the smart account must already be deployed
      // (true for any address that's already a party on a job).
      signMessage: async (message) => smartAccount.signMessage({ message }),
      disconnect: () => circle.disconnect(),
    };
  }

  return {
    isConnected: false,
    mode: null,
    address: undefined,
    sendCall: undefined,
    signMessage: undefined,
    disconnect: undefined,
  };
}
