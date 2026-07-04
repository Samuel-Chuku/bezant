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

// Idempotent ALTER for pre-M31 databases - adds agent_id to users so each
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
// SQLite can't drop NOT NULL in place - recreate the table if needed.
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

// Telegram alerts: an optional chat id linked to a user for push notifications.
// Added after the table-recreate migrations above so it survives them (those
// only fire on ancient schemas, but re-reading the columns keeps this
// order-independent).
const userColsAfter = db
  .prepare("SELECT name FROM pragma_table_info('users')")
  .all() as { name: string }[];
if (!new Set(userColsAfter.map((c) => c.name)).has('telegram_chat_id')) {
  db.exec('ALTER TABLE users ADD COLUMN telegram_chat_id TEXT');
}
if (!new Set(userColsAfter.map((c) => c.name)).has('telegram_username')) {
  db.exec('ALTER TABLE users ADD COLUMN telegram_username TEXT');
}
// Per-account API key for dev-controlled (custodial) accounts. Stores only the
// SHA-256 hash of the key; the plaintext is returned once at creation and never
// again. Nullable: a dev-controlled account with no hash cannot authenticate to
// the custodial signer routes (fail-closed).
if (!new Set(userColsAfter.map((c) => c.name)).has('secret_hash')) {
  db.exec('ALTER TABLE users ADD COLUMN secret_hash TEXT');
}

// One-time link tokens (deep-link `t.me/<bot>?start=<token>`) and per-key
// dedupe of alerts already pushed to Telegram.
db.exec(`
  CREATE TABLE IF NOT EXISTS telegram_link_tokens (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS telegram_sent (
    address TEXT NOT NULL,
    key     TEXT NOT NULL,
    sent_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (address, key)
  );
`);

// SIWE-style auth: single-use login nonces and issued bearer sessions. Only the
// SHA-256 of the session token is stored; the plaintext is returned once at
// /auth/verify. expires_at is epoch ms for cheap TTL comparisons.
db.exec(`
  CREATE TABLE IF NOT EXISTS auth_nonces (
    nonce      TEXT PRIMARY KEY,
    address    TEXT NOT NULL,
    message    TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    address    TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_address ON sessions(address);
`);

export type UserRow = {
  id: string;
  handle: string | null;
  circle_wallet_id: string | null;
  wallet_address: string;
  signing_mode: SigningMode;
  agent_id: string | null;
  telegram_chat_id: string | null;
  secret_hash: string | null;
  created_at: string;
};

export type User = {
  id: string;
  handle: string | null;
  walletAddress: string;
  agentId: string | null;
  telegramLinked: boolean;
  createdAt: string;
};

// Public user shape. Deliberately omits circle_wallet_id (custody wallet id) and
// signing_mode — these are internal and were previously world-readable via the
// user directory. The frontend derives signing mode client-side and never reads
// these back.
export function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    handle: row.handle,
    walletAddress: row.wallet_address,
    agentId: row.agent_id,
    // Expose only whether Telegram is linked, never the raw chat id.
    telegramLinked: row.telegram_chat_id != null,
    createdAt: row.created_at,
  };
}

// ─── Pacts index ───────────────────────────────────────────────────────────
// Local cache of JobCreated events from the ERC-8183 reference contract,
// surfaced in our domain as Pacts. Lets us answer "which pacts involve
// address X" without scanning chain logs on every request. Live state
// (status, budget) is still read from chain.

// M41a rename: pre-rename DBs had `jobs_index` / `job_events` and a
// `job_id` column in deliverables. Migrate before the CREATE TABLE block
// so existing rows carry over instead of leaving an empty new table.
const masterRow = (name: string) =>
  db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
if (masterRow('jobs_index') && !masterRow('pacts_index')) {
  db.exec(`
    ALTER TABLE jobs_index RENAME TO pacts_index;
    ALTER TABLE pacts_index RENAME COLUMN job_id TO pact_id;
    DROP INDEX IF EXISTS idx_jobs_client;
    DROP INDEX IF EXISTS idx_jobs_provider;
    DROP INDEX IF EXISTS idx_jobs_evaluator;
  `);
}
if (masterRow('job_events') && !masterRow('pact_events')) {
  db.exec(`
    ALTER TABLE job_events RENAME TO pact_events;
    ALTER TABLE pact_events RENAME COLUMN job_id TO pact_id;
    DROP INDEX IF EXISTS idx_job_events_job;
  `);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS pacts_index (
    pact_id       TEXT PRIMARY KEY,
    client        TEXT NOT NULL,
    provider      TEXT NOT NULL,
    evaluator     TEXT NOT NULL,
    expired_at    INTEGER NOT NULL,
    hook          TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    block_number  INTEGER NOT NULL,
    tx_hash       TEXT NOT NULL,
    indexed_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_pacts_client    ON pacts_index(client);
  CREATE INDEX IF NOT EXISTS idx_pacts_provider  ON pacts_index(provider);
  CREATE INDEX IF NOT EXISTS idx_pacts_evaluator ON pacts_index(evaluator);

  CREATE TABLE IF NOT EXISTS indexer_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Lifecycle events from ERC-8183 (Submitted/Completed/Rejected).
  -- One row per emitted event; PK is (tx_hash, log_index) so re-indexing
  -- the same block range is a no-op.
  CREATE TABLE IF NOT EXISTS pact_events (
    pact_id       TEXT NOT NULL,
    event_type    TEXT NOT NULL,
    hash_value    TEXT NOT NULL,
    actor         TEXT NOT NULL,
    block_number  INTEGER NOT NULL,
    tx_hash       TEXT NOT NULL,
    log_index     INTEGER NOT NULL,
    indexed_at    TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (tx_hash, log_index)
  );
  CREATE INDEX IF NOT EXISTS idx_pact_events_pact ON pact_events(pact_id);

  -- Off-chain deliverable content keyed by (pact_id, hash). Only inserted
  -- if the supplied content actually hashes to the claimed hash - the
  -- on-chain bytes32 is the access credential. Reads are parties-only
  -- (enforced in the route via signed-challenge auth).
  -- content_type: 'text' | 'url' | 'file'.
  -- text_content holds the actual text/url, or the filename for files.
  -- mime / size_bytes / file_path are only populated for files.
  CREATE TABLE IF NOT EXISTS deliverables (
    pact_id       TEXT NOT NULL,
    hash          TEXT NOT NULL,
    content_type  TEXT NOT NULL,
    text_content  TEXT NOT NULL,
    mime          TEXT,
    size_bytes    INTEGER,
    file_path     TEXT,
    uploaded_by   TEXT NOT NULL,
    uploaded_at   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (pact_id, hash)
  );

  -- CCTP V2 inbound bridge arrivals on Arc. Indexed from USDC Transfer
  -- events where from = 0x0 (mints), filtered to tx hashes that also
  -- emit MessageReceived from the MessageTransmitter - so we only record
  -- mints actually caused by a CCTP bridge (not faucets etc.).
  -- source_domain comes from the joined MessageReceived event; NULL if
  -- the join failed (defensive - shouldn't happen for valid bridges).
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
  -- Standalone-escrow trade index: one row per TradeCreated event, used to list
  -- a user's trades (as buyer or seller). Live status is read on demand.
  CREATE TABLE IF NOT EXISTS trade_index (
    trade_id      INTEGER PRIMARY KEY,
    buyer         TEXT NOT NULL,
    seller        TEXT NOT NULL,
    created_block INTEGER NOT NULL,
    tx_hash       TEXT NOT NULL,
    indexed_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- Every trade lifecycle event (propose/counter/agree/fund/finance/attest/
  -- release/dispute/refund/cancel), for the per-trade timeline + notifications.
  -- PK (tx_hash, log_index) so re-indexing a range is a no-op.
  CREATE TABLE IF NOT EXISTS trade_events (
    trade_id     INTEGER NOT NULL,
    kind         TEXT NOT NULL,
    actor        TEXT,
    amount_raw   TEXT,
    block_number INTEGER NOT NULL,
    block_time   INTEGER,
    tx_hash      TEXT NOT NULL,
    log_index    INTEGER NOT NULL,
    indexed_at   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (tx_hash, log_index)
  );
  -- LP deposit/withdraw events on the FinancingPool, for the activity feed.
  -- Indexed alongside trades so the feed serves from the DB (no per-request
  -- chain scan). block_time is unix ms; kind: 'pool-deposit' | 'pool-withdraw'.
  CREATE TABLE IF NOT EXISTS pool_events (
    lp           TEXT NOT NULL,
    kind         TEXT NOT NULL,
    assets_raw   TEXT NOT NULL,
    shares_raw   TEXT NOT NULL,
    block_number INTEGER NOT NULL,
    block_time   INTEGER,
    tx_hash      TEXT NOT NULL,
    log_index    INTEGER NOT NULL,
    indexed_at   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (tx_hash, log_index)
  );
  -- Read-state for notifications/activity, keyed by wallet address so unread
  -- counts stay in sync across a user's devices (was localStorage-only).
  CREATE TABLE IF NOT EXISTS notif_reads (
    address    TEXT NOT NULL,
    key        TEXT NOT NULL,
    read_at    TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (address, key)
  );
  -- Periodic NAV snapshots (share price over time) so we can show 24h / 7d
  -- yield. The RPC prunes historical state, so we can't read past prices on
  -- demand - we sample forward. ts is unix ms.
  CREATE TABLE IF NOT EXISTS pool_nav_snapshots (
    ts           INTEGER PRIMARY KEY,
    share_price  REAL NOT NULL
  );
  -- Pending auto-reveals for the auto-reveal agent. An evaluator who opts in at
  -- commit time hands us (vote, secret); the agent reveals on their behalf once
  -- the reveal window opens, via the operator wallet. One row per
  -- (dispute, evaluator) - a re-commit replaces it. status:
  -- pending | revealed | expired | failed.
  CREATE TABLE IF NOT EXISTS auto_reveals (
    dispute_id    TEXT NOT NULL,
    evaluator     TEXT NOT NULL,
    pact_id       TEXT NOT NULL,
    vote          INTEGER NOT NULL,
    secret        TEXT NOT NULL,
    reveal_after  INTEGER NOT NULL,
    reveal_before INTEGER NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending',
    attempts      INTEGER NOT NULL DEFAULT 0,
    last_error    TEXT,
    tx_hash       TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (dispute_id, evaluator)
  );
  CREATE INDEX IF NOT EXISTS idx_auto_reveals_status ON auto_reveals(status);

  -- Buyer challenge window. When the Trade Officer approves a delivery doc it
  -- does NOT settle immediately - it parks here until finalize_at. The trade
  -- stays Funded, so the buyer can raiseDispute() during the window. A finalizer
  -- poller calls attest() (settles) once finalize_at passes if still Funded.
  CREATE TABLE IF NOT EXISTS pending_attestations (
    trade_id    INTEGER PRIMARY KEY,
    proof_hash  TEXT NOT NULL,
    finalize_at INTEGER NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Cross-chain seller payouts via Circle Gateway. One row per trade (the
  -- PRIMARY KEY makes the payout once-per-trade - a page refresh can't replay
  -- it). Recorded only after the destination mint confirms.
  CREATE TABLE IF NOT EXISTS gateway_payouts (
    trade_id         INTEGER PRIMARY KEY,
    destination_key  TEXT NOT NULL,
    destination_name TEXT NOT NULL,
    amount_usdc      TEXT NOT NULL,
    recipient        TEXT NOT NULL,
    mint_tx          TEXT NOT NULL,
    mint_tx_url      TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Seller's chosen Gateway payout chain, set during the active trade and read
  -- back at settlement. Server-side so it syncs across the seller's devices.
  CREATE TABLE IF NOT EXISTS payout_prefs (
    trade_id        INTEGER NOT NULL,
    seller          TEXT NOT NULL,
    destination_key TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (trade_id, seller)
  );

  -- Trade Officer (automated) review snapshot for officer-route trades: the
  -- submitted document + the agent's pass reasons/confidence, so the trade page
  -- can show an honest "document validated (not full verification)" view later.
  CREATE TABLE IF NOT EXISTS officer_reviews (
    trade_id   INTEGER PRIMARY KEY,
    document   TEXT NOT NULL,
    reasons    TEXT NOT NULL DEFAULT '[]',
    confidence REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Delivery document submitted for a staked-panel trade, so panel verifiers
  -- can review it off-chain while they vote (the chain only holds its hash).
  CREATE TABLE IF NOT EXISTS verification_docs (
    trade_id   INTEGER PRIMARY KEY,
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Panel membership per staked-panel trade, captured when the operator draws
  -- the panel. Lets us answer "which trades need verifier X's vote" without a
  -- reverse scan (the module has no verifier→trades index). Live vote/resolved
  -- status is read on-chain when listing; this is just the membership map.
  CREATE TABLE IF NOT EXISTS verification_assignments (
    trade_id   INTEGER NOT NULL,
    verifier   TEXT NOT NULL,
    module     TEXT NOT NULL DEFAULT '',
    deadline   INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (trade_id, verifier)
  );
  CREATE INDEX IF NOT EXISTS idx_verif_assign_verifier ON verification_assignments(verifier);

  -- Verifier staking ledger events (Staked/Unstaked from the StakedVerifierModule),
  -- for the /verify recent list + the user's activity/notifications. The module
  -- column is the emitting contract so a redeploy's events don't mix with the old.
  CREATE TABLE IF NOT EXISTS verifier_events (
    module       TEXT NOT NULL,
    verifier     TEXT NOT NULL,
    kind         TEXT NOT NULL, -- 'verifier-stake' | 'verifier-unstake'
    amount_raw   TEXT NOT NULL,
    block_number INTEGER NOT NULL,
    block_time   INTEGER,
    tx_hash      TEXT NOT NULL,
    log_index    INTEGER NOT NULL,
    indexed_at   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (tx_hash, log_index)
  );
  CREATE INDEX IF NOT EXISTS idx_verifier_events_verifier ON verifier_events(verifier);
  CREATE INDEX IF NOT EXISTS idx_verifier_events_module ON verifier_events(module);

  -- Operator reputation boost: one trusted operator endorsement per (trade,
  -- agent) when a settled trade also got a counterparty thumbs-up. Dedup key
  -- stops replay/spam (one boost per agent per trade).
  CREATE TABLE IF NOT EXISTS reputation_boosts (
    trade_id   INTEGER NOT NULL,
    agent_id   TEXT NOT NULL,
    tx_hash    TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (trade_id, agent_id)
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
// Idempotent ALTER: pre-existing verification_assignments rows predate the
// `module` column. Scoping by module stops a redeployed module from showing the
// old module's assignments as bogus "missed" entries.
const vaCols = db.prepare("SELECT name FROM pragma_table_info('verification_assignments')").all() as { name: string }[];
if (vaCols.length > 0 && !new Set(vaCols.map((c) => c.name)).has('module')) {
  db.exec("ALTER TABLE verification_assignments ADD COLUMN module TEXT NOT NULL DEFAULT ''");
}

// Idempotent migration: trade_events gained block_time (unix ms) for the
// protocol activity graph + deal tape. Pre-existing rows are backfilled lazily
// by the trade indexer on next run.
const teCols = db.prepare("SELECT name FROM pragma_table_info('trade_events')").all() as { name: string }[];
if (teCols.length > 0 && !new Set(teCols.map((c) => c.name)).has('block_time')) {
  db.exec('ALTER TABLE trade_events ADD COLUMN block_time INTEGER');
}

if (!colNames.has('mime')) db.exec('ALTER TABLE deliverables ADD COLUMN mime TEXT');
if (!colNames.has('size_bytes')) db.exec('ALTER TABLE deliverables ADD COLUMN size_bytes INTEGER');
if (!colNames.has('file_path')) db.exec('ALTER TABLE deliverables ADD COLUMN file_path TEXT');
// M41a rename: pre-rename deliverables had `job_id`; carry the data into
// the renamed column without dropping the table.
if (colNames.has('job_id') && !colNames.has('pact_id')) {
  db.exec('ALTER TABLE deliverables RENAME COLUMN job_id TO pact_id');
}

// Idempotent migration for pre-M30 databases - adds amount_raw to pact_events
// so Funded rows can store the locked amount (uint256 as decimal string).
// Existing Submitted/Completed/Rejected rows keep amount_raw NULL.
const pactEventCols = db
  .prepare("SELECT name FROM pragma_table_info('pact_events')")
  .all() as { name: string }[];
const pactEventColNames = new Set(pactEventCols.map((c) => c.name));
if (!pactEventColNames.has('amount_raw')) {
  db.exec('ALTER TABLE pact_events ADD COLUMN amount_raw TEXT');
}

// Adds dispute_id to pact_events so the wrapper indexer can tag dispute-system
// events (DisputeOpened/Defended/CommitSubmitted/VoteRevealed/Resolved/Conceded)
// with their on-chain dispute id. NULL for all lifecycle (non-dispute) rows.
if (!pactEventColNames.has('dispute_id')) {
  db.exec('ALTER TABLE pact_events ADD COLUMN dispute_id TEXT');
}

// Adds description to pacts_index so per-pact reads can source it from the
// PactCreated event (the wrapper's pacts() struct has no description field,
// unlike the old reference's getJob). Backfills empty for pre-existing rows.
const pactsIndexCols = db
  .prepare("SELECT name FROM pragma_table_info('pacts_index')")
  .all() as { name: string }[];
if (!new Set(pactsIndexCols.map((c) => c.name)).has('description')) {
  db.exec("ALTER TABLE pacts_index ADD COLUMN description TEXT NOT NULL DEFAULT ''");
}

// M41a rename: migrate indexer cursor keys so the indexer resumes from
// where it stopped instead of re-scanning the lookback window.
db.exec(`
  UPDATE indexer_state SET key = 'pacts_index:last_block' WHERE key = 'jobs_index:last_block';
  UPDATE indexer_state SET key = 'pact_events:last_block' WHERE key = 'job_events:last_block';
`);

export type PactIndexRow = {
  pact_id: string;
  client: string;
  provider: string;
  evaluator: string;
  expired_at: number;
  hook: string;
  description: string;
  block_number: number;
  tx_hash: string;
  indexed_at: string;
};

export type PactIndex = {
  pactId: string;
  client: string;
  provider: string;
  evaluator: string;
  expiredAt: number;
  hook: string;
  description: string;
  blockNumber: number;
  txHash: string;
  indexedAt: string;
};

export function rowToPactIndex(row: PactIndexRow): PactIndex {
  return {
    pactId: row.pact_id,
    client: row.client,
    provider: row.provider,
    evaluator: row.evaluator,
    expiredAt: row.expired_at,
    hook: row.hook,
    description: row.description,
    blockNumber: row.block_number,
    txHash: row.tx_hash,
    indexedAt: row.indexed_at,
  };
}

export type PactEventType = 'Submitted' | 'Completed' | 'Rejected' | 'Funded' | 'Refunded';

export type PactEventRow = {
  pact_id: string;
  event_type: PactEventType;
  hash_value: string;       // bytes32 hex for Submitted/Completed/Rejected; '' for Funded
  amount_raw: string | null; // raw uint256 string for Funded; null for hash events
  actor: string;
  block_number: number;
  tx_hash: string;
  log_index: number;
  indexed_at: string;
};

export type PactEvent = {
  pactId: string;
  eventType: PactEventType;
  hashValue: string;
  amountRaw: string | null;
  actor: string;
  blockNumber: number;
  txHash: string;
  logIndex: number;
  indexedAt: string;
};

export function rowToPactEvent(row: PactEventRow): PactEvent {
  return {
    pactId: row.pact_id,
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
  pact_id: string;
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
  pactId: string;
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
    pactId: row.pact_id,
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
