import type { FastifyBaseLogger } from 'fastify';
import { db } from './db.js';

// The auto-reveal agent: reveals committed votes on behalf of evaluators who
// opted in, so they don't lose their pool share by going offline during the 2h
// reveal window. revealVote() is permissionless (evaluator is a param, the
// commit hash is verified, msg.sender is ignored), so the operator wallet can
// reveal for anyone - no smart accounts / session keys needed.
//
// Trust model: the evaluator handed us (vote, secret) at commit time. Same
// trust boundary as the rest of the backend. v1, per the M41 design.

const POLL_INTERVAL_MS = Number(process.env.AUTO_REVEAL_POLL_MS ?? 30_000);

// Small slack past graceDeadline so the contract's `block.timestamp > grace`
// check is comfortably satisfied even with minor clock skew.
const REVEAL_SLACK_SEC = 5;

export type AutoRevealRow = {
  dispute_id: string;
  evaluator: string;
  pact_id: string;
  vote: number;
  secret: string;
  reveal_after: number;
  reveal_before: number;
  status: string;
  attempts: number;
};

// Injected by server.ts so the Circle client + operator wallet stay in one place.
export type RevealFn = (row: AutoRevealRow) => Promise<{ txHash: string }>;

const selectDue = db.prepare(
  `SELECT * FROM auto_reveals WHERE status = 'pending' ORDER BY reveal_after ASC`,
);
const markRevealed = db.prepare(
  `UPDATE auto_reveals SET status = 'revealed', tx_hash = ?, attempts = attempts + 1 WHERE dispute_id = ? AND evaluator = ?`,
);
const markExpired = db.prepare(
  `UPDATE auto_reveals SET status = 'expired' WHERE dispute_id = ? AND evaluator = ?`,
);
const markFailed = db.prepare(
  `UPDATE auto_reveals SET status = 'failed', last_error = ?, attempts = attempts + 1 WHERE dispute_id = ? AND evaluator = ?`,
);

async function tick(log: FastifyBaseLogger, reveal: RevealFn): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const due = selectDue.all() as AutoRevealRow[];

  for (const row of due) {
    // Window closed before we got to it - the evaluator missed out.
    if (now >= row.reveal_before) {
      markExpired.run(row.dispute_id, row.evaluator);
      log.warn({ disputeId: row.dispute_id, evaluator: row.evaluator }, 'auto-reveal window closed before reveal');
      continue;
    }
    // Reveal phase not open yet.
    if (now < row.reveal_after + REVEAL_SLACK_SEC) continue;

    try {
      const { txHash } = await reveal(row);
      markRevealed.run(txHash, row.dispute_id, row.evaluator);
      log.info({ disputeId: row.dispute_id, evaluator: row.evaluator, txHash }, 'auto-revealed vote');
    } catch (err) {
      // Reverts here are almost always terminal (already revealed, window
      // closed, dispute resolved) - not transient - so we don't retry and burn
      // gas. The evaluator can still reveal manually (their secret is local).
      const message = err instanceof Error ? err.message : String(err);
      markFailed.run(message, row.dispute_id, row.evaluator);
      log.error({ disputeId: row.dispute_id, evaluator: row.evaluator, err: message }, 'auto-reveal failed');
    }
  }
}

export function startAutoRevealAgent(deps: { log: FastifyBaseLogger; reveal: RevealFn }): void {
  const { log, reveal } = deps;
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await tick(log, reveal);
    } catch (err) {
      log.error({ err }, 'auto-reveal agent tick failed');
    } finally {
      running = false;
    }
  };
  void run();
  setInterval(() => void run(), POLL_INTERVAL_MS);
  log.info({ pollMs: POLL_INTERVAL_MS }, 'auto-reveal agent started');
}
