import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, statSync, createReadStream } from 'node:fs';
import { resolve, join } from 'node:path';
import Fastify, { type FastifyReply } from 'fastify';
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
  ERC8183_ADDRESS,
  ERC8004_REPUTATION_ADDRESS,
  ARC_TESTNET_CHAIN_ID,
} from './lib/arc.js';
import { erc20Abi } from './lib/abis/erc20.js';
import { erc8183Abi, JOB_STATUS, jobCreatedEvent } from './lib/abis/erc8183.js';
import {
  reputationRegistryAbi,
  identityRegistryAbi,
  erc721TransferEvent,
} from './lib/abis/erc8004.js';
import {
  db,
  rowToUser,
  rowToJobIndex,
  rowToJobEvent,
  rowToDeliverable,
  type UserRow,
  type JobIndexRow,
  type JobEventRow,
  type DeliverableRow,
  type DeliverableContentType,
} from './lib/db.js';
import { startJobIndexer } from './lib/job-indexer.js';
import { startBridgeIndexer } from './lib/bridge-indexer.js';

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

app.get('/health', async () => {
  return {
    status: 'ok',
    service: 'arc-trade-backend',
    operatorAddress: process.env.CIRCLE_OPERATOR_ADDRESS ?? null,
  };
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
// enough on a single jobId-keyed page that caching can come later if needed.

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

app.get('/arc/escrow/info', async () => {
  const [jobCount, paymentToken, platformFeeBP, evaluatorFeeBP, platformTreasury] = await Promise.all([
    arcClient.readContract({ address: ERC8183_ADDRESS, abi: erc8183Abi, functionName: 'jobCounter' }),
    arcClient.readContract({ address: ERC8183_ADDRESS, abi: erc8183Abi, functionName: 'paymentToken' }),
    arcClient.readContract({ address: ERC8183_ADDRESS, abi: erc8183Abi, functionName: 'platformFeeBP' }),
    arcClient.readContract({ address: ERC8183_ADDRESS, abi: erc8183Abi, functionName: 'evaluatorFeeBP' }),
    arcClient.readContract({ address: ERC8183_ADDRESS, abi: erc8183Abi, functionName: 'platformTreasury' }),
  ]);

  return {
    address: ERC8183_ADDRESS,
    jobCount: jobCount.toString(),
    paymentToken,
    platformFeeBP: platformFeeBP.toString(),
    evaluatorFeeBP: evaluatorFeeBP.toString(),
    platformTreasury,
  };
});

app.post<{
  Body: {
    userId?: string;
    handle?: string;
    provider: string;
    evaluator: string;
    expiredInSeconds: number;
    description: string;
  };
}>('/arc/escrow/jobs', async (request, reply) => {
  const { provider, evaluator, expiredInSeconds, description } = request.body;
  const signer = requireSigner(reply, request.body);
  if (!signer) return;
  const expiredAt = Math.floor(Date.now() / 1000) + expiredInSeconds;

  const create = await circle.createContractExecutionTransaction({
    walletId: signer.circle_wallet_id,
    contractAddress: ERC8183_ADDRESS,
    abiFunctionSignature: 'createJob(address,address,uint256,string,address)',
    abiParameters: [provider, evaluator, expiredAt.toString(), description, ZERO_ADDRESS],
    fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
  });

  const tx = await waitForCircleTx(create.data!.id);
  if (!tx.txHash) return reply.code(500).send({ error: 'Circle tx confirmed without txHash' });

  const receipt = await arcClient.getTransactionReceipt({ hash: tx.txHash as `0x${string}` });
  const [createdLog] = parseEventLogs({
    abi: [jobCreatedEvent],
    eventName: 'JobCreated',
    logs: receipt.logs,
  });
  if (!createdLog) return reply.code(500).send({ error: 'JobCreated event missing from receipt' });

  return {
    jobId: createdLog.args.jobId.toString(),
    txId: tx.id,
    txHash: tx.txHash,
    state: tx.state,
  };
});

app.post<{ Params: { id: string }; Body: { userId?: string; handle?: string; budgetUsdc: string } }>(
  '/arc/escrow/jobs/:id/budget',
  async (request, reply) => {
    const { budgetUsdc } = request.body;
    const signer = requireSigner(reply, request.body);
    if (!signer) return;
    const jobId = request.params.id;
    const amountRaw = parseUnits(budgetUsdc, 6);

    const exec = await circle.createContractExecutionTransaction({
      walletId: signer.circle_wallet_id,
      contractAddress: ERC8183_ADDRESS,
      abiFunctionSignature: 'setBudget(uint256,uint256,bytes)',
      abiParameters: [jobId, amountRaw.toString(), '0x'],
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    });

    const tx = await waitForCircleTx(exec.data!.id);

    return {
      jobId,
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
    abiParameters: [ERC8183_ADDRESS, amountRaw.toString()],
    fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
  });

  const tx = await waitForCircleTx(exec.data!.id);

  return {
    spender: ERC8183_ADDRESS,
    amount: { raw: amountRaw.toString(), usdc: amountUsdc },
    txId: tx.id,
    txHash: tx.txHash,
    state: tx.state,
  };
});

app.post<{ Params: { id: string }; Body: { userId?: string; handle?: string } }>(
  '/arc/escrow/jobs/:id/fund',
  async (request, reply) => {
    const signer = requireSigner(reply, request.body);
    if (!signer) return;
    const jobId = request.params.id;

    const exec = await circle.createContractExecutionTransaction({
      walletId: signer.circle_wallet_id,
      contractAddress: ERC8183_ADDRESS,
      abiFunctionSignature: 'fund(uint256,bytes)',
      abiParameters: [jobId, '0x'],
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    });

    const tx = await waitForCircleTx(exec.data!.id);

    return {
      jobId,
      txId: tx.id,
      txHash: tx.txHash,
      state: tx.state,
    };
  }
);

app.post<{ Params: { id: string }; Body: { userId?: string; handle?: string; deliverableHash: string } }>(
  '/arc/escrow/jobs/:id/submit',
  async (request, reply) => {
    const signer = requireSigner(reply, request.body);
    if (!signer) return;
    const jobId = request.params.id;
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
      contractAddress: ERC8183_ADDRESS,
      abiFunctionSignature: 'submit(uint256,bytes32,bytes)',
      abiParameters: [jobId, deliverable, '0x'],
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    });

    const tx = await waitForCircleTx(exec.data!.id);

    return {
      jobId,
      deliverableHash: deliverable,
      txId: tx.id,
      txHash: tx.txHash,
      state: tx.state,
    };
  }
);

app.post<{ Params: { id: string }; Body: { userId?: string; handle?: string; reasonHash?: string } }>(
  '/arc/escrow/jobs/:id/complete',
  async (request, reply) => {
    const signer = requireSigner(reply, request.body);
    if (!signer) return;
    const jobId = request.params.id;
    let reason: `0x${string}`;
    try {
      reason = toBytes32(request.body?.reasonHash, 'reasonHash');
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }

    const exec = await circle.createContractExecutionTransaction({
      walletId: signer.circle_wallet_id,
      contractAddress: ERC8183_ADDRESS,
      abiFunctionSignature: 'complete(uint256,bytes32,bytes)',
      abiParameters: [jobId, reason, '0x'],
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    });

    const tx = await waitForCircleTx(exec.data!.id);

    return {
      jobId,
      reasonHash: reason,
      txId: tx.id,
      txHash: tx.txHash,
      state: tx.state,
    };
  }
);

app.post<{ Params: { id: string }; Body: { userId?: string; handle?: string; reasonHash?: string } }>(
  '/arc/escrow/jobs/:id/reject',
  async (request, reply) => {
    const signer = requireSigner(reply, request.body);
    if (!signer) return;
    const jobId = request.params.id;
    let reason: `0x${string}`;
    try {
      reason = toBytes32(request.body?.reasonHash, 'reasonHash');
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }

    const exec = await circle.createContractExecutionTransaction({
      walletId: signer.circle_wallet_id,
      contractAddress: ERC8183_ADDRESS,
      abiFunctionSignature: 'reject(uint256,bytes32,bytes)',
      abiParameters: [jobId, reason, '0x'],
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    });

    const tx = await waitForCircleTx(exec.data!.id);

    return {
      jobId,
      reasonHash: reason,
      txId: tx.id,
      txHash: tx.txHash,
      state: tx.state,
    };
  }
);

app.post<{ Params: { id: string }; Body: { userId?: string; handle?: string } }>(
  '/arc/escrow/jobs/:id/refund',
  async (request, reply) => {
    const signer = requireSigner(reply, request.body);
    if (!signer) return;
    const jobId = request.params.id;

    const exec = await circle.createContractExecutionTransaction({
      walletId: signer.circle_wallet_id,
      contractAddress: ERC8183_ADDRESS,
      abiFunctionSignature: 'claimRefund(uint256)',
      abiParameters: [jobId],
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    });

    const tx = await waitForCircleTx(exec.data!.id);

    return {
      jobId,
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

app.post<{
  Body: {
    provider: string;
    evaluator: string;
    expiredInSeconds: number;
    description: string;
  };
}>('/arc/escrow/jobs/unsigned', async (request, reply) => {
  const { provider, evaluator, expiredInSeconds, description } = request.body;
  if (!provider || !/^0x[0-9a-fA-F]{40}$/.test(provider)) {
    return reply.code(400).send({ error: 'provider must be a 0x-prefixed 20-byte hex address' });
  }
  if (!evaluator || !/^0x[0-9a-fA-F]{40}$/.test(evaluator)) {
    return reply.code(400).send({ error: 'evaluator must be a 0x-prefixed 20-byte hex address' });
  }
  if (typeof expiredInSeconds !== 'number' || expiredInSeconds <= 300) {
    return reply.code(400).send({ error: 'expiredInSeconds must be a number > 300 (reference contract floor is 5 minutes)' });
  }
  const expiredAt = BigInt(Math.floor(Date.now() / 1000) + expiredInSeconds);
  return buildUnsignedTx(ERC8183_ADDRESS, erc8183Abi as Abi, 'createJob', [
    provider as `0x${string}`,
    evaluator as `0x${string}`,
    expiredAt,
    description ?? '',
    ZERO_ADDRESS as `0x${string}`,
  ]);
});

app.post<{ Params: { id: string }; Body: { budgetUsdc: string } }>(
  '/arc/escrow/jobs/:id/budget/unsigned',
  async (request, reply) => {
    const jobId = BigInt(request.params.id);
    const { budgetUsdc } = request.body;
    if (!budgetUsdc || Number(budgetUsdc) <= 0) {
      return reply.code(400).send({ error: 'budgetUsdc must be a positive number string' });
    }
    const amountRaw = parseUnits(budgetUsdc, 6);
    return buildUnsignedTx(ERC8183_ADDRESS, erc8183Abi as Abi, 'setBudget', [jobId, amountRaw, '0x']);
  },
);

app.post<{ Body: { amountUsdc: string } }>('/arc/usdc/approve/unsigned', async (request, reply) => {
  const { amountUsdc } = request.body;
  if (!amountUsdc || Number(amountUsdc) <= 0) {
    return reply.code(400).send({ error: 'amountUsdc must be a positive number string' });
  }
  const amountRaw = parseUnits(amountUsdc, 6);
  return buildUnsignedTx(USDC_ADDRESS, erc20Abi as Abi, 'approve', [ERC8183_ADDRESS, amountRaw]);
});

app.post<{ Params: { id: string } }>('/arc/escrow/jobs/:id/fund/unsigned', async (request) => {
  const jobId = BigInt(request.params.id);
  return buildUnsignedTx(ERC8183_ADDRESS, erc8183Abi as Abi, 'fund', [jobId, '0x']);
});

app.post<{ Params: { id: string }; Body: { deliverableHash: string } }>(
  '/arc/escrow/jobs/:id/submit/unsigned',
  async (request, reply) => {
    const jobId = BigInt(request.params.id);
    let deliverable: `0x${string}`;
    try {
      deliverable = toBytes32(request.body.deliverableHash, 'deliverableHash');
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
    if (deliverable === ZERO_BYTES32) {
      return reply.code(400).send({ error: 'deliverableHash is required' });
    }
    return buildUnsignedTx(ERC8183_ADDRESS, erc8183Abi as Abi, 'submit', [jobId, deliverable, '0x']);
  },
);

app.post<{ Params: { id: string }; Body: { reasonHash?: string } }>(
  '/arc/escrow/jobs/:id/complete/unsigned',
  async (request, reply) => {
    const jobId = BigInt(request.params.id);
    let reason: `0x${string}`;
    try {
      reason = toBytes32(request.body.reasonHash, 'reasonHash');
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
    return buildUnsignedTx(ERC8183_ADDRESS, erc8183Abi as Abi, 'complete', [jobId, reason, '0x']);
  },
);

app.post<{ Params: { id: string }; Body: { reasonHash?: string } }>(
  '/arc/escrow/jobs/:id/reject/unsigned',
  async (request, reply) => {
    const jobId = BigInt(request.params.id);
    let reason: `0x${string}`;
    try {
      reason = toBytes32(request.body.reasonHash, 'reasonHash');
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
    return buildUnsignedTx(ERC8183_ADDRESS, erc8183Abi as Abi, 'reject', [jobId, reason, '0x']);
  },
);

app.post<{ Params: { id: string } }>('/arc/escrow/jobs/:id/refund/unsigned', async (request) => {
  const jobId = BigInt(request.params.id);
  return buildUnsignedTx(ERC8183_ADDRESS, erc8183Abi as Abi, 'claimRefund', [jobId]);
});

// Lookup jobs by participant address. Indexed locally by polling JobCreated
// events from the reference contract; live state (status, budget) still comes
// from the chain via /arc/escrow/job/:id. Returned rows include the role the
// address plays in each job so the frontend doesn't need to recompute it.
type JobsByAddressEntry = {
  jobId: string;
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
  '/jobs/by-address/:address',
  async (request, reply) => {
    const address = request.params.address.toLowerCase();
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      return reply.code(400).send({ error: 'address must be a 0x-prefixed 20-byte hex address' });
    }
    const rows = db
      .prepare(
        `SELECT * FROM jobs_index
         WHERE client = ? OR provider = ? OR evaluator = ?
         ORDER BY block_number DESC`,
      )
      .all(address, address, address) as JobIndexRow[];

    const jobs: JobsByAddressEntry[] = rows.map((row) => {
      const base = rowToJobIndex(row);
      const roles: JobsByAddressEntry['roles'] = [];
      if (base.client === address) roles.push('client');
      if (base.provider === address) roles.push('provider');
      if (base.evaluator === address) roles.push('evaluator');
      return { ...base, roles };
    });

    return { address, jobs, count: jobs.length };
  },
);

// Notifications feed for a given address — bundles, per job, the immutable
// index row + live on-chain state + this job's events. Saves the frontend
// from doing N×2 round-trips to render the bell. Paginated by recency.
const FEED_PAGE_DEFAULT = 30;
const FEED_PAGE_MAX = 100;

type FeedRow = {
  jobId: string;
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
    description: string;
  } | null;
  events: ReturnType<typeof rowToJobEvent>[];
};

app.get<{
  Params: { address: string };
  Querystring: { limit?: string; offset?: string };
}>('/jobs/by-address/:address/feed', async (request, reply) => {
  const address = request.params.address.toLowerCase();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return reply.code(400).send({ error: 'address must be a 0x-prefixed 20-byte hex address' });
  }
  const limit = clampInt(request.query.limit, FEED_PAGE_DEFAULT, 1, FEED_PAGE_MAX);
  const offset = clampInt(request.query.offset, 0, 0, 100_000);

  // Newest jobs first — matches the bell's "what changed recently" framing.
  const indexRows = db
    .prepare(
      `SELECT * FROM jobs_index
       WHERE client = ? OR provider = ? OR evaluator = ?
       ORDER BY block_number DESC`,
    )
    .all(address, address, address) as JobIndexRow[];

  const total = indexRows.length;
  const pageRows = indexRows.slice(offset, offset + limit);

  // Live read + events fetched per job in parallel. Tolerates per-call
  // failures — a single dead RPC shouldn't take the whole bell down.
  const live = await Promise.allSettled(
    pageRows.map((row) =>
      arcClient.readContract({
        address: ERC8183_ADDRESS,
        abi: erc8183Abi,
        functionName: 'getJob',
        args: [BigInt(row.job_id)],
      }),
    ),
  );

  const eventsByJob = new Map<string, ReturnType<typeof rowToJobEvent>[]>();
  if (pageRows.length > 0) {
    const placeholders = pageRows.map(() => '?').join(',');
    const eventRows = db
      .prepare(
        `SELECT * FROM job_events
         WHERE job_id IN (${placeholders})
         ORDER BY block_number ASC, log_index ASC`,
      )
      .all(...pageRows.map((r) => r.job_id)) as JobEventRow[];
    for (const r of eventRows) {
      const list = eventsByJob.get(r.job_id) ?? [];
      list.push(rowToJobEvent(r));
      eventsByJob.set(r.job_id, list);
    }
  }

  const feed: FeedRow[] = pageRows.map((row, i) => {
    const base = rowToJobIndex(row);
    const roles: FeedRow['roles'] = [];
    if (base.client === address) roles.push('client');
    if (base.provider === address) roles.push('provider');
    if (base.evaluator === address) roles.push('evaluator');

    const result = live[i];
    const liveData =
      result.status === 'fulfilled'
        ? {
            status: JOB_STATUS[result.value.status] ?? `Unknown(${result.value.status})`,
            budget: {
              raw: result.value.budget.toString(),
              usdc: formatUnits(result.value.budget, 6),
            },
            expiredAt: {
              unix: Number(result.value.expiredAt),
              iso: new Date(Number(result.value.expiredAt) * 1000).toISOString(),
            },
            description: result.value.description,
          }
        : null;

    return {
      jobId: base.jobId,
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
      events: eventsByJob.get(base.jobId) ?? [],
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

// Open-jobs marketplace. Lists every Open ERC-8183 job our indexer has
// seen (this is the public reference contract, so it's the whole network
// pre-wrapper, not just arc-trade-created jobs). Filters in-memory after a
// fan-out live read since status + budget aren't indexed on-chain.
const MARKET_INDEX_CAP = 500;
const MARKET_PAGE_DEFAULT = 20;
const MARKET_PAGE_MAX = 50;

type OpenJobEntry = {
  jobId: string;
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

app.get<{
  Querystring: { limit?: string; offset?: string; minBudget?: string; maxBudget?: string };
}>('/jobs/open', async (request, reply) => {
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

  // Pull the most-recent N from the index. Older jobs (most likely terminal
  // by now) are dropped — keeps the live-read fan-out bounded.
  const indexRows = db
    .prepare(
      `SELECT * FROM jobs_index
       ORDER BY block_number DESC
       LIMIT ?`,
    )
    .all(MARKET_INDEX_CAP) as JobIndexRow[];

  // Live-read budget + status for every candidate in parallel. ERC-8183
  // doesn't emit a BudgetSet event, so we can't index this — see M30 note.
  const liveStates = await Promise.allSettled(
    indexRows.map((row) =>
      arcClient.readContract({
        address: ERC8183_ADDRESS,
        abi: erc8183Abi,
        functionName: 'getJob',
        args: [BigInt(row.job_id)],
      }),
    ),
  );

  const nowUnix = Math.floor(Date.now() / 1000);
  const open: OpenJobEntry[] = [];

  for (let i = 0; i < indexRows.length; i++) {
    const row = indexRows[i];
    const result = liveStates[i];
    if (result.status !== 'fulfilled') continue;
    const job = result.value;
    const status = JOB_STATUS[job.status] ?? `Unknown(${job.status})`;
    if (status !== 'Open') continue;
    if (Number(job.expiredAt) <= nowUnix) continue;
    if (minBudgetRaw !== null && job.budget < minBudgetRaw) continue;
    if (maxBudgetRaw !== null && job.budget > maxBudgetRaw) continue;
    open.push({
      jobId: row.job_id,
      client: job.client,
      provider: job.provider,
      evaluator: job.evaluator,
      description: job.description,
      budget: { raw: job.budget.toString(), usdc: formatUnits(job.budget, 6) },
      expiredAt: {
        unix: Number(job.expiredAt),
        iso: new Date(Number(job.expiredAt) * 1000).toISOString(),
      },
      status,
      hook: job.hook,
      createdAt: {
        blockNumber: row.block_number,
        txHash: row.tx_hash,
        indexedAt: row.indexed_at,
      },
    });
  }

  const total = open.length;
  const jobs = open.slice(offset, offset + limit);
  return { jobs, total, limit, offset, indexScanned: indexRows.length };
});

function clampInt(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

app.get<{ Params: { id: string } }>('/arc/escrow/job/:id', async (request, reply) => {
  const jobId = BigInt(request.params.id);

  const job = await arcClient.readContract({
    address: ERC8183_ADDRESS,
    abi: erc8183Abi,
    functionName: 'getJob',
    args: [jobId],
  });

  if (job.id === 0n && job.client === '0x0000000000000000000000000000000000000000') {
    return reply.code(404).send({ error: `Job ${request.params.id} not found` });
  }

  // Bolt on the creation metadata from the local index so the frontend can
  // render a lifecycle timeline without a second roundtrip. null if the
  // indexer hasn't caught up yet (~10s window after a fresh JobCreated).
  const createdRow = db
    .prepare('SELECT block_number, tx_hash, indexed_at FROM jobs_index WHERE job_id = ?')
    .get(request.params.id) as
    | { block_number: number; tx_hash: string; indexed_at: string }
    | undefined;

  return {
    id: job.id.toString(),
    client: job.client,
    provider: job.provider,
    evaluator: job.evaluator,
    description: job.description,
    budget: {
      raw: job.budget.toString(),
      usdc: formatUnits(job.budget, 6),
    },
    expiredAt: {
      unix: Number(job.expiredAt),
      iso: new Date(Number(job.expiredAt) * 1000).toISOString(),
    },
    status: JOB_STATUS[job.status] ?? `Unknown(${job.status})`,
    hook: job.hook,
    createdAt: createdRow
      ? {
          blockNumber: createdRow.block_number,
          txHash: createdRow.tx_hash,
          indexedAt: createdRow.indexed_at,
        }
      : null,
  };
});

// ─── ERC-8004 reputation reads ─────────────────────────────────────────────
// Live view-calls to the ReputationRegistry. No indexing yet — view reads
// are cheap on a per-agent basis. Two routes:
//   - /summary: just getClients + getSummary. Used by the inline badge so
//     multi-party job-detail views don't shred bandwidth.
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

// Lifecycle events for a job (Submitted/Completed/Rejected). Surfaces the
// on-chain bytes32 deliverable + reason hashes for any viewer; indexed via
// job-indexer. Empty array is valid (e.g. Open or Funded jobs).
app.get<{ Params: { id: string } }>('/arc/escrow/job/:id/events', async (request, reply) => {
  if (!/^\d+$/.test(request.params.id)) {
    return reply.code(400).send({ error: 'id must be a numeric job id' });
  }
  const rows = db
    .prepare(
      `SELECT * FROM job_events WHERE job_id = ?
       ORDER BY block_number ASC, log_index ASC`,
    )
    .all(request.params.id) as JobEventRow[];
  return { jobId: request.params.id, events: rows.map(rowToJobEvent) };
});

// ─── Deliverable content (Layers 2 + 3) ────────────────────────────────────
// Off-chain content (text, URL, or file) attached to a Submitted event.
// Stored keyed by (jobId, hash). Upload is gated by hash verification — the
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
// party on this job. Returns the lowercased viewer address on success,
// or null after sending an error response. Shared between the JSON
// metadata route and the binary file route.
async function verifyDeliverableReadAuth(
  request: import('fastify').FastifyRequest,
  reply: FastifyReply,
  jobId: string,
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

  const message = `arc-trade:read-deliverable:${jobId}:${ts}`;
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

  const jobRow = db
    .prepare('SELECT client, provider, evaluator FROM jobs_index WHERE job_id = ?')
    .get(jobId) as { client: string; provider: string; evaluator: string } | undefined;
  if (!jobRow) {
    reply.code(404).send({ error: 'job not indexed yet — try again in a few seconds' });
    return null;
  }
  const v = viewer.toLowerCase();
  if (v !== jobRow.client && v !== jobRow.provider && v !== jobRow.evaluator) {
    reply.code(403).send({ error: 'not a party to this job' });
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
  '/arc/escrow/job/:id/deliverable-content',
  { bodyLimit: UPLOAD_BODY_LIMIT_BYTES },
  async (request, reply) => {
  const jobId = request.params.id;
  if (!/^\d+$/.test(jobId)) {
    return reply.code(400).send({ error: 'id must be a numeric job id' });
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
    .prepare('SELECT hash FROM deliverables WHERE job_id = ? AND hash = ?')
    .get(jobId, expectedHash.toLowerCase()) as { hash: string } | undefined;
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
      `INSERT INTO deliverables (job_id, hash, content_type, text_content, uploaded_by)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(jobId, computed.toLowerCase(), contentType, content, uploadedBy.toLowerCase());
    return reply.code(201).send({ jobId, hash: computed.toLowerCase(), contentType });
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
  const jobDir = join(DELIVERABLE_FILES_DIR, jobId);
  mkdirSync(jobDir, { recursive: true });
  const relativePath = join(jobId, `${hashLower}.bin`);
  const absolutePath = join(DELIVERABLE_FILES_DIR, relativePath);
  writeFileSync(absolutePath, bytes);

  db.prepare(
    `INSERT INTO deliverables (job_id, hash, content_type, text_content, mime, size_bytes, file_path, uploaded_by)
     VALUES (?, ?, 'file', ?, ?, ?, ?, ?)`,
  ).run(jobId, hashLower, fileName, safeMime, bytes.length, relativePath, uploadedBy.toLowerCase());

  return reply.code(201).send({
    jobId,
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
}>('/arc/escrow/job/:id/deliverable', async (request, reply) => {
  const jobId = request.params.id;
  if (!/^\d+$/.test(jobId)) {
    return reply.code(400).send({ error: 'id must be a numeric job id' });
  }
  const hash = request.query.hash;
  if (typeof hash !== 'string' || !isHexBytes32(hash)) {
    return reply.code(400).send({ error: 'hash query param must be a 0x-prefixed 32-byte hex string' });
  }
  const ok = await verifyDeliverableReadAuth(request, reply, jobId);
  if (!ok) return;

  const row = db
    .prepare('SELECT * FROM deliverables WHERE job_id = ? AND hash = ?')
    .get(jobId, hash.toLowerCase()) as DeliverableRow | undefined;
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
}>('/arc/escrow/job/:id/deliverable/file', async (request, reply) => {
  const jobId = request.params.id;
  if (!/^\d+$/.test(jobId)) {
    return reply.code(400).send({ error: 'id must be a numeric job id' });
  }
  const hash = request.query.hash;
  if (typeof hash !== 'string' || !isHexBytes32(hash)) {
    return reply.code(400).send({ error: 'hash query param must be a 0x-prefixed 32-byte hex string' });
  }
  const ok = await verifyDeliverableReadAuth(request, reply, jobId);
  if (!ok) return;

  const row = db
    .prepare('SELECT * FROM deliverables WHERE job_id = ? AND hash = ?')
    .get(jobId, hash.toLowerCase()) as DeliverableRow | undefined;
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


const port = Number(process.env.PORT ?? 3001);

app
  .listen({ port, host: '0.0.0.0' })
  .then(() => {
    startJobIndexer(app.log);
    startBridgeIndexer(app.log);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
