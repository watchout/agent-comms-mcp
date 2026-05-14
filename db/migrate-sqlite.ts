import { Database } from 'bun:sqlite'
import {
  DestructiveMigrationBlockedError,
  assertDestructiveMigrationAllowed,
  destructiveGateLogLine,
} from './destructive-migration-gate'

export function migrateSqlite(dbPath?: string): void {
  console.log(destructiveGateLogLine())
  const path = dbPath ?? process.env.AGENT_COM_SQLITE_PATH ?? './agent-com.db'
  const db = new Database(path, { create: true })
  // incident #339: gate every SQL string handed to sqlite. PRAGMA is
  // non-destructive but routing through the same path keeps adapter
  // symmetry with the pg side (spec §1.5).
  const gatedExec = (sql: string): void => {
    assertDestructiveMigrationAllowed(sql)
    db.exec(sql)
  }
  gatedExec('PRAGMA journal_mode = WAL')
  gatedExec('PRAGMA foreign_keys = ON')

  gatedExec(`
    CREATE TABLE IF NOT EXISTS agent_messages (
      id TEXT PRIMARY KEY,
      channel_id TEXT,
      thread_id TEXT,
      author_id TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      message_type TEXT NOT NULL DEFAULT 'message',
      mentions TEXT NOT NULL DEFAULT '[]',
      reply_to TEXT,
      attachments TEXT NOT NULL DEFAULT '[]',
      metadata TEXT DEFAULT '{}',
      discord_message_id TEXT,
      source TEXT DEFAULT 'agent-comms',
      direction TEXT DEFAULT 'inbound',
      role TEXT DEFAULT 'agent',
      depth INTEGER DEFAULT 0,
      sequence INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  gatedExec(`CREATE INDEX IF NOT EXISTS idx_am_channel_created ON agent_messages(channel_id, created_at)`)
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_am_discord_id ON agent_messages(discord_message_id) WHERE discord_message_id IS NOT NULL`)
  gatedExec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_messages_discord_id ON agent_messages(discord_message_id) WHERE discord_message_id IS NOT NULL`)

  // Issue #266: input_mentions trace column (SQLite stores TEXT[] as JSON string).
  const amCols = db.query(`PRAGMA table_info(agent_messages)`).all() as Array<{ name: string }>
  const amColNames = new Set(amCols.map((c) => c.name))
  if (!amColNames.has('input_mentions')) {
    gatedExec(`ALTER TABLE agent_messages ADD COLUMN input_mentions TEXT`)
  }

  gatedExec(`
    CREATE TABLE IF NOT EXISTS message_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      message_id TEXT,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'read', 'replied', 'skipped', 'failed')),
      priority INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      read_at TEXT,
      replied_at TEXT,
      replied_with TEXT,
      failed_reason TEXT,
      intent TEXT NOT NULL DEFAULT 'request',
      expect_response INTEGER NOT NULL DEFAULT 1,
      context TEXT NOT NULL DEFAULT '{}',
      -- Issue #278 (A) — per-row claim columns. Mirrors the PG schema so
      -- the CLI's claim lookup (cli/index.ts sendMessage, segment 3d)
      -- works in SQLite mode too. claim_expires_at uses TEXT for SQLite
      -- ISO-8601 timestamps; the actual TTL math runs in JS, not SQL.
      claimed_by TEXT,
      claimed_at TEXT,
      claim_expires_at TEXT
    )
  `)

  gatedExec(`CREATE INDEX IF NOT EXISTS idx_mq_agent_pending ON message_queue(agent_id, status, priority DESC, created_at ASC)`)
  gatedExec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_mq_agent_message ON message_queue(agent_id, message_id) WHERE message_id IS NOT NULL`)

  // v2.1.0 PR 1/3: idempotent ADD COLUMN for pre-v2.1.0 SQLite DBs (SQLite lacks
  // ALTER TABLE ADD COLUMN IF NOT EXISTS, so we PRAGMA check first). The CHECK
  // constraint on existing tables cannot be modified in place without a table
  // rebuild — for now we accept that operators upgrading from pre-v2.1.0 SQLite
  // will hit a CHECK violation the first time status='skipped' / 'failed' is
  // written, and should drop + recreate the DB (OSS users have no production
  // data to preserve yet). New SQLite DBs created from this migration get the
  // v2.1.0 CHECK constraint above.
  const mqCols = db.query(`PRAGMA table_info(message_queue)`).all() as Array<{ name: string }>
  const mqColNames = new Set(mqCols.map((c) => c.name))
  if (!mqColNames.has('failed_reason')) {
    gatedExec(`ALTER TABLE message_queue ADD COLUMN failed_reason TEXT`)
  }
  if (!mqColNames.has('intent')) {
    gatedExec(`ALTER TABLE message_queue ADD COLUMN intent TEXT NOT NULL DEFAULT 'request'`)
  }
  if (!mqColNames.has('expect_response')) {
    gatedExec(`ALTER TABLE message_queue ADD COLUMN expect_response INTEGER NOT NULL DEFAULT 1`)
  }
  if (!mqColNames.has('context')) {
    gatedExec(`ALTER TABLE message_queue ADD COLUMN context TEXT NOT NULL DEFAULT '{}'`)
  }
  // Issue #278 (A) segment 3d — backfill the per-row claim columns on
  // pre-Stage-B SQLite DBs. SQLite lacks ALTER TABLE ADD COLUMN IF NOT
  // EXISTS, so PRAGMA-check first.
  if (!mqColNames.has('claimed_by')) {
    gatedExec(`ALTER TABLE message_queue ADD COLUMN claimed_by TEXT`)
  }
  if (!mqColNames.has('claimed_at')) {
    gatedExec(`ALTER TABLE message_queue ADD COLUMN claimed_at TEXT`)
  }
  if (!mqColNames.has('claim_expires_at')) {
    gatedExec(`ALTER TABLE message_queue ADD COLUMN claim_expires_at TEXT`)
  }
  // Issue #278 (A) segment 3d — drop legacy current_message_id from
  // pre-Stage-B SQLite DBs. SQLite supports DROP COLUMN as of 3.35; for
  // older DBs we accept the dead column (PG schema is the source of truth).
  const aCols = db.query(`PRAGMA table_info(agents)`).all() as Array<{ name: string }>
  const aColNames = new Set(aCols.map((c) => c.name))
  if (aColNames.has('current_message_id')) {
    try {
      gatedExec(`ALTER TABLE agents DROP COLUMN current_message_id`)
    } catch (e) {
      // The gate's block decision is authoritative — re-throw it.
      if (e instanceof DestructiveMigrationBlockedError) throw e
      // SQLite < 3.35 — leave the column in place. Stage B reads /
      // writes never touch it, so it is dead but harmless.
    }
  }

  gatedExec(`
    CREATE TABLE IF NOT EXISTS outbound_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      channel_external_id TEXT NOT NULL,
      content TEXT NOT NULL,
      mentions_display TEXT DEFAULT '[]',
      attachments TEXT DEFAULT '[]',
      reply_to_discord_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'sent', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      sent_at TEXT,
      claimed_at TEXT,
      claimed_by TEXT,
      next_retry_at TEXT,
      discord_message_id TEXT
    )
  `)

  gatedExec(`CREATE INDEX IF NOT EXISTS idx_oq_pending ON outbound_queue(status, created_at ASC) WHERE status = 'pending'`)

  // Idempotent column additions for DBs created before these fields were added.
  // SQLite's ALTER TABLE lacks IF NOT EXISTS, so we check PRAGMA first.
  const oqCols = db.query(`PRAGMA table_info(outbound_queue)`).all() as Array<{ name: string }>
  const oqColNames = new Set(oqCols.map((c) => c.name))
  if (!oqColNames.has('next_retry_at')) {
    gatedExec(`ALTER TABLE outbound_queue ADD COLUMN next_retry_at TEXT`)
  }
  if (!oqColNames.has('discord_message_id')) {
    gatedExec(`ALTER TABLE outbound_queue ADD COLUMN discord_message_id TEXT`)
  }

  gatedExec(`
    CREATE TABLE IF NOT EXISTS agents (
      agent_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL DEFAULT '',
      agent_type TEXT NOT NULL DEFAULT 'dev',
      cli_type TEXT,
      discord_token TEXT,
      discord_user_id TEXT,
      status TEXT NOT NULL DEFAULT 'offline',
      status_detail TEXT,
      status_updated_at TEXT,
      last_seen_at TEXT,
      heartbeat_interval INTEGER DEFAULT 30,
      heartbeat_at TEXT,
      observer_mode INTEGER NOT NULL DEFAULT 0,
      -- Issue #278 (A) segment 3d — current_message_id removed; the per-row
      -- claim model on message_queue (claimed_by / claimed_at /
      -- claim_expires_at) replaces it.
      metadata TEXT DEFAULT '{}',
      -- Issue #287 (PR-0 cycle 5 axis 4) — inbox cursor persistence
      -- mirrors PG schema added in db/migrations/2026-05-01-inbox-cursor-db-persist.up.sql
      -- so SQLite-backed deployments survive session restarts identically.
      inbox_cursor_at TEXT,
      inbox_cursor_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  // Idempotent ADD COLUMN for pre-#287 SQLite DBs.
  const agentsCols = db.query(`PRAGMA table_info(agents)`).all() as Array<{ name: string }>
  const agentsColNames = new Set(agentsCols.map((c) => c.name))
  if (!agentsColNames.has('inbox_cursor_at')) {
    gatedExec(`ALTER TABLE agents ADD COLUMN inbox_cursor_at TEXT`)
  }
  if (!agentsColNames.has('inbox_cursor_id')) {
    gatedExec(`ALTER TABLE agents ADD COLUMN inbox_cursor_id TEXT`)
  }

  gatedExec(`
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      name TEXT,
      type TEXT DEFAULT 'channel',
      topic TEXT,
      members TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  gatedExec(`
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      channel_id TEXT REFERENCES channels(id),
      name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  // v2.1.0 Phase 2 F: the CLI send tool looks up Discord adapter mappings on
  // channel_adapters / thread_adapters to decide whether to enqueue an
  // outbound_queue row. SQLite's original migration omitted these tables
  // because the SQLite path was not the default when they were introduced;
  // adding them as CREATE IF NOT EXISTS keeps the schema in parity with PG so
  // the send tool succeeds (with outbound_skip_reason when no adapter match,
  // matching PG behaviour).
  gatedExec(`
    CREATE TABLE IF NOT EXISTS channel_adapters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT NOT NULL REFERENCES channels(id),
      platform TEXT NOT NULL,
      external_id TEXT NOT NULL,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(channel_id, platform)
    )
  `)

  gatedExec(`
    CREATE TABLE IF NOT EXISTS thread_adapters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL REFERENCES threads(id),
      platform TEXT NOT NULL,
      external_id TEXT NOT NULL,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(thread_id, platform)
    )
  `)

  gatedExec(`
    CREATE TABLE IF NOT EXISTS rate_limits (
      agent_id TEXT NOT NULL,
      window_start TEXT NOT NULL DEFAULT (datetime('now')),
      count INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (agent_id)
    )
  `)

  gatedExec(`
    CREATE TABLE IF NOT EXISTS duplicate_hashes (
      hash TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  db.close()
  console.log(`SQLite migration complete: ${path}`)
}

if (import.meta.main) {
  migrateSqlite()
}
