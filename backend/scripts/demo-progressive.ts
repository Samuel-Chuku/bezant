import 'dotenv/config';

// Progressive-trust demo: runs one buyer through N trades and shows the passport
// mechanically stepping the required deposit down as the track record grows.
// Each trade goes the full loop: create -> fund -> officer-attest -> release.
//
// Curve (deposit by completed-trade count): 0-2 100%, 3-5 90%, 6-10 80%, ...
// So with N=7 you see: 100,100,100,90,90,90,80.
//
// Run:  npm run demo:progressive        (defaults: 7 trades, 0.1 USDC each)

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:3001';
const N = Number(process.env.DEMO_TRADES ?? 7);
const AMOUNT = process.env.DEMO_AMOUNT ?? '0.1';
const OPERATOR_HANDLE = process.env.SMOKE_OPERATOR_HANDLE ?? 'operator';
const BUYER_HANDLE = process.env.DEMO_BUYER_HANDLE ?? `demo-buyer-${Date.now()}`;
const SELLER_HANDLE = process.env.DEMO_SELLER_HANDLE ?? 'demo-seller';
const GAS_BUFFER_USDC = process.env.SMOKE_GAS_BUFFER ?? '0.1';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

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
  return parsed as T;
}

type UserRecord = { id: string; handle: string | null; walletAddress: string };

async function resolveOrCreateUser(handle: string): Promise<UserRecord> {
  const res = await fetch(`${BASE}/users/by-handle/${encodeURIComponent(handle)}`);
  if (res.ok) return (await res.json()) as UserRecord;
  if (res.status !== 404) throw new Error(`GET /users/by-handle/${handle} → HTTP ${res.status}`);
  return req<UserRecord>('POST', '/users', { handle });
}

async function usdcRaw(address: string): Promise<bigint> {
  const r = await req<{ raw: string }>('GET', `/arc/usdc-balance?address=${encodeURIComponent(address)}`);
  return BigInt(r.raw);
}

function toRaw(usdc: string): bigint {
  return BigInt(Math.round(Number(usdc) * 1_000_000));
}

async function main() {
  console.log(`${BOLD}Progressive-trust demo — ${N} trades of ${AMOUNT} USDC, buyer "${BUYER_HANDLE}"${RESET}`);

  const operator = await req<UserRecord>('GET', `/users/by-handle/${encodeURIComponent(OPERATOR_HANDLE)}`);
  const buyer = await resolveOrCreateUser(BUYER_HANDLE);
  const seller = await resolveOrCreateUser(SELLER_HANDLE);

  // Fund the buyer up front: first 3 trades are full-collateral, so budget N*amount + gas.
  const needed = toRaw(AMOUNT) * BigInt(N) + toRaw(GAS_BUFFER_USDC) * BigInt(N);
  const bal = await usdcRaw(buyer.walletAddress);
  if (bal < needed) {
    const topup = (Number(needed - bal) / 1_000_000).toFixed(6);
    console.log(`${YELLOW}topping up buyer with ${topup} USDC${RESET}`);
    await req('POST', '/wallet/transfer-usdc', { fromHandle: OPERATOR_HANDLE, toAddress: buyer.walletAddress, amountUsdc: topup });
  }

  // Seller signs `accept` each trade, so it needs gas (Arc pays gas in USDC).
  const sellerNeeded = toRaw(GAS_BUFFER_USDC) * BigInt(N);
  const sBal = await usdcRaw(seller.walletAddress);
  if (sBal < sellerNeeded) {
    const topup = (Number(sellerNeeded - sBal) / 1_000_000).toFixed(6);
    console.log(`${YELLOW}topping up seller with ${topup} USDC (gas)${RESET}`);
    await req('POST', '/wallet/transfer-usdc', { fromHandle: OPERATOR_HANDLE, toAddress: seller.walletAddress, amountUsdc: topup });
  }

  const rows: { n: number; completedBefore: number; deposit: string; pct: string }[] = [];

  for (let n = 1; n <= N; n++) {
    const created = await req<{ tradeId: string }>('POST', '/arc/trade/create', {
      handle: BUYER_HANDLE,
      seller: seller.walletAddress,
      amountUsdc: AMOUNT,
      milestone: `progressive demo trade ${n}`,
    });
    const tradeId = created.tradeId;

    await req('POST', `/arc/trade/${tradeId}/accept`, { handle: SELLER_HANDLE });
    const funded = await req<{ depositUsdc: string }>('POST', `/arc/trade/${tradeId}/fund`, { handle: BUYER_HANDLE });
    const pct = ((Number(funded.depositUsdc) / Number(AMOUNT)) * 100).toFixed(0);
    rows.push({ n, completedBefore: n - 1, deposit: funded.depositUsdc, pct: `${pct}%` });
    console.log(`${GREEN}trade ${n}: ${n - 1} prior completions → deposit ${funded.depositUsdc} USDC (${pct}%)${RESET}`);

    const att = await req<{ attested: boolean }>('POST', `/arc/trade/${tradeId}/officer-attest`, {
      document: { kind: 'bill_of_lading', reference: `MAEU${1000000 + n}`, content: `BoL MAEU${1000000 + n} cleared, demo trade ${n}.` },
    });
    if (!att.attested) throw new Error(`trade ${n}: officer escalated unexpectedly`);
    // officer attestation auto-settles — no release step
  }

  console.log(`\n${BOLD}Progressive-trust schedule (this run):${RESET}`);
  console.log('  trade │ prior trades │ deposit');
  console.log('  ──────┼──────────────┼─────────');
  for (const r of rows) {
    console.log(`   ${String(r.n).padStart(3)}  │     ${String(r.completedBefore).padStart(2)}       │  ${r.pct}`);
  }
  console.log(`\n${GREEN}${BOLD}✓ ${N} trades settled — deposit stepped down with reputation${RESET}`);
}

main().catch((err) => {
  console.error(`${RED}${err}${RESET}`);
  process.exit(1);
});
