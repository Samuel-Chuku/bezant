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
    agent_id        TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Idempotent ALTER for pre-M31 databases — adds agent_id to users so each
// account can link an ERC-8004 agentId after on-chain ownership check.
// Stored as TEXT because uint256 doesn't fit in SQLite INTEGER.
const userCols = db
  .prepare("SELECT name FROM pragma_table_info('users')")
  .all() as { name: string }[];
const userColNames = new Set(userCols.map((c) => c.name));
if (!userColNames.has('agent_id')) {
  db.exec('ALTER TABLE users ADD COLUMN agent_id TEXT');
}

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
  agent_id: string | null;
  created_at: string;
};

export type User = {
  id: string;
  handle: string | null;
  circleWalletId: string | null;
  walletAddress: string;
  signingMode: SigningMode;
  agentId: string | null;
  createdAt: string;
};

export function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    handle: row.handle,
    circleWalletId: row.circle_wallet_id,
    walletAddress: row.wallet_address,
    signingMode: row.signing_mode,
    agentId: row.agent_id,
    createdAt: row.created_at,
  };
}

// ─── Jobs index ────────────────────────────────────────────────────────────
// Local cache of JobCreated events from the ERC-8183 reference contract.
// Lets us answer "which jobs involve address X" without scanning chain logs
// on every request. Live state (status, budget) is still read from chain.

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs_index (
    job_id        TEXT PRIMARY KEY,
    client        TEXT NOT NULL,
    provider      TEXT NOT NULL,
    evaluator     TEXT NOT NULL,
    expired_at    INTEGER NOT NULL,
    hook          TEXT NOT NULL,
    block_number  INTEGER NOT NULL,
    tx_hash       TEXT NOT NULL,
    indexed_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_client    ON jobs_index(client);
  CREATE INDEX IF NOT EXISTS idx_jobs_provider  ON jobs_index(provider);
  CREATE INDEX IF NOT EXISTS idx_jobs_evaluator ON jobs_index(evaluator);

  CREATE TABLE IF NOT EXISTS indexer_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Lifecycle events from ERC-8183 (Submitted/Completed/Rejected).
  -- One row per emitted event; PK is (tx_hash, log_index) so re-indexing
  -- the same block range is a no-op.
  CREATE TABLE IF NOT EXISTS job_events (
    job_id        TEXT NOT NULL,
    event_type    TEXT NOT NULL,
    hash_value    TEXT NOT NULL,
    actor         TEXT NOT NULL,
    block_number  INTEGER NOT NULL,
    tx_hash       TEXT NOT NULL,
    log_index     INTEGER NOT NULL,
    indexed_at    TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (tx_hash, log_index)
  );
  CREATE INDEX IF NOT EXISTS idx_job_events_job ON job_events(job_id);

  -- Off-chain deliverable content keyed by (job_id, hash). Only inserted
  -- if the supplied content actually hashes to the claimed hash — the
  -- on-chain bytes32 is the access credential. Reads are parties-only
  -- (enforced in the route via signed-challenge auth).
  -- content_type: 'text' | 'url' | 'file'.
  -- text_content holds the actual text/url, or the filename for files.
  -- mime / size_bytes / file_path are only populated for files.
  CREATE TABLE IF NOT EXISTS deliverables (
    job_id        TEXT NOT NULL,
    hash          TEXT NOT NULL,
    content_type  TEXT NOT NULL,
    text_content  TEXT NOT NULL,
    mime          TEXT,
    size_bytes    INTEGER,
    file_path     TEXT,
    uploaded_by   TEXT NOT NULL,
    uploaded_at   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (job_id, hash)
  );

  -- CCTP V2 inbound bridge arrivals on Arc. Indexed from USDC Transfer
  -- events where from = 0x0 (mints), filtered to tx hashes that also
  -- emit MessageReceived from the MessageTransmitter — so we only record
  -- mints actually caused by a CCTP bridge (not faucets etc.).
  -- source_domain comes from the joined MessageReceived event; NULL if
  -- the join failed (defensive — shouldn't happen for valid bridges).
  -- PK on (tx_hash, log_index) so re-indexing the same range is a no-op.
  CREATE TABLE IF NOT EXISTS bridge_inbound_events (
    recipient      TEXT NOT NULL,
    amount_raw     TEXT NOT NULL,
    source_domain  INTEGER,
    nonce          TEXT,
    block_number   INTEGER NOT NULL,
    tx_hash        TEXT NOT NULL,
    log_index      INTEGER NOT NULL,
    indexed_at     TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (tx_hash, log_index)
  );
  CREATE INDEX IF NOT EXISTS idx_bridge_inbound_recipient ON bridge_inbound_events(recipient);
  CREATE INDEX IF NOT EXISTS idx_bridge_inbound_block ON bridge_inbound_events(block_number);
`);

// Idempotent ALTER TABLE migration for pre-M28 databases that already have
// the deliverables table without the file columns. Guard each ADD with a
// pragma check so re-running doesn't error.
const deliverableCols = db
  .prepare("SELECT name FROM pragma_table_info('deliverables')")
  .all() as { name: string }[];
const colNames = new Set(deliverableCols.map((c) => c.name));
if (!colNames.has('mime')) db.exec('ALTER TABLE deliverables ADD COLUMN mime TEXT');
if (!colNames.has('size_bytes')) db.exec('ALTER TABLE deliverables ADD COLUMN size_bytes INTEGER');
if (!colNames.has('file_path')) db.exec('ALTER TABLE deliverables ADD COLUMN file_path TEXT');

// Idempotent migration for pre-M30 databases — adds amount_raw to job_events
// so JobFunded rows can store the locked amount (uint256 as decimal string).
// Existing Submitted/Completed/Rejected rows keep amount_raw NULL.
const jobEventCols = db
  .prepare("SELECT name FROM pragma_table_info('job_events')")
  .all() as { name: string }[];
const jobEventColNames = new Set(jobEventCols.map((c) => c.name));
if (!jobEventColNames.has('amount_raw')) {
  db.exec('ALTER TABLE job_events ADD COLUMN amount_raw TEXT');
}

export type JobIndexRow = {
  job_id: string;
  client: string;
  provider: string;
  evaluator: string;
  expired_at: number;
  hook: string;
  block_number: number;
  tx_hash: string;
  indexed_at: string;
};

export type JobIndex = {
  jobId: string;
  client: string;
  provider: string;
  evaluator: string;
  expiredAt: number;
  hook: string;
  blockNumber: number;
  txHash: string;
  indexedAt: string;
};

export function rowToJobIndex(row: JobIndexRow): JobIndex {
  return {
    jobId: row.job_id,
    client: row.client,
    provider: row.provider,
    evaluator: row.evaluator,
    expiredAt: row.expired_at,
    hook: row.hook,
    blockNumber: row.block_number,
    txHash: row.tx_hash,
    indexedAt: row.indexed_at,
  };
}

export type JobEventType = 'Submitted' | 'Completed' | 'Rejected' | 'Funded' | 'Refunded';

export type JobEventRow = {
  job_id: string;
  event_type: JobEventType;
  hash_value: string;       // bytes32 hex for Submitted/Completed/Rejected; '' for Funded
  amount_raw: string | null; // raw uint256 string for Funded; null for hash events
  actor: string;
  block_number: number;
  tx_hash: string;
  log_index: number;
  indexed_at: string;
};

export type JobEvent = {
  jobId: string;
  eventType: JobEventType;
  hashValue: string;
  amountRaw: string | null;
  actor: string;
  blockNumber: number;
  txHash: string;
  logIndex: number;
  indexedAt: string;
};

export function rowToJobEvent(row: JobEventRow): JobEvent {
  return {
    jobId: row.job_id,
    eventType: row.event_type,
    hashValue: row.hash_value,
    amountRaw: row.amount_raw,
    actor: row.actor,
    blockNumber: row.block_number,
    txHash: row.tx_hash,
    logIndex: row.log_index,
    indexedAt: row.indexed_at,
  };
}

export type DeliverableContentType = 'text' | 'url' | 'file';

export type DeliverableRow = {
  job_id: string;
  hash: string;
  content_type: DeliverableContentType;
  text_content: string;
  mime: string | null;
  size_bytes: number | null;
  file_path: string | null;
  uploaded_by: string;
  uploaded_at: string;
};

export type Deliverable = {
  jobId: string;
  hash: string;
  contentType: DeliverableContentType;
  textContent: string;
  mime: string | null;
  sizeBytes: number | null;
  filePath: string | null;
  uploadedBy: string;
  uploadedAt: string;
};

export function rowToDeliverable(row: DeliverableRow): Deliverable {
  return {
    jobId: row.job_id,
    hash: row.hash,
    contentType: row.content_type,
    textContent: row.text_content,
    mime: row.mime,
    sizeBytes: row.size_bytes,
    filePath: row.file_path,
    uploadedBy: row.uploaded_by,
    uploadedAt: row.uploaded_at,
  };
}

export function getIndexerState(key: string): string | null {
  const row = db.prepare('SELECT value FROM indexer_state WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setIndexerState(key: string, value: string): void {
  db.prepare(
    `INSERT INTO indexer_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}
