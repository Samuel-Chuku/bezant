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

// A plausible shipping/customs reference token (BoL, container, tracking, entry).
const REF_RE = /[A-Z]{2,}[A-Z0-9]{4,}|\b[0-9]{8,}\b/i;

export function evaluateDelivery(
  trade: { amountUsdc: number; seller: string },
  doc: DeliveryDoc,
): OfficerDecision {
  const proofHash = keccak256(stringToBytes(JSON.stringify(doc)));
  const reasons: string[] = [];

  const content = (doc.content ?? '').trim();
  const hasContent = content.length >= 8;
  const hasRef = (!!doc.reference && REF_RE.test(doc.reference)) || REF_RE.test(content);
  if (!hasContent) reasons.push('document content too short or empty');
  if (!hasRef) reasons.push('no shipping/customs reference detected');

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

  if (hasContent && hasRef) {
    return { decision: 'pass', proofHash, confidence: 0.9, reasons: ['documentary check passed'] };
  }

  // Ambiguous docs: escalate rather than auto-fail — a parse miss must not
  // slash the seller; let a human verifier decide.
  return { decision: 'escalate', proofHash, confidence: 0.3, reasons };
}
