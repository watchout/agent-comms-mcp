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
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'read', 'received', 'in_progress', 'done', 'replied', 'skipped', 'failed')),
      priority INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      read_at TEXT,
      replied_at TEXT,
      replied_with TEXT,
      failed_reason TEXT,
      done_at TEXT,
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
  if (!mqColNames.has('done_at')) {
    gatedExec(`ALTER TABLE message_queue ADD COLUMN done_at TEXT`)
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
      consumer_agent_id TEXT,
      projection_identity_id TEXT,
      intended_projection_identity_id TEXT,
      projection_source TEXT,
      projection_fallback_reason TEXT,
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
  if (!oqColNames.has('consumer_agent_id')) {
    gatedExec(`ALTER TABLE outbound_queue ADD COLUMN consumer_agent_id TEXT`)
  }
  if (!oqColNames.has('projection_identity_id')) {
    gatedExec(`ALTER TABLE outbound_queue ADD COLUMN projection_identity_id TEXT`)
  }
  if (!oqColNames.has('intended_projection_identity_id')) {
    gatedExec(`ALTER TABLE outbound_queue ADD COLUMN intended_projection_identity_id TEXT`)
  }
  if (!oqColNames.has('projection_source')) {
    gatedExec(`ALTER TABLE outbound_queue ADD COLUMN projection_source TEXT`)
  }
  if (!oqColNames.has('projection_fallback_reason')) {
    gatedExec(`ALTER TABLE outbound_queue ADD COLUMN projection_fallback_reason TEXT`)
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
      agent_uri TEXT,
      identity_scope TEXT NOT NULL DEFAULT 'local',
      trust_status TEXT NOT NULL DEFAULT 'local',
      auth_method TEXT NOT NULL DEFAULT 'local',
      auth_subject TEXT,
      disabled_at TEXT,
      identity_metadata TEXT NOT NULL DEFAULT '{}',
      -- Issue #287 (PR-0 cycle 5 axis 4) — inbox cursor persistence
      -- mirrors PG schema added in db/migrations/2026-05-01-inbox-cursor-db-persist.up.sql
      -- so SQLite-backed deployments survive session restarts identically.
      inbox_cursor_at TEXT,
      inbox_cursor_id TEXT,
      last_wake_attempt_at TEXT,
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
  if (!agentsColNames.has('last_wake_attempt_at')) {
    gatedExec(`ALTER TABLE agents ADD COLUMN last_wake_attempt_at TEXT`)
  }
  if (!agentsColNames.has('agent_uri')) {
    gatedExec(`ALTER TABLE agents ADD COLUMN agent_uri TEXT`)
  }
  if (!agentsColNames.has('identity_scope')) {
    gatedExec(`ALTER TABLE agents ADD COLUMN identity_scope TEXT NOT NULL DEFAULT 'local'`)
  }
  if (!agentsColNames.has('trust_status')) {
    gatedExec(`ALTER TABLE agents ADD COLUMN trust_status TEXT NOT NULL DEFAULT 'local'`)
  }
  if (!agentsColNames.has('auth_method')) {
    gatedExec(`ALTER TABLE agents ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'local'`)
  }
  if (!agentsColNames.has('auth_subject')) {
    gatedExec(`ALTER TABLE agents ADD COLUMN auth_subject TEXT`)
  }
  if (!agentsColNames.has('disabled_at')) {
    gatedExec(`ALTER TABLE agents ADD COLUMN disabled_at TEXT`)
  }
  if (!agentsColNames.has('identity_metadata')) {
    gatedExec(`ALTER TABLE agents ADD COLUMN identity_metadata TEXT NOT NULL DEFAULT '{}'`)
  }
  gatedExec(`UPDATE agents SET agent_uri = 'aun://default/agents/' || agent_id WHERE agent_uri IS NULL OR agent_uri = ''`)
  gatedExec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_agent_uri ON agents(agent_uri) WHERE agent_uri IS NOT NULL`)
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_agents_identity_scope ON agents(identity_scope)`)
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_agents_trust_status ON agents(trust_status)`)
  gatedExec(`
    CREATE TRIGGER IF NOT EXISTS trg_agents_agent_uri_after_insert
    AFTER INSERT ON agents
    WHEN NEW.agent_uri IS NULL OR NEW.agent_uri = ''
    BEGIN
      UPDATE agents
         SET agent_uri = 'aun://default/agents/' || NEW.agent_id,
             identity_scope = COALESCE(NULLIF(NEW.identity_scope, ''), 'local'),
             trust_status = COALESCE(NULLIF(NEW.trust_status, ''), 'local'),
             auth_method = COALESCE(NULLIF(NEW.auth_method, ''), 'local'),
             identity_metadata = COALESCE(NEW.identity_metadata, '{}')
       WHERE agent_id = NEW.agent_id;
    END;
  `)

  gatedExec(`
    CREATE TABLE IF NOT EXISTS agent_workspaces (
      workspace_id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL DEFAULT 'default',
      name TEXT NOT NULL,
      workspace_type TEXT NOT NULL DEFAULT 'local_path',
      local_path TEXT,
      repo_url TEXT,
      default_branch TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_agent_workspaces_org ON agent_workspaces(org_id)`)
  gatedExec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_workspaces_local_path ON agent_workspaces(org_id, local_path) WHERE local_path IS NOT NULL`)

  gatedExec(`
    CREATE TABLE IF NOT EXISTS agent_workspace_bindings (
      agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL REFERENCES agent_workspaces(workspace_id) ON DELETE CASCADE,
      binding_role TEXT NOT NULL DEFAULT 'primary',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (agent_id, workspace_id, binding_role)
    )
  `)
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_agent_workspace_bindings_workspace ON agent_workspace_bindings(workspace_id) WHERE active = 1`)

  gatedExec(`
    CREATE TABLE IF NOT EXISTS agent_runtime_instances (
      runtime_instance_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
      workspace_id TEXT REFERENCES agent_workspaces(workspace_id) ON DELETE SET NULL,
      runtime_engine TEXT NOT NULL DEFAULT 'unknown',
      runtime_kind TEXT NOT NULL DEFAULT 'local_process',
      host_id TEXT,
      session_name TEXT,
      process_id INTEGER,
      port INTEGER,
      checkout_path TEXT,
      commit_sha TEXT,
      endpoint_uri TEXT,
      status TEXT NOT NULL DEFAULT 'unknown',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      stopped_at TEXT,
      last_seen_at TEXT,
      metadata TEXT NOT NULL DEFAULT '{}'
    )
  `)
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_agent_runtime_instances_agent_status ON agent_runtime_instances(agent_id, status, started_at DESC)`)
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_agent_runtime_instances_workspace ON agent_runtime_instances(workspace_id) WHERE workspace_id IS NOT NULL`)

  gatedExec(`
    CREATE TABLE IF NOT EXISTS agent_endpoints (
      endpoint_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
      endpoint_uri TEXT NOT NULL,
      transport TEXT NOT NULL DEFAULT 'local',
      auth_method TEXT NOT NULL DEFAULT 'local',
      trust_status TEXT NOT NULL DEFAULT 'local',
      public_key_fingerprint TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      disabled_at TEXT,
      UNIQUE(agent_id, endpoint_uri)
    )
  `)
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_agent_endpoints_uri ON agent_endpoints(endpoint_uri)`)
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_agent_endpoints_status ON agent_endpoints(status)`)

  gatedExec(`
    CREATE TABLE IF NOT EXISTS agent_identity_keys (
      key_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
      key_type TEXT NOT NULL DEFAULT 'ed25519',
      public_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active',
      valid_from TEXT NOT NULL DEFAULT (datetime('now')),
      valid_until TEXT,
      revoked_at TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_agent_identity_keys_agent_status ON agent_identity_keys(agent_id, status)`)

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
    CREATE TABLE IF NOT EXISTS channel_routing_policy (
      channel_id TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
      primary_agent_id TEXT REFERENCES agents(agent_id),
      adapter_owner_agent_id TEXT REFERENCES agents(agent_id),
      outbound_allowlist TEXT,
      native_role_outbound_owners TEXT NOT NULL DEFAULT '{}',
      native_projection_identities TEXT NOT NULL DEFAULT '{}',
      policy_source TEXT NOT NULL DEFAULT 'db',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_channel_routing_policy_primary ON channel_routing_policy(primary_agent_id) WHERE primary_agent_id IS NOT NULL`)
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_channel_routing_policy_adapter_owner ON channel_routing_policy(adapter_owner_agent_id) WHERE adapter_owner_agent_id IS NOT NULL`)

  gatedExec(`
    CREATE TABLE IF NOT EXISTS role_routing (
      role_key TEXT PRIMARY KEY,
      channel_id TEXT REFERENCES channels(id),
      agent_id TEXT REFERENCES agents(agent_id),
      description TEXT,
      new_work_allowed INTEGER NOT NULL DEFAULT 1,
      policy_source TEXT NOT NULL DEFAULT 'db',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_role_routing_agent ON role_routing(agent_id) WHERE agent_id IS NOT NULL`)

  gatedExec(`
    CREATE TABLE IF NOT EXISTS agent_aliases (
      alias TEXT PRIMARY KEY,
      canonical_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
      new_work_allowed INTEGER NOT NULL DEFAULT 1,
      reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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

  gatedExec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6)))),
      event_type TEXT NOT NULL,
      agent_id TEXT,
      target TEXT,
      detail TEXT,
      org_id TEXT NOT NULL DEFAULT 'default',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_audit_log_event ON audit_log(event_type, created_at DESC)`)
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_audit_log_agent ON audit_log(agent_id, created_at DESC)`)
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_audit_log_org ON audit_log(org_id, created_at DESC)`)

  db.close()
  console.log(`SQLite migration complete: ${path}`)
}

if (import.meta.main) {
  migrateSqlite()
}
