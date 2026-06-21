import 'dotenv/config';
import { db } from '../src/lib/db.js';
import { GATEWAY_DESTINATIONS } from '../src/lib/gateway.js';

// Backfill a gateway_payouts row for a trade routed BEFORE the table existed,
// so the trade page shows the completed payout (and can't be re-routed).
//
// Usage: tsx scripts/backfill-gateway-payout.ts <tradeId> <destKey> <amountUsdc> <recipient> <mintTx>
// e.g.   tsx scripts/backfill-gateway-payout.ts 3 avalancheFuji 33 0x81F5321e62660E4802E306b02447682ef3742C11 0x433ba228bfbd2fcf332ca31945854d8f250a3c197b96e8acff9d150bcb4de86f
const [, , tradeId, destKey, amount, recipient, mintTx] = process.argv;
if (!tradeId || !destKey || !amount || !recipient || !mintTx) {
  console.error('Usage: tsx scripts/backfill-gateway-payout.ts <tradeId> <destKey> <amountUsdc> <recipient> <mintTx>');
  process.exit(1);
}
const dest = GATEWAY_DESTINATIONS.find((d) => d.key === destKey);
if (!dest) {
  console.error(`Unknown destKey '${destKey}'. Known: ${GATEWAY_DESTINATIONS.map((d) => d.key).join(', ')}`);
  process.exit(1);
}
const explorer = dest.chain.blockExplorers?.default.url?.replace(/\/$/, '');
const mintTxUrl = explorer ? `${explorer}/tx/${mintTx}` : null;

const info = db
  .prepare(
    `INSERT OR IGNORE INTO gateway_payouts (trade_id, destination_key, destination_name, amount_usdc, recipient, mint_tx, mint_tx_url)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  .run(Number(tradeId), dest.key, dest.name, amount, recipient, mintTx, mintTxUrl);

console.log(info.changes ? `✓ Backfilled payout for trade #${tradeId} → ${dest.name}.` : `Trade #${tradeId} already has a payout row — nothing changed.`);
