import 'dotenv/config';
import { decideDelivery, evaluateDelivery, type DeliveryDoc } from '../src/lib/trade-officer.js';

// Smoke for the Trade Officer documentary check. Exercises both the active
// path (decideDelivery — LLM when OPENROUTER_API_KEY is set, else regex) and the
// deterministic fallback (evaluateDelivery) directly. No server/chain needed.
//
// Run:  npm run smoke:officer
const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', BOLD = '\x1b[1m', RESET = '\x1b[0m';

let failures = 0;
function check(label: string, cond: boolean, detail = '') {
  console.log(`${cond ? GREEN + '✓' : RED + '✗'}${RESET} ${label}${detail ? ` ${DIM}${detail}${RESET}` : ''}`);
  if (!cond) failures += 1;
}

const VALID_BOL: DeliveryDoc = {
  kind: 'bill_of_lading',
  reference: 'MAEU7654321',
  content: [
    'BILL OF LADING',
    'B/L No: MAEU7654321',
    'Carrier: Maersk Line',
    'Vessel: Maersk Sentosa / Voyage 214E',
    "Container: MSKU1234567 (40' HC)",
    'Port of Loading: Yantian (CNYTN)',
    'Port of Discharge: Rotterdam (NLRTM)',
    'Goods: 480 cartons industrial fasteners, 12,000 kg gross',
    'Freight: PREPAID. Shipped on board 2026-06-21 in apparent good order.',
  ].join('\n'),
};
const GIBBERISH: DeliveryDoc = { kind: 'other', content: 'hi there please pay me thanks' };
const NO_REF: DeliveryDoc = {
  kind: 'bill_of_lading',
  content: 'Bill of lading: shipped on board, carrier Maersk, port of loading Yantian, a container of fasteners.',
};

const LOW = { amountUsdc: 100, seller: '0x0000000000000000000000000000000000000001' };
const HIGH = { amountUsdc: 6000, seller: '0x0000000000000000000000000000000000000001' }; // ≥ 5000 high-value floor

(async () => {
  const usingLlm = !!process.env.OPENROUTER_API_KEY;
  console.log(`${BOLD}Trade Officer smoke${RESET} — active brain: ${usingLlm ? `LLM (${process.env.OFFICER_LLM_MODEL ?? 'default model'})` : 'deterministic regex fallback'}\n`);

  // Active path — LLM and regex must agree on these clear cases.
  console.log(`${BOLD}── decideDelivery (active path) ──${RESET}`);
  const d1 = await decideDelivery(LOW, VALID_BOL);
  check('valid BoL → pass', d1.decision === 'pass', `(${d1.decision}, conf ${d1.confidence})`);
  const d2 = await decideDelivery(LOW, GIBBERISH);
  check('gibberish → escalate', d2.decision === 'escalate', `(${d2.category ?? '-'})`);
  const d3 = await decideDelivery(HIGH, VALID_BOL);
  check('high-value → escalate (high_value, deterministic short-circuit)', d3.decision === 'escalate' && d3.category === 'high_value');

  // Deterministic fallback — exact categories/resubmittable.
  console.log(`\n${BOLD}── evaluateDelivery (deterministic regex) ──${RESET}`);
  const r1 = evaluateDelivery(LOW, VALID_BOL);
  check('valid BoL → pass', r1.decision === 'pass');
  const r2 = evaluateDelivery(LOW, NO_REF);
  check('no reference number → escalate (documentary, resubmittable)', r2.decision === 'escalate' && r2.category === 'documentary' && r2.resubmittable === true);
  const r3 = evaluateDelivery(LOW, GIBBERISH);
  check('gibberish → escalate (documentary)', r3.decision === 'escalate' && r3.category === 'documentary');
  const r4 = evaluateDelivery(HIGH, VALID_BOL);
  check('high-value → escalate (high_value, not resubmittable)', r4.decision === 'escalate' && r4.category === 'high_value' && r4.resubmittable === false);

  console.log();
  if (failures) {
    console.log(`${RED}${BOLD}✗ ${failures} check(s) failed${RESET}`);
    process.exit(1);
  }
  console.log(`${GREEN}${BOLD}✓ all officer checks passed${RESET}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
