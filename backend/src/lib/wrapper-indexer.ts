import type { FastifyBaseLogger } from 'fastify';
import { parseEventLogs } from 'viem';
import { arcClient, WRAPPER_ADDRESS } from './arc.js';
import { pactWrapperAbi } from './abis/pact-wrapper.js';
import { db, getIndexerState, setIndexerState } from './db.js';

// Indexes the PactWrapper contract - the source of truth for pact state going
// forward. Replaces pact-indexer.ts, which read Job* events off the ERC-8183
// reference. The wrapper emits its own Pact* events (the reference's JobCreated
// still fires under the hood with the wrapper as both client and evaluator, so
// we must NOT index the reference for pacts or pacts_index fills with garbage
// underlying-job rows).

const POLL_INTERVAL_MS = Number(process.env.WRAPPER_INDEXER_POLL_MS ?? 10_000);

// First-run backfill window. The wrapper deployed at block 45167600; 1M blocks
// (~4-5 days at Arc's ~400ms blocks) comfortably covers its history.
const INITIAL_LOOKBACK_BLOCKS = BigInt(process.env.WRAPPER_INDEXER_LOOKBACK ?? 1_000_000);

// viem caps a single getLogs call; stay well under.
const MAX_BLOCKS_PER_QUERY = 5_000n;

const LAST_BLOCK_KEY = 'wrapper_index:last_block';

const insertPact = db.prepare(
  `INSERT OR IGNORE INTO pacts_index
   (pact_id, client, provider, evaluator, expired_at, hook, description, block_number, tx_hash)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

const insertPactEvent = db.prepare(
  `INSERT OR IGNORE INTO pact_events
   (pact_id, event_type, hash_value, amount_raw, actor, dispute_id, block_number, tx_hash, log_index)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

function startBlock(stored: string | null, head: bigint): bigint {
  if (stored) return BigInt(stored) + 1n;
  return head > INITIAL_LOOKBACK_BLOCKS ? head - INITIAL_LOOKBACK_BLOCKS : 0n;
}

const lower = (v: unknown): string => (typeof v === 'string' ? v.toLowerCase() : '');

// Maps a parsed wrapper event to the generic pact_events row shape. Returns null
// for non-pact-scoped events (evaluator pool / treasury / ownership), which have
// no pact_id and no frontend consumer yet. Rich dispute fields (evaluator slate,
// vote tallies, bond splits) are intentionally not stored - they're read on
// demand from the getDisputeMeta() view; the indexer only records that an event
// happened, for the activity feed and toast triggers.
type EventRow = {
  pactId: bigint;
  type: string;
  hash: string;
  amount: string | null;
  actor: string;
  disputeId: string | null;
};

function mapEvent(name: string, a: Record<string, unknown>): EventRow | null {
  const pactId = a.pactId as bigint | undefined;
  switch (name) {
    case 'TermsProposed':
      return { pactId: pactId!, type: 'TermsProposed', hash: '', amount: (a.budget as bigint).toString(), actor: lower(a.by), disputeId: null };
    case 'BudgetSet':
      return { pactId: pactId!, type: 'BudgetSet', hash: '', amount: (a.budget as bigint).toString(), actor: lower(a.by), disputeId: null };
    case 'Funded':
      return { pactId: pactId!, type: 'Funded', hash: '', amount: (a.budget as bigint).toString(), actor: lower(a.by), disputeId: null };
    case 'Submitted':
      return { pactId: pactId!, type: 'Submitted', hash: lower(a.deliverableHash), amount: null, actor: lower(a.by), disputeId: null };
    case 'Completed':
      return { pactId: pactId!, type: 'Completed', hash: lower(a.reason), amount: (a.grossAmount as bigint).toString(), actor: lower(a.by), disputeId: null };
    case 'Rejected':
      return { pactId: pactId!, type: 'Rejected', hash: lower(a.reason), amount: null, actor: lower(a.by), disputeId: null };
    case 'Refunded':
      return { pactId: pactId!, type: 'Refunded', hash: '', amount: (a.amount as bigint).toString(), actor: lower(a.to), disputeId: null };
    case 'Expired':
      return { pactId: pactId!, type: 'Expired', hash: '', amount: null, actor: lower(a.by), disputeId: null };
    case 'DeadlineExtended':
      return { pactId: pactId!, type: 'DeadlineExtended', hash: '', amount: (a.newExpiredAt as bigint).toString(), actor: '', disputeId: null };
    case 'DisputeOpened':
      return { pactId: pactId!, type: 'DisputeOpened', hash: lower(a.reasonHash), amount: (a.bond as bigint).toString(), actor: lower(a.disputer), disputeId: (a.disputeId as bigint).toString() };
    case 'DisputeConceded':
      return { pactId: pactId!, type: 'DisputeConceded', hash: '', amount: null, actor: lower(a.conceder), disputeId: (a.disputeId as bigint).toString() };
    case 'DisputeDefended':
      return { pactId: pactId!, type: 'DisputeDefended', hash: '', amount: (a.bond as bigint).toString(), actor: lower(a.opponent), disputeId: (a.disputeId as bigint).toString() };
    case 'CommitSubmitted':
      return { pactId: pactId!, type: 'CommitSubmitted', hash: lower(a.commit), amount: null, actor: lower(a.evaluator), disputeId: (a.disputeId as bigint).toString() };
    case 'VoteRevealed':
      return { pactId: pactId!, type: 'VoteRevealed', hash: '', amount: (a.vote as number).toString(), actor: lower(a.evaluator), disputeId: (a.disputeId as bigint).toString() };
    case 'DisputeResolved':
      return { pactId: pactId!, type: 'DisputeResolved', hash: '', amount: (a.result as number).toString(), actor: lower(a.winner), disputeId: (a.disputeId as bigint).toString() };
    default:
      // Non-pact-scoped: EvaluatorStaked/Unstaked/Ejected/Payout,
      // PlatformFeeUpdated, PlatformTreasuryUpdated, TreasuryWithdrawn,
      // OwnershipTransferred. No consumer yet - index when the evaluator UI lands.
      return null;
  }
}

async function pollOnce(log: FastifyBaseLogger): Promise<void> {
  const head = await arcClient.getBlockNumber();
  let from = startBlock(getIndexerState(LAST_BLOCK_KEY), head);
  if (from > head) return;

  let pacts = 0;
  let events = 0;
  while (from <= head) {
    const to = from + MAX_BLOCKS_PER_QUERY - 1n > head ? head : from + MAX_BLOCKS_PER_QUERY - 1n;

    const rawLogs = await arcClient.getLogs({ address: WRAPPER_ADDRESS, fromBlock: from, toBlock: to });
    const parsed = parseEventLogs({ abi: pactWrapperAbi, logs: rawLogs });

    for (const entry of parsed) {
      const a = entry.args as Record<string, unknown>;

      if (entry.eventName === 'PactCreated') {
        const r = insertPact.run(
          (a.pactId as bigint).toString(),
          lower(a.client),
          lower(a.provider),
          // The wrapper is the protocol-level evaluator on every pact it creates.
          WRAPPER_ADDRESS.toLowerCase(),
          Number(a.expiredAt as bigint),
          '',
          (a.description as string) ?? '',
          Number(entry.blockNumber),
          entry.transactionHash,
        );
        if (r.changes > 0) pacts += 1;
        continue;
      }

      const mapped = mapEvent(entry.eventName, a);
      if (!mapped) continue;
      const r = insertPactEvent.run(
        mapped.pactId.toString(),
        mapped.type,
        mapped.hash,
        mapped.amount,
        mapped.actor,
        mapped.disputeId,
        Number(entry.blockNumber),
        entry.transactionHash,
        entry.logIndex ?? 0,
      );
      if (r.changes > 0) events += 1;
    }

    setIndexerState(LAST_BLOCK_KEY, to.toString());
    from = to + 1n;
  }

  if (pacts > 0 || events > 0) {
    log.info({ pacts, events, head: head.toString() }, 'wrapper indexer caught up');
  }
}

export function startWrapperIndexer(log: FastifyBaseLogger): void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await pollOnce(log);
    } catch (err) {
      log.error({ err }, 'wrapper indexer poll failed');
    } finally {
      running = false;
    }
  };
  void tick();
  setInterval(() => void tick(), POLL_INTERVAL_MS);
  log.info({ pollMs: POLL_INTERVAL_MS, lookback: INITIAL_LOOKBACK_BLOCKS.toString(), wrapper: WRAPPER_ADDRESS }, 'wrapper indexer started');
}
