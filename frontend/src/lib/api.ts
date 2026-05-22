const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3001';

export type UserRecord = {
  id: string;
  handle: string | null;
  walletAddress: string;
  signingMode: 'dev-controlled' | 'external' | 'circle-modular';
  // ERC-8004 IdentityRegistry agentId (uint256 as string). null until the
  // user links an agentId they own — verified on-chain at link time.
  agentId: string | null;
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

// Link an ERC-8004 agentId to a user. Backend verifies on-chain that the
// user's wallet is the agent's owner (or its set agentWallet) before
// persisting. Pass null to unlink.
export async function linkAgentId(
  userId: string,
  agentId: string | null,
): Promise<UserRecord> {
  return jsonFetch<UserRecord>(
    'PATCH',
    `/users/${encodeURIComponent(userId)}/agent-id`,
    { agentId },
  );
}

// Reputation reads — live view-call against the ReputationRegistry. Two
// shapes: a cheap summary (used by the inline badge) and a full read that
// adds a truncated feedback list (used by the reputation page).
export type ReputationFeedback = {
  clientAddress: string;
  feedbackIndex: string;
  value: string;          // signed int128 as decimal string
  valueDecimals: number;
  tag1: string;
  tag2: string;
  isRevoked: boolean;
};

export type ReputationSummary = {
  agentId: string;
  summary: {
    count: number;
    value: string;        // signed int128 as decimal string
    valueDecimals: number;
  };
  clientsConsulted: string[];
};

export type ReputationDetail = ReputationSummary & {
  feedback: ReputationFeedback[];
  totalFeedback: number;
  limit: number;
  offset: number;
  truncated: boolean;
};

export async function getReputationSummary(agentId: string): Promise<ReputationSummary> {
  return jsonFetch<ReputationSummary>(
    'GET',
    `/arc/reputation/agent/${encodeURIComponent(agentId)}/summary`,
  );
}

export async function getReputation(
  agentId: string,
  opts?: { limit?: number; offset?: number },
): Promise<ReputationDetail> {
  const params = new URLSearchParams();
  if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts?.offset !== undefined) params.set('offset', String(opts.offset));
  const qs = params.toString();
  return jsonFetch<ReputationDetail>(
    'GET',
    `/arc/reputation/agent/${encodeURIComponent(agentId)}${qs ? `?${qs}` : ''}`,
  );
}

// Format an int128 + uint8 decimals fixed-point value into a human-readable
// string. The ERC-8004 spec leaves the convention to the reviewer (e.g.
// 42 with decimals=1 → "4.2"; 8500 with decimals=2 → "85.00"). Negative
// values are preserved.
export function formatReputationValue(value: string, decimals: number): string {
  if (decimals === 0) return value;
  const negative = value.startsWith('-');
  const raw = negative ? value.slice(1) : value;
  const padded = raw.padStart(decimals + 1, '0');
  const intPart = padded.slice(0, padded.length - decimals);
  const fracPart = padded.slice(padded.length - decimals);
  return `${negative ? '-' : ''}${intPart}.${fracPart}`;
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
  // Creation metadata from the local jobs_index. null if the indexer hasn't
  // caught up to the JobCreated event yet (~10s after creation).
  createdAt: { blockNumber: number; txHash: string; indexedAt: string } | null;
};

export async function getJobState(jobId: string): Promise<JobLiveState> {
  return jsonFetch<JobLiveState>('GET', `/arc/escrow/job/${encodeURIComponent(jobId)}`);
}

export type JobEvent = {
  jobId: string;
  eventType: 'Submitted' | 'Completed' | 'Rejected' | 'Funded';
  hashValue: string;
  // Set for Funded rows (uint256 USDC amount as decimal string); null otherwise.
  amountRaw: string | null;
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

export type DeliverableContentType = 'text' | 'url' | 'file';

export type Deliverable = {
  jobId: string;
  hash: string;
  contentType: DeliverableContentType;
  textContent: string;
  mime: string | null;
  sizeBytes: number | null;
  filePath: string | null;
  uploadedBy: string;
  uploadedAt: string;
};

export async function uploadDeliverableContent(input: {
  jobId: string;
  contentType: 'text' | 'url';
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

// Files travel base64-in-JSON to the same upload endpoint. Caller provides
// the precomputed keccak256 hash so the server can refuse mismatches without
// us redoing the hash twice.
export async function uploadDeliverableFile(input: {
  jobId: string;
  fileName: string;
  mime: string;
  fileBase64: string;
  expectedHash: string;
  uploadedBy: string;
}): Promise<{
  jobId: string;
  hash: string;
  contentType: 'file';
  fileName: string;
  mime: string;
  sizeBytes: number;
}> {
  return jsonFetch(
    'POST',
    `/arc/escrow/job/${encodeURIComponent(input.jobId)}/deliverable-content`,
    {
      contentType: 'file',
      fileName: input.fileName,
      mime: input.mime,
      fileBase64: input.fileBase64,
      expectedHash: input.expectedHash,
      uploadedBy: input.uploadedBy,
    },
  );
}

// Fetches the raw bytes for a file deliverable. Returns a Blob so the caller
// can recompute the hash client-side before saving the file to disk.
export async function getDeliverableFile(
  jobId: string,
  hash: string,
  auth: { viewer: string; sig: string; ts: number },
): Promise<Blob> {
  const res = await fetch(
    `${API_BASE}/arc/escrow/job/${encodeURIComponent(jobId)}/deliverable/file?hash=${encodeURIComponent(hash)}`,
    {
      headers: {
        'x-arc-viewer': auth.viewer,
        'x-arc-sig': auth.sig,
        'x-arc-ts': String(auth.ts),
      },
    },
  );
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) message = j.error;
    } catch {
      // ignore — keep HTTP fallback
    }
    const err = new Error(message) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return res.blob();
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
