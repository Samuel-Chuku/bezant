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

export async function getUserByHandle(handle: string): Promise<UserRecord | null> {
  try {
    return await jsonFetch<UserRecord>('GET', `/users/by-handle/${encodeURIComponent(handle)}`);
  } catch (err) {
    if ((err as Error & { status?: number }).status === 404) return null;
    throw err;
  }
}

// Resolve a free-text identifier to a 0x address. Accepts either:
//   - a 0x-prefixed 20-byte hex address (returned verbatim, lowercased)
//   - a handle, looked up via /users/by-handle
// Throws if it's neither a valid address nor a known handle.
export async function resolveAddress(input: string): Promise<`0x${string}`> {
  const trimmed = input.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    return trimmed.toLowerCase() as `0x${string}`;
  }
  if (trimmed.length === 0) {
    throw new Error('Address or handle required');
  }
  const user = await getUserByHandle(trimmed);
  if (!user) throw new Error(`No user found for handle "${trimmed}"`);
  return user.walletAddress.toLowerCase() as `0x${string}`;
}

// Backend builds the unsigned createJob calldata. The frontend then broadcasts
// it via the active signer. Body fields mirror the signed-route shape minus
// the handle/userId (signer is whoever the wallet is).
export type UnsignedTx = {
  to: `0x${string}`;
  data: `0x${string}`;
  value: `0x${string}`;
  chainId: number;
};

export async function buildCreateJobUnsigned(input: {
  provider: `0x${string}`;
  evaluator: `0x${string}`;
  expiredInSeconds: number;
  description: string;
}): Promise<UnsignedTx> {
  return jsonFetch<UnsignedTx>('POST', '/arc/escrow/jobs/unsigned', input);
}

// ─── Jobs index ────────────────────────────────────────────────────────────
// Static data from the backend's JobCreated event indexer. Pair with
// getJobState() to read live status/budget per job.
export type JobRole = 'client' | 'provider' | 'evaluator';

export type JobIndexEntry = {
  jobId: string;
  client: string;
  provider: string;
  evaluator: string;
  expiredAt: number;
  hook: string;
  blockNumber: number;
  txHash: string;
  indexedAt: string;
  roles: JobRole[];
};

export async function getJobsByAddress(address: string): Promise<JobIndexEntry[]> {
  const result = await jsonFetch<{ address: string; jobs: JobIndexEntry[]; count: number }>(
    'GET',
    `/jobs/by-address/${encodeURIComponent(address)}`,
  );
  return result.jobs;
}

// Live on-chain state for a single job. Shape mirrors the existing
// /arc/escrow/job/:id route response.
export type JobLiveState = {
  id: string;
  client: string;
  provider: string;
  evaluator: string;
  description: string;
  budget: { raw: string; usdc: string };
  expiredAt: { unix: number; iso: string };
  status: 'Open' | 'Funded' | 'Submitted' | 'Completed' | 'Rejected' | 'Expired' | string;
  hook: string;
};

export async function getJobState(jobId: string): Promise<JobLiveState> {
  return jsonFetch<JobLiveState>('GET', `/arc/escrow/job/${encodeURIComponent(jobId)}`);
}

export type JobEvent = {
  jobId: string;
  eventType: 'Submitted' | 'Completed' | 'Rejected';
  hashValue: string;
  actor: string;
  blockNumber: number;
  txHash: string;
  logIndex: number;
  indexedAt: string;
};

export async function getJobEvents(jobId: string): Promise<JobEvent[]> {
  const res = await jsonFetch<{ jobId: string; events: JobEvent[] }>(
    'GET',
    `/arc/escrow/job/${encodeURIComponent(jobId)}/events`,
  );
  return res.events;
}

// ─── Deliverable content (Layer 2) ─────────────────────────────────────────
// Off-chain content attached to a Submitted event. Upload is gated by hash
// verification (only the preimage holder — the provider — can store). Read
// is gated by wallet-signature auth, parties-only.

export type DeliverableContentType = 'text' | 'url';

export type Deliverable = {
  jobId: string;
  hash: string;
  contentType: DeliverableContentType;
  textContent: string;
  uploadedBy: string;
  uploadedAt: string;
};

export async function uploadDeliverableContent(input: {
  jobId: string;
  contentType: DeliverableContentType;
  content: string;
  expectedHash: string;
  uploadedBy: string;
}): Promise<{ jobId: string; hash: string; contentType: DeliverableContentType }> {
  return jsonFetch(
    'POST',
    `/arc/escrow/job/${encodeURIComponent(input.jobId)}/deliverable-content`,
    {
      contentType: input.contentType,
      content: input.content,
      expectedHash: input.expectedHash,
      uploadedBy: input.uploadedBy,
    },
  );
}

// Builds the canonical read-challenge message for a given jobId + timestamp.
// Backend must reconstruct this exact string to verify the signature.
export function readDeliverableChallenge(jobId: string, ts: number): string {
  return `arc-trade:read-deliverable:${jobId}:${ts}`;
}

// Reuses a cached signature from localStorage if it's within the validity
// window (a hair under the 24h backend window, to avoid races). Otherwise
// prompts the wallet once and caches. Caller passes signMessage so we stay
// signer-agnostic (wagmi or Circle Modular).
export async function getOrCreateReadAuth(
  jobId: string,
  viewer: string,
  signMessage: (msg: string) => Promise<string>,
): Promise<{ viewer: string; sig: string; ts: number }> {
  const CACHE_TTL_SECONDS = 23 * 60 * 60;
  const cacheKey = `arc:deliv-sig:${jobId}:${viewer.toLowerCase()}`;
  const nowSec = Math.floor(Date.now() / 1000);

  if (typeof window !== 'undefined') {
    const raw = localStorage.getItem(cacheKey);
    if (raw) {
      try {
        const cached = JSON.parse(raw) as { sig: string; ts: number };
        if (nowSec - cached.ts < CACHE_TTL_SECONDS && cached.sig && cached.ts) {
          return { viewer, sig: cached.sig, ts: cached.ts };
        }
      } catch {
        // Bad JSON in cache — fall through to fresh sign.
      }
    }
  }

  const ts = nowSec;
  const sig = await signMessage(readDeliverableChallenge(jobId, ts));

  if (typeof window !== 'undefined') {
    localStorage.setItem(cacheKey, JSON.stringify({ sig, ts }));
  }

  return { viewer, sig, ts };
}

export async function getDeliverable(
  jobId: string,
  hash: string,
  auth: { viewer: string; sig: string; ts: number },
): Promise<Deliverable> {
  const res = await fetch(
    `${API_BASE}/arc/escrow/job/${encodeURIComponent(jobId)}/deliverable?hash=${encodeURIComponent(hash)}`,
    {
      headers: {
        'x-arc-viewer': auth.viewer,
        'x-arc-sig': auth.sig,
        'x-arc-ts': String(auth.ts),
      },
    },
  );
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
  return parsed as Deliverable;
}

// ─── Unsigned calldata builders for every lifecycle action ─────────────────
// Each returns { to, data, value, chainId } ready to pass into
// useSigner().sendCall(). The signer is whoever's connected; the backend
// never sees the signer.

export async function buildSetBudgetUnsigned(jobId: string, budgetUsdc: string): Promise<UnsignedTx> {
  return jsonFetch<UnsignedTx>('POST', `/arc/escrow/jobs/${encodeURIComponent(jobId)}/budget/unsigned`, {
    budgetUsdc,
  });
}

export async function buildApproveUnsigned(amountUsdc: string): Promise<UnsignedTx> {
  return jsonFetch<UnsignedTx>('POST', '/arc/usdc/approve/unsigned', { amountUsdc });
}

export async function buildFundUnsigned(jobId: string): Promise<UnsignedTx> {
  return jsonFetch<UnsignedTx>('POST', `/arc/escrow/jobs/${encodeURIComponent(jobId)}/fund/unsigned`);
}

export async function buildSubmitUnsigned(
  jobId: string,
  deliverableHash: string,
): Promise<UnsignedTx> {
  return jsonFetch<UnsignedTx>('POST', `/arc/escrow/jobs/${encodeURIComponent(jobId)}/submit/unsigned`, {
    deliverableHash,
  });
}

export async function buildCompleteUnsigned(jobId: string, reasonHash?: string): Promise<UnsignedTx> {
  return jsonFetch<UnsignedTx>('POST', `/arc/escrow/jobs/${encodeURIComponent(jobId)}/complete/unsigned`, {
    reasonHash,
  });
}

export async function buildRejectUnsigned(jobId: string, reasonHash?: string): Promise<UnsignedTx> {
  return jsonFetch<UnsignedTx>('POST', `/arc/escrow/jobs/${encodeURIComponent(jobId)}/reject/unsigned`, {
    reasonHash,
  });
}

export async function buildRefundUnsigned(jobId: string): Promise<UnsignedTx> {
  return jsonFetch<UnsignedTx>('POST', `/arc/escrow/jobs/${encodeURIComponent(jobId)}/refund/unsigned`);
}
