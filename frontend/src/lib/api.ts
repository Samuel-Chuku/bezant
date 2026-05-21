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
