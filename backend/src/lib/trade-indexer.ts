import type { FastifyBaseLogger } from 'fastify';
import { parseAbiItem } from 'viem';
import { arcClient } from './arc.js';
import { db, getIndexerState, setIndexerState } from './db.js';

// Indexes TradeCreated events from the standalone TradeEscrow so the frontend
// can list a user's trades (as buyer or seller). Mirrors the bridge/wrapper
// indexers: chunked getLogs from a checkpoint, INSERT OR IGNORE (idempotent).

const ESCROW = (process.env.TRADE_ESCROW_ADDRESS ?? '') as `0x${string}`;
const DEPLOY_BLOCK = BigInt(process.env.TRADE_ESCROW_DEPLOY_BLOCK ?? '45662878');
const POLL_INTERVAL_MS = Number(process.env.TRADE_INDEXER_POLL_MS ?? 10_000);
const MAX_BLOCKS_PER_QUERY = 5_000n;
const LAST_BLOCK_KEY = 'trade_index:last_block';

const tradeCreatedEvent = parseAbiItem(
  'event TradeCreated(uint256 indexed id, address indexed buyer, address indexed seller, uint256 amount, uint256 deposit, address attester)',
);

const insertTrade = db.prepare(
  `INSERT OR IGNORE INTO trade_index (trade_id, buyer, seller, created_block, tx_hash)
   VALUES (?, ?, ?, ?, ?)`,
);

async function tick(log: FastifyBaseLogger): Promise<void> {
  const head = await arcClient.getBlockNumber();
  const last = getIndexerState(LAST_BLOCK_KEY);
  let from = last ? BigInt(last) + 1n : DEPLOY_BLOCK;
  if (from > head) return;

  let inserted = 0;
  while (from <= head) {
    const to = from + MAX_BLOCKS_PER_QUERY - 1n > head ? head : from + MAX_BLOCKS_PER_QUERY - 1n;
    const logs = await arcClient.getLogs({ address: ESCROW, event: tradeCreatedEvent, fromBlock: from, toBlock: to });
    for (const l of logs) {
      const a = l.args;
      if (a.id == null || !a.buyer || !a.seller) continue;
      const r = insertTrade.run(Number(a.id), a.buyer.toLowerCase(), a.seller.toLowerCase(), Number(l.blockNumber), l.transactionHash);
      if (r.changes > 0) inserted += 1;
    }
    setIndexerState(LAST_BLOCK_KEY, to.toString());
    from = to + 1n;
  }
  if (inserted > 0) log.info({ inserted, head: head.toString() }, 'trade indexer caught up');
}

export function startTradeIndexer(log: FastifyBaseLogger): void {
  if (!ESCROW) {
    log.warn('TRADE_ESCROW_ADDRESS unset — trade indexer disabled');
    return;
  }
  const loop = () =>
    tick(log)
      .catch((err) => log.error(err, 'trade indexer tick failed'))
      .finally(() => setTimeout(loop, POLL_INTERVAL_MS));
  loop();
}
