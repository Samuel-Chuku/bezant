import type { FastifyBaseLogger } from 'fastify';
import { arcClient, ERC8183_ADDRESS } from './arc.js';
import { jobCreatedEvent } from './abis/erc8183.js';
import { db, getIndexerState, setIndexerState } from './db.js';

// How often to poll the chain for new JobCreated events.
const POLL_INTERVAL_MS = Number(process.env.JOB_INDEXER_POLL_MS ?? 10_000);

// How far back to scan on first run if there's no saved progress.
// Arc Testnet runs ~400ms blocks (head ~43M after ~6 months live), so
// 1M blocks ≈ 4–5 days of history — covers our smoke test trail.
// First-time backfill takes ~30–60s; subsequent boots only catch the delta.
const INITIAL_LOOKBACK_BLOCKS = BigInt(process.env.JOB_INDEXER_LOOKBACK ?? 1_000_000);

// viem caps a single getLogs call. Stay well under to be safe.
const MAX_BLOCKS_PER_QUERY = 5_000n;

const LAST_BLOCK_KEY = 'jobs_index:last_block';

const insertJob = db.prepare(
  `INSERT OR IGNORE INTO jobs_index
   (job_id, client, provider, evaluator, expired_at, hook, block_number, tx_hash)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
);

async function pollOnce(log: FastifyBaseLogger): Promise<void> {
  const head = await arcClient.getBlockNumber();
  const stored = getIndexerState(LAST_BLOCK_KEY);
  let from = stored ? BigInt(stored) + 1n : (head > INITIAL_LOOKBACK_BLOCKS ? head - INITIAL_LOOKBACK_BLOCKS : 0n);

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

export function startJobIndexer(log: FastifyBaseLogger): void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await pollOnce(log);
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
