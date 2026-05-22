import type { FastifyBaseLogger } from 'fastify';
import { arcClient, ERC8183_ADDRESS } from './arc.js';
import {
  jobCreatedEvent,
  jobFundedEvent,
  jobRefundedEvent,
  jobSubmittedEvent,
  jobCompletedEvent,
  jobRejectedEvent,
} from './abis/erc8183.js';
import { db, getIndexerState, setIndexerState } from './db.js';

// How often to poll the chain for new events.
const POLL_INTERVAL_MS = Number(process.env.JOB_INDEXER_POLL_MS ?? 10_000);

// How far back to scan on first run if there's no saved progress.
// Arc Testnet runs ~400ms blocks (head ~43M after ~6 months live), so
// 1M blocks ≈ 4–5 days of history — covers our smoke test trail.
// First-time backfill takes ~30–60s; subsequent boots only catch the delta.
const INITIAL_LOOKBACK_BLOCKS = BigInt(process.env.JOB_INDEXER_LOOKBACK ?? 1_000_000);

// viem caps a single getLogs call. Stay well under to be safe.
const MAX_BLOCKS_PER_QUERY = 5_000n;

const LAST_BLOCK_KEY = 'jobs_index:last_block';
const EVENTS_LAST_BLOCK_KEY = 'job_events:last_block';

const insertJob = db.prepare(
  `INSERT OR IGNORE INTO jobs_index
   (job_id, client, provider, evaluator, expired_at, hook, block_number, tx_hash)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
);

const insertJobEvent = db.prepare(
  `INSERT OR IGNORE INTO job_events
   (job_id, event_type, hash_value, amount_raw, actor, block_number, tx_hash, log_index)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
);

function startBlock(stored: string | null, head: bigint): bigint {
  if (stored) return BigInt(stored) + 1n;
  return head > INITIAL_LOOKBACK_BLOCKS ? head - INITIAL_LOOKBACK_BLOCKS : 0n;
}

async function pollJobsOnce(log: FastifyBaseLogger): Promise<void> {
  const head = await arcClient.getBlockNumber();
  let from = startBlock(getIndexerState(LAST_BLOCK_KEY), head);
  if (from > head) return;

  let inserted = 0;
  while (from <= head) {
    const to = from + MAX_BLOCKS_PER_QUERY - 1n > head ? head : from + MAX_BLOCKS_PER_QUERY - 1n;
    const logs = await arcClient.getLogs({
      address: ERC8183_ADDRESS,
      event: jobCreatedEvent,
      fromBlock: from,
      toBlock: to,
    });
    for (const entry of logs) {
      const args = entry.args;
      if (!args.jobId || !args.client || !args.provider) continue;
      const result = insertJob.run(
        args.jobId.toString(),
        args.client.toLowerCase(),
        args.provider.toLowerCase(),
        (args.evaluator ?? '').toLowerCase(),
        Number(args.expiredAt ?? 0n),
        (args.hook ?? '').toLowerCase(),
        Number(entry.blockNumber),
        entry.transactionHash,
      );
      if (result.changes > 0) inserted += 1;
    }
    setIndexerState(LAST_BLOCK_KEY, to.toString());
    from = to + 1n;
  }

  if (inserted > 0) log.info({ inserted, head: head.toString() }, 'jobs indexer caught up');
}

async function pollLifecycleOnce(log: FastifyBaseLogger): Promise<void> {
  const head = await arcClient.getBlockNumber();
  let from = startBlock(getIndexerState(EVENTS_LAST_BLOCK_KEY), head);
  if (from > head) return;

  let inserted = 0;
  while (from <= head) {
    const to = from + MAX_BLOCKS_PER_QUERY - 1n > head ? head : from + MAX_BLOCKS_PER_QUERY - 1n;

    const [funded, refunded, submitted, completed, rejected] = await Promise.all([
      arcClient.getLogs({ address: ERC8183_ADDRESS, event: jobFundedEvent, fromBlock: from, toBlock: to }),
      arcClient.getLogs({ address: ERC8183_ADDRESS, event: jobRefundedEvent, fromBlock: from, toBlock: to }),
      arcClient.getLogs({ address: ERC8183_ADDRESS, event: jobSubmittedEvent, fromBlock: from, toBlock: to }),
      arcClient.getLogs({ address: ERC8183_ADDRESS, event: jobCompletedEvent, fromBlock: from, toBlock: to }),
      arcClient.getLogs({ address: ERC8183_ADDRESS, event: jobRejectedEvent, fromBlock: from, toBlock: to }),
    ]);

    for (const entry of funded) {
      const a = entry.args;
      if (!a.jobId || !a.client || a.amount == null) continue;
      const r = insertJobEvent.run(
        a.jobId.toString(), 'Funded', '', a.amount.toString(), a.client.toLowerCase(),
        Number(entry.blockNumber), entry.transactionHash, entry.logIndex ?? 0,
      );
      if (r.changes > 0) inserted += 1;
    }
    for (const entry of refunded) {
      const a = entry.args;
      if (!a.jobId || !a.client || a.amount == null) continue;
      // Refunded.client is the recipient. The actual caller of
      // claimRefund() can be anyone (permissionless); we store the
      // recipient as `actor` and rely on the row label in the UI to
      // disambiguate. Recovering the actual caller would require an
      // extra getTransaction() per event — not worth it for v1.
      const r = insertJobEvent.run(
        a.jobId.toString(), 'Refunded', '', a.amount.toString(), a.client.toLowerCase(),
        Number(entry.blockNumber), entry.transactionHash, entry.logIndex ?? 0,
      );
      if (r.changes > 0) inserted += 1;
    }
    for (const entry of submitted) {
      const a = entry.args;
      if (!a.jobId || !a.provider || !a.deliverable) continue;
      const r = insertJobEvent.run(
        a.jobId.toString(), 'Submitted', a.deliverable, null, a.provider.toLowerCase(),
        Number(entry.blockNumber), entry.transactionHash, entry.logIndex ?? 0,
      );
      if (r.changes > 0) inserted += 1;
    }
    for (const entry of completed) {
      const a = entry.args;
      if (!a.jobId || !a.evaluator || !a.reason) continue;
      const r = insertJobEvent.run(
        a.jobId.toString(), 'Completed', a.reason, null, a.evaluator.toLowerCase(),
        Number(entry.blockNumber), entry.transactionHash, entry.logIndex ?? 0,
      );
      if (r.changes > 0) inserted += 1;
    }
    for (const entry of rejected) {
      const a = entry.args;
      if (!a.jobId || !a.rejector || !a.reason) continue;
      const r = insertJobEvent.run(
        a.jobId.toString(), 'Rejected', a.reason, null, a.rejector.toLowerCase(),
        Number(entry.blockNumber), entry.transactionHash, entry.logIndex ?? 0,
      );
      if (r.changes > 0) inserted += 1;
    }

    setIndexerState(EVENTS_LAST_BLOCK_KEY, to.toString());
    from = to + 1n;
  }

  if (inserted > 0) log.info({ inserted, head: head.toString() }, 'job events indexer caught up');
}

export function startJobIndexer(log: FastifyBaseLogger): void {
  // One-shot backfill rewind: when any newly-added event type isn't yet in
  // the local index, drop the cursor so the next poll re-scans the lookback
  // window. All existing rows are PK-protected by (tx_hash, log_index) so
  // re-indexing is a safe no-op. Two milestones have triggered this so far:
  //   - M30 added JobFunded indexing
  //   - M33 added Refunded indexing
  // Skipped on fresh DBs (no cursor).
  const fundedExists = db
    .prepare("SELECT 1 FROM job_events WHERE event_type = 'Funded' LIMIT 1")
    .get();
  const refundedExists = db
    .prepare("SELECT 1 FROM job_events WHERE event_type = 'Refunded' LIMIT 1")
    .get();
  const eventsCursor = getIndexerState(EVENTS_LAST_BLOCK_KEY);
  if (eventsCursor && (!fundedExists || !refundedExists)) {
    db.prepare('DELETE FROM indexer_state WHERE key = ?').run(EVENTS_LAST_BLOCK_KEY);
    log.info(
      { fundedExists: !!fundedExists, refundedExists: !!refundedExists },
      'rewinding job_events cursor to backfill historical Funded/Refunded events',
    );
  }

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await pollJobsOnce(log);
      await pollLifecycleOnce(log);
    } catch (err) {
      log.error({ err }, 'jobs indexer poll failed');
    } finally {
      running = false;
    }
  };
  void tick();
  setInterval(() => void tick(), POLL_INTERVAL_MS);
  log.info({ pollMs: POLL_INTERVAL_MS, lookback: INITIAL_LOOKBACK_BLOCKS.toString() }, 'jobs indexer started');
}
