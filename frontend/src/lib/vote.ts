import { encodeAbiParameters, keccak256, type Hex } from 'viem';

// Commit-reveal voting for evaluators. The commit hash must exactly match the
// contract's: keccak256(abi.encode(Vote vote, bytes32 secret, address evaluator)).
// The secret stays client-side (localStorage) between commit and reveal — this
// is the manual path; the auto-reveal agent (M41 design) is a later addition.

export type VoteChoice = 1 | 2; // 1 = ForDisputer, 2 = ForOpponent

export function generateSecret(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}` as Hex;
}

export function computeCommitHash(vote: VoteChoice, secret: Hex, evaluator: string): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'uint8' }, { type: 'bytes32' }, { type: 'address' }],
      [vote, secret, evaluator as Hex],
    ),
  );
}

type StoredVote = { vote: VoteChoice; secret: Hex };

function key(pactId: string, disputeId: string, evaluator: string): string {
  return `arc:vote:${pactId}:${disputeId}:${evaluator.toLowerCase()}`;
}

export function saveVote(pactId: string, disputeId: string, evaluator: string, v: StoredVote): void {
  try {
    localStorage.setItem(key(pactId, disputeId, evaluator), JSON.stringify(v));
  } catch {
    // localStorage unavailable (private mode etc.) — the evaluator can still
    // reveal by re-entering the secret manually if we ever surface that path.
  }
}

export function loadVote(pactId: string, disputeId: string, evaluator: string): StoredVote | null {
  try {
    const raw = localStorage.getItem(key(pactId, disputeId, evaluator));
    return raw ? (JSON.parse(raw) as StoredVote) : null;
  } catch {
    return null;
  }
}

export function clearVote(pactId: string, disputeId: string, evaluator: string): void {
  try {
    localStorage.removeItem(key(pactId, disputeId, evaluator));
  } catch {
    // ignore
  }
}
