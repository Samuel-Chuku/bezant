import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { keccak256 } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { db } from '../src/lib/db.js';

// Focused smoke for the trade delivery-file endpoints (upload + parties-only
// verified download). It seeds the *prerequisites* directly in the same SQLite
// the running backend uses - a trade_index row (buyer/seller) and an
// officer_reviews row committing the file hash - so we can exercise the new
// endpoints in isolation, without a funded on-chain trade or Circle. Throwaway
// EOAs sign the read challenge (an EOA can sign; custodial smoke accounts can't).
//
// Prereqs: backend running (`npm run dev`) with a working ARC_RPC_URL (the read
// challenge verifies signatures via the chain's universal validator).
// Run:  npm run smoke:delivery-file

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:3001';
const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', BOLD = '\x1b[1m', RESET = '\x1b[0m';

let failures = 0;
function check(label: string, cond: boolean, detail = '') {
  console.log(`${cond ? GREEN + '✓' : RED + '✗'}${RESET} ${label}${detail ? ` ${DIM}${detail}${RESET}` : ''}`);
  if (!cond) failures += 1;
}

function readChallenge(tradeId: number, ts: number): string {
  return `arc-trade:read-trade-delivery:${tradeId}:${ts}`;
}

async function main() {
  console.log(`${BOLD}Trade delivery-file smoke${RESET} — base ${BASE}\n`);

  const seller = privateKeyToAccount(generatePrivateKey());
  const buyer = privateKeyToAccount(generatePrivateKey());
  const stranger = privateKeyToAccount(generatePrivateKey());
  const tradeId = 900_000 + Math.floor(Math.random() * 90_000);

  // A pretend delivery file + its keccak hash (as the seller would commit it).
  const bytes = randomBytes(4096);
  const fileHash = keccak256(new Uint8Array(bytes)).toLowerCase();
  const fileName = 'delivery-proof.png';
  const fileMime = 'image/png';
  const fileBase64 = Buffer.from(bytes).toString('base64');

  console.log(`${DIM}tradeId=${tradeId} seller=${seller.address} buyer=${buyer.address}${RESET}\n`);

  // ── Seed prerequisites in the shared SQLite ────────────────────────────────
  db.prepare(
    'INSERT OR REPLACE INTO trade_index (trade_id, buyer, seller, created_block, tx_hash) VALUES (?, ?, ?, 0, ?)',
  ).run(tradeId, buyer.address.toLowerCase(), seller.address.toLowerCase(), '0xsmoke');
  db.prepare(
    "INSERT OR REPLACE INTO officer_reviews (trade_id, document, reasons, confidence, file_hash, file_name, file_mime, file_size) VALUES (?, 'smoke delivery', '[]', 0.9, ?, ?, ?, ?)",
  ).run(tradeId, fileHash, fileName, fileMime, bytes.length);

  try {
    // ── 1. Upload (content-addressed, seller only) ───────────────────────────
    const up = await fetch(`${BASE}/arc/trade/${tradeId}/delivery-file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileBase64, fileName, mime: fileMime, uploadedBy: seller.address }),
    });
    check('seller upload → 201', up.status === 201, `(got ${up.status})`);

    // ── 2. Non-seller upload of a different file → 400 (hash mismatch) ────────
    const wrong = Buffer.from(randomBytes(1024)).toString('base64');
    const upBad = await fetch(`${BASE}/arc/trade/${tradeId}/delivery-file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileBase64: wrong, fileName, mime: fileMime, uploadedBy: seller.address }),
    });
    check('mismatched bytes → 400', upBad.status === 400, `(got ${upBad.status})`);

    // ── 3. Non-seller uploader → 403 ─────────────────────────────────────────
    const upStranger = await fetch(`${BASE}/arc/trade/${tradeId}/delivery-file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileBase64, fileName, mime: fileMime, uploadedBy: stranger.address }),
    });
    check('non-seller upload → 403', upStranger.status === 403, `(got ${upStranger.status})`);

    // ── 4. Buyer (a party) downloads + we re-verify the hash ─────────────────
    const ts = Math.floor(Date.now() / 1000);
    const buyerSig = await buyer.signMessage({ message: readChallenge(tradeId, ts) });
    const dl = await fetch(`${BASE}/arc/trade/${tradeId}/delivery-file/download?hash=${fileHash}`, {
      headers: { 'x-arc-viewer': buyer.address, 'x-arc-sig': buyerSig, 'x-arc-ts': String(ts) },
    });
    check('buyer download → 200', dl.status === 200, `(got ${dl.status})`);
    if (dl.status === 200) {
      const got = new Uint8Array(await dl.arrayBuffer());
      check('downloaded bytes hash matches committed', keccak256(got).toLowerCase() === fileHash);
    }

    // ── 5. Stranger (non-party) download → 403 ───────────────────────────────
    const sSig = await stranger.signMessage({ message: readChallenge(tradeId, ts) });
    const dlStranger = await fetch(`${BASE}/arc/trade/${tradeId}/delivery-file/download?hash=${fileHash}`, {
      headers: { 'x-arc-viewer': stranger.address, 'x-arc-sig': sSig, 'x-arc-ts': String(ts) },
    });
    check('non-party download → 403', dlStranger.status === 403, `(got ${dlStranger.status})`);

    // ── 6. Missing/unsigned download → 401 ───────────────────────────────────
    const dlNoAuth = await fetch(`${BASE}/arc/trade/${tradeId}/delivery-file/download?hash=${fileHash}`);
    check('unauthenticated download → 401', dlNoAuth.status === 401, `(got ${dlNoAuth.status})`);
  } finally {
    // Best-effort cleanup of the seeded rows + stored file.
    db.prepare('DELETE FROM trade_index WHERE trade_id = ?').run(tradeId);
    db.prepare('DELETE FROM officer_reviews WHERE trade_id = ?').run(tradeId);
    db.prepare('DELETE FROM trade_deliverables WHERE trade_id = ?').run(tradeId);
    try {
      rmSync(resolve(process.cwd(), 'data', 'trade-deliverables', String(tradeId)), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  console.log();
  if (failures) {
    console.log(`${RED}${BOLD}✗ ${failures} check(s) failed${RESET}`);
    process.exit(1);
  }
  console.log(`${GREEN}${BOLD}✓ delivery-file endpoints OK — upload, hash-binding, parties-only download all verified${RESET}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`${RED}${err}${RESET}`);
  process.exit(1);
});
