import type { FastifyBaseLogger } from 'fastify';
import { parseEventLogs, type Abi } from 'viem';
import { arcClient } from './arc.js';
import { tradeEscrowAbi } from './abis/trade-escrow.js';
import { financingPoolAbi } from './abis/financing-pool.js';
import { stakedVerifierAbi } from './abis/staked-verifier.js';
import { db, getIndexerState, setIndexerState } from './db.js';

// Indexes every TradeEscrow event:
//  - trade_index: one row per TradeProposed (lists a user's trades)
//  - trade_events: one row per event (per-trade timeline + notifications)
// Mirrors the bridge/wrapper indexers: chunked getLogs from a checkpoint,
// INSERT OR IGNORE (idempotent on re-index).

const ESCROW = (process.env.TRADE_ESCROW_ADDRESS ?? '') as `0x${string}`;
const POOL = (process.env.FINANCING_POOL_ADDRESS ?? '') as `0x${string}`;
const VERIFIER = (process.env.STAKED_VERIFIER_ADDRESS ?? '') as `0x${string}`;
// A freshly (re)deployed module is recent, so backfill a bounded recent window
// on first sight rather than scanning from the escrow deploy block.
const VERIFIER_LOOKBACK = 200_000n;
const DEPLOY_BLOCK = BigInt(process.env.TRADE_ESCROW_DEPLOY_BLOCK ?? '45662878');
const POLL_INTERVAL_MS = Number(process.env.TRADE_INDEXER_POLL_MS ?? 10_000);
const MAX_BLOCKS_PER_QUERY = 5_000n;
const LAST_BLOCK_KEY = 'trade_index:last_block';
const POOL_LAST_BLOCK_KEY = 'pool_index:last_block';
const NAV_SNAPSHOT_KEY = 'pool_nav:last_ts';
const NAV_SNAPSHOT_INTERVAL_MS = 3_600_000; // hourly

const insertTrade = db.prepare(
  `INSERT OR IGNORE INTO trade_index (trade_id, buyer, seller, created_block, tx_hash)
   VALUES (?, ?, ?, ?, ?)`,
);
const insertEvent = db.prepare(
  `INSERT OR IGNORE INTO trade_events (trade_id, kind, actor, amount_raw, block_number, tx_hash, log_index)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
);
const insertPoolEvent = db.prepare(
  `INSERT OR IGNORE INTO pool_events (lp, kind, assets_raw, shares_raw, block_number, block_time, tx_hash, log_index)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
);
const insertNavSnapshot = db.prepare(
  `INSERT OR REPLACE INTO pool_nav_snapshots (ts, share_price) VALUES (?, ?)`,
);
const insertVerifierEvent = db.prepare(
  `INSERT OR IGNORE INTO verifier_events (module, verifier, kind, amount_raw, block_number, block_time, tx_hash, log_index)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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

  // FinancingPool LP events → pool_events. Independent checkpoint so it
  // backfills from the deploy block even though the escrow checkpoint has
  // already advanced past the user's earlier deposits.
  const poolEvents = POOL ? await tickPool(head) : 0;
  if (POOL) await maybeSnapshotNav();

  const verifierEvents = VERIFIER ? await tickVerifier(head) : 0;

  if (trades > 0 || events > 0 || poolEvents > 0 || verifierEvents > 0)
    log.info({ trades, events, poolEvents, verifierEvents, head: head.toString() }, 'trade indexer caught up');
}

// Scan StakedVerifierModule Staked/Unstaked into verifier_events. Checkpoint is
// per-module so a redeploy starts fresh (and its events are tagged with `module`).
async function tickVerifier(head: bigint): Promise<number> {
  const key = `verifier_index:last_block:${VERIFIER.toLowerCase()}`;
  const last = getIndexerState(key);
  let from = last ? BigInt(last) + 1n : head > VERIFIER_LOOKBACK ? head - VERIFIER_LOOKBACK : 0n;
  let inserted = 0;
  while (from <= head) {
    const to = from + MAX_BLOCKS_PER_QUERY - 1n > head ? head : from + MAX_BLOCKS_PER_QUERY - 1n;
    const logs = await arcClient.getLogs({ address: VERIFIER, fromBlock: from, toBlock: to });
    const evs = parseEventLogs({ abi: stakedVerifierAbi as Abi, logs }).filter(
      (ev) => ev.eventName === 'Staked' || ev.eventName === 'Unstaked',
    );
    const tsByBlock = new Map<bigint, number>();
    await Promise.all(
      [...new Set(evs.map((ev) => ev.blockNumber))].map(async (b) => {
        const blk = await arcClient.getBlock({ blockNumber: b });
        tsByBlock.set(b, Number(blk.timestamp) * 1000);
      }),
    );
    for (const ev of evs) {
      const a = ev.args as { verifier: string; amount: bigint };
      const r = insertVerifierEvent.run(
        VERIFIER.toLowerCase(),
        a.verifier.toLowerCase(),
        ev.eventName === 'Staked' ? 'verifier-stake' : 'verifier-unstake',
        a.amount.toString(),
        Number(ev.blockNumber),
        tsByBlock.get(ev.blockNumber) ?? null,
        ev.transactionHash,
        ev.logIndex ?? 0,
      );
      if (r.changes > 0) inserted += 1;
    }
    setIndexerState(key, to.toString());
    from = to + 1n;
  }
  return inserted;
}

// Sample the pool's share price at most once an hour for the 24h / 7d yield.
async function maybeSnapshotNav(): Promise<void> {
  const lastTs = Number(getIndexerState(NAV_SNAPSHOT_KEY) ?? '0');
  if (Date.now() - lastTs < NAV_SNAPSHOT_INTERVAL_MS) return;
  const [ta, ts] = (await Promise.all([
    arcClient.readContract({ address: POOL, abi: financingPoolAbi as Abi, functionName: 'totalAssets' }),
    arcClient.readContract({ address: POOL, abi: financingPoolAbi as Abi, functionName: 'totalShares' }),
  ])) as [bigint, bigint];
  const price = ts > 0n ? Number(ta) / Number(ts) : 1;
  const now = Date.now();
  insertNavSnapshot.run(now, price);
  setIndexerState(NAV_SNAPSHOT_KEY, String(now));
}

// Scan FinancingPool Deposit/Withdraw from the pool's own checkpoint up to
// `head`, writing pool_events. Returns the number of new rows.
async function tickPool(head: bigint): Promise<number> {
  const last = getIndexerState(POOL_LAST_BLOCK_KEY);
  let from = last ? BigInt(last) + 1n : DEPLOY_BLOCK;
  let inserted = 0;
  while (from <= head) {
    const to = from + MAX_BLOCKS_PER_QUERY - 1n > head ? head : from + MAX_BLOCKS_PER_QUERY - 1n;
    const logs = await arcClient.getLogs({ address: POOL, fromBlock: from, toBlock: to });
    const lpEvents = parseEventLogs({ abi: financingPoolAbi as Abi, logs }).filter(
      (ev) => ev.eventName === 'Deposit' || ev.eventName === 'Withdraw',
    );
    const tsByBlock = new Map<bigint, number>();
    await Promise.all(
      [...new Set(lpEvents.map((ev) => ev.blockNumber))].map(async (b) => {
        const blk = await arcClient.getBlock({ blockNumber: b });
        tsByBlock.set(b, Number(blk.timestamp) * 1000);
      }),
    );
    for (const ev of lpEvents) {
      const a = ev.args as { lp: string; assets: bigint; shares: bigint };
      const r = insertPoolEvent.run(
        a.lp.toLowerCase(),
        ev.eventName === 'Deposit' ? 'pool-deposit' : 'pool-withdraw',
        a.assets.toString(),
        a.shares.toString(),
        Number(ev.blockNumber),
        tsByBlock.get(ev.blockNumber) ?? null,
        ev.transactionHash,
        ev.logIndex ?? 0,
      );
      if (r.changes > 0) inserted += 1;
    }
    setIndexerState(POOL_LAST_BLOCK_KEY, to.toString());
    from = to + 1n;
  }
  return inserted;
}

export function startTradeIndexer(log: FastifyBaseLogger): void {
  if (!ESCROW) {
    log.warn('TRADE_ESCROW_ADDRESS unset - trade indexer disabled');
    return;
  }
  const loop = () =>
    tick(log)
      .catch((err) => log.error(err, 'trade indexer tick failed'))
      .finally(() => setTimeout(loop, POLL_INTERVAL_MS));
  loop();
}
