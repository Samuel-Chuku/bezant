const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3001';

export type UserRecord = {
  id: string;
  handle: string | null;
  walletAddress: string;
  signingMode: 'dev-controlled' | 'external' | 'circle-modular';
  createdAt: string;
};

async function jsonFetch<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    const message =
      parsed && typeof parsed === 'object' && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : `HTTP ${res.status}`;
    const err = new Error(message) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return parsed as T;
}

export async function getUserByAddress(address: string): Promise<UserRecord | null> {
  try {
    return await jsonFetch<UserRecord>('GET', `/users/by-address/${encodeURIComponent(address)}`);
  } catch (err) {
    if ((err as Error & { status?: number }).status === 404) return null;
    throw err;
  }
}

export async function registerExternalUser(input: {
  walletAddress: string;
  signingMode: 'external' | 'circle-modular';
  handle?: string;
}): Promise<UserRecord> {
  return jsonFetch<UserRecord>('POST', '/users/register-external', input);
}

export async function claimHandle(userId: string, handle: string): Promise<UserRecord> {
  return jsonFetch<UserRecord>('PATCH', `/users/${encodeURIComponent(userId)}`, { handle });
}
