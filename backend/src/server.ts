import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, statSync, createReadStream } from 'node:fs';
import { resolve, join } from 'node:path';
import Fastify, { type FastifyError, type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import {
  encodeFunctionData,
  formatUnits,
  parseUnits,
  parseEventLogs,
  keccak256,
  stringToBytes,
  type Abi,
} from 'viem';
import {
  initiateDeveloperControlledWalletsClient,
  type Blockchain,
} from '@circle-fin/developer-controlled-wallets';
import pkg from '../package.json' with { type: 'json' };
import {
  arcClient,
  USDC_ADDRESS,
  WRAPPER_ADDRESS,
  ERC8004_REPUTATION_ADDRESS,
  ARC_TESTNET_CHAIN_ID,
} from './lib/arc.js';
import { erc20Abi } from './lib/abis/erc20.js';
import { pactWrapperAbi, PACT_STATUS } from './lib/abis/pact-wrapper.js';
import {
  reputationRegistryAbi,
  identityRegistryAbi,
  erc721TransferEvent,
} from './lib/abis/erc8004.js';
import {
  db,
  rowToUser,
  rowToPactIndex,
  rowToPactEvent,
  rowToDeliverable,
  type UserRow,
  type PactIndexRow,
  type PactEventRow,
  type DeliverableRow,
  type DeliverableContentType,
} from './lib/db.js';
import { tradeEscrowAbi } from './lib/abis/trade-escrow.js';
import {
  TRADE_ESCROW_ADDRESS,
  getTrade,
  depositOf,
  createTradeSpec,
  fundSpec,
  attestSpec,
  acceptSpec,
  counterSpec,
  cancelSpec,
  requestFinancingSpec,
  approveEscrowSpec,
  approveSpec,
  poolFundSpec,
  getPassport,
  FINANCING_POOL_ADDRESS,
  TRADE_PASSPORT_ADDRESS,
  type ExecSpec,
} from './lib/tradepass.js';
import { evaluateDelivery, type DeliveryDoc } from './lib/trade-officer.js';
import { startTradeIndexer } from './lib/trade-indexer.js';
import { startWrapperIndexer } from './lib/wrapper-indexer.js';
import { startBridgeIndexer } from './lib/bridge-indexer.js';
import { startAutoRevealAgent, type AutoRevealRow } from './lib/auto-reveal-agent.js';

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
}

const CIRCLE_API_KEY = requireEnv('CIRCLE_API_KEY');
const CIRCLE_ENTITY_SECRET = requireEnv('CIRCLE_ENTITY_SECRET');
const CIRCLE_OPERATOR_WALLET_ID = requireEnv('CIRCLE_OPERATOR_WALLET_ID');
const CIRCLE_OPERATOR_ADDRESS = requireEnv('CIRCLE_OPERATOR_ADDRESS') as `0x${string}`;
const CIRCLE_WALLET_SET_ID = requireEnv('CIRCLE_WALLET_SET_ID');

const circle = initiateDeveloperControlledWalletsClient({
  apiKey: CIRCLE_API_KEY,
  entitySecret: CIRCLE_ENTITY_SECRET,
});

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000' as const;

function toBytes32(input: string | undefined, fieldName: string): `0x${string}` {
  if (input === undefined || input === '') return ZERO_BYTES32;
  if (!/^0x[0-9a-fA-F]{64}$/.test(input)) {
    throw new Error(`${fieldName} must be a 0x-prefixed 32-byte hex string (66 chars total)`);
  }
  return input as `0x${string}`;
}

type UnsignedTx = {
  to: `0x${string}`;
  data: `0x${string}`;
  value: `0x${string}`;
  chainId: number;
};

function buildUnsignedTx(to: `0x${string}`, abi: Abi, functionName: string, args: readonly unknown[]): UnsignedTx {
  const data = encodeFunctionData({ abi, functionName, args });
  return { to, data, value: '0x0', chainId: ARC_TESTNET_CHAIN_ID };
}

async function waitForCircleTx(id: string, timeoutMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await circle.getTransaction({ id });
    const tx = res.data?.transaction;
    if (!tx) throw new Error(`No transaction data for id=${id}`);
    if (tx.state === 'CONFIRMED' || tx.state === 'COMPLETE') return tx;
    if (['FAILED', 'CANCELED', 'DENIED'].includes(tx.state ?? '')) {
      throw new Error(`Tx ${tx.state}: ${tx.errorReason ?? 'unknown'}`);
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`Tx ${id} timed out after ${timeoutMs}ms`);
}

// The wrapper's pacts(pactId) auto-getter returns a positional array (viem does
// not key multi-output getters by name, unlike the reference's single-struct
// getJob). Decode by index — order matches the PactRecord struct in
// PactWrapper.sol. description is NOT in the struct; source it from pacts_index.
type WrapperPact = {
  underlyingJobId: bigint;
  client: `0x${string}`;
  provider: `0x${string}`;
  createdAt: bigint;
  expiredAt: bigint;
  submittedExtCount: number;
  status: number;
  terminationActor: `0x${string}`;
  budget: bigint;
  challengeWindow: bigint;
  pendingBudget: bigint;
  pendingChallengeWindow: bigint;
  pendingProposedAt: bigint;
  deliverableHash: `0x${string}`;
  submittedAt: bigint;
  disputeId: bigint;
  confidentialPayout: boolean;
};

async function readWrapperPact(pactId: bigint): Promise<WrapperPact> {
  const r = (await arcClient.readContract({
    address: WRAPPER_ADDRESS,
    abi: pactWrapperAbi,
    functionName: 'pacts',
    args: [pactId],
  })) as readonly unknown[];
  return {
    underlyingJobId: r[0] as bigint,
    client: r[1] as `0x${string}`,
    provider: r[2] as `0x${string}`,
    createdAt: r[3] as bigint,
    expiredAt: r[4] as bigint,
    submittedExtCount: Number(r[5]),
    status: Number(r[6]),
    terminationActor: r[7] as `0x${string}`,
    budget: r[8] as bigint,
    challengeWindow: r[9] as bigint,
    pendingBudget: r[10] as bigint,
    pendingChallengeWindow: r[11] as bigint,
    pendingProposedAt: r[12] as bigint,
    deliverableHash: r[13] as `0x${string}`,
    submittedAt: r[14] as bigint,
    disputeId: r[15] as bigint,
    confidentialPayout: r[16] as boolean,
  };
}

// getDisputeMeta(disputeId) is another multi-output getter → positional array.
// Order matches the Dispute struct readout in PactWrapper.sol.
type DisputeMeta = {
  pactId: bigint;
  disputer: `0x${string}`;
  opponent: `0x${string}`;
  bondDisputer: bigint;
  bondOpponent: bigint;
  reasonHash: `0x${string}`;
  status: number;
  openedAt: bigint;
  concedeDeadline: bigint;
  commitDeadline: bigint;
  graceDeadline: bigint;
  revealDeadline: bigint;
  evaluators: readonly `0x${string}`[];
  commitCount: number;
  revealCount: number;
  votesForDisputer: number;
  votesForOpponent: number;
};

// Wrapper dispute status enum (PactWrapper.sol DisputeStatus).
const DISPUTE_STATUS = [
  'Open',
  'Defended',
  'Resolved_Disputer',
  'Resolved_Opponent',
  'Resolved_NoQuorum',
  'Conceded_Disputer',
] as const;

async function readDisputeMeta(disputeId: bigint): Promise<DisputeMeta> {
  const r = (await arcClient.readContract({
    address: WRAPPER_ADDRESS,
    abi: pactWrapperAbi,
    functionName: 'getDisputeMeta',
    args: [disputeId],
  })) as readonly unknown[];
  return {
    pactId: r[0] as bigint,
    disputer: r[1] as `0x${string}`,
    opponent: r[2] as `0x${string}`,
    bondDisputer: r[3] as bigint,
    bondOpponent: r[4] as bigint,
    reasonHash: r[5] as `0x${string}`,
    status: Number(r[6]),
    openedAt: r[7] as bigint,
    concedeDeadline: r[8] as bigint,
    commitDeadline: r[9] as bigint,
    graceDeadline: r[10] as bigint,
    revealDeadline: r[11] as bigint,
    evaluators: r[12] as readonly `0x${string}`[],
    commitCount: Number(r[13]),
    revealCount: Number(r[14]),
    votesForDisputer: Number(r[15]),
    votesForOpponent: Number(r[16]),
  };
}

const app = Fastify({
  logger: {
    redact: {
      paths: [
        'req.headers.authorization',
        'err.config.headers.Authorization',
        'err.config.headers.authorization',
      ],
      censor: '[REDACTED]',
    },
  },
});

// CORS — let the frontend dev server (and any explicit allow-listed origins)
// hit the backend. Override with CORS_ORIGINS as a comma-separated list.
const corsOrigins = (process.env.CORS_ORIGINS ?? 'http://localhost:3000')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
app.register(cors, {
  origin: corsOrigins,
  methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
});

// Single error handler so every error response is shaped { error: string },
// matching the convention used by per-route reply.code(...).send({error}).
// Without this, unhandled throws and schema-validation errors return
// Fastify's default { statusCode, error, message } shape, forcing callers to
// parse two shapes. With this, the frontend's jsonFetch sees one shape.
app.setErrorHandler((err: FastifyError, request, reply) => {
  const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
  // Log full error for ops; respond with a clean message for the client.
  if (status >= 500) {
    request.log.error({ err }, 'unhandled error');
  } else {
    request.log.info({ err }, 'client error');
  }
  reply.code(status).send({ error: err.message || 'Internal Server Error' });
});

// Ensure the operator wallet has a corresponding user row so the escrow routes
// can resolve signers uniformly. Idempotent: skipped if the wallet is already
// registered under any handle.
const operatorRow = db
  .prepare('SELECT id, handle FROM users WHERE circle_wallet_id = ?')
  .get(CIRCLE_OPERATOR_WALLET_ID) as { id: string; handle: string } | undefined;
if (!operatorRow) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO users (id, handle, circle_wallet_id, wallet_address, signing_mode) VALUES (?, ?, ?, ?, ?)`
  ).run(id, 'operator', CIRCLE_OPERATOR_WALLET_ID, CIRCLE_OPERATOR_ADDRESS, 'dev-controlled');
  app.log.info({ id, handle: 'operator' }, 'seeded operator user');
}

type SignerRow = {
  circle_wallet_id: string | null;
  wallet_address: string;
  signing_mode: string;
};
type SignerLookup = { userId?: string; handle?: string };

function requireSigner(
  reply: FastifyReply,
  lookup: SignerLookup | undefined,
): { circle_wallet_id: string; wallet_address: string } | null {
  const userId = lookup?.userId;
  const handle = lookup?.handle;

  let row: SignerRow | undefined;
  let identifier: string;

  if (userId && typeof userId === 'string') {
    row = db
      .prepare('SELECT circle_wallet_id, wallet_address, signing_mode FROM users WHERE id = ?')
      .get(userId) as SignerRow | undefined;
    identifier = `user ${userId}`;
  } else if (handle && typeof handle === 'string') {
    row = db
      .prepare('SELECT circle_wallet_id, wallet_address, signing_mode FROM users WHERE handle = ?')
      .get(handle) as SignerRow | undefined;
    identifier = `user with handle '${handle}'`;
  } else {
    reply.code(400).send({ error: 'userId or handle is required' });
    return null;
  }

  if (!row) {
    reply.code(404).send({ error: `${identifier} not found` });
    return null;
  }

  // External / Circle-Modular users sign client-side via wagmi or their own bundler.
  // The backend can't sign on their behalf — they should use the /unsigned routes instead.
  if (row.signing_mode !== 'dev-controlled' || !row.circle_wallet_id) {
    reply.code(409).send({
      error: `${identifier} has signing_mode='${row.signing_mode}' — backend cannot sign for this user. Use the /unsigned variant of this route and have the wallet sign client-side.`,
    });
    return null;
  }

  return { circle_wallet_id: row.circle_wallet_id, wallet_address: row.wallet_address };
}

// Health probe: liveness vs readiness. Returns 200 when both dependencies
// (SQLite + Arc RPC) respond; 503 when either is down so external monitors
// can distinguish "process is running" from "process can actually serve".
// Per-component status is always included so an alert can point to the
// failing dependency directly.
app.get('/health', async (_request, reply) => {
  const dbStart = Date.now();
  let dbStatus: { ok: boolean; latencyMs: number; error?: string };
  try {
    db.prepare('SELECT 1').get();
    dbStatus = { ok: true, latencyMs: Date.now() - dbStart };
  } catch (err) {
    dbStatus = {
      ok: false,
      latencyMs: Date.now() - dbStart,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const rpcStart = Date.now();
  let rpcStatus: { ok: boolean; latencyMs: number; blockNumber?: string; error?: string };
  try {
    const head = await arcClient.getBlockNumber();
    rpcStatus = {
      ok: true,
      latencyMs: Date.now() - rpcStart,
      blockNumber: head.toString(),
    };
  } catch (err) {
    rpcStatus = {
      ok: false,
      latencyMs: Date.now() - rpcStart,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const overall = dbStatus.ok && rpcStatus.ok;
  return reply.code(overall ? 200 : 503).send({
    status: overall ? 'ok' : 'degraded',
    service: 'arc-trade-backend',
    operatorAddress: process.env.CIRCLE_OPERATOR_ADDRESS ?? null,
    checks: {
      db: dbStatus,
      rpc: rpcStatus,
    },
  });
});

app.get('/version', async () => {
  return {
    service: pkg.name,
    version: pkg.version,
  };
});

app.get('/wallet/balance', async () => {
  const res = await circle.getWalletTokenBalance({ id: CIRCLE_OPERATOR_WALLET_ID });
  return res.data;
});

app.post<{
  Body: {
    fromUserId?: string;
    fromHandle?: string;
    toUserId?: string;
    toHandle?: string;
    toAddress?: string;
    amountUsdc: string;
  };
}>('/wallet/transfer-usdc', async (request, reply) => {
  const { fromUserId, fromHandle, toUserId, toHandle, toAddress, amountUsdc } = request.body;
  const sender = requireSigner(reply, { userId: fromUserId, handle: fromHandle });
  if (!sender) return;

  let destination: string;
  if (toUserId) {
    const recipient = db
      .prepare('SELECT wallet_address FROM users WHERE id = ?')
      .get(toUserId) as { wallet_address: string } | undefined;
    if (!recipient) return reply.code(404).send({ error: `toUserId ${toUserId} not found` });
    destination = recipient.wallet_address;
  } else if (toHandle) {
    const recipient = db
      .prepare('SELECT wallet_address FROM users WHERE handle = ?')
      .get(toHandle) as { wallet_address: string } | undefined;
    if (!recipient) return reply.code(404).send({ error: `user with handle '${toHandle}' not found` });
    destination = recipient.wallet_address;
  } else if (toAddress) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(toAddress)) {
      return reply.code(400).send({ error: 'toAddress must be a 0x-prefixed 20-byte hex address' });
    }
    destination = toAddress;
  } else {
    return reply.code(400).send({ error: 'one of toUserId, toHandle, or toAddress is required' });
  }

  if (!amountUsdc || Number(amountUsdc) <= 0) {
    return reply.code(400).send({ error: 'amountUsdc must be a positive number string' });
  }
  const amountRaw = parseUnits(amountUsdc, 6);

  const exec = await circle.createContractExecutionTransaction({
    walletId: sender.circle_wallet_id,
    contractAddress: USDC_ADDRESS,
    abiFunctionSignature: 'transfer(address,uint256)',
    abiParameters: [destination, amountRaw.toString()],
    fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
  });

  const tx = await waitForCircleTx(exec.data!.id);

  return {
    from: sender.wallet_address,
    to: destination,
    amount: { raw: amountRaw.toString(), usdc: amountUsdc },
    txId: tx.id,
    txHash: tx.txHash,
    state: tx.state,
  };
});

app.post<{ Body: { handle?: string } }>('/users', async (request, reply) => {
  const rawHandle = request.body?.handle?.trim();
  const handle = rawHandle && rawHandle.length > 0 ? rawHandle : null;

  if (handle !== null) {
    const existing = db.prepare('SELECT id FROM users WHERE handle = ?').get(handle);
    if (existing) return reply.code(409).send({ error: `handle '${handle}' already exists` });
  }

  const created = await circle.createWallets({
    walletSetId: CIRCLE_WALLET_SET_ID,
    // 'ARC-TESTNET' isn't in Circle's developer-controlled-wallets Blockchain
    // enum yet (verified 2026-05-26), but the API accepts it at runtime —
    // cast through unknown until the SDK catches up.
    blockchains: ['ARC-TESTNET' as unknown as Blockchain],
    count: 1,
    accountType: 'EOA',
  });
  const wallet = created.data?.wallets?.[0];
  if (!wallet?.id || !wallet.address) {
    return reply.code(502).send({ error: 'Circle did not return a usable wallet' });
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO users (id, handle, circle_wallet_id, wallet_address, signing_mode) VALUES (?, ?, ?, ?, ?)`
  ).run(id, handle, wallet.id, wallet.address, 'dev-controlled');

  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow;
  return reply.code(201).send(rowToUser(row));
});

// Register a wallet the backend does NOT custody — used by the frontend after
// a user connects MetaMask/Rabby (wagmi) or signs in with Circle Modular passkey.
// circle_wallet_id stays NULL; the signer must use the /unsigned routes to act.
app.post<{
  Body: { walletAddress: string; handle?: string; signingMode?: 'external' | 'circle-modular' };
}>('/users/register-external', async (request, reply) => {
  const walletAddress = request.body?.walletAddress?.trim().toLowerCase();
  if (!walletAddress || !/^0x[0-9a-fA-F]{40}$/.test(walletAddress)) {
    return reply.code(400).send({ error: 'walletAddress must be a 0x-prefixed 20-byte hex address' });
  }
  const signingMode = request.body?.signingMode ?? 'external';
  if (signingMode !== 'external' && signingMode !== 'circle-modular') {
    return reply
      .code(400)
      .send({ error: "signingMode must be 'external' or 'circle-modular'" });
  }

  // Address is unique — idempotent: if this address is already registered, return the existing row.
  const existing = db
    .prepare('SELECT * FROM users WHERE wallet_address = ?')
    .get(walletAddress) as UserRow | undefined;
  if (existing) return reply.code(200).send(rowToUser(existing));

  const rawHandle = request.body?.handle?.trim();
  const handle = rawHandle && rawHandle.length > 0 ? rawHandle : null;
  if (handle !== null) {
    const taken = db.prepare('SELECT id FROM users WHERE handle = ?').get(handle);
    if (taken) return reply.code(409).send({ error: `handle '${handle}' already exists` });
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO users (id, handle, circle_wallet_id, wallet_address, signing_mode) VALUES (?, ?, NULL, ?, ?)`,
  ).run(id, handle, walletAddress, signingMode);

  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow;
  return reply.code(201).send(rowToUser(row));
});

app.get('/users', async () => {
  const rows = db
    .prepare('SELECT * FROM users ORDER BY created_at DESC LIMIT 200')
    .all() as UserRow[];
  return { users: rows.map(rowToUser), count: rows.length };
});

app.get<{ Params: { id: string } }>('/users/:id', async (request, reply) => {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(request.params.id) as
    | UserRow
    | undefined;
  if (!row) return reply.code(404).send({ error: 'user not found' });
  return rowToUser(row);
});

// PATCH /users/:id — first-time handle assignment only.
// Handles are immutable once set: a user with a non-null handle cannot rename
// it or clear it. This prevents squatting attacks where a third party grabs
// a recognizable handle the moment its original owner changes it.
app.patch<{ Params: { id: string }; Body: { handle?: string | null } }>(
  '/users/:id',
  async (request, reply) => {
    const id = request.params.id;
    const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    if (!existing) return reply.code(404).send({ error: 'user not found' });

    const body = request.body ?? {};
    if (!('handle' in body)) {
      return rowToUser(existing);
    }

    if (existing.handle !== null) {
      return reply.code(409).send({
        error: 'handle is immutable once set',
        currentHandle: existing.handle,
      });
    }

    const raw = body.handle;
    let newHandle: string | null;
    if (raw === null) {
      newHandle = null;
    } else if (typeof raw === 'string') {
      const trimmed = raw.trim();
      newHandle = trimmed.length > 0 ? trimmed : null;
    } else {
      return reply.code(400).send({ error: 'handle must be a string or null' });
    }

    if (newHandle === null) {
      return rowToUser(existing);
    }

    const conflict = db
      .prepare('SELECT id FROM users WHERE handle = ? AND id != ?')
      .get(newHandle, id);
    if (conflict) {
      return reply.code(409).send({ error: `handle '${newHandle}' already exists` });
    }

    db.prepare('UPDATE users SET handle = ? WHERE id = ?').run(newHandle, id);
    const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow;
    return rowToUser(updated);
  }
);

// ─── ERC-8004 agent linking + reputation reads ─────────────────────────────
// Users opt-in to surface their ERC-8004 reputation by linking an agentId
// they own (verified on-chain via IdentityRegistry.ownerOf / getAgentWallet).
// Reputation itself is fetched live — no indexing yet, view calls are cheap
// enough on a single pactId-keyed page that caching can come later if needed.

let cachedIdentityRegistry: `0x${string}` | null = null;
async function resolveIdentityRegistry(): Promise<`0x${string}`> {
  if (cachedIdentityRegistry) return cachedIdentityRegistry;
  const envOverride = process.env.ARC_IDENTITY_REGISTRY_ADDRESS;
  if (envOverride && /^0x[0-9a-fA-F]{40}$/.test(envOverride)) {
    cachedIdentityRegistry = envOverride as `0x${string}`;
    return cachedIdentityRegistry;
  }
  const addr = await arcClient.readContract({
    address: ERC8004_REPUTATION_ADDRESS,
    abi: reputationRegistryAbi,
    functionName: 'getIdentityRegistry',
  });
  cachedIdentityRegistry = addr as `0x${string}`;
  return cachedIdentityRegistry;
}

app.patch<{ Params: { id: string }; Body: { agentId?: string | null } }>(
  '/users/:id/agent-id',
  async (request, reply) => {
    const id = request.params.id;
    const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    if (!existing) return reply.code(404).send({ error: 'user not found' });

    const body = request.body ?? {};
    if (!('agentId' in body)) return rowToUser(existing);

    // null clears the link. Allowed any time — there's no squatting risk on
    // unlink, and re-linking still requires the on-chain ownership check.
    if (body.agentId === null) {
      db.prepare('UPDATE users SET agent_id = NULL WHERE id = ?').run(id);
      const cleared = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow;
      return rowToUser(cleared);
    }

    if (typeof body.agentId !== 'string' || !/^\d+$/.test(body.agentId)) {
      return reply.code(400).send({ error: 'agentId must be a numeric string (uint256)' });
    }
    const agentIdBig = BigInt(body.agentId);

    // Ownership proof: caller's wallet must be either the ERC-721 owner of
    // the agentId OR the explicitly-set agent wallet override. getAgentWallet
    // returns address(0) when unset.
    let identityRegistry: `0x${string}`;
    try {
      identityRegistry = await resolveIdentityRegistry();
    } catch (err) {
      return reply.code(502).send({
        error: 'could not resolve IdentityRegistry from ReputationRegistry',
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    const userAddr = existing.wallet_address.toLowerCase();
    let owner = '0x0000000000000000000000000000000000000000' as `0x${string}`;
    let agentWallet = '0x0000000000000000000000000000000000000000' as `0x${string}`;
    try {
      [owner, agentWallet] = await Promise.all([
        arcClient.readContract({
          address: identityRegistry,
          abi: identityRegistryAbi,
          functionName: 'ownerOf',
          args: [agentIdBig],
        }),
        arcClient.readContract({
          address: identityRegistry,
          abi: identityRegistryAbi,
          functionName: 'getAgentWallet',
          args: [agentIdBig],
        }),
      ]);
    } catch (err) {
      return reply.code(404).send({
        error: 'agentId not found on IdentityRegistry',
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    const matchesOwner = owner.toLowerCase() === userAddr;
    const matchesAgentWallet =
      agentWallet !== '0x0000000000000000000000000000000000000000' &&
      agentWallet.toLowerCase() === userAddr;
    if (!matchesOwner && !matchesAgentWallet) {
      return reply.code(403).send({
        error: 'caller wallet is not the owner or agent-wallet for this agentId',
        owner,
        agentWallet,
      });
    }

    // Prevent two distinct users from claiming the same agentId — first claim wins.
    const conflict = db
      .prepare('SELECT id FROM users WHERE agent_id = ? AND id != ?')
      .get(body.agentId, id);
    if (conflict) {
      return reply.code(409).send({ error: `agentId already linked to another user` });
    }

    db.prepare('UPDATE users SET agent_id = ? WHERE id = ?').run(body.agentId, id);
    const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow;
    return rowToUser(updated);
  },
);

app.get<{ Params: { handle: string } }>('/users/by-handle/:handle', async (request, reply) => {
  const row = db.prepare('SELECT * FROM users WHERE handle = ?').get(request.params.handle) as
    | UserRow
    | undefined;
  if (!row) return reply.code(404).send({ error: 'user not found' });
  return rowToUser(row);
});

app.get<{ Params: { address: string } }>(
  '/users/by-address/:address',
  async (request, reply) => {
    const row = db
      .prepare('SELECT * FROM users WHERE LOWER(wallet_address) = LOWER(?)')
      .get(request.params.address) as UserRow | undefined;
    if (!row) return reply.code(404).send({ error: 'user not found' });
    return rowToUser(row);
  }
);

app.get('/arc/health', async () => {
  const [chainId, blockNumber] = await Promise.all([
    arcClient.getChainId(),
    arcClient.getBlockNumber(),
  ]);
  return {
    rpc: 'connected',
    chainId,
    blockNumber: blockNumber.toString(),
  };
});

app.get<{ Querystring: { address?: string } }>('/arc/usdc-balance', async (request, reply) => {
  const queryAddress = request.query.address?.trim();
  const target = (queryAddress && queryAddress.length > 0 ? queryAddress : CIRCLE_OPERATOR_ADDRESS) as `0x${string}`;
  if (!/^0x[0-9a-fA-F]{40}$/.test(target)) {
    return reply.code(400).send({ error: `invalid address: ${target}` });
  }

  const [rawBalance, decimals, symbol] = await Promise.all([
    arcClient.readContract({
      address: USDC_ADDRESS,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [target],
    }),
    arcClient.readContract({
      address: USDC_ADDRESS,
      abi: erc20Abi,
      functionName: 'decimals',
    }),
    arcClient.readContract({
      address: USDC_ADDRESS,
      abi: erc20Abi,
      functionName: 'symbol',
    }),
  ]);

  return {
    address: target,
    token: USDC_ADDRESS,
    symbol,
    decimals,
    raw: rawBalance.toString(),
    formatted: formatUnits(rawBalance, decimals),
  };
});

// Wrapper diagnostics. The wrapper has no standing evaluator fee (evaluators
// are paid out of dispute bonds, not the job budget), so there's no
// evaluatorFeeBP — only the single platform fee, its cap, the treasury, and the
// escrowed treasury balance.
app.get('/arc/escrow/info', async () => {
  const [pactCount, paymentToken, platformFeeBps, maxPlatformFeeBps, platformTreasury, treasuryBalance] =
    await Promise.all([
      arcClient.readContract({ address: WRAPPER_ADDRESS, abi: pactWrapperAbi, functionName: 'nextPactId' }),
      arcClient.readContract({ address: WRAPPER_ADDRESS, abi: pactWrapperAbi, functionName: 'usdc' }),
      arcClient.readContract({ address: WRAPPER_ADDRESS, abi: pactWrapperAbi, functionName: 'platformFeeBps' }),
      arcClient.readContract({ address: WRAPPER_ADDRESS, abi: pactWrapperAbi, functionName: 'MAX_PLATFORM_FEE_BPS' }),
      arcClient.readContract({ address: WRAPPER_ADDRESS, abi: pactWrapperAbi, functionName: 'platformTreasury' }),
      arcClient.readContract({ address: WRAPPER_ADDRESS, abi: pactWrapperAbi, functionName: 'treasuryBalance' }),
    ]);

  return {
    address: WRAPPER_ADDRESS,
    pactCount: pactCount.toString(),
    paymentToken,
    platformFeeBps: platformFeeBps.toString(),
    maxPlatformFeeBps: maxPlatformFeeBps.toString(),
    platformTreasury,
    treasuryBalance: treasuryBalance.toString(),
  };
});

app.post<{
  Body: {
    userId?: string;
    handle?: string;
    provider: string;
    expiredInSeconds: number;
    description: string;
    challengeWindowSeconds?: number;
  };
}>('/arc/escrow/pacts', async (request, reply) => {
  const { provider, expiredInSeconds, description, challengeWindowSeconds } = request.body;
  const signer = requireSigner(reply, request.body);
  if (!signer) return;
  if (typeof expiredInSeconds !== 'number' || expiredInSeconds < 1800) {
    return reply.code(400).send({ error: 'expiredInSeconds must be a number >= 1800 (wrapper Rule 3 floor is 30 minutes)' });
  }
  const expiredAt = Math.floor(Date.now() / 1000) + expiredInSeconds;

  // Wrapper is the protocol-level evaluator (no evaluator arg); hook is unused
  // at this layer; challengeWindow 0 = contract default (24h).
  const create = await circle.createContractExecutionTransaction({
    walletId: signer.circle_wallet_id,
    contractAddress: WRAPPER_ADDRESS,
    abiFunctionSignature: 'createPact(address,uint64,string,address,uint64)',
    abiParameters: [provider, expiredAt.toString(), description, ZERO_ADDRESS, String(challengeWindowSeconds ?? 0)],
    fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
  });

  const tx = await waitForCircleTx(create.data!.id);
  if (!tx.txHash) return reply.code(500).send({ error: 'Circle tx confirmed without txHash' });

  const receipt = await arcClient.getTransactionReceipt({ hash: tx.txHash as `0x${string}` });
  const [createdLog] = parseEventLogs({
    abi: pactWrapperAbi,
    eventName: 'PactCreated',
    logs: receipt.logs,
  });
  if (!createdLog) return reply.code(500).send({ error: 'PactCreated event missing from receipt' });

  return {
    pactId: createdLog.args.pactId.toString(),
    txId: tx.id,
    txHash: tx.txHash,
    state: tx.state,
  };
});

app.post<{ Params: { id: string }; Body: { userId?: string; handle?: string; budgetUsdc: string; challengeWindowSeconds?: number } }>(
  '/arc/escrow/pacts/:id/budget',
  async (request, reply) => {
    const { budgetUsdc, challengeWindowSeconds } = request.body;
    const signer = requireSigner(reply, request.body);
    if (!signer) return;
    const pactId = request.params.id;
    const amountRaw = parseUnits(budgetUsdc, 6);

    // challengeWindow 0 = keep current; provider's setBudget supersedes any
    // pending client proposeTerms.
    const exec = await circle.createContractExecutionTransaction({
      walletId: signer.circle_wallet_id,
      contractAddress: WRAPPER_ADDRESS,
      abiFunctionSignature: 'setBudget(uint256,uint256,uint64)',
      abiParameters: [pactId, amountRaw.toString(), String(challengeWindowSeconds ?? 0)],
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    });

    const tx = await waitForCircleTx(exec.data!.id);

    return {
      pactId,
      budget: { raw: amountRaw.toString(), usdc: budgetUsdc },
      txId: tx.id,
      txHash: tx.txHash,
      state: tx.state,
    };
  }
);

app.post<{ Body: { userId?: string; handle?: string; amountUsdc: string } }>('/arc/usdc/approve', async (request, reply) => {
  const { amountUsdc } = request.body;
  const signer = requireSigner(reply, request.body);
  if (!signer) return;
  const amountRaw = parseUnits(amountUsdc, 6);

  const exec = await circle.createContractExecutionTransaction({
    walletId: signer.circle_wallet_id,
    contractAddress: USDC_ADDRESS,
    abiFunctionSignature: 'approve(address,uint256)',
    abiParameters: [WRAPPER_ADDRESS, amountRaw.toString()],
    fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
  });

  const tx = await waitForCircleTx(exec.data!.id);

  return {
    spender: WRAPPER_ADDRESS,
    amount: { raw: amountRaw.toString(), usdc: amountUsdc },
    txId: tx.id,
    txHash: tx.txHash,
    state: tx.state,
  };
});

app.post<{ Params: { id: string }; Body: { userId?: string; handle?: string; expectedBudgetUsdc: string; expectedChallengeWindowSeconds: number } }>(
  '/arc/escrow/pacts/:id/fund',
  async (request, reply) => {
    const signer = requireSigner(reply, request.body);
    if (!signer) return;
    const pactId = request.params.id;
    const { expectedBudgetUsdc, expectedChallengeWindowSeconds } = request.body;
    if (!expectedBudgetUsdc || Number(expectedBudgetUsdc) <= 0) {
      return reply.code(400).send({ error: 'expectedBudgetUsdc must be a positive number string' });
    }
    if (typeof expectedChallengeWindowSeconds !== 'number' || expectedChallengeWindowSeconds <= 0) {
      return reply.code(400).send({ error: 'expectedChallengeWindowSeconds must be a positive number (the pact\'s current challenge window)' });
    }
    const expectedBudget = parseUnits(expectedBudgetUsdc, 6);

    // Atomic acceptance — funding signs off on exactly the current live quote;
    // the wrapper reverts WrongTerms if budget or window drifted.
    const exec = await circle.createContractExecutionTransaction({
      walletId: signer.circle_wallet_id,
      contractAddress: WRAPPER_ADDRESS,
      abiFunctionSignature: 'fund(uint256,uint256,uint64)',
      abiParameters: [pactId, expectedBudget.toString(), String(expectedChallengeWindowSeconds)],
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    });

    const tx = await waitForCircleTx(exec.data!.id);

    return {
      pactId,
      txId: tx.id,
      txHash: tx.txHash,
      state: tx.state,
    };
  }
);

app.post<{ Params: { id: string }; Body: { userId?: string; handle?: string; deliverableHash: string } }>(
  '/arc/escrow/pacts/:id/submit',
  async (request, reply) => {
    const signer = requireSigner(reply, request.body);
    if (!signer) return;
    const pactId = request.params.id;
    let deliverable: `0x${string}`;
    try {
      deliverable = toBytes32(request.body?.deliverableHash, 'deliverableHash');
      if (deliverable === ZERO_BYTES32) {
        return reply.code(400).send({ error: 'deliverableHash is required' });
      }
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }

    const exec = await circle.createContractExecutionTransaction({
      walletId: signer.circle_wallet_id,
      contractAddress: WRAPPER_ADDRESS,
      abiFunctionSignature: 'submit(uint256,bytes32)',
      abiParameters: [pactId, deliverable],
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    });

    const tx = await waitForCircleTx(exec.data!.id);

    return {
      pactId,
      deliverableHash: deliverable,
      txId: tx.id,
      txHash: tx.txHash,
      state: tx.state,
    };
  }
);

// complete now maps to clientAccept — the client's instant-payout button
// during the challenge window. (The permissionless post-challenge complete()
// path has no signed route; it's exposed via /finalize/unsigned.)
app.post<{ Params: { id: string }; Body: { userId?: string; handle?: string } }>(
  '/arc/escrow/pacts/:id/complete',
  async (request, reply) => {
    const signer = requireSigner(reply, request.body);
    if (!signer) return;
    const pactId = request.params.id;

    const exec = await circle.createContractExecutionTransaction({
      walletId: signer.circle_wallet_id,
      contractAddress: WRAPPER_ADDRESS,
      abiFunctionSignature: 'clientAccept(uint256)',
      abiParameters: [pactId],
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    });

    const tx = await waitForCircleTx(exec.data!.id);

    return {
      pactId,
      txId: tx.id,
      txHash: tx.txHash,
      state: tx.state,
    };
  }
);

app.post<{ Params: { id: string }; Body: { userId?: string; handle?: string; reasonHash?: string } }>(
  '/arc/escrow/pacts/:id/reject',
  async (request, reply) => {
    const signer = requireSigner(reply, request.body);
    if (!signer) return;
    const pactId = request.params.id;
    let reason: `0x${string}`;
    try {
      reason = toBytes32(request.body?.reasonHash, 'reasonHash');
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }

    const exec = await circle.createContractExecutionTransaction({
      walletId: signer.circle_wallet_id,
      contractAddress: WRAPPER_ADDRESS,
      abiFunctionSignature: 'reject(uint256,bytes32)',
      abiParameters: [pactId, reason],
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    });

    const tx = await waitForCircleTx(exec.data!.id);

    return {
      pactId,
      reasonHash: reason,
      txId: tx.id,
      txHash: tx.txHash,
      state: tx.state,
    };
  }
);

app.post<{ Params: { id: string }; Body: { userId?: string; handle?: string } }>(
  '/arc/escrow/pacts/:id/refund',
  async (request, reply) => {
    const signer = requireSigner(reply, request.body);
    if (!signer) return;
    const pactId = request.params.id;

    const exec = await circle.createContractExecutionTransaction({
      walletId: signer.circle_wallet_id,
      contractAddress: WRAPPER_ADDRESS,
      abiFunctionSignature: 'claimRefund(uint256)',
      abiParameters: [pactId],
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    });

    const tx = await waitForCircleTx(exec.data!.id);

    return {
      pactId,
      txId: tx.id,
      txHash: tx.txHash,
      state: tx.state,
    };
  }
);

// ────────────────────────────────────────────────────────────────────────────
// Unsigned tx-data routes — for external wallets (MetaMask via wagmi) that
// sign client-side. Each route returns { to, data, value, chainId } ready to
// pass into wagmi's useSendTransaction. The backend does NOT call Circle and
// does NOT look up any user — the signer is whatever wallet the frontend has
// connected.
// ────────────────────────────────────────────────────────────────────────────

// createPact — wrapper is the protocol-level evaluator, so no evaluator arg.
// challengeWindow (seconds) is optional; 0 lets the contract apply its default
// (CHALLENGE_DEFAULT = 24h). hook is unused at this layer → ZERO_ADDRESS.
app.post<{
  Body: {
    provider: string;
    expiredInSeconds: number;
    description: string;
    challengeWindowSeconds?: number;
  };
}>('/arc/escrow/pacts/unsigned', async (request, reply) => {
  const { provider, expiredInSeconds, description, challengeWindowSeconds } = request.body;
  if (!provider || !/^0x[0-9a-fA-F]{40}$/.test(provider)) {
    return reply.code(400).send({ error: 'provider must be a 0x-prefixed 20-byte hex address' });
  }
  if (typeof expiredInSeconds !== 'number' || expiredInSeconds < 1800) {
    return reply.code(400).send({ error: 'expiredInSeconds must be a number >= 1800 (wrapper Rule 3 floor is 30 minutes)' });
  }
  if (challengeWindowSeconds != null && (typeof challengeWindowSeconds !== 'number' || challengeWindowSeconds < 0)) {
    return reply.code(400).send({ error: 'challengeWindowSeconds must be a non-negative number (0 = contract default)' });
  }
  const expiredAt = BigInt(Math.floor(Date.now() / 1000) + expiredInSeconds);
  return buildUnsignedTx(WRAPPER_ADDRESS, pactWrapperAbi as Abi, 'createPact', [
    provider as `0x${string}`,
    expiredAt,
    description ?? '',
    ZERO_ADDRESS as `0x${string}`,
    BigInt(challengeWindowSeconds ?? 0),
  ]);
});

// setBudget — provider's quote. challengeWindow (seconds) optional; 0 keeps the
// current window. The provider's setBudget supersedes any client proposeTerms.
app.post<{ Params: { id: string }; Body: { budgetUsdc: string; challengeWindowSeconds?: number } }>(
  '/arc/escrow/pacts/:id/budget/unsigned',
  async (request, reply) => {
    const pactId = BigInt(request.params.id);
    const { budgetUsdc, challengeWindowSeconds } = request.body;
    if (!budgetUsdc || Number(budgetUsdc) <= 0) {
      return reply.code(400).send({ error: 'budgetUsdc must be a positive number string' });
    }
    if (challengeWindowSeconds != null && (typeof challengeWindowSeconds !== 'number' || challengeWindowSeconds < 0)) {
      return reply.code(400).send({ error: 'challengeWindowSeconds must be a non-negative number (0 = keep current)' });
    }
    const amountRaw = parseUnits(budgetUsdc, 6);
    return buildUnsignedTx(WRAPPER_ADDRESS, pactWrapperAbi as Abi, 'setBudget', [
      pactId,
      amountRaw,
      BigInt(challengeWindowSeconds ?? 0),
    ]);
  },
);

app.post<{ Body: { amountUsdc: string } }>('/arc/usdc/approve/unsigned', async (request, reply) => {
  const { amountUsdc } = request.body;
  if (!amountUsdc || Number(amountUsdc) <= 0) {
    return reply.code(400).send({ error: 'amountUsdc must be a positive number string' });
  }
  const amountRaw = parseUnits(amountUsdc, 6);
  // Spender is the wrapper — it pulls (budget + fee) on fund(), bonds on
  // dispute()/defend(), and stake on stakeEvaluator().
  return buildUnsignedTx(USDC_ADDRESS, erc20Abi as Abi, 'approve', [WRAPPER_ADDRESS, amountRaw]);
});

// fund — atomic acceptance. The client signs off on exactly the current live
// quote; the wrapper reverts WrongTerms if either field drifted. The frontend
// must read the pact's current budget + challengeWindow and pass them here.
app.post<{ Params: { id: string }; Body: { expectedBudgetUsdc: string; expectedChallengeWindowSeconds: number } }>(
  '/arc/escrow/pacts/:id/fund/unsigned',
  async (request, reply) => {
    const pactId = BigInt(request.params.id);
    const { expectedBudgetUsdc, expectedChallengeWindowSeconds } = request.body;
    if (!expectedBudgetUsdc || Number(expectedBudgetUsdc) <= 0) {
      return reply.code(400).send({ error: 'expectedBudgetUsdc must be a positive number string' });
    }
    if (typeof expectedChallengeWindowSeconds !== 'number' || expectedChallengeWindowSeconds <= 0) {
      return reply.code(400).send({ error: 'expectedChallengeWindowSeconds must be a positive number (the pact\'s current challenge window)' });
    }
    const expectedBudget = parseUnits(expectedBudgetUsdc, 6);
    return buildUnsignedTx(WRAPPER_ADDRESS, pactWrapperAbi as Abi, 'fund', [
      pactId,
      expectedBudget,
      BigInt(expectedChallengeWindowSeconds),
    ]);
  },
);

app.post<{ Params: { id: string }; Body: { deliverableHash: string } }>(
  '/arc/escrow/pacts/:id/submit/unsigned',
  async (request, reply) => {
    const pactId = BigInt(request.params.id);
    let deliverable: `0x${string}`;
    try {
      deliverable = toBytes32(request.body.deliverableHash, 'deliverableHash');
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
    if (deliverable === ZERO_BYTES32) {
      return reply.code(400).send({ error: 'deliverableHash is required' });
    }
    return buildUnsignedTx(WRAPPER_ADDRESS, pactWrapperAbi as Abi, 'submit', [pactId, deliverable]);
  },
);

// complete/unsigned now maps to clientAccept — the client's instant-payout
// button during the challenge window. (The wrapper's complete() is the separate
// permissionless post-challenge auto-finalize path; see /finalize/unsigned.)
app.post<{ Params: { id: string } }>(
  '/arc/escrow/pacts/:id/complete/unsigned',
  async (request) => {
    const pactId = BigInt(request.params.id);
    return buildUnsignedTx(WRAPPER_ADDRESS, pactWrapperAbi as Abi, 'clientAccept', [pactId]);
  },
);

app.post<{ Params: { id: string }; Body: { reasonHash?: string } }>(
  '/arc/escrow/pacts/:id/reject/unsigned',
  async (request, reply) => {
    const pactId = BigInt(request.params.id);
    let reason: `0x${string}`;
    try {
      reason = toBytes32(request.body.reasonHash, 'reasonHash');
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
    return buildUnsignedTx(WRAPPER_ADDRESS, pactWrapperAbi as Abi, 'reject', [pactId, reason]);
  },
);

app.post<{ Params: { id: string } }>('/arc/escrow/pacts/:id/refund/unsigned', async (request) => {
  const pactId = BigInt(request.params.id);
  return buildUnsignedTx(WRAPPER_ADDRESS, pactWrapperAbi as Abi, 'claimRefund', [pactId]);
});

// cancel — client withdraws an Open (unfunded) pact. Distinct from reject(),
// which is the Funded/Submitted refund path. Lands the pact in Status.Expired.
app.post<{ Params: { id: string } }>('/arc/escrow/pacts/:id/cancel/unsigned', async (request) => {
  const pactId = BigInt(request.params.id);
  return buildUnsignedTx(WRAPPER_ADDRESS, pactWrapperAbi as Abi, 'cancel', [pactId]);
});

// ────────────────────────────────────────────────────────────────────────────
// Wrapper-only unsigned routes (no ERC-8183 reference equivalent): client-side
// negotiation, deadline extension, post-challenge finalize, the full dispute
// system, and evaluator staking. All return { to, data, value, chainId } for a
// client-side signer. Bond/stake-pulling routes (dispute, defend, stake) assume
// the caller has already approved the wrapper via /arc/usdc/approve/unsigned.
// ────────────────────────────────────────────────────────────────────────────

// proposeTerms — client's quote-and-accept counter. challengeWindow is required
// here (unlike setBudget, proposeTerms has no 0-default) and must sit within the
// contract's CHALLENGE_FLOOR..CHALLENGE_CEILING band.
app.post<{ Params: { id: string }; Body: { budgetUsdc: string; challengeWindowSeconds: number } }>(
  '/arc/escrow/pacts/:id/terms/unsigned',
  async (request, reply) => {
    const pactId = BigInt(request.params.id);
    const { budgetUsdc, challengeWindowSeconds } = request.body;
    if (!budgetUsdc || Number(budgetUsdc) <= 0) {
      return reply.code(400).send({ error: 'budgetUsdc must be a positive number string' });
    }
    if (typeof challengeWindowSeconds !== 'number' || challengeWindowSeconds <= 0) {
      return reply.code(400).send({ error: 'challengeWindowSeconds must be a positive number' });
    }
    const amountRaw = parseUnits(budgetUsdc, 6);
    return buildUnsignedTx(WRAPPER_ADDRESS, pactWrapperAbi as Abi, 'proposeTerms', [
      pactId,
      amountRaw,
      BigInt(challengeWindowSeconds),
    ]);
  },
);

// extendDeadline — Rule 1. newExpiredAt is an absolute unix timestamp. In
// Submitted state the contract only accepts exactly current+1h (max 3 times);
// in Open/Funded/Disputed any strictly-forward value is allowed. The frontend
// computes the target and the contract enforces the bounds.
app.post<{ Params: { id: string }; Body: { newExpiredAt: number } }>(
  '/arc/escrow/pacts/:id/extend/unsigned',
  async (request, reply) => {
    const pactId = BigInt(request.params.id);
    const { newExpiredAt } = request.body;
    if (typeof newExpiredAt !== 'number' || newExpiredAt <= Math.floor(Date.now() / 1000)) {
      return reply.code(400).send({ error: 'newExpiredAt must be a unix timestamp (seconds) in the future' });
    }
    return buildUnsignedTx(WRAPPER_ADDRESS, pactWrapperAbi as Abi, 'extendDeadline', [pactId, BigInt(newExpiredAt)]);
  },
);

// finalize — permissionless post-challenge auto-completion. Pays the provider
// once the challenge window has closed with no dispute. (Client early-accept is
// the separate /complete/unsigned → clientAccept path.)
app.post<{ Params: { id: string }; Body: { reasonHash?: string } }>(
  '/arc/escrow/pacts/:id/finalize/unsigned',
  async (request, reply) => {
    const pactId = BigInt(request.params.id);
    let reason: `0x${string}`;
    try {
      reason = toBytes32(request.body?.reasonHash, 'reasonHash');
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
    return buildUnsignedTx(WRAPPER_ADDRESS, pactWrapperAbi as Abi, 'complete', [pactId, reason]);
  },
);

// ── Dispute system ──────────────────────────────────────────────────────────

// dispute — client or provider opens a dispute during the challenge window.
// Pulls a 5% bond (approve the wrapper first).
app.post<{ Params: { id: string }; Body: { reasonHash?: string } }>(
  '/arc/escrow/pacts/:id/dispute/unsigned',
  async (request, reply) => {
    const pactId = BigInt(request.params.id);
    let reason: `0x${string}`;
    try {
      reason = toBytes32(request.body?.reasonHash, 'reasonHash');
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
    return buildUnsignedTx(WRAPPER_ADDRESS, pactWrapperAbi as Abi, 'dispute', [pactId, reason]);
  },
);

// concede — the opponent gives up within the concede window (opponent wins).
app.post<{ Params: { id: string } }>('/arc/escrow/pacts/:id/concede/unsigned', async (request) => {
  const pactId = BigInt(request.params.id);
  return buildUnsignedTx(WRAPPER_ADDRESS, pactWrapperAbi as Abi, 'concede', [pactId]);
});

// forceConcede — permissionless; anyone can settle a dispute the opponent
// ignored once the concede deadline has passed (treated as a concede).
app.post<{ Params: { id: string } }>('/arc/escrow/pacts/:id/force-concede/unsigned', async (request) => {
  const pactId = BigInt(request.params.id);
  return buildUnsignedTx(WRAPPER_ADDRESS, pactWrapperAbi as Abi, 'forceConcede', [pactId]);
});

// defend — opponent posts a matching bond, triggering evaluator selection and
// the commit-reveal vote (approve the wrapper first).
app.post<{ Params: { id: string } }>('/arc/escrow/pacts/:id/defend/unsigned', async (request) => {
  const pactId = BigInt(request.params.id);
  return buildUnsignedTx(WRAPPER_ADDRESS, pactWrapperAbi as Abi, 'defend', [pactId]);
});

// commitVote — selected evaluator commits keccak256(abi.encode(vote, secret,
// evaluator)). The frontend computes the hash; the secret stays client-side
// until reveal.
app.post<{ Params: { id: string }; Body: { commitHash: string } }>(
  '/arc/escrow/pacts/:id/commit/unsigned',
  async (request, reply) => {
    const pactId = BigInt(request.params.id);
    let commitHash: `0x${string}`;
    try {
      commitHash = toBytes32(request.body?.commitHash, 'commitHash');
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
    if (commitHash === ZERO_BYTES32) {
      return reply.code(400).send({ error: 'commitHash is required' });
    }
    return buildUnsignedTx(WRAPPER_ADDRESS, pactWrapperAbi as Abi, 'commitVote', [pactId, commitHash]);
  },
);

// revealVote — permissionless (anyone with the secret, incl. the auto-reveal
// agent). vote: 1 = ForDisputer, 2 = ForOpponent (0/None is rejected).
app.post<{ Params: { id: string }; Body: { evaluator: string; vote: number; secret: string } }>(
  '/arc/escrow/pacts/:id/reveal/unsigned',
  async (request, reply) => {
    const pactId = BigInt(request.params.id);
    const { evaluator, vote } = request.body;
    if (!evaluator || !/^0x[0-9a-fA-F]{40}$/.test(evaluator)) {
      return reply.code(400).send({ error: 'evaluator must be a 0x-prefixed 20-byte hex address' });
    }
    if (vote !== 1 && vote !== 2) {
      return reply.code(400).send({ error: 'vote must be 1 (ForDisputer) or 2 (ForOpponent)' });
    }
    let secret: `0x${string}`;
    try {
      secret = toBytes32(request.body?.secret, 'secret');
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
    return buildUnsignedTx(WRAPPER_ADDRESS, pactWrapperAbi as Abi, 'revealVote', [
      pactId,
      evaluator as `0x${string}`,
      vote,
      secret,
    ]);
  },
);

// resolve — permissionless tally once the reveal window closes (or all N have
// revealed). Settles the pact in the winning side's favour.
app.post<{ Params: { id: string } }>('/arc/escrow/pacts/:id/resolve/unsigned', async (request) => {
  const pactId = BigInt(request.params.id);
  return buildUnsignedTx(WRAPPER_ADDRESS, pactWrapperAbi as Abi, 'resolve', [pactId]);
});

// ── Evaluator pool ──────────────────────────────────────────────────────────

// stakeEvaluator — join the evaluator pool (approve the wrapper for `amount`
// first). Must be >= EVALUATOR_MIN_STAKE.
app.post<{ Body: { amountUsdc: string } }>('/arc/escrow/evaluators/stake/unsigned', async (request, reply) => {
  const { amountUsdc } = request.body;
  if (!amountUsdc || Number(amountUsdc) <= 0) {
    return reply.code(400).send({ error: 'amountUsdc must be a positive number string' });
  }
  const amountRaw = parseUnits(amountUsdc, 6);
  return buildUnsignedTx(WRAPPER_ADDRESS, pactWrapperAbi as Abi, 'stakeEvaluator', [amountRaw]);
});

// unstakeEvaluator — withdraw the full stake (reverts if the evaluator still
// has pending dispute references).
app.post('/arc/escrow/evaluators/unstake/unsigned', async () =>
  buildUnsignedTx(WRAPPER_ADDRESS, pactWrapperAbi as Abi, 'unstakeEvaluator', []),
);

// Lookup pacts by participant address. Indexed locally by polling JobCreated
// events from the reference contract; live state (status, budget) still comes
// from the chain via /arc/escrow/pact/:id. Returned rows include the role the
// address plays in each pact so the frontend doesn't need to recompute it.
type PactsByAddressEntry = {
  pactId: string;
  client: string;
  provider: string;
  evaluator: string;
  expiredAt: number;
  hook: string;
  blockNumber: number;
  txHash: string;
  indexedAt: string;
  roles: Array<'client' | 'provider' | 'evaluator'>;
};

app.get<{ Params: { address: string } }>(
  '/pacts/by-address/:address',
  async (request, reply) => {
    const address = request.params.address.toLowerCase();
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      return reply.code(400).send({ error: 'address must be a 0x-prefixed 20-byte hex address' });
    }
    const rows = db
      .prepare(
        `SELECT * FROM pacts_index
         WHERE client = ? OR provider = ? OR evaluator = ?
         ORDER BY block_number DESC`,
      )
      .all(address, address, address) as PactIndexRow[];

    const pacts: PactsByAddressEntry[] = rows.map((row) => {
      const base = rowToPactIndex(row);
      const roles: PactsByAddressEntry['roles'] = [];
      if (base.client === address) roles.push('client');
      if (base.provider === address) roles.push('provider');
      if (base.evaluator === address) roles.push('evaluator');
      return { ...base, roles };
    });

    return { address, pacts, count: pacts.length };
  },
);

// Notifications feed for a given address — bundles, per pact, the immutable
// index row + live on-chain state + this pact's events. Saves the frontend
// from doing N×2 round-trips to render the bell. Paginated by recency.
const FEED_PAGE_DEFAULT = 30;
const FEED_PAGE_MAX = 100;

type FeedRow = {
  pactId: string;
  roles: Array<'client' | 'provider' | 'evaluator'>;
  index: {
    client: string;
    provider: string;
    evaluator: string;
    expiredAt: number;
    blockNumber: number;
    txHash: string;
    indexedAt: string;
  };
  live: {
    status: string;
    budget: { raw: string; usdc: string };
    expiredAt: { unix: number; iso: string };
    challengeWindow: number;
    description: string;
  } | null;
  events: ReturnType<typeof rowToPactEvent>[];
};

app.get<{
  Params: { address: string };
  Querystring: { limit?: string; offset?: string };
}>('/pacts/by-address/:address/feed', async (request, reply) => {
  const address = request.params.address.toLowerCase();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return reply.code(400).send({ error: 'address must be a 0x-prefixed 20-byte hex address' });
  }
  const limit = clampInt(request.query.limit, FEED_PAGE_DEFAULT, 1, FEED_PAGE_MAX);
  const offset = clampInt(request.query.offset, 0, 0, 100_000);

  // Newest pacts first — matches the bell's "what changed recently" framing.
  const indexRows = db
    .prepare(
      `SELECT * FROM pacts_index
       WHERE client = ? OR provider = ? OR evaluator = ?
       ORDER BY block_number DESC`,
    )
    .all(address, address, address) as PactIndexRow[];

  const total = indexRows.length;
  const pageRows = indexRows.slice(offset, offset + limit);

  // Live read + events fetched per pact in parallel. Tolerates per-call
  // failures — a single dead RPC shouldn't take the whole bell down.
  const live = await Promise.allSettled(pageRows.map((row) => readWrapperPact(BigInt(row.pact_id))));

  const eventsByPact = new Map<string, ReturnType<typeof rowToPactEvent>[]>();
  if (pageRows.length > 0) {
    const placeholders = pageRows.map(() => '?').join(',');
    const eventRows = db
      .prepare(
        `SELECT * FROM pact_events
         WHERE pact_id IN (${placeholders})
         ORDER BY block_number ASC, log_index ASC`,
      )
      .all(...pageRows.map((r) => r.pact_id)) as PactEventRow[];
    for (const r of eventRows) {
      const list = eventsByPact.get(r.pact_id) ?? [];
      list.push(rowToPactEvent(r));
      eventsByPact.set(r.pact_id, list);
    }
  }

  const feed: FeedRow[] = pageRows.map((row, i) => {
    const base = rowToPactIndex(row);
    const roles: FeedRow['roles'] = [];
    if (base.client === address) roles.push('client');
    if (base.provider === address) roles.push('provider');
    if (base.evaluator === address) roles.push('evaluator');

    const result = live[i];
    const liveData =
      result.status === 'fulfilled'
        ? {
            status: PACT_STATUS[result.value.status] ?? `Unknown(${result.value.status})`,
            budget: {
              raw: result.value.budget.toString(),
              usdc: formatUnits(result.value.budget, 6),
            },
            expiredAt: {
              unix: Number(result.value.expiredAt),
              iso: new Date(Number(result.value.expiredAt) * 1000).toISOString(),
            },
            challengeWindow: Number(result.value.challengeWindow),
            description: base.description,
          }
        : null;

    return {
      pactId: base.pactId,
      roles,
      index: {
        client: base.client,
        provider: base.provider,
        evaluator: base.evaluator,
        expiredAt: base.expiredAt,
        blockNumber: base.blockNumber,
        txHash: base.txHash,
        indexedAt: base.indexedAt,
      },
      live: liveData,
      events: eventsByPact.get(base.pactId) ?? [],
    };
  });

  return { address, feed, total, limit, offset };
});

// CCTP V2 inbound bridge history for an address. Backed by bridge_inbound_events
// which the bridge-indexer populates from USDC mints on Arc joined to
// MessageTransmitter MessageReceived (so we only return mints actually caused
// by a CCTP bridge). Replaces the localStorage cap-of-3 — surviving browser
// clears and visible across devices for the same wallet.
type BridgeHistoryRow = {
  recipient: string;
  amount: { raw: string; usdc: string };
  sourceDomain: number | null;
  nonce: string | null;
  blockNumber: number;
  txHash: string;
  logIndex: number;
  indexedAt: string;
};

const BRIDGE_HISTORY_DEFAULT = 20;
const BRIDGE_HISTORY_MAX = 100;

app.get<{
  Params: { address: string };
  Querystring: { limit?: string };
}>('/bridge/history/:address', async (request, reply) => {
  const address = request.params.address.toLowerCase();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return reply
      .code(400)
      .send({ error: 'address must be a 0x-prefixed 20-byte hex address' });
  }
  const limit = clampInt(
    request.query.limit,
    BRIDGE_HISTORY_DEFAULT,
    1,
    BRIDGE_HISTORY_MAX,
  );

  const rows = db
    .prepare(
      `SELECT recipient, amount_raw, source_domain, nonce, block_number, tx_hash, log_index, indexed_at
       FROM bridge_inbound_events
       WHERE recipient = ?
       ORDER BY block_number DESC, log_index DESC
       LIMIT ?`,
    )
    .all(address, limit) as Array<{
    recipient: string;
    amount_raw: string;
    source_domain: number | null;
    nonce: string | null;
    block_number: number;
    tx_hash: string;
    log_index: number;
    indexed_at: string;
  }>;

  const history: BridgeHistoryRow[] = rows.map((r) => ({
    recipient: r.recipient,
    amount: {
      raw: r.amount_raw,
      usdc: formatUnits(BigInt(r.amount_raw), 6),
    },
    sourceDomain: r.source_domain,
    nonce: r.nonce,
    blockNumber: r.block_number,
    txHash: r.tx_hash,
    logIndex: r.log_index,
    indexedAt: r.indexed_at,
  }));

  return { address, history, count: history.length };
});

// Open-pacts marketplace. Lists every Open ERC-8183 pact our indexer has
// seen (this is the public reference contract, so it's the whole network
// pre-wrapper, not just arc-trade-created pacts). Filters in-memory after a
// fan-out live read since status + budget aren't indexed on-chain.
const MARKET_INDEX_CAP = 500;
const MARKET_PAGE_DEFAULT = 20;
const MARKET_PAGE_MAX = 50;

type OpenPactEntry = {
  pactId: string;
  client: string;
  provider: string;
  evaluator: string;
  description: string;
  budget: { raw: string; usdc: string };
  expiredAt: { unix: number; iso: string };
  challengeWindow: number;
  status: string;
  hook: string;
  createdAt: { blockNumber: number; txHash: string; indexedAt: string };
};

app.get<{
  Querystring: { limit?: string; offset?: string; minBudget?: string; maxBudget?: string };
}>('/pacts/open', async (request, reply) => {
  const limit = clampInt(request.query.limit, MARKET_PAGE_DEFAULT, 1, MARKET_PAGE_MAX);
  const offset = clampInt(request.query.offset, 0, 0, 100_000);

  let minBudgetRaw: bigint | null = null;
  let maxBudgetRaw: bigint | null = null;
  try {
    if (request.query.minBudget) minBudgetRaw = parseUnits(request.query.minBudget, 6);
    if (request.query.maxBudget) maxBudgetRaw = parseUnits(request.query.maxBudget, 6);
  } catch {
    return reply.code(400).send({ error: 'minBudget/maxBudget must be numeric USDC strings' });
  }

  // Pull the most-recent N from the index. Older pacts (most likely terminal
  // by now) are dropped — keeps the live-read fan-out bounded.
  const indexRows = db
    .prepare(
      `SELECT * FROM pacts_index
       ORDER BY block_number DESC
       LIMIT ?`,
    )
    .all(MARKET_INDEX_CAP) as PactIndexRow[];

  // Live-read budget + status for every candidate in parallel. ERC-8183
  // doesn't emit a BudgetSet event, so we can't index this — see M30 note.
  const liveStates = await Promise.allSettled(indexRows.map((row) => readWrapperPact(BigInt(row.pact_id))));

  const nowUnix = Math.floor(Date.now() / 1000);
  const open: OpenPactEntry[] = [];

  for (let i = 0; i < indexRows.length; i++) {
    const row = indexRows[i];
    const result = liveStates[i];
    if (result.status !== 'fulfilled') continue;
    const pact = result.value;
    const status = PACT_STATUS[pact.status] ?? `Unknown(${pact.status})`;
    if (status !== 'Open') continue;
    if (Number(pact.expiredAt) <= nowUnix) continue;
    if (minBudgetRaw !== null && pact.budget < minBudgetRaw) continue;
    if (maxBudgetRaw !== null && pact.budget > maxBudgetRaw) continue;
    // evaluator/hook/description aren't in the wrapper's pacts() struct — they
    // come from the local index (PactCreated). evaluator is always the wrapper.
    open.push({
      pactId: row.pact_id,
      client: pact.client,
      provider: pact.provider,
      evaluator: row.evaluator,
      description: row.description,
      budget: { raw: pact.budget.toString(), usdc: formatUnits(pact.budget, 6) },
      expiredAt: {
        unix: Number(pact.expiredAt),
        iso: new Date(Number(pact.expiredAt) * 1000).toISOString(),
      },
      challengeWindow: Number(pact.challengeWindow),
      status,
      hook: row.hook,
      createdAt: {
        blockNumber: row.block_number,
        txHash: row.tx_hash,
        indexedAt: row.indexed_at,
      },
    });
  }

  const total = open.length;
  const pacts = open.slice(offset, offset + limit);
  return { pacts, total, limit, offset, indexScanned: indexRows.length };
});

function clampInt(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

app.get<{ Params: { id: string } }>('/arc/escrow/pact/:id', async (request, reply) => {
  const pactId = BigInt(request.params.id);

  const pact = await readWrapperPact(pactId);

  if (pact.client === ZERO_ADDRESS) {
    return reply.code(404).send({ error: `Pact ${request.params.id} not found` });
  }

  // Bolt on creation metadata from the local index so the frontend can render a
  // lifecycle timeline without a second roundtrip. evaluator/hook/description
  // aren't in the wrapper's pacts() struct — they live in the index (from
  // PactCreated). null if the indexer hasn't caught up (~10s after creation).
  const createdRow = db
    .prepare('SELECT evaluator, hook, description, block_number, tx_hash, indexed_at FROM pacts_index WHERE pact_id = ?')
    .get(request.params.id) as
    | { evaluator: string; hook: string; description: string; block_number: number; tx_hash: string; indexed_at: string }
    | undefined;

  // For terminal states (Completed / Rejected) include the actor address from
  // pact_events so the frontend can disambiguate who ended the pact.
  const status = PACT_STATUS[pact.status] ?? `Unknown(${pact.status})`;
  let terminationActor: string | null = null;
  if (status === 'Rejected' || status === 'Completed') {
    const eventType = status; // 'Rejected' or 'Completed'
    const row = db
      .prepare(
        `SELECT actor FROM pact_events
         WHERE pact_id = ? AND event_type = ?
         ORDER BY block_number DESC, log_index DESC
         LIMIT 1`,
      )
      .get(request.params.id, eventType) as { actor: string } | undefined;
    if (row) terminationActor = row.actor;
  }

  return {
    id: request.params.id,
    client: pact.client,
    provider: pact.provider,
    evaluator: createdRow?.evaluator ?? WRAPPER_ADDRESS.toLowerCase(),
    description: createdRow?.description ?? '',
    budget: {
      raw: pact.budget.toString(),
      usdc: formatUnits(pact.budget, 6),
    },
    expiredAt: {
      unix: Number(pact.expiredAt),
      iso: new Date(Number(pact.expiredAt) * 1000).toISOString(),
    },
    // Atomic-acceptance + dispute fields the frontend needs: challengeWindow is
    // required to fund(), submittedAt drives the challenge-window countdown, and
    // disputeId (0 = none) gates the dispute panel.
    challengeWindow: Number(pact.challengeWindow),
    submittedAt: Number(pact.submittedAt),
    disputeId: pact.disputeId.toString(),
    status,
    hook: createdRow?.hook ?? '',
    terminationActor,
    createdAt: createdRow
      ? {
          blockNumber: createdRow.block_number,
          txHash: createdRow.tx_hash,
          indexedAt: createdRow.indexed_at,
        }
      : null,
  };
});

// Live dispute state for a pact. Reads the pact's disputeId, then getDisputeMeta.
// Returns { dispute: null } when no dispute is or was open. Rich fields the
// dispute panel needs (deadlines, selected evaluators, vote tallies) — kept as a
// live read rather than indexed.
app.get<{ Params: { id: string } }>('/arc/escrow/pact/:id/dispute', async (request) => {
  const pact = await readWrapperPact(BigInt(request.params.id));
  if (pact.disputeId === 0n) return { dispute: null };

  const d = await readDisputeMeta(pact.disputeId);
  return {
    dispute: {
      disputeId: pact.disputeId.toString(),
      pactId: d.pactId.toString(),
      disputer: d.disputer,
      opponent: d.opponent,
      bondDisputer: d.bondDisputer.toString(),
      bondOpponent: d.bondOpponent.toString(),
      reasonHash: d.reasonHash,
      status: DISPUTE_STATUS[d.status] ?? `Unknown(${d.status})`,
      openedAt: Number(d.openedAt),
      concedeDeadline: Number(d.concedeDeadline),
      commitDeadline: Number(d.commitDeadline),
      graceDeadline: Number(d.graceDeadline),
      revealDeadline: Number(d.revealDeadline),
      // Zero-address slots mean "not yet selected" (dispute still in Open phase).
      evaluators: d.evaluators.filter((e) => e !== ZERO_ADDRESS),
      commitCount: d.commitCount,
      revealCount: d.revealCount,
      votesForDisputer: d.votesForDisputer,
      votesForOpponent: d.votesForOpponent,
    },
  };
});

// Opt in to auto-reveal: hand the agent (vote, secret) at commit time and it
// reveals on your behalf once the reveal window opens. Validated against live
// dispute state; one row per (dispute, evaluator) — a re-commit replaces it.
const upsertAutoReveal = db.prepare(
  `INSERT OR REPLACE INTO auto_reveals
   (dispute_id, evaluator, pact_id, vote, secret, reveal_after, reveal_before, status, attempts, last_error, tx_hash)
   VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL)`,
);

app.post<{
  Params: { id: string };
  Body: { disputeId: string; evaluator: string; vote: number; secret: string };
}>('/arc/escrow/pacts/:id/auto-reveal', async (request, reply) => {
  const pactId = request.params.id;
  const { disputeId, evaluator, vote } = request.body;

  if (!evaluator || !/^0x[0-9a-fA-F]{40}$/.test(evaluator)) {
    return reply.code(400).send({ error: 'evaluator must be a 0x-prefixed 20-byte hex address' });
  }
  if (vote !== 1 && vote !== 2) {
    return reply.code(400).send({ error: 'vote must be 1 (ForDisputer) or 2 (ForOpponent)' });
  }
  let secret: `0x${string}`;
  try {
    secret = toBytes32(request.body?.secret, 'secret');
  } catch (e) {
    return reply.code(400).send({ error: (e as Error).message });
  }
  if (secret === ZERO_BYTES32) {
    return reply.code(400).send({ error: 'secret is required' });
  }

  // Validate against live state: the dispute must be in its voting phase and the
  // caller must actually be one of the selected evaluators.
  const pact = await readWrapperPact(BigInt(pactId));
  if (pact.disputeId === 0n || pact.disputeId.toString() !== disputeId) {
    return reply.code(400).send({ error: 'disputeId does not match the pact\'s open dispute' });
  }
  const d = await readDisputeMeta(pact.disputeId);
  if (d.status !== 1) {
    return reply.code(400).send({ error: 'dispute is not in the voting (Defended) phase' });
  }
  const ev = evaluator.toLowerCase();
  if (!d.evaluators.some((e) => e.toLowerCase() === ev)) {
    return reply.code(403).send({ error: 'address is not a selected evaluator on this dispute' });
  }
  if (Math.floor(Date.now() / 1000) >= Number(d.revealDeadline)) {
    return reply.code(400).send({ error: 'reveal window has already closed' });
  }

  upsertAutoReveal.run(
    disputeId,
    ev,
    pactId,
    vote,
    secret,
    Number(d.graceDeadline),
    Number(d.revealDeadline),
  );
  return { scheduled: true, revealAfter: Number(d.graceDeadline), revealBefore: Number(d.revealDeadline) };
});

// Evaluator pool state for an address + global pool params. Powers the stake
// onboarding page and the "are you a selected evaluator" check.
app.get<{ Params: { address: string } }>('/arc/escrow/evaluators/:address', async (request, reply) => {
  const address = request.params.address;
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return reply.code(400).send({ error: 'address must be a 0x-prefixed 20-byte hex address' });
  }
  const [me, activeCount, minStake, bondBps, perDispute] = await Promise.all([
    arcClient.readContract({ address: WRAPPER_ADDRESS, abi: pactWrapperAbi, functionName: 'evaluators', args: [address as `0x${string}`] }) as Promise<readonly unknown[]>,
    arcClient.readContract({ address: WRAPPER_ADDRESS, abi: pactWrapperAbi, functionName: 'getActiveEvaluatorCount' }),
    arcClient.readContract({ address: WRAPPER_ADDRESS, abi: pactWrapperAbi, functionName: 'EVALUATOR_MIN_STAKE' }),
    arcClient.readContract({ address: WRAPPER_ADDRESS, abi: pactWrapperAbi, functionName: 'BOND_BPS' }),
    arcClient.readContract({ address: WRAPPER_ADDRESS, abi: pactWrapperAbi, functionName: 'EVALUATORS_PER_DISPUTE' }),
  ]);

  // evaluators(address) → [stake, stakedAt, totalVotes, majorityVotes, pendingDisputeRefs, active]
  const stake = me[0] as bigint;
  return {
    address: address.toLowerCase(),
    stake: { raw: stake.toString(), usdc: formatUnits(stake, 6) },
    stakedAt: Number(me[1] as bigint),
    totalVotes: Number(me[2]),
    majorityVotes: Number(me[3]),
    pendingDisputeRefs: Number(me[4]),
    active: me[5] as boolean,
    pool: {
      activeCount: (activeCount as bigint).toString(),
      minStake: { raw: (minStake as bigint).toString(), usdc: formatUnits(minStake as bigint, 6) },
      bondBps: Number(bondBps),
      evaluatorsPerDispute: Number(perDispute),
    },
  };
});

// ─── ERC-8004 reputation reads ─────────────────────────────────────────────
// Live view-calls to the ReputationRegistry. No indexing yet — view reads
// are cheap on a per-agent basis. Two routes:
//   - /summary: just getClients + getSummary. Used by the inline badge so
//     multi-party pact-detail views don't shred bandwidth.
//   - full path: adds readAllFeedback for the reputation page; truncated
//     to FEEDBACK_PAGE_DEFAULT (or ?limit=) most-recent entries, since
//     readAllFeedback returns the entire history in one shot and some
//     agents have thousands of entries.

const FEEDBACK_PAGE_DEFAULT = 20;
const FEEDBACK_PAGE_MAX = 500;

async function readReputationSummary(agentIdStr: string) {
  const agentIdBig = BigInt(agentIdStr);
  const clients = await arcClient.readContract({
    address: ERC8004_REPUTATION_ADDRESS,
    abi: reputationRegistryAbi,
    functionName: 'getClients',
    args: [agentIdBig],
  });
  if (clients.length === 0) {
    return {
      agentId: agentIdStr,
      summary: { count: 0, value: '0', valueDecimals: 0 },
      clientsConsulted: [] as readonly `0x${string}`[],
    };
  }
  const [count, summaryValue, summaryValueDecimals] = await arcClient.readContract({
    address: ERC8004_REPUTATION_ADDRESS,
    abi: reputationRegistryAbi,
    functionName: 'getSummary',
    args: [agentIdBig, clients, '', ''],
  });
  return {
    agentId: agentIdStr,
    summary: {
      count: Number(count),
      value: summaryValue.toString(),
      valueDecimals: Number(summaryValueDecimals),
    },
    clientsConsulted: clients,
  };
}

app.get<{ Params: { agentId: string } }>(
  '/arc/reputation/agent/:agentId/summary',
  async (request, reply) => {
    if (!/^\d+$/.test(request.params.agentId)) {
      return reply.code(400).send({ error: 'agentId must be a numeric string (uint256)' });
    }
    try {
      return await readReputationSummary(request.params.agentId);
    } catch (err) {
      return reply.code(502).send({
        error: 'failed to read reputation summary from ReputationRegistry',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  },
);

app.get<{
  Params: { agentId: string };
  Querystring: { limit?: string; offset?: string };
}>(
  '/arc/reputation/agent/:agentId',
  async (request, reply) => {
    if (!/^\d+$/.test(request.params.agentId)) {
      return reply.code(400).send({ error: 'agentId must be a numeric string (uint256)' });
    }
    let limit = FEEDBACK_PAGE_DEFAULT;
    if (request.query.limit !== undefined) {
      if (!/^\d+$/.test(request.query.limit)) {
        return reply.code(400).send({ error: 'limit must be a non-negative integer' });
      }
      limit = Math.min(Number(request.query.limit), FEEDBACK_PAGE_MAX);
    }
    let offset = 0;
    if (request.query.offset !== undefined) {
      if (!/^\d+$/.test(request.query.offset)) {
        return reply.code(400).send({ error: 'offset must be a non-negative integer' });
      }
      offset = Number(request.query.offset);
    }
    const agentIdBig = BigInt(request.params.agentId);

    let summaryResult: Awaited<ReturnType<typeof readReputationSummary>>;
    try {
      summaryResult = await readReputationSummary(request.params.agentId);
    } catch (err) {
      return reply.code(502).send({
        error: 'failed to read reputation from ReputationRegistry',
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    if (summaryResult.clientsConsulted.length === 0 || limit === 0) {
      return {
        ...summaryResult,
        feedback: [],
        totalFeedback: summaryResult.summary.count,
        limit,
        offset,
        truncated: summaryResult.summary.count > 0,
      };
    }

    let feedback: readonly [
      readonly `0x${string}`[],
      readonly bigint[],
      readonly bigint[],
      readonly number[],
      readonly string[],
      readonly string[],
      readonly boolean[],
    ];
    try {
      feedback = await arcClient.readContract({
        address: ERC8004_REPUTATION_ADDRESS,
        abi: reputationRegistryAbi,
        functionName: 'readAllFeedback',
        args: [agentIdBig, summaryResult.clientsConsulted, '', '', true],
      });
    } catch (err) {
      return reply.code(502).send({
        error: 'failed to read feedback from ReputationRegistry',
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    const [
      feedbackClients,
      feedbackIndexes,
      values,
      valueDecimals,
      tag1s,
      tag2s,
      revokedStatuses,
    ] = feedback;
    const total = feedbackClients.length;
    // Newest-first pagination: page 0 covers indexes total-limit..total-1,
    // page N skips that many entries before sampling backward. The spec
    // doesn't formally pin ordering, but the reference impl appends, so
    // trailing entries are the most recent in practice.
    const endExclusive = Math.max(0, total - offset);
    const startInclusive = Math.max(0, endExclusive - limit);
    const slicedFeedback = [] as Array<{
      clientAddress: string;
      feedbackIndex: string;
      value: string;
      valueDecimals: number;
      tag1: string;
      tag2: string;
      isRevoked: boolean;
    }>;
    for (let i = endExclusive - 1; i >= startInclusive; i -= 1) {
      slicedFeedback.push({
        clientAddress: feedbackClients[i],
        feedbackIndex: feedbackIndexes[i].toString(),
        value: values[i].toString(),
        valueDecimals: Number(valueDecimals[i]),
        tag1: tag1s[i],
        tag2: tag2s[i],
        isRevoked: revokedStatuses[i],
      });
    }

    return {
      ...summaryResult,
      feedback: slicedFeedback,
      totalFeedback: total,
      limit,
      offset,
      // `truncated` is now "are there entries we didn't return on this
      // page" — true whenever total exceeds what fits before+within the
      // current page. Frontend uses it to decide whether to show pager.
      truncated: total > slicedFeedback.length,
    };
  },
);

// ─── ERC-8004 agent self-registration (M32) ────────────────────────────────
// Two routes. register-unsigned returns the calldata to mint a fresh
// agentId; the frontend signs it with whichever wallet is connected.
// parse-registration takes the resulting tx hash, fetches the receipt
// server-side, and extracts the new agentId from the ERC-721 Transfer
// event (from = 0x0). The frontend then links via the existing PATCH
// route, whose on-chain ownership check passes trivially because the
// caller just minted the token.

app.post('/arc/identity/register-unsigned', async (_request, reply) => {
  let identityRegistry: `0x${string}`;
  try {
    identityRegistry = await resolveIdentityRegistry();
  } catch (err) {
    return reply.code(502).send({
      error: 'could not resolve IdentityRegistry from ReputationRegistry',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
  const data = encodeFunctionData({
    abi: identityRegistryAbi,
    functionName: 'register',
    args: [],
  });
  return {
    to: identityRegistry,
    data,
    value: '0x0',
    chainId: ARC_TESTNET_CHAIN_ID,
    identityRegistry,
  };
});

app.post<{ Body: { txHash?: string } }>(
  '/arc/identity/parse-registration',
  async (request, reply) => {
    const txHash = request.body?.txHash;
    if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      return reply.code(400).send({ error: 'txHash must be a 0x-prefixed 32-byte hex string' });
    }
    let identityRegistry: `0x${string}`;
    try {
      identityRegistry = await resolveIdentityRegistry();
    } catch (err) {
      return reply.code(502).send({
        error: 'could not resolve IdentityRegistry from ReputationRegistry',
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    let receipt: Awaited<ReturnType<typeof arcClient.getTransactionReceipt>>;
    try {
      receipt = await arcClient.getTransactionReceipt({ hash: txHash as `0x${string}` });
    } catch (err) {
      return reply.code(404).send({
        error: 'transaction receipt not found (still pending?)',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    if (receipt.status !== 'success') {
      return reply.code(400).send({ error: 'transaction reverted; no agentId minted' });
    }

    // Find the mint Transfer (from = 0x0) emitted by the IdentityRegistry.
    // A single register() call should emit exactly one such event; if
    // multiple appear the first is returned.
    const parsed = parseEventLogs({
      abi: [erc721TransferEvent],
      logs: receipt.logs,
      eventName: 'Transfer',
    });
    const mint = parsed.find(
      (entry) =>
        entry.address.toLowerCase() === identityRegistry.toLowerCase() &&
        entry.args.from === '0x0000000000000000000000000000000000000000',
    );
    if (!mint || !mint.args.tokenId || !mint.args.to) {
      return reply.code(404).send({
        error: 'no IdentityRegistry mint event found in this transaction',
      });
    }
    return {
      agentId: mint.args.tokenId.toString(),
      to: mint.args.to,
      identityRegistry,
      txHash,
      blockNumber: Number(receipt.blockNumber),
    };
  },
);

// Lifecycle events for a pact (Submitted/Completed/Rejected). Surfaces the
// on-chain bytes32 deliverable + reason hashes for any viewer; indexed via
// pact-indexer. Empty array is valid (e.g. Open or Funded pacts).
app.get<{ Params: { id: string } }>('/arc/escrow/pact/:id/events', async (request, reply) => {
  if (!/^\d+$/.test(request.params.id)) {
    return reply.code(400).send({ error: 'id must be a numeric pact id' });
  }
  const rows = db
    .prepare(
      `SELECT * FROM pact_events WHERE pact_id = ?
       ORDER BY block_number ASC, log_index ASC`,
    )
    .all(request.params.id) as PactEventRow[];
  return { pactId: request.params.id, events: rows.map(rowToPactEvent) };
});

// ─── Deliverable content (Layers 2 + 3) ────────────────────────────────────
// Off-chain content (text, URL, or file) attached to a Submitted event.
// Stored keyed by (pactId, hash). Upload is gated by hash verification — the
// supplied content must keccak256 to the claimed hash, which means only
// whoever already knew the preimage (i.e. the provider) can store content
// for that slot. Read is gated by wallet-signature auth, parties-only.
// Files travel base64-in-JSON; raw bytes are written to disk and served
// from a separate binary route. Both read routes share the same auth helper.

const DELIVERABLE_TEXT_MAX_BYTES = 200_000;
const DELIVERABLE_URL_MAX_BYTES = 2_048;
const DELIVERABLE_FILE_MAX_BYTES = Number(
  process.env.DELIVERABLE_FILE_MAX_BYTES ?? 10 * 1024 * 1024,
);
const READ_CHALLENGE_WINDOW_SECONDS = 24 * 60 * 60;

const DELIVERABLE_FILES_DIR = resolve(process.cwd(), 'data', 'deliverables');
mkdirSync(DELIVERABLE_FILES_DIR, { recursive: true });

function isHexBytes32(s: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(s);
}

// Verify x-arc-viewer / x-arc-sig / x-arc-ts and check the viewer is a
// party on this pact. Returns the lowercased viewer address on success,
// or null after sending an error response. Shared between the JSON
// metadata route and the binary file route.
async function verifyDeliverableReadAuth(
  request: import('fastify').FastifyRequest,
  reply: FastifyReply,
  pactId: string,
): Promise<string | null> {
  const viewer = request.headers['x-arc-viewer'];
  const sig = request.headers['x-arc-sig'];
  const tsStr = request.headers['x-arc-ts'];
  if (typeof viewer !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(viewer)) {
    reply.code(401).send({ error: 'x-arc-viewer header (address) is required' });
    return null;
  }
  if (typeof sig !== 'string' || !/^0x[0-9a-fA-F]+$/.test(sig)) {
    reply.code(401).send({ error: 'x-arc-sig header (hex signature) is required' });
    return null;
  }
  if (typeof tsStr !== 'string' || !/^\d+$/.test(tsStr)) {
    reply.code(401).send({ error: 'x-arc-ts header (unix seconds) is required' });
    return null;
  }
  const ts = Number(tsStr);
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > READ_CHALLENGE_WINDOW_SECONDS) {
    reply.code(401).send({ error: 'challenge timestamp expired or too far in the future' });
    return null;
  }

  const message = `arc-trade:read-deliverable:${pactId}:${ts}`;
  let valid = false;
  try {
    valid = await arcClient.verifyMessage({
      address: viewer as `0x${string}`,
      message,
      signature: sig as `0x${string}`,
    });
  } catch {
    valid = false;
  }
  if (!valid) {
    reply.code(401).send({ error: 'invalid signature for viewer' });
    return null;
  }

  const pactRow = db
    .prepare('SELECT client, provider, evaluator FROM pacts_index WHERE pact_id = ?')
    .get(pactId) as { client: string; provider: string; evaluator: string } | undefined;
  if (!pactRow) {
    reply.code(404).send({ error: 'pact not indexed yet — try again in a few seconds' });
    return null;
  }
  const v = viewer.toLowerCase();
  if (v !== pactRow.client && v !== pactRow.provider && v !== pactRow.evaluator) {
    reply.code(403).send({ error: 'not a party to this pact' });
    return null;
  }
  return v;
}

// Per-route bodyLimit so we can accept up to ~14 MB of base64 (a 10 MB file).
// Other routes keep Fastify's default limit. Server also enforces the actual
// post-decode size against DELIVERABLE_FILE_MAX_BYTES.
const UPLOAD_BODY_LIMIT_BYTES = 16 * 1024 * 1024;

app.post<{
  Params: { id: string };
  Body: {
    contentType?: string;
    content?: string;
    expectedHash?: string;
    uploadedBy?: string;
    fileBase64?: string;
    fileName?: string;
    mime?: string;
  };
}>(
  '/arc/escrow/pact/:id/deliverable-content',
  { bodyLimit: UPLOAD_BODY_LIMIT_BYTES },
  async (request, reply) => {
  const pactId = request.params.id;
  if (!/^\d+$/.test(pactId)) {
    return reply.code(400).send({ error: 'id must be a numeric pact id' });
  }
  const { contentType, content, expectedHash, uploadedBy, fileBase64, fileName, mime } =
    request.body ?? {};

  if (contentType !== 'text' && contentType !== 'url' && contentType !== 'file') {
    return reply.code(400).send({ error: "contentType must be 'text', 'url', or 'file'" });
  }
  if (typeof expectedHash !== 'string' || !isHexBytes32(expectedHash)) {
    return reply.code(400).send({ error: 'expectedHash must be a 0x-prefixed 32-byte hex string' });
  }
  if (typeof uploadedBy !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(uploadedBy)) {
    return reply.code(400).send({ error: 'uploadedBy must be a 0x-prefixed 20-byte hex address' });
  }

  // Idempotency check up-front so we don't write a file we'll then reject.
  const existing = db
    .prepare('SELECT hash FROM deliverables WHERE pact_id = ? AND hash = ?')
    .get(pactId, expectedHash.toLowerCase()) as { hash: string } | undefined;
  if (existing) {
    return reply.code(409).send({ error: 'deliverable already uploaded for this hash' });
  }

  if (contentType === 'text' || contentType === 'url') {
    if (typeof content !== 'string' || content.length === 0) {
      return reply.code(400).send({ error: 'content is required' });
    }
    const limit = contentType === 'text' ? DELIVERABLE_TEXT_MAX_BYTES : DELIVERABLE_URL_MAX_BYTES;
    if (Buffer.byteLength(content, 'utf8') > limit) {
      return reply.code(413).send({ error: `content exceeds ${limit} byte limit for ${contentType}` });
    }
    if (contentType === 'url') {
      try {
        const u = new URL(content);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          return reply.code(400).send({ error: 'url must use http or https' });
        }
      } catch {
        return reply.code(400).send({ error: 'content is not a valid URL' });
      }
    }
    const computed = keccak256(stringToBytes(content));
    if (computed.toLowerCase() !== expectedHash.toLowerCase()) {
      return reply.code(400).send({ error: 'content does not hash to expectedHash', computed });
    }
    db.prepare(
      `INSERT INTO deliverables (pact_id, hash, content_type, text_content, uploaded_by)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(pactId, computed.toLowerCase(), contentType, content, uploadedBy.toLowerCase());
    return reply.code(201).send({ pactId, hash: computed.toLowerCase(), contentType });
  }

  // contentType === 'file'
  if (typeof fileBase64 !== 'string' || fileBase64.length === 0) {
    return reply.code(400).send({ error: 'fileBase64 is required for file uploads' });
  }
  if (typeof fileName !== 'string' || fileName.length === 0 || fileName.length > 255) {
    return reply.code(400).send({ error: 'fileName is required (1..255 chars)' });
  }
  if (fileName.includes('/') || fileName.includes('\\') || fileName.includes('\0')) {
    return reply.code(400).send({ error: 'fileName must not contain path separators or nulls' });
  }
  const safeMime =
    typeof mime === 'string' && mime.length > 0 && mime.length < 256 ? mime : 'application/octet-stream';

  let bytes: Buffer;
  try {
    bytes = Buffer.from(fileBase64, 'base64');
  } catch {
    return reply.code(400).send({ error: 'fileBase64 is not valid base64' });
  }
  if (bytes.length === 0) {
    return reply.code(400).send({ error: 'decoded file is empty' });
  }
  if (bytes.length > DELIVERABLE_FILE_MAX_BYTES) {
    return reply.code(413).send({
      error: `file exceeds ${DELIVERABLE_FILE_MAX_BYTES} byte limit`,
      sizeBytes: bytes.length,
    });
  }
  const computed = keccak256(bytes);
  if (computed.toLowerCase() !== expectedHash.toLowerCase()) {
    return reply.code(400).send({ error: 'file does not hash to expectedHash', computed });
  }

  const hashLower = computed.toLowerCase();
  const pactDir = join(DELIVERABLE_FILES_DIR, pactId);
  mkdirSync(pactDir, { recursive: true });
  const relativePath = join(pactId, `${hashLower}.bin`);
  const absolutePath = join(DELIVERABLE_FILES_DIR, relativePath);
  writeFileSync(absolutePath, bytes);

  db.prepare(
    `INSERT INTO deliverables (pact_id, hash, content_type, text_content, mime, size_bytes, file_path, uploaded_by)
     VALUES (?, ?, 'file', ?, ?, ?, ?, ?)`,
  ).run(pactId, hashLower, fileName, safeMime, bytes.length, relativePath, uploadedBy.toLowerCase());

  return reply.code(201).send({
    pactId,
    hash: hashLower,
    contentType: 'file',
    fileName,
    mime: safeMime,
    sizeBytes: bytes.length,
  });
});

// Read deliverable metadata. Parties-only. The binary bytes for file-type
// deliverables come from /deliverable/file instead.
app.get<{
  Params: { id: string };
  Querystring: { hash?: string };
}>('/arc/escrow/pact/:id/deliverable', async (request, reply) => {
  const pactId = request.params.id;
  if (!/^\d+$/.test(pactId)) {
    return reply.code(400).send({ error: 'id must be a numeric pact id' });
  }
  const hash = request.query.hash;
  if (typeof hash !== 'string' || !isHexBytes32(hash)) {
    return reply.code(400).send({ error: 'hash query param must be a 0x-prefixed 32-byte hex string' });
  }
  const ok = await verifyDeliverableReadAuth(request, reply, pactId);
  if (!ok) return;

  const row = db
    .prepare('SELECT * FROM deliverables WHERE pact_id = ? AND hash = ?')
    .get(pactId, hash.toLowerCase()) as DeliverableRow | undefined;
  if (!row) {
    return reply.code(404).send({ error: 'no deliverable content stored for this hash' });
  }
  return rowToDeliverable(row);
});

// Download the binary bytes of a file-type deliverable. Same auth as the
// metadata route. Streams from disk; sets Content-Type from the stored
// MIME and Content-Disposition so the browser saves with the original name.
app.get<{
  Params: { id: string };
  Querystring: { hash?: string };
}>('/arc/escrow/pact/:id/deliverable/file', async (request, reply) => {
  const pactId = request.params.id;
  if (!/^\d+$/.test(pactId)) {
    return reply.code(400).send({ error: 'id must be a numeric pact id' });
  }
  const hash = request.query.hash;
  if (typeof hash !== 'string' || !isHexBytes32(hash)) {
    return reply.code(400).send({ error: 'hash query param must be a 0x-prefixed 32-byte hex string' });
  }
  const ok = await verifyDeliverableReadAuth(request, reply, pactId);
  if (!ok) return;

  const row = db
    .prepare('SELECT * FROM deliverables WHERE pact_id = ? AND hash = ?')
    .get(pactId, hash.toLowerCase()) as DeliverableRow | undefined;
  if (!row || row.content_type !== 'file' || !row.file_path) {
    return reply.code(404).send({ error: 'no file deliverable stored for this hash' });
  }
  const absolutePath = join(DELIVERABLE_FILES_DIR, row.file_path);
  let size: number;
  try {
    size = statSync(absolutePath).size;
  } catch {
    return reply.code(500).send({ error: 'stored file missing from disk' });
  }
  // RFC 6266 filename* avoids fish-eats-quote-style breakage on non-ASCII.
  const encodedName = encodeURIComponent(row.text_content);
  reply
    .header('Content-Type', row.mime ?? 'application/octet-stream')
    .header('Content-Length', String(size))
    .header('Content-Disposition', `attachment; filename*=UTF-8''${encodedName}`);
  return reply.send(createReadStream(absolutePath));
});


// --------------------------------------------------------------------------
// Standalone trade-finance escrow (TradeEscrow) — no ERC-8183 dependency.
// Lifecycle: create -> fund (approve+lock, passport-priced) -> attest (the
// Trade Officer agent / operator wallet) -> release (yield split + passport
// write); optional requestFinancing advances the seller at attestation.
// --------------------------------------------------------------------------

function escrowReady(reply: FastifyReply): boolean {
  if (TRADE_ESCROW_ADDRESS === ZERO_ADDRESS) {
    reply.code(503).send({ error: 'escrow not deployed — set TRADE_ESCROW_ADDRESS in backend/.env after forge deploy' });
    return false;
  }
  return true;
}

async function runExec(walletId: string, spec: ExecSpec) {
  const exec = await circle.createContractExecutionTransaction({
    walletId,
    contractAddress: spec.contractAddress,
    abiFunctionSignature: spec.abiFunctionSignature,
    abiParameters: spec.abiParameters,
    fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
  });
  return waitForCircleTx(exec.data!.id);
}

app.get<{ Params: { id: string } }>('/arc/trade/:id', async (request, reply) => {
  if (!escrowReady(reply)) return;
  const id = BigInt(request.params.id);
  const t = await getTrade(id);
  // What the buyer would lock if they funded now (passport-priced), shown pre-fund.
  let estDeposit = t.deposit;
  if (t.status === 'Proposing' || t.status === 'Agreed') {
    estDeposit = (await arcClient.readContract({
      address: TRADE_ESCROW_ADDRESS, abi: tradeEscrowAbi, functionName: 'estimatedDeposit', args: [id],
    })) as bigint;
  }
  return {
    buyer: t.buyer,
    seller: t.seller,
    attester: t.attester,
    lastProposer: t.lastProposer,
    amountUsdc: formatUnits(t.amount, 6),
    depositUsdc: formatUnits(t.deposit, 6),
    estimatedDepositUsdc: formatUnits(estDeposit, 6),
    financedRepayUsdc: formatUnits(t.financedRepay, 6),
    milestoneHash: t.milestoneHash,
    deadline: t.deadline,
    financingAdvanced: t.financingAdvanced,
    status: t.status,
  };
});

app.post<{
  Body: { userId?: string; handle?: string; seller: string; amountUsdc: string; milestone?: string; deadlineSeconds?: number; attester?: string };
}>('/arc/trade/create', async (request, reply) => {
  if (!escrowReady(reply)) return;
  const signer = requireSigner(reply, request.body);
  if (!signer) return;
  const { seller, amountUsdc, milestone, deadlineSeconds, attester } = request.body;

  if (!/^0x[0-9a-fA-F]{40}$/.test(seller ?? '')) {
    return reply.code(400).send({ error: 'seller must be a 0x address' });
  }
  if (!amountUsdc || Number(amountUsdc) <= 0) {
    return reply.code(400).send({ error: 'amountUsdc must be a positive number string' });
  }
  const amount = parseUnits(amountUsdc, 6);
  const milestoneHash = keccak256(stringToBytes(milestone ?? 'delivery'));
  const deadline = Math.floor(Date.now() / 1000) + (deadlineSeconds ?? 7 * 24 * 3600);
  const attesterAddr = (attester ?? CIRCLE_OPERATOR_ADDRESS) as `0x${string}`;

  const tx = await runExec(
    signer.circle_wallet_id,
    createTradeSpec(seller as `0x${string}`, amount, milestoneHash, deadline, attesterAddr),
  );
  if (!tx.txHash) return reply.code(500).send({ error: 'create tx confirmed without txHash' });

  const receipt = await arcClient.getTransactionReceipt({ hash: tx.txHash as `0x${string}` });
  const [proposed] = parseEventLogs({ abi: tradeEscrowAbi, eventName: 'TradeProposed', logs: receipt.logs });
  if (!proposed) return reply.code(500).send({ error: 'TradeProposed event missing from receipt' });

  return {
    tradeId: proposed.args.id.toString(),
    amountUsdc: formatUnits(proposed.args.amount, 6),
    attester: attesterAddr,
    txId: tx.id,
    txHash: tx.txHash,
    state: tx.state,
  };
});

// Buyer locks the passport-priced deposit: approve the escrow, then fund.
app.post<{ Params: { id: string }; Body: { userId?: string; handle?: string } }>(
  '/arc/trade/:id/fund',
  async (request, reply) => {
    if (!escrowReady(reply)) return;
    const signer = requireSigner(reply, request.body);
    if (!signer) return;
    const id = BigInt(request.params.id);

    const deposit = await depositOf(id);
    const approveTx = await runExec(signer.circle_wallet_id, approveEscrowSpec(deposit));
    const fundTx = await runExec(signer.circle_wallet_id, fundSpec(id));

    return {
      tradeId: request.params.id,
      depositUsdc: formatUnits(deposit, 6),
      approveTxHash: approveTx.txHash,
      fundTxHash: fundTx.txHash,
      state: fundTx.state,
    };
  },
);

// The trade's assigned attester (Trade Officer agent / operator) confirms delivery.
app.post<{ Params: { id: string }; Body: { userId?: string; handle?: string; proof?: string; passed?: boolean } }>(
  '/arc/trade/:id/attest',
  async (request, reply) => {
    if (!escrowReady(reply)) return;
    const signer = requireSigner(reply, request.body);
    if (!signer) return;
    const proofHash = keccak256(stringToBytes(request.body.proof ?? 'attested'));
    const passed = request.body.passed ?? true;

    const tx = await runExec(signer.circle_wallet_id, attestSpec(BigInt(request.params.id), proofHash, passed));
    return { tradeId: request.params.id, passed, txId: tx.id, txHash: tx.txHash, state: tx.state };
  },
);

// Negotiation: the counterparty accepts the standing offer.
app.post<{ Params: { id: string }; Body: { userId?: string; handle?: string } }>(
  '/arc/trade/:id/accept',
  async (request, reply) => {
    if (!escrowReady(reply)) return;
    const signer = requireSigner(reply, request.body);
    if (!signer) return;
    const tx = await runExec(signer.circle_wallet_id, acceptSpec(BigInt(request.params.id)));
    return { tradeId: request.params.id, txId: tx.id, txHash: tx.txHash, state: tx.state };
  },
);

// Negotiation: propose a new amount (not allowed when it's your offer on the table).
app.post<{ Params: { id: string }; Body: { userId?: string; handle?: string; amountUsdc: string } }>(
  '/arc/trade/:id/counter',
  async (request, reply) => {
    if (!escrowReady(reply)) return;
    const signer = requireSigner(reply, request.body);
    if (!signer) return;
    if (!request.body.amountUsdc || Number(request.body.amountUsdc) <= 0) {
      return reply.code(400).send({ error: 'amountUsdc must be a positive number string' });
    }
    const tx = await runExec(signer.circle_wallet_id, counterSpec(BigInt(request.params.id), parseUnits(request.body.amountUsdc, 6)));
    return { tradeId: request.params.id, txId: tx.id, txHash: tx.txHash, state: tx.state };
  },
);

// Either party walks away before funding.
app.post<{ Params: { id: string }; Body: { userId?: string; handle?: string } }>(
  '/arc/trade/:id/cancel',
  async (request, reply) => {
    if (!escrowReady(reply)) return;
    const signer = requireSigner(reply, request.body);
    if (!signer) return;
    const tx = await runExec(signer.circle_wallet_id, cancelSpec(BigInt(request.params.id)));
    return { tradeId: request.params.id, txId: tx.id, txHash: tx.txHash, state: tx.state };
  },
);

// Seller draws an advance while goods are in transit (Funded phase).
app.post<{ Params: { id: string }; Body: { userId?: string; handle?: string } }>(
  '/arc/trade/:id/finance',
  async (request, reply) => {
    if (!escrowReady(reply)) return;
    const signer = requireSigner(reply, request.body);
    if (!signer) return;
    const tx = await runExec(signer.circle_wallet_id, requestFinancingSpec(BigInt(request.params.id)));
    return { tradeId: request.params.id, txId: tx.id, txHash: tx.txHash, state: tx.state };
  },
);

// Seed the financing pool's USDC reserve from the operator (treasury) wallet.
app.post<{ Body: { amountUsdc: string } }>('/arc/trade/pool/fund', async (request, reply) => {
  if (!escrowReady(reply)) return;
  const { amountUsdc } = request.body;
  if (!amountUsdc || Number(amountUsdc) <= 0) {
    return reply.code(400).send({ error: 'amountUsdc must be a positive number string' });
  }
  const amount = parseUnits(amountUsdc, 6);
  const approveTx = await runExec(CIRCLE_OPERATOR_WALLET_ID, approveSpec(FINANCING_POOL_ADDRESS, amount));
  const fundTx = await runExec(CIRCLE_OPERATOR_WALLET_ID, poolFundSpec(amount));
  return { amountUsdc, approveTxHash: approveTx.txHash, fundTxHash: fundTx.txHash, state: fundTx.state };
});

// Trade Officer agent — skill 1: ingest a delivery document, run the documentary
// check, and either auto-attest from the operator (agent) wallet or escalate to a
// staked human verifier. No signer in the body: the agent acts autonomously as
// the trade's assigned attester (the operator wallet set at deploy).
app.post<{ Params: { id: string }; Body: { document: DeliveryDoc } }>(
  '/arc/trade/:id/officer-attest',
  async (request, reply) => {
    if (!escrowReady(reply)) return;
    const { document } = request.body;
    if (!document || typeof document.content !== 'string') {
      return reply.code(400).send({ error: 'document with a content string is required' });
    }

    const id = BigInt(request.params.id);
    const trade = await getTrade(id);
    if (trade.status !== 'Funded') {
      return reply.code(409).send({ error: `trade is '${trade.status}', expected 'Funded' to attest` });
    }

    const decision = evaluateDelivery(
      { amountUsdc: Number(formatUnits(trade.amount, 6)), seller: trade.seller },
      document,
    );

    if (decision.decision === 'escalate') {
      return {
        tradeId: request.params.id,
        decision: 'escalate',
        attested: false,
        confidence: decision.confidence,
        reasons: decision.reasons,
        note: 'withheld — routed to a staked human verifier (Arm 2)',
      };
    }

    // PASS — the agent signs the attestation from its own (operator) wallet.
    const tx = await runExec(CIRCLE_OPERATOR_WALLET_ID, attestSpec(id, decision.proofHash, true));
    return {
      tradeId: request.params.id,
      decision: 'pass',
      attested: true,
      confidence: decision.confidence,
      reasons: decision.reasons,
      proofHash: decision.proofHash,
      txId: tx.id,
      txHash: tx.txHash,
      state: tx.state,
    };
  },
);


// ---- Unsigned variants: the buyer/seller signs with their own wallet ----
// (Agent attestation stays a backend dev-controlled call; release is permissionless.)

app.post<{ Body: { seller: string; amountUsdc: string; milestone?: string; deadlineSeconds?: number; attester?: string } }>(
  '/arc/trade/create/unsigned',
  async (request, reply) => {
    if (!escrowReady(reply)) return;
    const { seller, amountUsdc, milestone, deadlineSeconds, attester } = request.body;
    if (!/^0x[0-9a-fA-F]{40}$/.test(seller ?? '')) return reply.code(400).send({ error: 'seller must be a 0x address' });
    if (!amountUsdc || Number(amountUsdc) <= 0) return reply.code(400).send({ error: 'amountUsdc must be a positive number string' });
    const amount = parseUnits(amountUsdc, 6);
    const milestoneHash = keccak256(stringToBytes(milestone ?? 'delivery'));
    const deadline = Math.floor(Date.now() / 1000) + (deadlineSeconds ?? 7 * 24 * 3600);
    const attesterAddr = (attester ?? CIRCLE_OPERATOR_ADDRESS) as `0x${string}`;
    return buildUnsignedTx(TRADE_ESCROW_ADDRESS, tradeEscrowAbi as Abi, 'createTrade', [seller, amount, milestoneHash, deadline, attesterAddr]);
  },
);

app.post<{ Body: { amountUsdc: string } }>('/arc/trade/approve/unsigned', async (request, reply) => {
  if (!escrowReady(reply)) return;
  if (!request.body.amountUsdc || Number(request.body.amountUsdc) <= 0) {
    return reply.code(400).send({ error: 'amountUsdc must be a positive number string' });
  }
  const amount = parseUnits(request.body.amountUsdc, 6);
  return buildUnsignedTx(USDC_ADDRESS, erc20Abi as Abi, 'approve', [TRADE_ESCROW_ADDRESS, amount]);
});

app.post<{ Params: { id: string } }>('/arc/trade/:id/fund/unsigned', async (request, reply) => {
  if (!escrowReady(reply)) return;
  return buildUnsignedTx(TRADE_ESCROW_ADDRESS, tradeEscrowAbi as Abi, 'fund', [BigInt(request.params.id)]);
});

app.post<{ Params: { id: string } }>('/arc/trade/:id/accept/unsigned', async (request, reply) => {
  if (!escrowReady(reply)) return;
  return buildUnsignedTx(TRADE_ESCROW_ADDRESS, tradeEscrowAbi as Abi, 'accept', [BigInt(request.params.id)]);
});

app.post<{ Params: { id: string }; Body: { amountUsdc: string } }>('/arc/trade/:id/counter/unsigned', async (request, reply) => {
  if (!escrowReady(reply)) return;
  if (!request.body.amountUsdc || Number(request.body.amountUsdc) <= 0) {
    return reply.code(400).send({ error: 'amountUsdc must be a positive number string' });
  }
  return buildUnsignedTx(TRADE_ESCROW_ADDRESS, tradeEscrowAbi as Abi, 'counter', [BigInt(request.params.id), parseUnits(request.body.amountUsdc, 6)]);
});

app.post<{ Params: { id: string } }>('/arc/trade/:id/cancel/unsigned', async (request, reply) => {
  if (!escrowReady(reply)) return;
  return buildUnsignedTx(TRADE_ESCROW_ADDRESS, tradeEscrowAbi as Abi, 'cancel', [BigInt(request.params.id)]);
});

app.post<{ Params: { id: string } }>('/arc/trade/:id/finance/unsigned', async (request, reply) => {
  if (!escrowReady(reply)) return;
  return buildUnsignedTx(TRADE_ESCROW_ADDRESS, tradeEscrowAbi as Abi, 'requestFinancing', [BigInt(request.params.id)]);
});

// List a user's trades (as buyer or seller) from the trade index, with live status.
app.get<{ Querystring: { address?: string } }>('/arc/trades', async (request, reply) => {
  if (!escrowReady(reply)) return;
  const address = (request.query.address ?? '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) return reply.code(400).send({ error: 'address query param (0x…) required' });

  const rows = db
    .prepare('SELECT trade_id FROM trade_index WHERE buyer = ? OR seller = ? ORDER BY trade_id DESC')
    .all(address, address) as { trade_id: number }[];

  const trades = await Promise.all(
    rows.map(async (r) => {
      const t = await getTrade(BigInt(r.trade_id));
      return {
        tradeId: String(r.trade_id),
        status: t.status,
        amountUsdc: formatUnits(t.amount, 6),
        depositUsdc: formatUnits(t.deposit, 6),
        role: t.buyer.toLowerCase() === address ? 'buyer' : 'seller',
        counterparty: t.buyer.toLowerCase() === address ? t.seller : t.buyer,
      };
    }),
  );
  return { trades };
});

// Notification feed across a user's trades: recent activity + pending actions
// (what they need to do next). Feeds the global bell.
app.get<{ Querystring: { address?: string } }>('/arc/trades/notifications', async (request, reply) => {
  if (!escrowReady(reply)) return;
  const address = (request.query.address ?? '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) return reply.code(400).send({ error: 'address query param (0x…) required' });

  const ids = (db.prepare('SELECT trade_id FROM trade_index WHERE buyer = ? OR seller = ?').all(address, address) as { trade_id: number }[]).map((r) => r.trade_id);

  const EVENT_LABEL: Record<string, string> = {
    TradeProposed: 'proposed', TradeCountered: 'counter-offer', TradeAgreed: 'agreed', TradeCancelled: 'cancelled',
    TradeFunded: 'funded', FinancingAdvanced: 'financing advanced', Attested: 'delivery attested',
    Released: 'settled — paid to seller', Disputed: 'disputed', Resolved: 'dispute resolved', Refunded: 'refunded',
  };

  const items: { tradeId: string; key: string; kind: 'action' | 'event'; summary: string; whenMs: number }[] = [];

  for (const id of ids) {
    const t = await getTrade(BigInt(id));
    const isBuyer = t.buyer.toLowerCase() === address;
    const isSeller = t.seller.toLowerCase() === address;
    const myOffer = t.lastProposer.toLowerCase() === address;

    // Pending action for me (sorts to top as "fresh").
    let action: string | null = null;
    if (t.status === 'Proposing' && (isBuyer || isSeller) && !myOffer) {
      const offerBy = t.lastProposer.toLowerCase() === t.buyer.toLowerCase() ? 'buyer' : 'seller';
      action = `Trade #${id} — respond to the ${offerBy}'s offer of ${formatUnits(t.amount, 6)} USDC`;
    } else if (t.status === 'Agreed' && isBuyer) {
      action = `Trade #${id} — fund the escrow`;
    } else if (t.status === 'Funded' && isSeller) {
      action = `Trade #${id} — submit your delivery document`;
    }
    if (action) items.push({ tradeId: String(id), key: `trade:${id}:action:${t.status}`, kind: 'action', summary: action, whenMs: Date.now() });

    // Recent activity (last 3 events on this trade).
    const evs = db
      .prepare('SELECT kind, tx_hash, indexed_at FROM trade_events WHERE trade_id = ? ORDER BY block_number DESC, log_index DESC LIMIT 3')
      .all(id) as { kind: string; tx_hash: string; indexed_at: string }[];
    for (const e of evs) {
      items.push({
        tradeId: String(id),
        key: `trade:${id}:event:${e.tx_hash}`,
        kind: 'event',
        summary: `Trade #${id} ${EVENT_LABEL[e.kind] ?? e.kind}`,
        whenMs: new Date(e.indexed_at + 'Z').getTime() || Date.now(),
      });
    }
  }

  items.sort((a, b) => b.whenMs - a.whenMs);
  return { items };
});

// Per-trade event timeline (what happened, by whom, with tx hashes).
app.get<{ Params: { id: string } }>('/arc/trades/:id/events', async (request, reply) => {
  if (!escrowReady(reply)) return;
  const id = Number(request.params.id);
  const rows = db
    .prepare(
      `SELECT kind, actor, amount_raw, block_number, tx_hash, indexed_at
       FROM trade_events WHERE trade_id = ? ORDER BY block_number ASC, log_index ASC`,
    )
    .all(id) as { kind: string; actor: string | null; amount_raw: string | null; block_number: number; tx_hash: string; indexed_at: string }[];
  return {
    events: rows.map((r) => ({
      kind: r.kind,
      actor: r.actor,
      amountUsdc: r.amount_raw ? formatUnits(BigInt(r.amount_raw), 6) : null,
      blockNumber: r.block_number,
      txHash: r.tx_hash,
      at: r.indexed_at,
    })),
  };
});

// Credit passport snapshot for the UI panel.
app.get<{ Params: { address: string } }>('/arc/passport/:address', async (request, reply) => {
  if (TRADE_PASSPORT_ADDRESS === ZERO_ADDRESS) {
    return reply.code(503).send({ error: 'passport not deployed — set TRADE_PASSPORT_ADDRESS' });
  }
  const address = request.params.address;
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return reply.code(400).send({ error: 'address must be 0x…' });
  return getPassport(address as `0x${string}`);
});


const port = Number(process.env.PORT ?? 3001);

app
  .listen({ port, host: '0.0.0.0' })
  .then(() => {
    startWrapperIndexer(app.log);
    startBridgeIndexer(app.log);
    startTradeIndexer(app.log);
    // Auto-reveal agent: reveals opted-in evaluators' votes via the operator
    // wallet once the reveal window opens. revealVote is permissionless, so the
    // operator can reveal on anyone's behalf given (vote, secret).
    startAutoRevealAgent({
      log: app.log,
      reveal: async (row: AutoRevealRow) => {
        const exec = await circle.createContractExecutionTransaction({
          walletId: CIRCLE_OPERATOR_WALLET_ID,
          contractAddress: WRAPPER_ADDRESS,
          abiFunctionSignature: 'revealVote(uint256,address,uint8,bytes32)',
          abiParameters: [row.pact_id, row.evaluator, String(row.vote), row.secret],
          fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
        });
        const tx = await waitForCircleTx(exec.data!.id);
        if (!tx.txHash) throw new Error('reveal tx confirmed without txHash');
        return { txHash: tx.txHash };
      },
    });
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
