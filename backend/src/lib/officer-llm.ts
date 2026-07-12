// Trade Officer - LLM documentary examiner (plugs into the evaluateDelivery seam).
//
// Sends the submitted delivery document + the trade context to an OpenRouter
// model and asks for a structured PASS / ESCALATE verdict, like a letter-of-
// credit document examiner. Still *documentary* verification (is this a coherent,
// authentic-looking shipping/customs document?), not physical proof - but far
// better than a regex: it catches gibberish, typos, internal inconsistencies,
// and docs that don't read like a real shipment.
//
// Configure with OPENROUTER_API_KEY (+ optional OFFICER_LLM_MODEL). When the key
// is absent or the call fails, returns null so the caller falls back to the
// deterministic check - the officer never hard-depends on the LLM.

import type { DeliveryDoc, OfficerDecision } from './trade-officer.js';
import { proofHashOf } from './trade-officer.js';

const API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'google/gemini-2.0-flash-001';

const SYSTEM = `You are a trade-finance delivery-document examiner, like a letter-of-credit document examiner.
You are given a delivery document a seller submitted to release escrowed funds, plus the trade's value.
Decide whether the document is a coherent, authentic-looking shipping/customs document that plausibly evidences this shipment.

PASS only if ALL hold:
- it clearly reads as a shipping/customs document (bill of lading, air waybill, tracking, customs entry, etc.);
- it carries a plausible, well-formed reference number (carrier/booking, container, tracking, or customs entry);
- it is internally consistent (carrier, ports/route, goods, quantity) and not obviously contradictory;
- nothing looks like gibberish, a placeholder, or a typo in the reference.

ESCALATE otherwise. Use category:
- "documentary" for a fixable document problem (missing/short, no real reference, doesn't read like a shipping doc, likely typo) - the seller can correct and resubmit;
- "mismatch" if it looks like a real document but for a different/unrelated shipment - the seller can submit the correct one.
Set resubmittable=true for both. Never approve when uncertain - escalate with short, specific reasons.

Respond with ONLY a JSON object, no prose, no code fences:
{"decision":"pass"|"escalate","category":"documentary"|"mismatch"|"ok","confidence":0..1,"reasons":["..."],"resubmittable":true|false}`;

type LlmVerdict = {
  decision?: string;
  category?: string;
  confidence?: number;
  reasons?: unknown;
  resubmittable?: boolean;
};

// Pull the first {...} JSON object out of the model's text (handles code fences / stray prose).
function extractJson(text: string): LlmVerdict | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as LlmVerdict;
  } catch {
    return null;
  }
}

export async function llmVerifyDelivery(
  trade: { amountUsdc: number; seller: string },
  doc: DeliveryDoc,
): Promise<OfficerDecision | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null; // not configured → caller falls back to the deterministic check
  const model = process.env.OFFICER_LLM_MODEL ?? process.env.OPENROUTER_MODEL ?? DEFAULT_MODEL;
  const proofHash = proofHashOf(doc);

  const user = [
    `Trade value: ${trade.amountUsdc} USDC`,
    `Document type (declared): ${doc.kind}`,
    doc.reference ? `Reference (declared): ${doc.reference}` : null,
    doc.carrier ? `Carrier: ${doc.carrier}` : null,
    doc.origin ? `Origin: ${doc.origin}` : null,
    doc.destination ? `Destination: ${doc.destination}` : null,
    '',
    'Document content:',
    doc.content ?? '',
  ]
    .filter((l) => l !== null)
    .join('\n');

  try {
    const resp = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://arc-trade.local',
        'X-Title': 'arc-trade Trade Officer',
      },
      body: JSON.stringify({
        model,
        max_tokens: 400,
        temperature: 0,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: user },
        ],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!resp.ok) return null; // fall back to deterministic

    const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const verdict = extractJson(data.choices?.[0]?.message?.content ?? '');
    if (!verdict || (verdict.decision !== 'pass' && verdict.decision !== 'escalate')) return null;

    const reasons = Array.isArray(verdict.reasons) ? verdict.reasons.map(String).slice(0, 5) : [];
    const confidence = typeof verdict.confidence === 'number' ? Math.max(0, Math.min(1, verdict.confidence)) : 0.5;

    if (verdict.decision === 'pass') {
      return { decision: 'pass', proofHash, confidence, reasons: reasons.length ? reasons : ['documentary check passed'], engine: 'llm', model };
    }
    const category = verdict.category === 'mismatch' ? 'mismatch' : 'documentary';
    return {
      decision: 'escalate',
      category,
      resubmittable: verdict.resubmittable ?? true,
      proofHash,
      confidence,
      reasons: reasons.length ? reasons : ['document could not be verified'],
      engine: 'llm',
      model,
    };
  } catch {
    return null; // network/timeout/parse → deterministic fallback
  }
}
