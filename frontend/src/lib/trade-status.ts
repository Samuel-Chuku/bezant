// Role-aware "what happens next" for a trade. Single source of truth for the
// pulsing waiting-cue on both the trades list cards and the trade-detail page,
// so the two never drift. Mirrors the lifecycle TradeEscrow enforces.
//
// Returns a directive sentence + whether the *connected user* is the one being
// asked to act (forMe → "your turn", styled brighter), or null on terminal
// states (Released / Cancelled / Refunded).

export type TradeStepInput = {
  status: string;
  buyer: string;
  seller: string;
  lastProposer: string;
  deadline: number; // unix seconds
};

export type TradeStep = { line: string; forMe: boolean };

export function describeTradeStep(t: TradeStepInput, me: string | null): TradeStep | null {
  const meLower = me?.toLowerCase() ?? null;
  const isBuyer = meLower === t.buyer.toLowerCase();
  const isSeller = meLower === t.seller.toLowerCase();
  const isParty = isBuyer || isSeller;
  const myOffer = meLower === t.lastProposer.toLowerCase();
  const now = Math.floor(Date.now() / 1000);

  switch (t.status) {
    case 'Proposing': {
      const offerByBuyer = t.lastProposer.toLowerCase() === t.buyer.toLowerCase();
      const offerBy = offerByBuyer ? 'buyer' : 'seller';
      const other = offerByBuyer ? 'seller' : 'buyer';
      if (!isParty) return { line: 'Negotiation in progress…', forMe: false };
      if (myOffer) return { line: `Waiting for the ${other} to accept or counter…`, forMe: false };
      return { line: `Your turn - respond to the ${offerBy}'s offer…`, forMe: true };
    }
    case 'Agreed':
      return isBuyer
        ? { line: 'Fund the escrow to lock your deposit…', forMe: true }
        : { line: 'Waiting for the buyer to fund the escrow…', forMe: false };
    case 'Funded':
      if (isSeller) return { line: 'Submit your delivery document…', forMe: true };
      if (isBuyer && now > t.deadline) return { line: 'Deadline passed - claim your refund…', forMe: true };
      return { line: 'Waiting for the seller to submit delivery…', forMe: false };
    case 'Disputed':
      return { line: 'Under dispute - awaiting the arbitrator…', forMe: false };
    default:
      return null; // Released / Cancelled / Refunded / None - terminal
  }
}
