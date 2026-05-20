import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';

const DB_PATH = process.env.DB_PATH ?? resolve(process.cwd(), 'data/arc.db');

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export const SIGNING_MODES = ['dev-controlled', 'external', 'circle-modular'] as const;
export type SigningMode = (typeof SIGNING_MODES)[number];

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id              TEXT PRIMARY KEY,
    handle          TEXT UNIQUE,
    circle_wallet_id TEXT UNIQUE,
    wallet_address  TEXT NOT NULL UNIQUE,
    signing_mode    TEXT NOT NULL DEFAULT 'dev-controlled',
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// One-shot migration: older deployments created `handle` as NOT NULL.
// SQLite can't drop NOT NULL in place — recreate the table if needed.
const handleColumn = db
  .prepare("SELECT name, [notnull] FROM pragma_table_info('users') WHERE name = 'handle'")
  .get() as { name: string; notnull: number } | undefined;

if (handleColumn?.notnull === 1) {
  db.exec(`
    BEGIN;
    CREATE TABLE users_new (
      id              TEXT PRIMARY KEY,
      handle          TEXT UNIQUE,
      circle_wallet_id TEXT NOT NULL UNIQUE,
      wallet_address  TEXT NOT NULL UNIQUE,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO users_new (id, handle, circle_wallet_id, wallet_address, created_at)
      SELECT id, handle, circle_wallet_id, wallet_address, created_at FROM users;
    DROP TABLE users;
    ALTER TABLE users_new RENAME TO users;
    COMMIT;
  `);
}

// One-shot migration: pre-M19c deployments had circle_wallet_id NOT NULL and
// no signing_mode column. Frontend signing paths (external wagmi wallets,
// Circle Modular smart accounts) don't have a Circle wallet id, so we need
// the column to be nullable. Use signing_mode to keep records honest about
// which signing path owns the wallet.
const circleWalletColumn = db
  .prepare("SELECT name, [notnull] FROM pragma_table_info('users') WHERE name = 'circle_wallet_id'")
  .get() as { name: string; notnull: number } | undefined;

const signingModeColumn = db
  .prepare("SELECT name FROM pragma_table_info('users') WHERE name = 'signing_mode'")
  .get() as { name: string } | undefined;

if (circleWalletColumn?.notnull === 1 || !signingModeColumn) {
  db.exec(`
    BEGIN;
    CREATE TABLE users_new (
      id              TEXT PRIMARY KEY,
      handle          TEXT UNIQUE,
      circle_wallet_id TEXT UNIQUE,
      wallet_address  TEXT NOT NULL UNIQUE,
      signing_mode    TEXT NOT NULL DEFAULT 'dev-controlled',
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO users_new (id, handle, circle_wallet_id, wallet_address, created_at)
      SELECT id, handle, circle_wallet_id, wallet_address, created_at FROM users;
    DROP TABLE users;
    ALTER TABLE users_new RENAME TO users;
    COMMIT;
  `);
}

export type UserRow = {
  id: string;
  handle: string | null;
  circle_wallet_id: string | null;
  wallet_address: string;
  signing_mode: SigningMode;
  created_at: string;
};

export type User = {
  id: string;
  handle: string | null;
  circleWalletId: string | null;
  walletAddress: string;
  signingMode: SigningMode;
  createdAt: string;
};

export function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    handle: row.handle,
    circleWalletId: row.circle_wallet_id,
    walletAddress: row.wallet_address,
    signingMode: row.signing_mode,
    createdAt: row.created_at,
  };
}
