'use client';

import { useCallback } from 'react';
import type { Address, Hex } from 'viem';
import {
  useAccount,
  useDisconnect,
  usePublicClient,
  useSendTransaction,
} from 'wagmi';
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
  disconnect: () => void;
};

type DisconnectedState = {
  isConnected: false;
  mode: null;
  address: undefined;
  sendCall: undefined;
  disconnect: undefined;
};

export function useSigner(): ConnectedState | DisconnectedState {
  // External (wagmi) — RainbowKit / MetaMask / Rabby / etc.
  const wagmi = useAccount();
  const wagmiPublic = usePublicClient();
  const { sendTransactionAsync } = useSendTransaction();
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
        const hash = await sendTransactionAsync({ to, data, value: value ?? 0n });
        return {
          hash,
          wait: async () => {
            if (!wagmiPublic) throw new Error('No wagmi public client available');
            const receipt = await wagmiPublic.waitForTransactionReceipt({ hash });
            return { txHash: hash, status: receipt.status };
          },
        };
      },
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
        const userOpHash = await bundlerClient.sendUserOperation({
          calls: [{ to, data, value: value ?? 0n }],
          paymaster: true,
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
      disconnect: () => circle.disconnect(),
    };
  }

  return {
    isConnected: false,
    mode: null,
    address: undefined,
    sendCall: undefined,
    disconnect: undefined,
  };
}
