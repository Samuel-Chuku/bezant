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
    const message = extractErrorMessage(parsed, res.status);
    const err = new Error(message) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return parsed as T;
}

// Backend convention is { error: string }. Fastify's auto-thrown errors use
// { statusCode, error, message } where `error` is the status reason ("Bad
// Request") and `message` is the actual cause. Prefer message when present
// so the user sees the real reason, falling back to error, falling back to
// the status code.
function extractErrorMessage(parsed: unknown, status: number): string {
  if (parsed && typeof parsed === 'object') {
    const p = parsed as { error?: unknown; message?: unknown };
    if (typeof p.message === 'string' && p.message.length > 0) return p.message;
    if (typeof p.error === 'string' && p.error.length > 0) return p.error;
  }
  return `HTTP ${status}`;
}

// Type guard for callers that want to branch on HTTP status without losing
// the type. Lets pages render 404s differently from 5xx, etc.
export function isApiError(err: unknown): err is Error & { status: number } {
  return err instanceof Error && typeof (err as { status?: unknown }).status === 'number';
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

// Self-registration flow (M32). Step 1 — get unsigned calldata for the
// IdentityRegistry's no-arg `register()`. Frontend signs via useSigner.
export async function buildRegisterAgentUnsigned(): Promise<UnsignedTx & {
  identityRegistry: string;
}> {
  return jsonFetch('POST', '/arc/identity/register-unsigned');
}

// Step 2 — after the tx confirms, ask the backend to parse the receipt
// and pull the freshly-minted agentId out of the ERC-721 Transfer event.
// Centralizes log parsing so we don't have to handle the wagmi-vs-Circle
// receipt-shape difference on the client.
export async function parseRegistration(txHash: string): Promise<{
  agentId: string;
  to: string;
  identityRegistry: string;
  txHash: string;
  blockNumber: number;
}> {
  return jsonFetch('POST', '/arc/identity/parse-registration', { txHash });
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

// No evaluator — the wrapper is the protocol-level evaluator. challengeWindow
// (seconds) is optional; omit/0 lets the contract apply its 24h default.
export async function buildCreatePactUnsigned(input: {
  provider: `0x${string}`;
  expiredInSeconds: number;
  description: string;
  challengeWindowSeconds?: number;
}): Promise<UnsignedTx> {
  return jsonFetch<UnsignedTx>('POST', '/arc/escrow/pacts/unsigned', input);
}

// ─── Pacts index ───────────────────────────────────────────────────────────
// Static data from the backend's pact-indexer (decodes JobCreated events
// off the ERC-8183 reference contract). Pair with getPactState() to read
// live status/budget per pact.
export type PactRole = 'client' | 'provider' | 'evaluator';

export type PactIndexEntry = {
  pactId: string;
  client: string;
  provider: string;
  evaluator: string;
  expiredAt: number;
  hook: string;
  blockNumber: number;
  txHash: string;
  indexedAt: string;
  roles: PactRole[];
};

export async function getPactsByAddress(address: string): Promise<PactIndexEntry[]> {
  const result = await jsonFetch<{ address: string; pacts: PactIndexEntry[]; count: number }>(
    'GET',
    `/pacts/by-address/${encodeURIComponent(address)}`,
  );
  return result.pacts;
}

// Live on-chain state for a single pact. Shape mirrors the existing
// /arc/escrow/pact/:id route response.
export type PactLiveState = {
  id: string;
  client: string;
  provider: string;
  evaluator: string;
  description: string;
  budget: { raw: string; usdc: string };
  expiredAt: { unix: number; iso: string };
  status: 'Open' | 'Funded' | 'Submitted' | 'Disputed' | 'Completed' | 'Rejected' | 'Expired' | string;
  hook: string;
  // Wrapper challenge window (seconds). Required when funding — the wrapper's
  // atomic acceptance reverts if the funder's expected value drifts from this.
  challengeWindow: number;
  // Unix seconds the deliverable was submitted (0 until Submitted) — drives the
  // challenge-window countdown. disputeId is 0 when no dispute is open.
  submittedAt: number;
  disputeId: string;
  // Address of the actor who emitted the terminal-state event (Completed
  // or Rejected). null otherwise (in-flight) or if the indexer hasn't
  // caught up. Used to distinguish "client cancelled" from "evaluator
  // rejected" since the contract emits the same Rejected event for both.
  terminationActor?: string | null;
  // Creation metadata from the local pacts_index. null if the indexer hasn't
  // caught up to the JobCreated event yet (~10s after creation).
  createdAt: { blockNumber: number; txHash: string; indexedAt: string } | null;
};

export async function getPactState(pactId: string): Promise<PactLiveState> {
  return jsonFetch<PactLiveState>('GET', `/arc/escrow/pact/${encodeURIComponent(pactId)}`);
}

// Marketplace — all Open ERC-8183 pacts across the public reference contract
// on Arc (not just arc-trade-created pacts). Paginated server-side; budget
// filter is optional. Each row is PactIndexEntry-like + live status/budget
// merged so the card can render without a second fetch.
export type OpenPactEntry = {
  pactId: string;
  client: string;
  provider: string;
  evaluator: string;
  description: string;
  budget: { raw: string; usdc: string };
  expiredAt: { unix: number; iso: string };
  status: string;
  hook: string;
  createdAt: { blockNumber: number; txHash: string; indexedAt: string };
};

export type OpenPactsResponse = {
  pacts: OpenPactEntry[];
  total: number;
  limit: number;
  offset: number;
  indexScanned: number;
};

export async function getOpenPacts(params: {
  limit?: number;
  offset?: number;
  minBudget?: string;
  maxBudget?: string;
}): Promise<OpenPactsResponse> {
  const qs = new URLSearchParams();
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));
  if (params.minBudget) qs.set('minBudget', params.minBudget);
  if (params.maxBudget) qs.set('maxBudget', params.maxBudget);
  return jsonFetch<OpenPactsResponse>('GET', `/pacts/open?${qs.toString()}`);
}

// Notifications feed. Per-pact bundle: index row + live state + events array.
// The frontend derives action/event/deadline notifications from these rows
// (see hooks/use-notifications.ts) rather than the backend pre-shaping them,
// because the action/deadline-bucket logic is role-sensitive and easier to
// keep in sync with the pact-detail page when both consume from lib/pact-status.
export type FeedPactLive = {
  status: string;
  budget: { raw: string; usdc: string };
  expiredAt: { unix: number; iso: string };
  description: string;
};

export type FeedRow = {
  pactId: string;
  roles: PactRole[];
  index: {
    client: string;
    provider: string;
    evaluator: string;
    expiredAt: number;
    blockNumber: number;
    txHash: string;
    indexedAt: string;
  };
  live: FeedPactLive | null;
  events: PactEvent[];
};

export type NotificationFeedResponse = {
  address: string;
  feed: FeedRow[];
  total: number;
  limit: number;
  offset: number;
};

export async function getNotificationFeed(
  address: string,
  params: { limit?: number; offset?: number } = {},
): Promise<NotificationFeedResponse> {
  const qs = new URLSearchParams();
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return jsonFetch<NotificationFeedResponse>(
    'GET',
    `/pacts/by-address/${encodeURIComponent(address)}/feed${suffix}`,
  );
}

// CCTP V2 inbound bridge history for an address. Served by the backend
// bridge-indexer (USDC mints joined to MessageReceived). One row per
// inbound mint; sorted newest-first server-side.
export type BridgeHistoryRow = {
  recipient: string;
  amount: { raw: string; usdc: string };
  sourceDomain: number | null;
  nonce: string | null;
  blockNumber: number;
  txHash: string;
  logIndex: number;
  indexedAt: string;
};

export type BridgeHistoryResponse = {
  address: string;
  history: BridgeHistoryRow[];
  count: number;
};

export async function getBridgeHistory(
  address: string,
  params: { limit?: number } = {},
): Promise<BridgeHistoryResponse> {
  const qs = new URLSearchParams();
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return jsonFetch<BridgeHistoryResponse>(
    'GET',
    `/bridge/history/${encodeURIComponent(address)}${suffix}`,
  );
}

export type PactEvent = {
  pactId: string;
  // Wrapper Pact* events the indexer records. The dispute/negotiation events
  // were added with the PactWrapper migration.
  eventType:
    | 'Submitted'
    | 'Completed'
    | 'Rejected'
    | 'Funded'
    | 'Refunded'
    | 'Expired'
    | 'BudgetSet'
    | 'TermsProposed'
    | 'DeadlineExtended'
    | 'DisputeOpened'
    | 'DisputeConceded'
    | 'DisputeDefended'
    | 'CommitSubmitted'
    | 'VoteRevealed'
    | 'DisputeResolved';
  hashValue: string;
  // Set for Funded + Refunded rows (uint256 USDC amount as decimal string);
  // null for hash-bearing rows.
  amountRaw: string | null;
  // For Funded: the funder (client). For Refunded: the recipient (also
  // client) — caller of claimRefund isn't recoverable from the event.
  actor: string;
  blockNumber: number;
  txHash: string;
  logIndex: number;
  indexedAt: string;
};

export async function getPactEvents(pactId: string): Promise<PactEvent[]> {
  const res = await jsonFetch<{ pactId: string; events: PactEvent[] }>(
    'GET',
    `/arc/escrow/pact/${encodeURIComponent(pactId)}/events`,
  );
  return res.events;
}

// ─── Deliverable content (Layer 2) ─────────────────────────────────────────
// Off-chain content attached to a Submitted event. Upload is gated by hash
// verification (only the preimage holder — the provider — can store). Read
// is gated by wallet-signature auth, parties-only.

export type DeliverableContentType = 'text' | 'url' | 'file';

export type Deliverable = {
  pactId: string;
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
  pactId: string;
  contentType: 'text' | 'url';
  content: string;
  expectedHash: string;
  uploadedBy: string;
}): Promise<{ pactId: string; hash: string; contentType: DeliverableContentType }> {
  return jsonFetch(
    'POST',
    `/arc/escrow/pact/${encodeURIComponent(input.pactId)}/deliverable-content`,
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
  pactId: string;
  fileName: string;
  mime: string;
  fileBase64: string;
  expectedHash: string;
  uploadedBy: string;
}): Promise<{
  pactId: string;
  hash: string;
  contentType: 'file';
  fileName: string;
  mime: string;
  sizeBytes: number;
}> {
  return jsonFetch(
    'POST',
    `/arc/escrow/pact/${encodeURIComponent(input.pactId)}/deliverable-content`,
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
  pactId: string,
  hash: string,
  auth: { viewer: string; sig: string; ts: number },
): Promise<Blob> {
  const res = await fetch(
    `${API_BASE}/arc/escrow/pact/${encodeURIComponent(pactId)}/deliverable/file?hash=${encodeURIComponent(hash)}`,
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

// Builds the canonical read-challenge message for a given pactId + timestamp.
// Backend must reconstruct this exact string to verify the signature.
export function readDeliverableChallenge(pactId: string, ts: number): string {
  return `arc-trade:read-deliverable:${pactId}:${ts}`;
}

// Reuses a cached signature from localStorage if it's within the validity
// window (a hair under the 24h backend window, to avoid races). Otherwise
// prompts the wallet once and caches. Caller passes signMessage so we stay
// signer-agnostic (wagmi or Circle Modular).
export async function getOrCreateReadAuth(
  pactId: string,
  viewer: string,
  signMessage: (msg: string) => Promise<string>,
): Promise<{ viewer: string; sig: string; ts: number }> {
  const CACHE_TTL_SECONDS = 23 * 60 * 60;
  const cacheKey = `arc:deliv-sig:${pactId}:${viewer.toLowerCase()}`;
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
  const sig = await signMessage(readDeliverableChallenge(pactId, ts));

  if (typeof window !== 'undefined') {
    localStorage.setItem(cacheKey, JSON.stringify({ sig, ts }));
  }

  return { viewer, sig, ts };
}

export async function getDeliverable(
  pactId: string,
  hash: string,
  auth: { viewer: string; sig: string; ts: number },
): Promise<Deliverable> {
  const res = await fetch(
    `${API_BASE}/arc/escrow/pact/${encodeURIComponent(pactId)}/deliverable?hash=${encodeURIComponent(hash)}`,
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

export async function buildSetBudgetUnsigned(pactId: string, budgetUsdc: string): Promise<UnsignedTx> {
  return jsonFetch<UnsignedTx>('POST', `/arc/escrow/pacts/${encodeURIComponent(pactId)}/budget/unsigned`, {
    budgetUsdc,
  });
}

export async function buildApproveUnsigned(amountUsdc: string): Promise<UnsignedTx> {
  return jsonFetch<UnsignedTx>('POST', '/arc/usdc/approve/unsigned', { amountUsdc });
}

// Atomic acceptance — the caller signs off on exactly the current live quote.
// Pass the pact's current budget + challengeWindow; the wrapper reverts
// WrongTerms if either drifted (e.g. the provider re-quoted mid-flight).
export async function buildFundUnsigned(
  pactId: string,
  expectedBudgetUsdc: string,
  expectedChallengeWindowSeconds: number,
): Promise<UnsignedTx> {
  return jsonFetch<UnsignedTx>('POST', `/arc/escrow/pacts/${encodeURIComponent(pactId)}/fund/unsigned`, {
    expectedBudgetUsdc,
    expectedChallengeWindowSeconds,
  });
}

export async function buildSubmitUnsigned(
  pactId: string,
  deliverableHash: string,
): Promise<UnsignedTx> {
  return jsonFetch<UnsignedTx>('POST', `/arc/escrow/pacts/${encodeURIComponent(pactId)}/submit/unsigned`, {
    deliverableHash,
  });
}

export async function buildCompleteUnsigned(pactId: string, reasonHash?: string): Promise<UnsignedTx> {
  return jsonFetch<UnsignedTx>('POST', `/arc/escrow/pacts/${encodeURIComponent(pactId)}/complete/unsigned`, {
    reasonHash,
  });
}

export async function buildRejectUnsigned(pactId: string, reasonHash?: string): Promise<UnsignedTx> {
  return jsonFetch<UnsignedTx>('POST', `/arc/escrow/pacts/${encodeURIComponent(pactId)}/reject/unsigned`, {
    reasonHash,
  });
}

export async function buildRefundUnsigned(pactId: string): Promise<UnsignedTx> {
  return jsonFetch<UnsignedTx>('POST', `/arc/escrow/pacts/${encodeURIComponent(pactId)}/refund/unsigned`);
}

// cancel() — client withdraws an Open (unfunded) pact. The wrapper's reject()
// only works on Funded/Submitted, so Open uses this separate path.
export async function buildCancelUnsigned(pactId: string): Promise<UnsignedTx> {
  return jsonFetch<UnsignedTx>('POST', `/arc/escrow/pacts/${encodeURIComponent(pactId)}/cancel/unsigned`);
}

// ─── Dispute system ──────────────────────────────────────────────────────────

// Permissionless post-challenge finalize — pays the provider once the challenge
// window closes with no dispute. (Client early-accept is buildCompleteUnsigned.)
export async function buildFinalizeUnsigned(pactId: string, reasonHash?: string): Promise<UnsignedTx> {
  return jsonFetch<UnsignedTx>('POST', `/arc/escrow/pacts/${encodeURIComponent(pactId)}/finalize/unsigned`, {
    reasonHash,
  });
}

// Open a dispute (client or provider, within the challenge window). Pulls a 5%
// bond — approve the wrapper for the bond first.
export async function buildDisputeUnsigned(pactId: string, reasonHash?: string): Promise<UnsignedTx> {
  return jsonFetch<UnsignedTx>('POST', `/arc/escrow/pacts/${encodeURIComponent(pactId)}/dispute/unsigned`, {
    reasonHash,
  });
}

export async function buildConcedeUnsigned(pactId: string): Promise<UnsignedTx> {
  return jsonFetch<UnsignedTx>('POST', `/arc/escrow/pacts/${encodeURIComponent(pactId)}/concede/unsigned`);
}

export async function buildForceConcedeUnsigned(pactId: string): Promise<UnsignedTx> {
  return jsonFetch<UnsignedTx>('POST', `/arc/escrow/pacts/${encodeURIComponent(pactId)}/force-concede/unsigned`);
}

// Defend (opponent, within concede window). Posts a matching bond and triggers
// evaluator selection — approve the wrapper for the bond first.
export async function buildDefendUnsigned(pactId: string): Promise<UnsignedTx> {
  return jsonFetch<UnsignedTx>('POST', `/arc/escrow/pacts/${encodeURIComponent(pactId)}/defend/unsigned`);
}

export async function buildCommitVoteUnsigned(pactId: string, commitHash: string): Promise<UnsignedTx> {
  return jsonFetch<UnsignedTx>('POST', `/arc/escrow/pacts/${encodeURIComponent(pactId)}/commit/unsigned`, {
    commitHash,
  });
}

// vote: 1 = ForDisputer, 2 = ForOpponent.
export async function buildRevealVoteUnsigned(
  pactId: string,
  evaluator: string,
  vote: 1 | 2,
  secret: string,
): Promise<UnsignedTx> {
  return jsonFetch<UnsignedTx>('POST', `/arc/escrow/pacts/${encodeURIComponent(pactId)}/reveal/unsigned`, {
    evaluator,
    vote,
    secret,
  });
}

export async function buildResolveUnsigned(pactId: string): Promise<UnsignedTx> {
  return jsonFetch<UnsignedTx>('POST', `/arc/escrow/pacts/${encodeURIComponent(pactId)}/resolve/unsigned`);
}

export async function buildStakeEvaluatorUnsigned(amountUsdc: string): Promise<UnsignedTx> {
  return jsonFetch<UnsignedTx>('POST', '/arc/escrow/evaluators/stake/unsigned', { amountUsdc });
}

export async function buildUnstakeEvaluatorUnsigned(): Promise<UnsignedTx> {
  return jsonFetch<UnsignedTx>('POST', '/arc/escrow/evaluators/unstake/unsigned');
}

export type DisputeState = {
  disputeId: string;
  pactId: string;
  disputer: string;
  opponent: string;
  bondDisputer: string;
  bondOpponent: string;
  reasonHash: string;
  status:
    | 'Open'
    | 'Defended'
    | 'Resolved_Disputer'
    | 'Resolved_Opponent'
    | 'Resolved_NoQuorum'
    | 'Conceded_Disputer'
    | string;
  openedAt: number;
  concedeDeadline: number;
  commitDeadline: number;
  graceDeadline: number;
  revealDeadline: number;
  evaluators: string[];
  commitCount: number;
  revealCount: number;
  votesForDisputer: number;
  votesForOpponent: number;
};

export async function getDisputeState(pactId: string): Promise<DisputeState | null> {
  const res = await jsonFetch<{ dispute: DisputeState | null }>(
    'GET',
    `/arc/escrow/pact/${encodeURIComponent(pactId)}/dispute`,
  );
  return res.dispute;
}

export type EvaluatorInfo = {
  address: string;
  stake: { raw: string; usdc: string };
  stakedAt: number;
  totalVotes: number;
  majorityVotes: number;
  pendingDisputeRefs: number;
  active: boolean;
  pool: {
    activeCount: string;
    minStake: { raw: string; usdc: string };
    bondBps: number;
    evaluatorsPerDispute: number;
  };
};

export async function getEvaluatorInfo(address: string): Promise<EvaluatorInfo> {
  return jsonFetch<EvaluatorInfo>('GET', `/arc/escrow/evaluators/${encodeURIComponent(address)}`);
}

// Opt in to auto-reveal: the agent reveals this vote on the evaluator's behalf
// once the reveal window opens, using the operator wallet.
export async function registerAutoReveal(
  pactId: string,
  body: { disputeId: string; evaluator: string; vote: 1 | 2; secret: string },
): Promise<{ scheduled: boolean; revealAfter: number; revealBefore: number }> {
  return jsonFetch('POST', `/arc/escrow/pacts/${encodeURIComponent(pactId)}/auto-reveal`, body);
}

// ──────────────────────────────────────────────────────────────────────────
// Standalone trade-finance escrow (TradeEscrow). Buyer/seller sign with their
// own wallet via the /unsigned builders; the Trade Officer agent attests via a
// backend dev-controlled call.
// ──────────────────────────────────────────────────────────────────────────

export type TradeStatus =
  | 'None'
  | 'Proposing'
  | 'Agreed'
  | 'Funded'
  | 'Released'
  | 'Disputed'
  | 'Refunded'
  | 'Cancelled';

export type TradeState = {
  buyer: `0x${string}`;
  seller: `0x${string}`;
  attester: `0x${string}`;
  arbitrator: `0x${string}`;
  lastProposer: `0x${string}`;
  amountUsdc: string;
  depositUsdc: string;
  estimatedDepositUsdc: string;
  financedRepayUsdc: string;
  milestoneHash: string;
  deadline: number;
  financingAdvanced: boolean;
  status: TradeStatus;
  // Set while a buyer challenge window is open (officer approved, not yet
  // settled) — unix seconds when it auto-settles. null otherwise.
  challengeWindowUntil: number | null;
};

export type DeliveryDoc = {
  kind: 'bill_of_lading' | 'tracking' | 'customs' | 'other';
  reference?: string;
  content: string;
  carrier?: string;
  origin?: string;
  destination?: string;
};

export async function getTrade(tradeId: string): Promise<TradeState> {
  return jsonFetch('GET', `/arc/trade/${encodeURIComponent(tradeId)}`);
}

export async function buildCreateTradeUnsigned(input: {
  seller: `0x${string}`;
  amountUsdc: string;
  milestone?: string;
  deadlineSeconds?: number;
}): Promise<UnsignedTx> {
  return jsonFetch('POST', '/arc/trade/create/unsigned', input);
}

export async function buildApproveTradeUnsigned(amountUsdc: string): Promise<UnsignedTx> {
  return jsonFetch('POST', '/arc/trade/approve/unsigned', { amountUsdc });
}

export async function buildFundTradeUnsigned(tradeId: string): Promise<UnsignedTx> {
  return jsonFetch('POST', `/arc/trade/${encodeURIComponent(tradeId)}/fund/unsigned`);
}

export async function buildAcceptTradeUnsigned(tradeId: string): Promise<UnsignedTx> {
  return jsonFetch('POST', `/arc/trade/${encodeURIComponent(tradeId)}/accept/unsigned`);
}

export async function buildCounterTradeUnsigned(tradeId: string, amountUsdc: string): Promise<UnsignedTx> {
  return jsonFetch('POST', `/arc/trade/${encodeURIComponent(tradeId)}/counter/unsigned`, { amountUsdc });
}

export async function buildCancelTradeUnsigned(tradeId: string): Promise<UnsignedTx> {
  return jsonFetch('POST', `/arc/trade/${encodeURIComponent(tradeId)}/cancel/unsigned`);
}

export async function buildRequestFinancingUnsigned(tradeId: string): Promise<UnsignedTx> {
  return jsonFetch('POST', `/arc/trade/${encodeURIComponent(tradeId)}/finance/unsigned`);
}

// Trade Officer skill 2 — financing underwriting quote (priced off the buyer's
// passport tier). Read-only; the seller still signs requestFinancing to draw.
export type FinancingQuote = {
  buyerTier: number;
  financeBps: number;
  feeBps: number;
  advanceUsdc: string; // received now
  grossUsdc: string;
  feeUsdc: string;
  repayUsdc: string; // repaid at settlement
  eligible: boolean;
  alreadyAdvanced: boolean;
};

export async function getFinancingQuote(tradeId: string): Promise<FinancingQuote> {
  return jsonFetch('GET', `/arc/trade/${encodeURIComponent(tradeId)}/financing-quote`);
}

// ── Financing pool (LP vault) ───────────────────────────────────────────────
export type PoolStats = {
  totalAssetsUsdc: string;
  idleUsdc: string;
  outstandingUsdc: string;
  totalShares: string;
  sharePrice: number;
  myShares?: string;
  myValueUsdc?: string;
};

export async function getPoolStats(address?: string): Promise<PoolStats> {
  const q = address ? `?address=${encodeURIComponent(address)}` : '';
  return jsonFetch('GET', `/arc/trade/pool${q}`);
}

export async function buildPoolApproveUnsigned(amountUsdc: string): Promise<UnsignedTx> {
  return jsonFetch('POST', '/arc/trade/pool/deposit/approve/unsigned', { amountUsdc });
}

export async function buildPoolDepositUnsigned(amountUsdc: string): Promise<UnsignedTx> {
  return jsonFetch('POST', '/arc/trade/pool/deposit/unsigned', { amountUsdc });
}

export async function buildPoolWithdrawUnsigned(input: { amountUsdc?: string; shares?: string }): Promise<UnsignedTx> {
  return jsonFetch('POST', '/arc/trade/pool/withdraw/unsigned', input);
}

export type PoolActivity = {
  key: string;
  kind: 'pool-deposit' | 'pool-withdraw';
  amountUsdc: string;
  sharesRaw: string;
  txHash: string;
  whenMs: number;
  summary: string;
};

export async function getPoolActivity(address: string): Promise<PoolActivity[]> {
  const r = await jsonFetch<{ items: PoolActivity[] }>('GET', `/arc/trade/pool/activity?address=${encodeURIComponent(address)}`);
  return r.items;
}

export type PoolYield = {
  sharePrice: number;
  cumulativePct: number;
  // null until enough NAV history exists for the window (24h / 7d).
  dayPct: number | null;
  weekPct: number | null;
};

export async function getPoolYield(): Promise<PoolYield> {
  return jsonFetch('GET', '/arc/trade/pool/yield');
}

// Notification read-state (server-side, shared across devices).
export async function getReadKeys(address: string): Promise<string[]> {
  const r = await jsonFetch<{ keys: string[] }>('GET', `/arc/notifications/read?address=${encodeURIComponent(address)}`);
  return r.keys;
}

export async function markReadKeysRemote(address: string, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await jsonFetch('POST', '/arc/notifications/read', { address, keys });
}

// Either party flags a problem on a Funded trade → parks it in Disputed.
export async function buildRaiseDisputeUnsigned(tradeId: string): Promise<UnsignedTx> {
  return jsonFetch('POST', `/arc/trade/${encodeURIComponent(tradeId)}/dispute/unsigned`);
}

// Buyer reclaims their deposit on a Funded trade whose deadline has passed.
export async function buildRefundTradeUnsigned(tradeId: string): Promise<UnsignedTx> {
  return jsonFetch('POST', `/arc/trade/${encodeURIComponent(tradeId)}/refund/unsigned`);
}

// Arbitrator settles a Disputed trade — release to seller or refund the buyer.
export async function buildResolveDisputeUnsigned(tradeId: string, releaseToSeller: boolean): Promise<UnsignedTx> {
  return jsonFetch('POST', `/arc/trade/${encodeURIComponent(tradeId)}/resolve/unsigned`, { releaseToSeller });
}

export type TradeEvent = {
  kind: string;
  actor: string | null;
  amountUsdc: string | null;
  blockNumber: number;
  txHash: string;
  at: string;
};

export async function getTradeEvents(tradeId: string): Promise<TradeEvent[]> {
  const r = await jsonFetch<{ events: TradeEvent[] }>('GET', `/arc/trades/${encodeURIComponent(tradeId)}/events`);
  return r.events;
}

// The Trade Officer agent ingests a delivery doc and either auto-attests
// (from its own wallet) or escalates to a human verifier.
export async function officerAttest(
  tradeId: string,
  document: DeliveryDoc,
): Promise<{
  decision: 'pass' | 'escalate';
  attested: boolean;
  category?: 'documentary' | 'mismatch' | 'high_value';
  resubmittable?: boolean;
  confidence: number;
  reasons: string[];
  note?: string;
  challengeWindowSeconds?: number;
  finalizeAt?: number;
  txHash?: string;
}> {
  return jsonFetch('POST', `/arc/trade/${encodeURIComponent(tradeId)}/officer-attest`, { document });
}

export type TradeListItem = {
  tradeId: string;
  status: TradeState['status'];
  amountUsdc: string;
  depositUsdc: string;
  role: 'buyer' | 'seller';
  counterparty: `0x${string}`;
  buyer: `0x${string}`;
  seller: `0x${string}`;
  lastProposer: `0x${string}`;
  deadline: number;
};

export async function getTradesByAddress(address: string): Promise<TradeListItem[]> {
  const r = await jsonFetch<{ trades: TradeListItem[] }>('GET', `/arc/trades?address=${encodeURIComponent(address)}`);
  return r.trades;
}

export type PassportSnapshot = {
  address: `0x${string}`;
  completedTrades: number;
  failedTrades: number;
  depositBps: number;
  depositPct: number;
};

export async function getPassport(address: string): Promise<PassportSnapshot> {
  return jsonFetch('GET', `/arc/passport/${encodeURIComponent(address)}`);
}

export type TradeNotification = {
  tradeId: string;
  key: string;
  kind: 'action' | 'event';
  summary: string;
  whenMs: number;
};

export async function getTradeNotifications(address: string): Promise<TradeNotification[]> {
  const r = await jsonFetch<{ items: TradeNotification[] }>('GET', `/arc/trades/notifications?address=${encodeURIComponent(address)}`);
  return r.items;
}
