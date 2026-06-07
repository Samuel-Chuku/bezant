import 'dotenv/config';

// Smoke for the dispute + refund paths on the standalone escrow:
//   A) create -> accept -> fund -> raiseDispute (seller) -> assert Disputed
//      -> if the operator is the on-chain arbitrator, resolveDispute -> assert.
//   B) create (short deadline) -> accept -> fund -> wait out deadline
//      -> refund (buyer) -> assert Refunded, buyer made whole.
//
// Prereqs: server running, contracts deployed, backend/.env has the addresses +
// the CIRCLE_* operator wallet (funder + attester). Run:  npm run smoke:dispute
//
// resolveDispute is gated on-chain to the arbitrator (the deployer EOA by
// default), which the backend can't sign — so scenario A asserts Disputed and
// only resolves when arbitrator == operator. To exercise resolve end-to-end,
// run setArbitrator(operator) from the deployer first.

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:3001';
const AMOUNT = process.env.SMOKE_TRADE_AMOUNT ?? '0.5';
const REFUND_DEADLINE_SECONDS = Number(process.env.SMOKE_REFUND_DEADLINE ?? 20);
const OPERATOR_HANDLE = process.env.SMOKE_OPERATOR_HANDLE ?? 'operator';
const BUYER_HANDLE = process.env.SMOKE_BUYER_HANDLE ?? 'smoke-buyer';
const SELLER_HANDLE = process.env.SMOKE_SELLER_HANDLE ?? 'smoke-seller';
const GAS_BUFFER_USDC = process.env.SMOKE_GAS_BUFFER ?? '0.05';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
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

type UserRecord = { id: string; handle: string | null; walletAddress: string };

async function resolveOrCreateUser(handle: string): Promise<UserRecord> {
  const res = await fetch(`${BASE}/users/by-handle/${encodeURIComponent(handle)}`);
  if (res.ok) {
    console.log(`${YELLOW}↻ reusing user "${handle}"${RESET}`);
    return (await res.json()) as UserRecord;
  }
  if (res.status !== 404) throw new Error(`GET /users/by-handle/${handle} → HTTP ${res.status}`);
  console.log(`${YELLOW}+ creating user "${handle}"${RESET}`);
  return req<UserRecord>('POST', '/users', { handle });
}

async function usdcRaw(address: string): Promise<bigint> {
  const r = await req<{ raw: string }>('GET', `/arc/usdc-balance?address=${encodeURIComponent(address)}`);
  return BigInt(r.raw);
}

async function ensureBalance(user: UserRecord, funder: UserRecord, neededRaw: bigint, label: string) {
  if (user.walletAddress.toLowerCase() === funder.walletAddress.toLowerCase()) return;
  const bal = await usdcRaw(user.walletAddress);
  console.log(`${GREEN}→ ${label} USDC raw=${bal}, need=${neededRaw}${RESET}`);
  if (bal >= neededRaw) return;
  const topupRaw = neededRaw - bal;
  const topupUsdc = (Number(topupRaw) / 1_000_000).toFixed(6);
  console.log(`${YELLOW}↻ topping up ${label} with ${topupUsdc} USDC${RESET}`);
  await req('POST', '/wallet/transfer-usdc', {
    fromHandle: funder.handle ?? undefined,
    fromUserId: funder.handle ? undefined : funder.id,
    toAddress: user.walletAddress,
    amountUsdc: topupUsdc,
  });
}

function toRaw(usdc: string): bigint {
  return BigInt(Math.round(Number(usdc) * 1_000_000));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type TradeView = { status: string; deadline: number; arbitrator: string; depositUsdc: string };

async function createAcceptFund(seller: UserRecord, deadlineSeconds: number): Promise<string> {
  const created = await req<{ tradeId: string }>('POST', '/arc/trade/create', {
    handle: BUYER_HANDLE,
    seller: seller.walletAddress,
    amountUsdc: AMOUNT,
    milestone: 'dispute smoke',
    deadlineSeconds,
  });
  const id = created.tradeId;
  console.log(`${GREEN}→ tradeId=${id}${RESET}`);
  await req('POST', `/arc/trade/${id}/accept`, { handle: SELLER_HANDLE });
  await req('POST', `/arc/trade/${id}/fund`, { handle: BUYER_HANDLE });
  return id;
}

async function main() {
  step('Config');
  console.log({ BASE, AMOUNT, REFUND_DEADLINE_SECONDS, OPERATOR_HANDLE, BUYER_HANDLE, SELLER_HANDLE });

  step('0. Health');
  await req('GET', '/health');

  step('1. Resolve operator (funder), buyer, seller');
  const operator = await req<UserRecord>('GET', `/users/by-handle/${encodeURIComponent(OPERATOR_HANDLE)}`);
  const buyer = await resolveOrCreateUser(BUYER_HANDLE);
  const seller = await resolveOrCreateUser(SELLER_HANDLE);

  const gas = toRaw(GAS_BUFFER_USDC);
  // Two trades, each a fresh-buyer 100% deposit, plus gas for each leg.
  step('2. Fund buyer (2 deposits + gas) and seller (gas)');
  await ensureBalance(buyer, operator, toRaw(AMOUNT) * 2n + gas * 2n, 'buyer');
  await ensureBalance(seller, operator, gas, 'seller');

  // ── Scenario A: dispute ──────────────────────────────────────────────────
  step('A1. create → accept → fund (long deadline)');
  const idA = await createAcceptFund(seller, 3600);

  step('A2. Seller raises a dispute');
  await req('POST', `/arc/trade/${idA}/dispute`, { handle: SELLER_HANDLE });

  step('A3. Assert Disputed');
  const tA = await req<TradeView>('GET', `/arc/trade/${idA}`);
  if (tA.status !== 'Disputed') {
    console.error(`${RED}✗ expected Disputed, got ${tA.status}${RESET}`);
    process.exit(1);
  }
  console.log(`${GREEN}✓ trade ${idA} is Disputed${RESET}`);

  const operatorIsArbitrator = tA.arbitrator.toLowerCase() === operator.walletAddress.toLowerCase();
  if (operatorIsArbitrator) {
    step('A4. Operator is the arbitrator → resolve (release to seller)');
    const buyerBefore = await usdcRaw(buyer.walletAddress);
    await req('POST', `/arc/trade/${idA}/resolve`, { handle: OPERATOR_HANDLE, releaseToSeller: true });
    const tA2 = await req<TradeView>('GET', `/arc/trade/${idA}`);
    if (tA2.status !== 'Released') {
      console.error(`${RED}✗ expected Released after resolve, got ${tA2.status}${RESET}`);
      process.exit(1);
    }
    void buyerBefore;
    console.log(`${GREEN}✓ dispute resolved → Released${RESET}`);
  } else {
    console.log(
      `${YELLOW}⚠ arbitrator is ${tA.arbitrator} (not the operator ${operator.walletAddress}).\n` +
        `   resolveDispute is on-chain gated to the arbitrator, so this smoke leaves trade ${idA} Disputed.\n` +
        `   To exercise resolve end-to-end: run setArbitrator(operator) from the deployer, or connect the\n` +
        `   arbitrator wallet in the UI and use the resolve panel.${RESET}`,
    );
  }

  // ── Scenario B: refund after deadline ────────────────────────────────────
  step('B1. create → accept → fund (short deadline)');
  const buyerBeforeB = await usdcRaw(buyer.walletAddress);
  const idB = await createAcceptFund(seller, REFUND_DEADLINE_SECONDS);

  step('B2. Wait out the deadline');
  const tB = await req<TradeView>('GET', `/arc/trade/${idB}`);
  const waitMs = Math.max(0, (tB.deadline + 3) * 1000 - Date.now());
  console.log(`${YELLOW}…sleeping ${(waitMs / 1000).toFixed(1)}s until past the deadline${RESET}`);
  await sleep(waitMs);

  step('B3. Buyer claims refund');
  await req('POST', `/arc/trade/${idB}/refund`, { handle: BUYER_HANDLE });

  step('B4. Assert Refunded + buyer made whole');
  const tB2 = await req<TradeView>('GET', `/arc/trade/${idB}`);
  const buyerAfterB = await usdcRaw(buyer.walletAddress);
  if (tB2.status !== 'Refunded') {
    console.error(`${RED}✗ expected Refunded, got ${tB2.status}${RESET}`);
    process.exit(1);
  }
  // Buyer paid the deposit at fund and got it back at refund — net change is just gas.
  const net = buyerAfterB - buyerBeforeB;
  console.log(`${GREEN}→ buyer net across fund+refund = ${net} raw (deposit returned; difference is gas)${RESET}`);
  if (buyerAfterB <= buyerBeforeB - toRaw(AMOUNT)) {
    console.error(`${RED}✗ buyer did not get the deposit back${RESET}`);
    process.exit(1);
  }
  console.log(`${GREEN}✓ trade ${idB} Refunded, deposit returned to buyer${RESET}`);

  console.log(`\n${GREEN}${BOLD}✓ dispute + refund smoke OK${operatorIsArbitrator ? '' : ' (resolve gated — see note above)'}${RESET}`);
}

main().catch((err) => {
  console.error(`${RED}${err}${RESET}`);
  process.exit(1);
});
