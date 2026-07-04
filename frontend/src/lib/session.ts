// SIWE session token. Obtained by signing a server-issued nonce with the
// connected wallet, stored in localStorage, and attached as
// `Authorization: Bearer <token>` on every API call (see jsonFetch in api.ts).
// The token is bound to one wallet address; connecting a different wallet mints
// its own session.
const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3001';
const STORAGE_KEY = 'bezant:session';

type Stored = { address: string; token: string; expiresAt: number };

function read(): Stored | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Stored;
    if (!s.token || !s.address || s.expiresAt < Date.now()) return null;
    return s;
  } catch {
    return null;
  }
}

export function getSessionToken(): string | null {
  return read()?.token ?? null;
}

export function getSessionAddress(): string | null {
  return read()?.address ?? null;
}

// Subscribers are notified whenever the session is established or cleared, so
// views can refetch owner-only data (e.g. their volume) after sign-in.
const listeners = new Set<() => void>();
export function onSessionChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
function notify() {
  listeners.forEach((fn) => fn());
}

export function clearSession(): void {
  if (typeof window === 'undefined') return;
  if (!localStorage.getItem(STORAGE_KEY)) return; // nothing to clear - don't churn subscribers
  localStorage.removeItem(STORAGE_KEY);
  notify();
}

// Dedupe concurrent sign-ins for the same address (React strict mode double
// invoke, multiple callers). Callers (SessionManager) guard against re-prompting
// on failure; this only ensures one in-flight ceremony per address.
const inflight = new Map<string, Promise<void>>();

export async function ensureSession(
  address: string,
  signMessage: (message: string) => Promise<`0x${string}`>,
): Promise<void> {
  const addr = address.toLowerCase();
  const cur = read();
  if (cur && cur.address === addr) return; // already signed in for this wallet
  const existing = inflight.get(addr);
  if (existing) return existing;

  const p = (async () => {
    const nonceRes = await fetch(`${API_BASE}/auth/nonce?address=${addr}`);
    if (!nonceRes.ok) throw new Error('failed to get sign-in nonce');
    const { nonce, message } = (await nonceRes.json()) as { nonce: string; message: string };

    const signature = await signMessage(message);

    const verifyRes = await fetch(`${API_BASE}/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce, signature }),
    });
    if (!verifyRes.ok) throw new Error('sign-in verification failed');
    const { token, address: verified, expiresAt } = (await verifyRes.json()) as {
      token: string;
      address: string;
      expiresAt: number;
    };
    const stored: Stored = { address: verified.toLowerCase(), token, expiresAt };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    notify();
  })().finally(() => {
    inflight.delete(addr);
  });

  inflight.set(addr, p);
  return p;
}
