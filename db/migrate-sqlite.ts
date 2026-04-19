import { Database } from 'bun:sqlite'

export function migrateSqlite(dbPath?: string): void {
  const path = dbPath ?? process.env.AGENT_COM_SQLITE_PATH ?? './agent-com.db'
  const db = new Database(path, { create: true })
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')

  db.exec(`
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

  db.exec(`CREATE INDEX IF NOT EXISTS idx_am_channel_created ON agent_messages(channel_id, created_at)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_am_discord_id ON agent_messages(discord_message_id) WHERE discord_message_id IS NOT NULL`)
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_messages_discord_id ON agent_messages(discord_message_id) WHERE discord_message_id IS NOT NULL`)

  db.exec(`
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
      failed_reason TEXT
    )
  `)

  db.exec(`CREATE INDEX IF NOT EXISTS idx_mq_agent_pending ON message_queue(agent_id, status, priority DESC, created_at ASC)`)
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_mq_agent_message ON message_queue(agent_id, message_id) WHERE message_id IS NOT NULL`)

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
    db.exec(`ALTER TABLE message_queue ADD COLUMN failed_reason TEXT`)
  }

  db.exec(`
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

  db.exec(`CREATE INDEX IF NOT EXISTS idx_oq_pending ON outbound_queue(status, created_at ASC) WHERE status = 'pending'`)

  // Idempotent column additions for DBs created before these fields were added.
  // SQLite's ALTER TABLE lacks IF NOT EXISTS, so we check PRAGMA first.
  const oqCols = db.query(`PRAGMA table_info(outbound_queue)`).all() as Array<{ name: string }>
  const oqColNames = new Set(oqCols.map((c) => c.name))
  if (!oqColNames.has('next_retry_at')) {
    db.exec(`ALTER TABLE outbound_queue ADD COLUMN next_retry_at TEXT`)
  }
  if (!oqColNames.has('discord_message_id')) {
    db.exec(`ALTER TABLE outbound_queue ADD COLUMN discord_message_id TEXT`)
  }

  db.exec(`
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
      current_message_id TEXT,
      metadata TEXT DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      name TEXT,
      type TEXT DEFAULT 'channel',
      topic TEXT,
      members TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      channel_id TEXT REFERENCES channels(id),
      name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS rate_limits (
      agent_id TEXT NOT NULL,
      window_start TEXT NOT NULL DEFAULT (datetime('now')),
      count INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (agent_id)
    )
  `)

  db.exec(`
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
