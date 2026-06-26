// Role-aware "what should happen next" for a pact. Single source of truth
// for both the pact-detail page's waiting cue and the notifications feed -
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
  const budgetSet = pact.budget.usdc !== '0';

  // Terminal states. On-chain Expired = client cancelled an Open pact;
  // Refunded = post-deadline claimRefund. Both terminal.
  if (status === 'Completed' || status === 'Rejected') return null;
  if (pact.status === 'Expired' || pact.status === 'Refunded') return null;

  if (status === 'Disputed') {
    return 'A dispute is open - open the pact to respond or follow the evaluator vote.';
  }

  // Soft-Expired: past the pact deadline but not yet acted on.
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
      ? 'Submit your deliverable to start the challenge window.'
      : 'Waiting for the provider to submit a deliverable.';
  }

  if (status === 'Submitted') {
    // Wrapper model: the client accepts (instant release) or disputes during the
    // challenge window; either party can dispute; after it closes anyone finalizes.
    if (isClient)
      return 'Review the deliverable - accept to release the funds, or open a dispute before the challenge window closes.';
    if (isProvider)
      return 'Delivered. Waiting for the client to accept, or for the challenge window to close so the payout can finalize.';
    return 'Waiting for the client to accept or the challenge window to close.';
  }

  return `Status: ${status}.`;
}

// True when the directive in describeCurrentStep is *for the connected user*
// - i.e., they're the one being asked to act, not just observing someone
// else's turn. Used by the notifications feed to flag "action required" rows
// and by other surfaces (e.g., countdown urgency label) to swap "waiting"
// vs "act now" language.
//
// We branch by the same (status, role) tuples as describeCurrentStep rather
// than scraping the returned sentence - keeps the two in lock-step without
// fragile string matching.
export function isActionRequiredByMe(
  pact: PactLiveState,
  status: string,
  roles: PactRole[],
): boolean {
  const isClient = roles.includes('client');
  const isProvider = roles.includes('provider');
  const budgetSet = pact.budget.usdc !== '0';

  if (status === 'Completed' || status === 'Rejected') return false;
  if (pact.status === 'Expired' || pact.status === 'Refunded') return false;

  // A party to an open dispute likely owes a move (concede / defend / resolve).
  // Over-flags the side that's only waiting, but missing a concede deadline is
  // worse than a redundant nudge. Precise per-phase routing is the job of the
  // action-required push layer (which reads full dispute state).
  if (status === 'Disputed') return isClient || isProvider;

  if (status === 'Expired') {
    if (pact.status === 'Funded' || pact.status === 'Submitted') return isClient;
    return isClient;
  }
  if (status === 'Open' && !budgetSet) return isProvider;
  if (status === 'Open' && budgetSet) return isClient;
  if (status === 'Funded') return isProvider;
  // Submitted: the client is the one expected to act (accept or dispute).
  if (status === 'Submitted') return isClient;

  return false;
}

// Display status. The wrapper splits the old single-reject into distinct states:
// cancel() of an Open pact lands in Status.Expired (surface as "Cancelled"),
// while reject() of a Funded/Submitted deliverable stays "Rejected". So unlike
// the reference, we no longer need terminationActor to disambiguate.
export function displayStatus(_pact: PactLiveState, status: string): string {
  if (status === 'Expired') return 'Cancelled';
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
