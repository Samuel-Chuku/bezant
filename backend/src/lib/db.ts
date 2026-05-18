import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';

const DB_PATH = process.env.DB_PATH ?? resolve(process.cwd(), 'data/arc.db');

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id              TEXT PRIMARY KEY,
    handle          TEXT NOT NULL UNIQUE,
    circle_wallet_id TEXT NOT NULL UNIQUE,
    wallet_address  TEXT NOT NULL UNIQUE,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

export type UserRow = {
  id: string;
  handle: string;
  circle_wallet_id: string;
  wallet_address: string;
  created_at: string;
};

export type User = {
  id: string;
  handle: string;
  circleWalletId: string;
  walletAddress: string;
  createdAt: string;
};

export function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    handle: row.handle,
    circleWalletId: row.circle_wallet_id,
    walletAddress: row.wallet_address,
    createdAt: row.created_at,
  };
}
