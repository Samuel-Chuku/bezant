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
import { llmVerifyDelivery } from './officer-llm.js';

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
  // Why it escalated, so the UI can route the seller correctly:
  //   documentary/mismatch → the seller can FIX & RESUBMIT (an honest typo or
  //   wrong doc never goes straight to a refund); high_value → needs a human.
  category?: 'documentary' | 'mismatch' | 'high_value';
  resubmittable?: boolean;
  proofHash: `0x${string}`;
  confidence: number; // 0..1
  reasons: string[];
};

// The on-chain proof committed by attest(). Same doc → same hash on every path
// (LLM or deterministic), so the parked attestation finalizes against the right proof.
export function proofHashOf(doc: DeliveryDoc): `0x${string}` {
  return keccak256(stringToBytes(JSON.stringify(doc)));
}

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

// The Trade Officer's verdict for a submitted document. Prefers the LLM examiner
// when OPENROUTER_API_KEY is set; otherwise uses the deterministic check. High-
// value trades always go to a human, regardless of how clean the docs look.
export async function decideDelivery(
  trade: { amountUsdc: number; seller: string },
  doc: DeliveryDoc,
): Promise<OfficerDecision> {
  if (trade.amountUsdc >= HIGH_VALUE_USDC) {
    return {
      decision: 'escalate',
      category: 'high_value',
      resubmittable: false,
      proofHash: proofHashOf(doc),
      confidence: 0,
      reasons: [`high-value trade (${trade.amountUsdc} USDC ≥ ${HIGH_VALUE_USDC}) — routed to a human reviewer`],
    };
  }
  const llm = await llmVerifyDelivery(trade, doc);
  return llm ?? evaluateDelivery(trade, doc);
}

// Deterministic documentary check — the fallback when no LLM is configured.
export function evaluateDelivery(
  trade: { amountUsdc: number; seller: string },
  doc: DeliveryDoc,
): OfficerDecision {
  const proofHash = proofHashOf(doc);
  const reasons: string[] = [];

  const content = (doc.content ?? '').trim();
  const hasContent = content.length >= 20;
  const hasRef = (!!doc.reference && REF_RE.test(doc.reference)) || REF_RE.test(content);
  const hasKeyword = DOC_KEYWORD_RE.test(content);
  if (!hasContent) reasons.push('document too short — paste the full delivery document');
  if (!hasRef) reasons.push('no valid reference number (e.g. a BoL/container/tracking number with digits)');
  if (!hasKeyword) reasons.push('does not read like a shipping/customs document (no recognizable terms)');

  if (trade.amountUsdc >= HIGH_VALUE_USDC) {
    return {
      decision: 'escalate',
      category: 'high_value',
      resubmittable: false,
      proofHash,
      confidence: 0,
      reasons: [`high-value trade (${trade.amountUsdc} USDC ≥ ${HIGH_VALUE_USDC}) — routed to a human reviewer`],
    };
  }

  if (hasContent && hasRef && hasKeyword) {
    return { decision: 'pass', proofHash, confidence: 0.9, reasons: ['documentary check passed'] };
  }

  // Documentary issue → the seller can correct it and resubmit; never an auto-fail.
  return { decision: 'escalate', category: 'documentary', resubmittable: true, proofHash, confidence: 0.3, reasons };
}
