import 'dotenv/config';

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:3001';
const OPERATOR = process.env.CIRCLE_OPERATOR_ADDRESS;

if (!OPERATOR) {
  console.error('CIRCLE_OPERATOR_ADDRESS missing in .env');
  process.exit(1);
}

const PROVIDER = process.env.SMOKE_PROVIDER ?? OPERATOR;
const EVALUATOR = process.env.SMOKE_EVALUATOR ?? OPERATOR;
const BUDGET = process.env.SMOKE_BUDGET ?? '0.1';
const EXPIRES_IN = Number(process.env.SMOKE_EXPIRES_IN ?? 3600);
const DESCRIPTION = process.env.SMOKE_DESCRIPTION ?? `smoke test ${new Date().toISOString()}`;

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

function step(label: string) {
  console.log(`\n${BOLD}── ${label} ──${RESET}`);
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
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
  if (!res.ok) {
    console.error(parsed);
    throw new Error(`${method} ${path} → HTTP ${res.status}`);
  }
  console.log(JSON.stringify(parsed, null, 2));
  return parsed as T;
}

async function main() {
  step('Config');
  console.log({ BASE, PROVIDER, EVALUATOR, BUDGET, EXPIRES_IN, DESCRIPTION });

  step('0. Server health');
  await req('GET', '/health');

  step('1. Create job');
  const created = await req<{ jobId: string }>('POST', '/arc/escrow/jobs', {
    provider: PROVIDER,
    evaluator: EVALUATOR,
    expiredInSeconds: EXPIRES_IN,
    description: DESCRIPTION,
  });
  const jobId = created.jobId;
  console.log(`${GREEN}→ jobId=${jobId}${RESET}`);

  step(`2. Set budget (${BUDGET} USDC)`);
  await req('POST', `/arc/escrow/jobs/${jobId}/budget`, { budgetUsdc: BUDGET });

  step(`3. Approve USDC (${BUDGET}) — idempotent`);
  await req('POST', '/arc/usdc/approve', { amountUsdc: BUDGET });

  step(`4. Fund job ${jobId}`);
  await req('POST', `/arc/escrow/jobs/${jobId}/fund`);

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

main().catch((err) => {
  console.error(`${RED}smoke test failed:${RESET}`, err instanceof Error ? err.message : err);
  process.exit(1);
});
