import type { FastifyBaseLogger } from 'fastify';
import { parseEventLogs } from 'viem';
import { arcClient } from './arc.js';
import { tradeEscrowAbi } from './abis/trade-escrow.js';
import { db, getIndexerState, setIndexerState } from './db.js';

// Indexes every TradeEscrow event:
//  - trade_index: one row per TradeProposed (lists a user's trades)
//  - trade_events: one row per event (per-trade timeline + notifications)
// Mirrors the bridge/wrapper indexers: chunked getLogs from a checkpoint,
// INSERT OR IGNORE (idempotent on re-index).

const ESCROW = (process.env.TRADE_ESCROW_ADDRESS ?? '') as `0x${string}`;
const DEPLOY_BLOCK = BigInt(process.env.TRADE_ESCROW_DEPLOY_BLOCK ?? '45662878');
const POLL_INTERVAL_MS = Number(process.env.TRADE_INDEXER_POLL_MS ?? 10_000);
const MAX_BLOCKS_PER_QUERY = 5_000n;
const LAST_BLOCK_KEY = 'trade_index:last_block';

const insertTrade = db.prepare(
  `INSERT OR IGNORE INTO trade_index (trade_id, buyer, seller, created_block, tx_hash)
   VALUES (?, ?, ?, ?, ?)`,
);
const insertEvent = db.prepare(
  `INSERT OR IGNORE INTO trade_events (trade_id, kind, actor, amount_raw, block_number, tx_hash, log_index)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
);

// Pull the acting address + a relevant amount out of an event's args, whatever shape it is.
function actorOf(args: Record<string, unknown>): string | null {
  const a = (args.by ?? args.buyer ?? args.seller ?? args.attester) as `0x${string}` | undefined;
  return a ? a.toLowerCase() : null;
}
function amountOf(args: Record<string, unknown>): string | null {
  const v = (args.amount ?? args.newAmount ?? args.deposit ?? args.gross ?? args.toSeller ?? args.toBuyer) as
    | bigint
    | undefined;
  return v == null ? null : v.toString();
}

async function tick(log: FastifyBaseLogger): Promise<void> {
  const head = await arcClient.getBlockNumber();
  const last = getIndexerState(LAST_BLOCK_KEY);
  let from = last ? BigInt(last) + 1n : DEPLOY_BLOCK;
  if (from > head) return;

  let trades = 0;
  let events = 0;
  while (from <= head) {
    const to = from + MAX_BLOCKS_PER_QUERY - 1n > head ? head : from + MAX_BLOCKS_PER_QUERY - 1n;
    const raw = await arcClient.getLogs({ address: ESCROW, fromBlock: from, toBlock: to });
    const parsed = parseEventLogs({ abi: tradeEscrowAbi, logs: raw });

    for (const ev of parsed) {
      const args = ev.args as Record<string, unknown>;
      const id = args.id as bigint | undefined;
      if (id == null) continue;

      const r = insertEvent.run(
        Number(id),
        ev.eventName,
        actorOf(args),
        amountOf(args),
        Number(ev.blockNumber),
        ev.transactionHash,
        ev.logIndex ?? 0,
      );
      if (r.changes > 0) events += 1;

      if (ev.eventName === 'TradeProposed') {
        const t = insertTrade.run(
          Number(id),
          String(args.buyer).toLowerCase(),
          String(args.seller).toLowerCase(),
          Number(ev.blockNumber),
          ev.transactionHash,
        );
        if (t.changes > 0) trades += 1;
      }
    }

    setIndexerState(LAST_BLOCK_KEY, to.toString());
    from = to + 1n;
  }
  if (trades > 0 || events > 0) log.info({ trades, events, head: head.toString() }, 'trade indexer caught up');
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
