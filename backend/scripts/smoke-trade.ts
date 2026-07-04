import 'dotenv/config';
import { authHeadersForBody, rememberAccountKey } from './lib/account-keys';

// End-to-end smoke for the standalone escrow loop:
//   create (buyer) -> fund (buyer) -> [finance (seller)] -> attest (operator)
//   -> release (operator) -> assert status Released.
//
// Prereqs: server running, contracts deployed, backend/.env has
// TRADE_ESCROW_ADDRESS / TRADE_PASSPORT_ADDRESS / FINANCING_POOL_ADDRESS and the
// CIRCLE_* operator wallet. The operator is the Trade Officer agent (attester).
//
// Run:  npm run smoke:trade

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:3001';
const AMOUNT = process.env.SMOKE_TRADE_AMOUNT ?? '0.5'; // USDC trade value
const DEADLINE_SECONDS = Number(process.env.SMOKE_TRADE_DEADLINE ?? 3600);
const DO_FINANCE = (process.env.SMOKE_TRADE_FINANCE ?? 'false').toLowerCase() === 'true';
const USE_OFFICER = (process.env.SMOKE_USE_OFFICER ?? 'true').toLowerCase() === 'true';
const YIELD_USDC = process.env.SMOKE_YIELD_USDC ?? '0'; // simulate USYC yield while locked
const YIELD_VAULT = process.env.SMOKE_YIELD_VAULT ?? ''; // MockYieldVault address
const POOL_ADDR = process.env.FINANCING_POOL_ADDRESS ?? '';
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
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...authHeadersForBody(body) },
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
    const user = (await res.json()) as UserRecord;
    console.log(`${YELLOW}↻ reusing user "${handle}"${RESET}`);
    return user;
  }
  if (res.status !== 404) throw new Error(`GET /users/by-handle/${handle} → HTTP ${res.status}`);
  console.log(`${YELLOW}+ creating user "${handle}"${RESET}`);
  const created = await req<UserRecord & { accountKey?: string }>('POST', '/users', { handle });
  if (created.accountKey) rememberAccountKey(handle, created.accountKey);
  return created;
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

async function main() {
  step('Config');
  console.log({ BASE, AMOUNT, DEADLINE_SECONDS, DO_FINANCE, OPERATOR_HANDLE, BUYER_HANDLE, SELLER_HANDLE });

  step('0. Health');
  await req('GET', '/health');

  step('1. Resolve operator (attester + funder), buyer, seller');
  const operator = await req<UserRecord>('GET', `/users/by-handle/${encodeURIComponent(OPERATOR_HANDLE)}`);
  const buyer = await resolveOrCreateUser(BUYER_HANDLE);
  const seller = await resolveOrCreateUser(SELLER_HANDLE);

  // New buyer => 100% deposit, so buyer needs the full trade amount + gas.
  const gasBuffer = toRaw(GAS_BUFFER_USDC);
  step('2. Ensure buyer has deposit + gas');
  await ensureBalance(buyer, operator, toRaw(AMOUNT) + gasBuffer, 'buyer');
  step('2b. Ensure seller has gas');
  await ensureBalance(seller, operator, gasBuffer, 'seller');

  const sellerBalBefore = await usdcRaw(seller.walletAddress);
  const yieldRaw = toRaw(YIELD_USDC);
  const poolBalBefore = POOL_ADDR && yieldRaw > 0n ? await usdcRaw(POOL_ADDR) : 0n;

  step('3. Create trade (buyer proposes)');
  const created = await req<{ tradeId: string; amountUsdc: string }>('POST', '/arc/trade/create', {
    handle: BUYER_HANDLE,
    seller: seller.walletAddress,
    amountUsdc: AMOUNT,
    milestone: 'smoke delivery',
    deadlineSeconds: DEADLINE_SECONDS,
  });
  const tradeId = created.tradeId;
  console.log(`${GREEN}→ tradeId=${tradeId}, amount=${created.amountUsdc} USDC${RESET}`);

  step('3b. Seller accepts the offer');
  await req('POST', `/arc/trade/${tradeId}/accept`, { handle: SELLER_HANDLE });

  step('4. Fund trade (buyer: approve + lock)');
  await req('POST', `/arc/trade/${tradeId}/fund`, { handle: BUYER_HANDLE });

  if (yieldRaw > 0n && YIELD_VAULT) {
    step('4b. Simulate USYC yield — operator sends USDC into the vault while funds are locked');
    await req('POST', '/wallet/transfer-usdc', {
      fromHandle: OPERATOR_HANDLE,
      toAddress: YIELD_VAULT,
      amountUsdc: YIELD_USDC,
    });
  }

  if (DO_FINANCE) {
    step('5. Request financing (seller, during Funded phase)');
    await req('POST', `/arc/trade/${tradeId}/finance`, { handle: SELLER_HANDLE });
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const waitForReleased = async (maxSeconds: number) => {
    const until = Date.now() + maxSeconds * 1000;
    while (Date.now() < until) {
      const t = await req<{ status: string }>('GET', `/arc/trade/${tradeId}`);
      if (t.status === 'Released') return;
      await sleep(3000);
    }
  };

  const attest = async () => {
    if (USE_OFFICER) {
      step('Attest via Trade Officer agent (doc-ingest → approve+window or escalate)');
      const r = await req<{ decision: string; attested: boolean; challengeWindowSeconds?: number }>('POST', `/arc/trade/${tradeId}/officer-attest`, {
        document: {
          kind: 'bill_of_lading',
          reference: 'MAEU123456789',
          content: 'Bill of Lading MAEU123456789 — 2000kg textiles, Jebel Ali to Lagos, carrier Maersk, cleared.',
          carrier: 'Maersk',
          origin: 'Jebel Ali',
          destination: 'Lagos',
        },
      });
      if (r.decision !== 'pass') {
        console.error(`${RED}✗ officer escalated instead of approving (decision=${r.decision}); lower SMOKE_TRADE_AMOUNT below OFFICER_HIGH_VALUE_USDC${RESET}`);
        process.exit(1);
      }
      // Officer approved → opened the buyer challenge window; the finalizer
      // settles once it elapses. Wait it out (no dispute raised here).
      const windowS = r.challengeWindowSeconds ?? 30;
      step(`Waiting out the ${windowS}s buyer challenge window for auto-settle`);
      await waitForReleased(windowS + 30);
    } else {
      step('Attest delivery (operator, direct — settles immediately)');
      await req('POST', `/arc/trade/${tradeId}/attest`, { handle: OPERATOR_HANDLE, proof: 'BoL#smoke', passed: true });
    }
  };

  // Officer approval opens a buyer challenge window; settlement follows once it elapses.
  await attest();

  step('6. Verify final state (settled after the challenge window)');
  const trade = await req<{ status: string }>('GET', `/arc/trade/${tradeId}`);
  const sellerBalAfter = await usdcRaw(seller.walletAddress);
  const gained = sellerBalAfter - sellerBalBefore;
  console.log(`${GREEN}→ seller gained raw=${gained} (${(Number(gained) / 1_000_000).toFixed(6)} USDC)${RESET}`);

  if (trade.status !== 'Released') {
    console.error(`${RED}✗ expected status Released, got ${trade.status}${RESET}`);
    process.exit(1);
  }
  if (gained <= 0n) {
    console.error(`${RED}✗ seller balance did not increase${RESET}`);
    process.exit(1);
  }

  // Yield split verification (non-finance flow: seller + pool pay no gas, so deltas are exact).
  if (yieldRaw > 0n && !DO_FINANCE && POOL_ADDR) {
    const poolBalAfter = await usdcRaw(POOL_ADDR);
    const poolDelta = poolBalAfter - poolBalBefore;
    const buyerCut = (yieldRaw * 4000n) / 10000n;
    const poolCut = (yieldRaw * 3000n) / 10000n;
    const sellerCut = yieldRaw - buyerCut - poolCut;
    const depositRaw = toRaw(AMOUNT); // fresh buyer => 100% deposit
    const expectedSellerGain = depositRaw + sellerCut;
    step('9. Verify USYC yield split (buyer 40 / seller 30 / pool 30)');
    console.log(`${GREEN}→ yield=${yieldRaw} | pool slice got=${poolDelta} expect=${poolCut}${RESET}`);
    console.log(`${GREEN}→ seller gained=${gained} expect=${expectedSellerGain} (deposit ${depositRaw} + 30% yield ${sellerCut})${RESET}`);
    if (poolDelta !== poolCut) {
      console.error(`${RED}✗ pool yield slice mismatch${RESET}`);
      process.exit(1);
    }
    if (gained !== expectedSellerGain) {
      console.error(`${RED}✗ seller yield slice mismatch${RESET}`);
      process.exit(1);
    }
    console.log(`${GREEN}${BOLD}✓ yield split verified on-chain${RESET}`);
  }

  console.log(`\n${GREEN}${BOLD}✓ trade loop OK — status Released, seller paid${RESET}`);
}

main().catch((err) => {
  console.error(`${RED}${err}${RESET}`);
  process.exit(1);
});
