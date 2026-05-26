import { createPublicClient, type Hex } from 'viem';
import {
  createBundlerClient,
  toWebAuthnAccount,
  type P256Credential,
  type SmartAccount,
} from 'viem/account-abstraction';
import {
  toCircleSmartAccount,
  toModularTransport,
  toPasskeyTransport,
  toWebAuthnCredential,
  WebAuthnMode,
} from '@circle-fin/modular-wallets-core';
import { arcTestnet } from './chains';

function requireEnv(value: string | undefined, key: string): string {
  if (!value || value === '' || value.startsWith('YOUR_')) {
    throw new Error(
      `${key} is not set. Add it to .env.local and restart the dev server.`,
    );
  }
  return value;
}

function getConfig() {
  const clientKey = requireEnv(
    process.env.NEXT_PUBLIC_CIRCLE_CLIENT_KEY,
    'NEXT_PUBLIC_CIRCLE_CLIENT_KEY',
  );
  const clientUrl = requireEnv(
    process.env.NEXT_PUBLIC_CIRCLE_CLIENT_URL,
    'NEXT_PUBLIC_CIRCLE_CLIENT_URL',
  );
  const chainAlias =
    process.env.NEXT_PUBLIC_CIRCLE_CHAIN_ALIAS && process.env.NEXT_PUBLIC_CIRCLE_CHAIN_ALIAS.length > 0
      ? process.env.NEXT_PUBLIC_CIRCLE_CHAIN_ALIAS
      : 'arcTestnet';
  return { clientKey, clientUrl, chainAlias };
}

export async function registerPasskey(username: string): Promise<P256Credential> {
  const { clientKey, clientUrl } = getConfig();
  const passkeyTransport = toPasskeyTransport(clientUrl, clientKey);
  return toWebAuthnCredential({
    transport: passkeyTransport,
    mode: WebAuthnMode.Register,
    username,
  });
}

export async function loginPasskey(): Promise<P256Credential> {
  const { clientKey, clientUrl } = getConfig();
  const passkeyTransport = toPasskeyTransport(clientUrl, clientKey);
  return toWebAuthnCredential({
    transport: passkeyTransport,
    mode: WebAuthnMode.Login,
  });
}

export async function buildSmartAccountFromCredential(credential: P256Credential) {
  const { clientKey, clientUrl, chainAlias } = getConfig();
  const modularTransport = toModularTransport(`${clientUrl}/${chainAlias}`, clientKey);
  const client = createPublicClient({ chain: arcTestnet, transport: modularTransport });
  const owner = toWebAuthnAccount({ credential });
  const smartAccount = await toCircleSmartAccount({ client, owner });
  const bundlerClient = createBundlerClient({
    account: smartAccount,
    chain: arcTestnet,
    transport: modularTransport,
  });
  return { smartAccount, bundlerClient };
}

export type CircleSmartAccount = SmartAccount;
export type { P256Credential };

// Credential persistence — keep only the metadata we need to re-derive the
// WebAuthn account on next visit. The private key never leaves the authenticator.
const STORAGE_KEY = 'arc-trade:circle-credential';

type SerializedCredential = {
  id: string;
  publicKey: Hex;
};

export function saveCredential(credential: P256Credential) {
  const serialized: SerializedCredential = {
    id: credential.id,
    publicKey: credential.publicKey,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(serialized));
}

export function loadCredential(): P256Credential | null {
  if (typeof window === 'undefined') return null;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SerializedCredential;
    return parsed as unknown as P256Credential;
  } catch {
    return null;
  }
}

export function clearCredential() {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(STORAGE_KEY);
}
