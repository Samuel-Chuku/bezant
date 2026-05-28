// Role-aware "what should happen next" for a pact. Single source of truth
// for both the pact-detail page's waiting cue and the notifications feed —
// derives the directive sentence and whether the *connected user* is the
// one being asked to act.
import type { PactLiveState, PactRole } from './api';

// Returns a directive/waiting sentence for the connected user, or null when
// the pact is terminal. Mirrors the lifecycle the reference contract enforces;
// `status` is the effective status (soft-Expired included), `pact.status` is
// the raw on-chain enum value.
export function describeCurrentStep(
  pact: PactLiveState,
  status: string,
  roles: PactRole[],
): string | null {
  const isClient = roles.includes('client');
  const isProvider = roles.includes('provider');
  const isEvaluator = roles.includes('evaluator');
  const budgetSet = pact.budget.usdc !== '0';

  if (status === 'Completed' || status === 'Rejected') return null;
  // On-chain Expired is reached only via claimRefund(); terminal.
  if (pact.status === 'Expired') return null;

  if (status === 'Expired') {
    if (pact.status === 'Funded' || pact.status === 'Submitted') {
      return `Anyone can claim the ${pact.budget.usdc} USDC refund for the client.`;
    }
    return isClient
      ? 'Cancel this pact to clear it, then post a fresh one with a longer deadline.'
      : 'Waiting for the client to cancel or repost.';
  }

  if (status === 'Open' && !budgetSet) {
    return isProvider
      ? 'Set your quote so the client can fund the pact.'
      : 'Waiting for the provider to quote a price.';
  }

  if (status === 'Open' && budgetSet) {
    if (isClient) return `Fund the pact to lock the ${pact.budget.usdc} USDC and let work begin.`;
    if (isProvider) return 'Quote sent. Waiting for the client to fund the pact.';
    return 'Waiting for the client to fund the pact.';
  }

  if (status === 'Funded') {
    return isProvider
      ? 'Submit your deliverable so the evaluator can review and release the funds.'
      : 'Waiting for the provider to submit a deliverable.';
  }

  if (status === 'Submitted') {
    if (isEvaluator) return 'Review the deliverable, then complete or reject.';
    if (isProvider) return 'Waiting for the evaluator to review your submission.';
    return 'Waiting for the evaluator to complete or reject.';
  }

  return `Status: ${status}.`;
}

// True when the directive in describeCurrentStep is *for the connected user*
// — i.e., they're the one being asked to act, not just observing someone
// else's turn. Used by the notifications feed to flag "action required" rows
// and by other surfaces (e.g., countdown urgency label) to swap "waiting"
// vs "act now" language.
//
// We branch by the same (status, role) tuples as describeCurrentStep rather
// than scraping the returned sentence — keeps the two in lock-step without
// fragile string matching.
export function isActionRequiredByMe(
  pact: PactLiveState,
  status: string,
  roles: PactRole[],
): boolean {
  const isClient = roles.includes('client');
  const isProvider = roles.includes('provider');
  const isEvaluator = roles.includes('evaluator');
  const budgetSet = pact.budget.usdc !== '0';

  if (status === 'Completed' || status === 'Rejected') return false;
  if (pact.status === 'Expired') return false;

  if (status === 'Expired') {
    // Anyone can claim the refund on behalf of the client; only the client
    // sees this as "their action" — non-clients can technically call it too
    // but it's not their pact. Surface this only to client.
    if (pact.status === 'Funded' || pact.status === 'Submitted') return isClient;
    return isClient;
  }
  if (status === 'Open' && !budgetSet) return isProvider;
  if (status === 'Open' && budgetSet) return isClient;
  if (status === 'Funded') return isProvider;
  if (status === 'Submitted') return isEvaluator;

  return false;
}

// Display status that distinguishes a client cancellation from an evaluator
// rejection. The ERC-8183 reference contract has a single reject() function
// for both, so the raw on-chain status is "Rejected" in both cases. Compare
// the indexed terminationActor with pact.client to recover the semantic case.
// Falls back to the raw status when terminationActor isn't available yet
// (~10s window while the indexer catches up).
export function displayStatus(pact: PactLiveState, status: string): string {
  if (status !== 'Rejected') return status;
  if (!pact.terminationActor) return status;
  if (pact.terminationActor.toLowerCase() === pact.client.toLowerCase()) {
    return 'Cancelled';
  }
  return status;
}

// Short action label for the countdown banner ("Time to {verb}…"). Returns
// null on terminal states or "waiting for someone else" branches; callers
// fall back to a generic deadline label.
export function actionVerbForMe(
  pact: PactLiveState,
  status: string,
  roles: PactRole[],
): string | null {
  if (!isActionRequiredByMe(pact, status, roles)) return null;
  const budgetSet = pact.budget.usdc !== '0';
  if (status === 'Expired') return 'cancel and repost';
  if (status === 'Open' && !budgetSet) return 'set your quote';
  if (status === 'Open' && budgetSet) return 'fund the pact';
  if (status === 'Funded') return 'submit the deliverable';
  if (status === 'Submitted') return 'review the deliverable';
  return null;
}
