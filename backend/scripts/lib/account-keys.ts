// Local persistence of per-account custodial keys for the smoke/demo scripts.
//
// Dev-controlled accounts now return an `accountKey` once at creation (POST
// /users) and require it as `Authorization: Bearer <key>` on every custodial
// signer route. Since the scripts resolve-or-create and reuse accounts across
// runs, we persist each key to a gitignored file (backend/data/) and reload it.
// The operator account's key comes from the OPERATOR_API_KEY env var instead.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const KEYS_PATH = resolve(process.cwd(), 'data/.account-keys.json');

type KeyMap = Record<string, string>;

function load(): KeyMap {
  try {
    return JSON.parse(readFileSync(KEYS_PATH, 'utf8')) as KeyMap;
  } catch {
    return {};
  }
}

export function rememberAccountKey(handle: string, key: string): void {
  const map = load();
  map[handle] = key;
  mkdirSync(dirname(KEYS_PATH), { recursive: true });
  writeFileSync(KEYS_PATH, JSON.stringify(map, null, 2));
}

export function accountKeyFor(handle: string | null | undefined): string | null {
  if (!handle) return null;
  if (handle === 'operator') return process.env.OPERATOR_API_KEY ?? null;
  return load()[handle] ?? null;
}

// Custodial routes identify the acting account by `handle` or `fromHandle` in
// the request body. Returns the bearer header if we hold that account's key.
export function authHeadersForBody(body: unknown): Record<string, string> {
  if (!body || typeof body !== 'object') return {};
  const b = body as { handle?: string; fromHandle?: string };
  const key = accountKeyFor(b.handle ?? b.fromHandle);
  return key ? { Authorization: `Bearer ${key}` } : {};
}
