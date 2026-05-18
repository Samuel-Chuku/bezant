import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyReply } from 'fastify';
import { formatUnits, parseUnits, parseEventLogs } from 'viem';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import pkg from '../package.json' with { type: 'json' };
import { arcClient, USDC_ADDRESS, ERC8183_ADDRESS } from './lib/arc.js';
import { erc20Abi } from './lib/abis/erc20.js';
import { erc8183Abi, JOB_STATUS, jobCreatedEvent } from './lib/abis/erc8183.js';
import { db, rowToUser, type UserRow } from './lib/db.js';

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

// Ensure the operator wallet has a corresponding user row so the escrow routes
// can resolve signers uniformly. Idempotent: skipped if the wallet is already
// registered under any handle.
const operatorRow = db
  .prepare('SELECT id, handle FROM users WHERE circle_wallet_id = ?')
  .get(CIRCLE_OPERATOR_WALLET_ID) as { id: string; handle: string } | undefined;
if (!operatorRow) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO users (id, handle, circle_wallet_id, wallet_address) VALUES (?, ?, ?, ?)`
  ).run(id, 'operator', CIRCLE_OPERATOR_WALLET_ID, CIRCLE_OPERATOR_ADDRESS);
  app.log.info({ id, handle: 'operator' }, 'seeded operator user');
}

type SignerRow = { circle_wallet_id: string; wallet_address: string };

function requireSigner(reply: FastifyReply, userId: string | undefined): SignerRow | null {
  if (!userId || typeof userId !== 'string') {
    reply.code(400).send({ error: 'userId is required' });
    return null;
  }
  const row = db
    .prepare('SELECT circle_wallet_id, wallet_address FROM users WHERE id = ?')
    .get(userId) as SignerRow | undefined;
  if (!row) {
    reply.code(404).send({ error: `user ${userId} not found` });
    return null;
  }
  return row;
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

app.post<{ Body: { handle: string } }>('/users', async (request, reply) => {
  const handle = request.body?.handle?.trim();
  if (!handle) return reply.code(400).send({ error: 'handle is required' });

  const existing = db.prepare('SELECT id FROM users WHERE handle = ?').get(handle);
  if (existing) return reply.code(409).send({ error: `handle '${handle}' already exists` });

  const created = await circle.createWallets({
    walletSetId: CIRCLE_WALLET_SET_ID,
    blockchains: ['ARC-TESTNET'],
    count: 1,
    accountType: 'EOA',
  });
  const wallet = created.data?.wallets?.[0];
  if (!wallet?.id || !wallet.address) {
    return reply.code(502).send({ error: 'Circle did not return a usable wallet' });
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO users (id, handle, circle_wallet_id, wallet_address) VALUES (?, ?, ?, ?)`
  ).run(id, handle, wallet.id, wallet.address);

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

app.get('/arc/usdc-balance', async () => {
  const [rawBalance, decimals, symbol] = await Promise.all([
    arcClient.readContract({
      address: USDC_ADDRESS,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [CIRCLE_OPERATOR_ADDRESS],
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
    address: CIRCLE_OPERATOR_ADDRESS,
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
    userId: string;
    provider: string;
    evaluator: string;
    expiredInSeconds: number;
    description: string;
  };
}>('/arc/escrow/jobs', async (request, reply) => {
  const { userId, provider, evaluator, expiredInSeconds, description } = request.body;
  const signer = requireSigner(reply, userId);
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

app.post<{ Params: { id: string }; Body: { userId: string; budgetUsdc: string } }>(
  '/arc/escrow/jobs/:id/budget',
  async (request, reply) => {
    const { userId, budgetUsdc } = request.body;
    const signer = requireSigner(reply, userId);
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

app.post<{ Body: { userId: string; amountUsdc: string } }>('/arc/usdc/approve', async (request, reply) => {
  const { userId, amountUsdc } = request.body;
  const signer = requireSigner(reply, userId);
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

app.post<{ Params: { id: string }; Body: { userId: string } }>(
  '/arc/escrow/jobs/:id/fund',
  async (request, reply) => {
    const { userId } = request.body;
    const signer = requireSigner(reply, userId);
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

app.post<{ Params: { id: string }; Body: { userId: string; deliverableHash: string } }>(
  '/arc/escrow/jobs/:id/submit',
  async (request, reply) => {
    const { userId } = request.body;
    const signer = requireSigner(reply, userId);
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

app.post<{ Params: { id: string }; Body: { userId: string; reasonHash?: string } }>(
  '/arc/escrow/jobs/:id/complete',
  async (request, reply) => {
    const { userId } = request.body;
    const signer = requireSigner(reply, userId);
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

app.post<{ Params: { id: string }; Body: { userId: string; reasonHash?: string } }>(
  '/arc/escrow/jobs/:id/reject',
  async (request, reply) => {
    const { userId } = request.body;
    const signer = requireSigner(reply, userId);
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

app.post<{ Params: { id: string }; Body: { userId: string } }>(
  '/arc/escrow/jobs/:id/refund',
  async (request, reply) => {
    const { userId } = request.body;
    const signer = requireSigner(reply, userId);
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

app.post<{
  Body: {
    userId: string;
    provider: string;
    evaluator: string;
    expiredInSeconds: number;
    description: string;
    budgetUsdc: string;
  };
}>('/trades', async (request, reply) => {
  const { userId, provider, evaluator, expiredInSeconds, description, budgetUsdc } = request.body;
  const signer = requireSigner(reply, userId);
  if (!signer) return;
  const amountRaw = parseUnits(budgetUsdc, 6);
  const expiredAt = Math.floor(Date.now() / 1000) + expiredInSeconds;

  const txs: Record<string, unknown> = {};

  try {
    const create = await circle.createContractExecutionTransaction({
      walletId: signer.circle_wallet_id,
      contractAddress: ERC8183_ADDRESS,
      abiFunctionSignature: 'createJob(address,address,uint256,string,address)',
      abiParameters: [provider, evaluator, expiredAt.toString(), description, ZERO_ADDRESS],
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    });
    const createTx = await waitForCircleTx(create.data!.id);
    if (!createTx.txHash) throw new Error('createJob confirmed without txHash');

    const receipt = await arcClient.getTransactionReceipt({ hash: createTx.txHash as `0x${string}` });
    const [createdLog] = parseEventLogs({
      abi: [jobCreatedEvent],
      eventName: 'JobCreated',
      logs: receipt.logs,
    });
    if (!createdLog) throw new Error('JobCreated event missing from receipt');
    const jobId = createdLog.args.jobId.toString();
    txs.createJob = { jobId, txId: createTx.id, txHash: createTx.txHash, state: createTx.state };

    const budgetExec = await circle.createContractExecutionTransaction({
      walletId: signer.circle_wallet_id,
      contractAddress: ERC8183_ADDRESS,
      abiFunctionSignature: 'setBudget(uint256,uint256,bytes)',
      abiParameters: [jobId, amountRaw.toString(), '0x'],
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    });
    const budgetTx = await waitForCircleTx(budgetExec.data!.id);
    txs.setBudget = { txId: budgetTx.id, txHash: budgetTx.txHash, state: budgetTx.state };

    const currentAllowance = await arcClient.readContract({
      address: USDC_ADDRESS,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [signer.wallet_address as `0x${string}`, ERC8183_ADDRESS],
    });

    if (currentAllowance >= amountRaw) {
      txs.approve = {
        skipped: true,
        reason: 'sufficient allowance',
        currentAllowance: { raw: currentAllowance.toString(), usdc: formatUnits(currentAllowance, 6) },
      };
    } else {
      const approveExec = await circle.createContractExecutionTransaction({
        walletId: signer.circle_wallet_id,
        contractAddress: USDC_ADDRESS,
        abiFunctionSignature: 'approve(address,uint256)',
        abiParameters: [ERC8183_ADDRESS, amountRaw.toString()],
        fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
      });
      const approveTx = await waitForCircleTx(approveExec.data!.id);
      txs.approve = { txId: approveTx.id, txHash: approveTx.txHash, state: approveTx.state };
    }

    const fundExec = await circle.createContractExecutionTransaction({
      walletId: signer.circle_wallet_id,
      contractAddress: ERC8183_ADDRESS,
      abiFunctionSignature: 'fund(uint256,bytes)',
      abiParameters: [jobId, '0x'],
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    });
    const fundTx = await waitForCircleTx(fundExec.data!.id);
    txs.fund = { txId: fundTx.id, txHash: fundTx.txHash, state: fundTx.state };

    const job = await arcClient.readContract({
      address: ERC8183_ADDRESS,
      abi: erc8183Abi,
      functionName: 'getJob',
      args: [BigInt(jobId)],
    });

    return {
      jobId,
      budget: { raw: amountRaw.toString(), usdc: budgetUsdc },
      status: JOB_STATUS[job.status] ?? `Unknown(${job.status})`,
      txs,
    };
  } catch (err) {
    return reply.code(500).send({
      error: err instanceof Error ? err.message : String(err),
      completed: txs,
    });
  }
});

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
  };
});


const port = Number(process.env.PORT ?? 3001);

app.listen({ port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
