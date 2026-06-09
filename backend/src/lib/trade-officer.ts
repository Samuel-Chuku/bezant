// Trade Officer agent — skill 1: doc-ingest attestation.
//
// Replaces the buyer's blind "confirm receipt" button with a documentary check,
// exactly like a letter-of-credit document examiner. The agent ingests a
// delivery document (bill of lading / tracking / customs), runs deterministic
// documentary rules, and either:
//   - PASS     → signs attest(passed=true) from the operator (agent) wallet
//   - ESCALATE → withholds its signature and routes to a staked human verifier
//                (Arm 2): high-value trades or ambiguous docs are never
//                auto-attested.
//
// This is *documentary* verification (the docs say it shipped/cleared), not
// physical inspection — that's the parked staked-verifier arm. The rules here
// are intentionally simple + deterministic so the decision is auditable; the
// `evaluateDelivery` seam is where an LLM/OCR doc parser plugs in later.

import { keccak256, stringToBytes } from 'viem';

export type DeliveryDoc = {
  kind: 'bill_of_lading' | 'tracking' | 'customs' | 'other';
  reference?: string; // BoL no. / tracking no. / customs entry
  content: string; // raw text or JSON of the document
  carrier?: string;
  origin?: string;
  destination?: string;
};

export type OfficerDecision = {
  decision: 'pass' | 'escalate';
  proofHash: `0x${string}`;
  confidence: number; // 0..1
  reasons: string[];
};

// Trades at or above this USDC value always go to a human verifier (Arm 2),
// regardless of how clean the documents look.
const HIGH_VALUE_USDC = Number(process.env.OFFICER_HIGH_VALUE_USDC ?? '5000');

// A real shipping/customs reference always carries DIGITS: a carrier/booking
// number (MAEU123456789), a container number (MSKU1234567), or a standalone
// long tracking/entry number. A plain word is not a reference — case-sensitive
// uppercase for the alpha-prefixed forms, since real refs are uppercased.
const REF_RE = /\b([A-Z]{2,4}\d{6,}|[A-Z]{4}\d{7}|\d{8,})\b/;

// The body must read like a shipping/customs document, not free text — at least
// one domain keyword. Stops a stray code in otherwise-gibberish text passing.
const DOC_KEYWORD_RE =
  /\b(bill of lading|b\/l|bol|air ?waybill|awb|waybill|consignment|tracking|container|customs|shipment|shipped|carrier|freight|vessel|port of (loading|discharge))\b/i;

export function evaluateDelivery(
  trade: { amountUsdc: number; seller: string },
  doc: DeliveryDoc,
): OfficerDecision {
  const proofHash = keccak256(stringToBytes(JSON.stringify(doc)));
  const reasons: string[] = [];

  const content = (doc.content ?? '').trim();
  const hasContent = content.length >= 20;
  const hasRef = (!!doc.reference && REF_RE.test(doc.reference)) || REF_RE.test(content);
  const hasKeyword = DOC_KEYWORD_RE.test(content);
  if (!hasContent) reasons.push('document too short — paste the full delivery document');
  if (!hasRef) reasons.push('no valid reference number (e.g. a BoL/container/tracking number with digits)');
  if (!hasKeyword) reasons.push('does not read like a shipping/customs document (no recognizable terms)');

  // Escalate high-value trades to a staked human verifier — the agent only
  // owns the documentary happy-path.
  if (trade.amountUsdc >= HIGH_VALUE_USDC) {
    return {
      decision: 'escalate',
      proofHash,
      confidence: 0,
      reasons: [`trade value ${trade.amountUsdc} USDC >= high-value threshold ${HIGH_VALUE_USDC} — route to staked verifier`],
    };
  }

  if (hasContent && hasRef && hasKeyword) {
    return { decision: 'pass', proofHash, confidence: 0.9, reasons: ['documentary check passed'] };
  }

  // Ambiguous docs: escalate rather than auto-fail — a parse miss must not
  // slash the seller; let a human verifier decide.
  return { decision: 'escalate', proofHash, confidence: 0.3, reasons };
}
