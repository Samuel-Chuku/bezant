import 'dotenv/config';
import Fastify from 'fastify';
import { formatUnits, parseUnits, parseEventLogs } from 'viem';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import pkg from '../package.json' with { type: 'json' };
import { arcClient, USDC_ADDRESS, ERC8183_ADDRESS } from './lib/arc.js';
import { erc20Abi } from './lib/abis/erc20.js';
import { erc8183Abi, JOB_STATUS, jobCreatedEvent } from './lib/abis/erc8183.js';

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
}

const CIRCLE_API_KEY = requireEnv('CIRCLE_API_KEY');
const CIRCLE_ENTITY_SECRET = requireEnv('CIRCLE_ENTITY_SECRET');
const CIRCLE_OPERATOR_WALLET_ID = requireEnv('CIRCLE_OPERATOR_WALLET_ID');
const CIRCLE_OPERATOR_ADDRESS = requireEnv('CIRCLE_OPERATOR_ADDRESS') as `0x${string}`;

const circle = initiateDeveloperControlledWalletsClient({
  apiKey: CIRCLE_API_KEY,
  entitySecret: CIRCLE_ENTITY_SECRET,
});

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

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
  Body: { provider: string; evaluator: string; expiredInSeconds: number; description: string };
}>('/arc/escrow/jobs', async (request, reply) => {
  const { provider, evaluator, expiredInSeconds, description } = request.body;
  const expiredAt = Math.floor(Date.now() / 1000) + expiredInSeconds;

  const create = await circle.createContractExecutionTransaction({
    walletId: CIRCLE_OPERATOR_WALLET_ID,
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

app.post<{ Params: { id: string }; Body: { budgetUsdc: string } }>(
  '/arc/escrow/jobs/:id/budget',
  async (request) => {
    const { budgetUsdc } = request.body;
    const jobId = request.params.id;
    const amountRaw = parseUnits(budgetUsdc, 6);

    const exec = await circle.createContractExecutionTransaction({
      walletId: CIRCLE_OPERATOR_WALLET_ID,
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

app.post<{ Body: { amountUsdc: string } }>('/arc/usdc/approve', async (request) => {
  const { amountUsdc } = request.body;
  const amountRaw = parseUnits(amountUsdc, 6);

  const exec = await circle.createContractExecutionTransaction({
    walletId: CIRCLE_OPERATOR_WALLET_ID,
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

app.post<{ Params: { id: string } }>('/arc/escrow/jobs/:id/fund', async (request) => {
  const jobId = request.params.id;

  const exec = await circle.createContractExecutionTransaction({
    walletId: CIRCLE_OPERATOR_WALLET_ID,
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
