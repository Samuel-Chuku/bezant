import 'dotenv/config';
import { randomBytes } from 'node:crypto';

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:3001';
const OPERATOR_ADDRESS = process.env.CIRCLE_OPERATOR_ADDRESS;

if (!OPERATOR_ADDRESS) {
  console.error('CIRCLE_OPERATOR_ADDRESS missing in .env');
  process.exit(1);
}

const BUDGET = process.env.SMOKE_BUDGET ?? '0.1';
const EXPIRES_IN = Number(process.env.SMOKE_EXPIRES_IN ?? 3600);
const DESCRIPTION = process.env.SMOKE_DESCRIPTION ?? `smoke test ${new Date().toISOString()}`;
const TARGET = (process.env.SMOKE_TARGET ?? 'completed').toLowerCase(); // 'funded' | 'completed' | 'rejected'
const CLIENT_HANDLE = process.env.SMOKE_CLIENT_HANDLE ?? 'operator';
const PROVIDER_HANDLE = process.env.SMOKE_PROVIDER_HANDLE ?? 'smoke-provider';
const EVALUATOR_HANDLE = process.env.SMOKE_EVALUATOR_HANDLE ?? 'smoke-evaluator';
const GAS_MIN_USDC = process.env.SMOKE_GAS_MIN_USDC ?? '0.02';
const GAS_TOPUP_USDC = process.env.SMOKE_GAS_TOPUP_USDC ?? '0.05';

const VALID_TARGETS = ['funded', 'completed', 'rejected'] as const;
type Target = (typeof VALID_TARGETS)[number];

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

function step(label: string) {
  console.log(`\n${BOLD}── ${label} ──${RESET}`);
}

async function req<T>(method: string, path: string, body?: unknown, expectStatus?: number[]): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  const ok = expectStatus ? expectStatus.includes(res.status) : res.ok;
  if (!ok) {
    console.error(parsed);
    throw new Error(`${method} ${path} → HTTP ${res.status}`);
  }
  console.log(JSON.stringify(parsed, null, 2));
  return parsed as T;
}

type UserRecord = { id: string; handle: string | null; walletAddress: string };

async function resolveOrCreateUser(handle: string): Promise<UserRecord> {
  const res = await fetch(`${BASE}/users/by-handle/${encodeURIComponent(handle)}`);
  if (res.ok) {
    const user = (await res.json()) as UserRecord;
    console.log(`${YELLOW}↻ reusing existing user "${handle}"${RESET}`);
    console.log(JSON.stringify(user, null, 2));
    return user;
  }
  if (res.status !== 404) {
    const text = await res.text();
    throw new Error(`GET /users/by-handle/${handle} → HTTP ${res.status}: ${text}`);
  }
  console.log(`${YELLOW}+ creating user with handle "${handle}"${RESET}`);
  return req<UserRecord>('POST', '/users', { handle });
}

async function getUsdcRawBalance(address: string): Promise<bigint> {
  const r = await req<{ raw: string }>('GET', `/arc/usdc-balance?address=${encodeURIComponent(address)}`);
  return BigInt(r.raw);
}

async function ensureGas(user: UserRecord, funder: UserRecord, minRaw: bigint, topupUsdc: string, label: string) {
  if (user.walletAddress.toLowerCase() === funder.walletAddress.toLowerCase()) {
    console.log(`${GREEN}✓ ${label} is the funder, skipping top-up${RESET}`);
    return;
  }
  const balance = await getUsdcRawBalance(user.walletAddress);
  console.log(`${GREEN}→ ${label} USDC raw=${balance}, min required=${minRaw}${RESET}`);
  if (balance < minRaw) {
    console.log(`${YELLOW}↻ topping up ${label} with ${topupUsdc} USDC from ${funder.handle ?? funder.id}${RESET}`);
    await req('POST', '/wallet/transfer-usdc', {
      fromHandle: funder.handle ?? undefined,
      fromUserId: funder.handle ? undefined : funder.id,
      toAddress: user.walletAddress,
      amountUsdc: topupUsdc,
    });
  } else {
    console.log(`${GREEN}✓ ${label} has enough gas, skipping top-up${RESET}`);
  }
}

async function main() {
  step('Config');
  console.log({
    BASE, BUDGET, EXPIRES_IN, DESCRIPTION, TARGET,
    CLIENT_HANDLE, PROVIDER_HANDLE, EVALUATOR_HANDLE,
  });

  if (!(VALID_TARGETS as readonly string[]).includes(TARGET)) {
    console.error(`${RED}SMOKE_TARGET must be one of ${VALID_TARGETS.join(' | ')}, got '${TARGET}'${RESET}`);
    process.exit(1);
  }
  const target = TARGET as Target;

  step('0. Server health');
  await req('GET', '/health');

  step(`0b. Resolve client (handle="${CLIENT_HANDLE}")`);
  const client = await req<UserRecord>('GET', `/users/by-handle/${encodeURIComponent(CLIENT_HANDLE)}`);

  step(`0c. Resolve-or-create provider (handle="${PROVIDER_HANDLE}")`);
  const provider = await resolveOrCreateUser(PROVIDER_HANDLE);

  step(`0d. Resolve-or-create evaluator (handle="${EVALUATOR_HANDLE}")`);
  const evaluator = await resolveOrCreateUser(EVALUATOR_HANDLE);

  step('0e. Read reference-contract fee BPs');
  const info = await req<{ platformFeeBP: string; evaluatorFeeBP: string }>('GET', '/arc/escrow/info');
  const platformBP = BigInt(info.platformFeeBP);
  const evaluatorBP = BigInt(info.evaluatorFeeBP);
  console.log(`${GREEN}→ platformFeeBP=${platformBP}, evaluatorFeeBP=${evaluatorBP}${RESET}`);

  const gasMinRaw = BigInt(Math.round(Number(GAS_MIN_USDC) * 1_000_000));

  step('0f. Ensure provider has gas (Arc pays gas in USDC)');
  await ensureGas(provider, client, gasMinRaw, GAS_TOPUP_USDC, 'provider');

  step('0g. Ensure evaluator has gas');
  await ensureGas(evaluator, client, gasMinRaw, GAS_TOPUP_USDC, 'evaluator');

  step(`1. Create job (client=${CLIENT_HANDLE}, provider=${PROVIDER_HANDLE}, evaluator=${EVALUATOR_HANDLE})`);
  const created = await req<{ jobId: string }>('POST', '/arc/escrow/jobs', {
    handle: CLIENT_HANDLE,
    provider: provider.walletAddress,
    evaluator: evaluator.walletAddress,
    expiredInSeconds: EXPIRES_IN,
    description: DESCRIPTION,
  });
  const jobId = created.jobId;
  console.log(`${GREEN}→ jobId=${jobId}${RESET}`);

  step(`2. Set budget (${BUDGET} USDC) — signed by ${PROVIDER_HANDLE} (provider quotes price)`);
  await req('POST', `/arc/escrow/jobs/${jobId}/budget`, { handle: PROVIDER_HANDLE, budgetUsdc: BUDGET });

  step(`3. Approve USDC (${BUDGET}) — signed by ${CLIENT_HANDLE} (idempotent)`);
  await req('POST', '/arc/usdc/approve', { handle: CLIENT_HANDLE, amountUsdc: BUDGET });

  step(`4. Fund job ${jobId} — signed by ${CLIENT_HANDLE}`);
  await req('POST', `/arc/escrow/jobs/${jobId}/fund`, { handle: CLIENT_HANDLE });

  if (target === 'funded') {
    step('5. Verify final state');
    const job = await req<{ status: string }>('GET', `/arc/escrow/job/${jobId}`);

    console.log();
    if (job.status === 'Funded') {
      console.log(`${GREEN}✓ smoke test passed — job ${jobId} is Funded${RESET}`);
      process.exit(0);
    } else {
      console.log(`${RED}✗ expected Funded, got ${job.status}${RESET}`);
      process.exit(1);
    }
  }

  const deliverableHash = `0x${randomBytes(32).toString('hex')}`;
  step(`5. Submit deliverable (${deliverableHash.slice(0, 10)}…) — signed by ${PROVIDER_HANDLE}`);
  await req('POST', `/arc/escrow/jobs/${jobId}/submit`, { handle: PROVIDER_HANDLE, deliverableHash });

  const budgetRaw = BigInt(Math.round(Number(BUDGET) * 1_000_000));

  if (target === 'completed') {
    step('6a. Read provider USDC balance (just before complete) — isolates payout from gas');
    const providerPreComplete = await getUsdcRawBalance(provider.walletAddress);

    step(`6b. Complete job (release to provider) — signed by ${EVALUATOR_HANDLE}`);
    await req('POST', `/arc/escrow/jobs/${jobId}/complete`, { handle: EVALUATOR_HANDLE });

    step('7. Verify on-chain state');
    const job = await req<{ status: string; provider: string }>('GET', `/arc/escrow/job/${jobId}`);

    step('8. Read provider USDC balance (after complete) + assert delta');
    const providerPostComplete = await getUsdcRawBalance(provider.walletAddress);
    const delta = providerPostComplete - providerPreComplete;
    const expectedDelta = (budgetRaw * (10000n - platformBP - evaluatorBP)) / 10000n;
    console.log(`${GREEN}→ preComplete=${providerPreComplete} postComplete=${providerPostComplete} delta=${delta} expected=${expectedDelta}${RESET}`);

    console.log();
    const statusOK = job.status === 'Completed';
    const providerOK = job.provider.toLowerCase() === provider.walletAddress.toLowerCase();
    const deltaOK = delta === expectedDelta;

    if (statusOK && providerOK && deltaOK) {
      console.log(`${GREEN}✓ smoke test passed — job ${jobId} Completed; provider ${provider.walletAddress} received ${delta} raw USDC (expected ${expectedDelta})${RESET}`);
      process.exit(0);
    } else {
      if (!statusOK) console.log(`${RED}✗ expected status Completed, got ${job.status}${RESET}`);
      if (!providerOK) console.log(`${RED}✗ provider mismatch: chain says ${job.provider}, expected ${provider.walletAddress}${RESET}`);
      if (!deltaOK) console.log(`${RED}✗ provider USDC delta ${delta} != expected ${expectedDelta}${RESET}`);
      process.exit(1);
    }
  }

  if (target === 'rejected') {
    if (client.walletAddress.toLowerCase() === evaluator.walletAddress.toLowerCase()) {
      console.log(`${RED}✗ for rejected target, evaluator must differ from client to isolate refund delta from gas — got both = ${client.walletAddress}${RESET}`);
      process.exit(1);
    }

    step('6a. Read client USDC balance (just before reject) — isolates refund from gas');
    const clientPreReject = await getUsdcRawBalance(client.walletAddress);

    step(`6b. Reject job (refund client) — signed by ${EVALUATOR_HANDLE}`);
    await req('POST', `/arc/escrow/jobs/${jobId}/reject`, { handle: EVALUATOR_HANDLE });

    step('7. Verify on-chain state');
    const job = await req<{ status: string; client: string }>('GET', `/arc/escrow/job/${jobId}`);

    step('8. Read client USDC balance (after reject) + assert delta');
    const clientPostReject = await getUsdcRawBalance(client.walletAddress);
    const delta = clientPostReject - clientPreReject;
    console.log(`${GREEN}→ preReject=${clientPreReject} postReject=${clientPostReject} delta=${delta} expected=${budgetRaw} (full refund, no fees)${RESET}`);

    console.log();
    const statusOK = job.status === 'Rejected';
    const clientOK = job.client.toLowerCase() === client.walletAddress.toLowerCase();
    const deltaOK = delta === budgetRaw;

    if (statusOK && clientOK && deltaOK) {
      console.log(`${GREEN}✓ smoke test passed — job ${jobId} Rejected; client ${client.walletAddress} received full refund ${delta} raw USDC${RESET}`);
      process.exit(0);
    } else {
      if (!statusOK) console.log(`${RED}✗ expected status Rejected, got ${job.status}${RESET}`);
      if (!clientOK) console.log(`${RED}✗ client mismatch: chain says ${job.client}, expected ${client.walletAddress}${RESET}`);
      if (!deltaOK) console.log(`${RED}✗ client USDC delta ${delta} != expected ${budgetRaw}${RESET}`);
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error(`${RED}smoke test failed:${RESET}`, err instanceof Error ? err.message : err);
  process.exit(1);
});
