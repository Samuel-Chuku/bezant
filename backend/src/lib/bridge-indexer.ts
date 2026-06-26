import type { FastifyBaseLogger } from 'fastify';
import { zeroAddress } from 'viem';
import {
  arcClient,
  USDC_ADDRESS,
  CCTP_MESSAGE_TRANSMITTER_ADDRESS,
} from './arc.js';
import { erc20TransferEvent } from './abis/erc20.js';
import { cctpMessageReceivedEvent } from './abis/cctp.js';
import { db, getIndexerState, setIndexerState } from './db.js';

// How often to poll Arc for new bridge events.
const POLL_INTERVAL_MS = Number(process.env.BRIDGE_INDEXER_POLL_MS ?? 10_000);

// How far back to scan on first run (same default as job indexer - covers
// the smoke test trail). Re-indexing is safe: (tx_hash, log_index) PK.
const INITIAL_LOOKBACK_BLOCKS = BigInt(
  process.env.BRIDGE_INDEXER_LOOKBACK ?? 1_000_000,
);

// viem caps a single getLogs call; stay well under to be safe.
const MAX_BLOCKS_PER_QUERY = 5_000n;

const LAST_BLOCK_KEY = 'bridge_inbound:last_block';

const insertEvent = db.prepare(
  `INSERT OR IGNORE INTO bridge_inbound_events
   (recipient, amount_raw, source_domain, nonce, block_number, tx_hash, log_index)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
);

function startBlock(stored: string | null, head: bigint): bigint {
  if (stored) return BigInt(stored) + 1n;
  return head > INITIAL_LOOKBACK_BLOCKS ? head - INITIAL_LOOKBACK_BLOCKS : 0n;
}

async function pollOnce(log: FastifyBaseLogger): Promise<void> {
  const head = await arcClient.getBlockNumber();
  let from = startBlock(getIndexerState(LAST_BLOCK_KEY), head);
  if (from > head) return;

  let inserted = 0;
  while (from <= head) {
    const to =
      from + MAX_BLOCKS_PER_QUERY - 1n > head
        ? head
        : from + MAX_BLOCKS_PER_QUERY - 1n;

    // Two parallel getLogs: USDC mints (Transfer with from=0x0) and CCTP
    // MessageReceived. Join by tx hash so we only record mints actually
    // caused by a CCTP bridge - eliminates faucets and other non-CCTP
    // mint paths from the bridge history.
    const [mints, received] = await Promise.all([
      arcClient.getLogs({
        address: USDC_ADDRESS,
        event: erc20TransferEvent,
        args: { from: zeroAddress },
        fromBlock: from,
        toBlock: to,
      }),
      arcClient.getLogs({
        address: CCTP_MESSAGE_TRANSMITTER_ADDRESS,
        event: cctpMessageReceivedEvent,
        fromBlock: from,
        toBlock: to,
      }),
    ]);

    const receivedByTx = new Map<
      string,
      { sourceDomain: number; nonce: string }
    >();
    for (const entry of received) {
      const a = entry.args;
      if (a.sourceDomain == null || !a.nonce) continue;
      receivedByTx.set(entry.transactionHash, {
        sourceDomain: Number(a.sourceDomain),
        nonce: a.nonce as string,
      });
    }

    for (const entry of mints) {
      const a = entry.args;
      if (!a.to || a.value == null) continue;
      const joined = receivedByTx.get(entry.transactionHash);
      if (!joined) continue; // not a CCTP-caused mint; skip
      const r = insertEvent.run(
        a.to.toLowerCase(),
        a.value.toString(),
        joined.sourceDomain,
        joined.nonce,
        Number(entry.blockNumber),
        entry.transactionHash,
        entry.logIndex ?? 0,
      );
      if (r.changes > 0) inserted += 1;
    }

    setIndexerState(LAST_BLOCK_KEY, to.toString());
    from = to + 1n;
  }

  if (inserted > 0) {
    log.info(
      { inserted, head: head.toString() },
      'bridge inbound indexer caught up',
    );
  }
}

export function startBridgeIndexer(log: FastifyBaseLogger): void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await pollOnce(log);
    } catch (err) {
      log.error({ err }, 'bridge indexer poll failed');
    } finally {
      running = false;
    }
  };
  void tick();
  setInterval(() => void tick(), POLL_INTERVAL_MS);
  log.info(
    { pollMs: POLL_INTERVAL_MS, lookback: INITIAL_LOOKBACK_BLOCKS.toString() },
    'bridge indexer started',
  );
}
