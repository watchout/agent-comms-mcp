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
  const uuidDefault = `(lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6))))`
  gatedExec('PRAGMA journal_mode = WAL')
  gatedExec('PRAGMA foreign_keys = ON')

  gatedExec(`
    CREATE TABLE IF NOT EXISTS agent_messages (
      id TEXT PRIMARY KEY NOT NULL,
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
      consumer_source TEXT,
      delivery_connector_instance_id TEXT,
      channel_binding_id TEXT,
      provider_channel_access_id TEXT,
      projection_identity_id TEXT,
      intended_projection_identity_id TEXT,
      projection_source TEXT,
      projection_fallback_reason TEXT,
      delivery_fallback_reason TEXT,
      delivery_diagnostics TEXT DEFAULT '[]',
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
      agent_id TEXT PRIMARY KEY NOT NULL,
      org_id TEXT NOT NULL DEFAULT 'default',
      display_name TEXT NOT NULL DEFAULT '',
      agent_type TEXT NOT NULL DEFAULT 'dev',
      runtime TEXT NOT NULL DEFAULT 'TUI',
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
      channel_port INTEGER,
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
      ui_id INTEGER,
      ui_handle TEXT,
      home_directory TEXT,
      runtime_engine_preference TEXT,
      provider_token_source_ref TEXT,
      expected_provider_identity TEXT NOT NULL DEFAULT '{}',
      profile_enabled INTEGER NOT NULL DEFAULT 1,
      profile_revision INTEGER NOT NULL DEFAULT 1,
      profile_source TEXT NOT NULL DEFAULT 'legacy',
      profile_updated_at TEXT,
      historical_only INTEGER NOT NULL DEFAULT 0,
      new_work_allowed INTEGER NOT NULL DEFAULT 1,
      -- Issue #287 (PR-0 cycle 5 axis 4) — inbox cursor persistence
      -- mirrors PG schema added in db/migrations/2026-05-01-inbox-cursor-db-persist.up.sql
      -- so SQLite-backed deployments survive session restarts identically.
      inbox_cursor_at TEXT,
      inbox_cursor_id TEXT,
      last_wake_attempt_at TEXT,
      registered_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  // Idempotent ADD COLUMN for pre-#287 SQLite DBs.
  const agentsCols = db.query(`PRAGMA table_info(agents)`).all() as Array<{ name: string }>
  const agentsColNames = new Set(agentsCols.map((c) => c.name))
  if (!agentsColNames.has('org_id')) {
    gatedExec(`ALTER TABLE agents ADD COLUMN org_id TEXT NOT NULL DEFAULT 'default'`)
  }
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
  // #530: the `status` CLI extension joins on agents.runtime to surface
  // TUI bots without tmux_session metadata as drift. SQLite was missing
  // the column (PG has had it since the pre-#341 migration); add it
  // here with the same default the runtime self-register path uses
  // (server.ts uses 'TUI' as the implicit fallback when bots register).
  if (!agentsColNames.has('runtime')) {
    gatedExec(`ALTER TABLE agents ADD COLUMN runtime TEXT NOT NULL DEFAULT 'TUI'`)
  }
  if (!agentsColNames.has('channel_port')) {
    gatedExec(`ALTER TABLE agents ADD COLUMN channel_port INTEGER`)
  }
  if (!agentsColNames.has('metadata')) {
    gatedExec(`ALTER TABLE agents ADD COLUMN metadata TEXT DEFAULT '{}'`)
  }
  if (!agentsColNames.has('identity_metadata')) {
    gatedExec(`ALTER TABLE agents ADD COLUMN identity_metadata TEXT NOT NULL DEFAULT '{}'`)
  }
  if (!agentsColNames.has('ui_id')) {
    gatedExec(`ALTER TABLE agents ADD COLUMN ui_id INTEGER`)
  }
  if (!agentsColNames.has('ui_handle')) {
    gatedExec(`ALTER TABLE agents ADD COLUMN ui_handle TEXT`)
  }
  if (!agentsColNames.has('home_directory')) {
    gatedExec(`ALTER TABLE agents ADD COLUMN home_directory TEXT`)
  }
  if (!agentsColNames.has('runtime_engine_preference')) {
    gatedExec(`ALTER TABLE agents ADD COLUMN runtime_engine_preference TEXT`)
  }
  if (!agentsColNames.has('provider_token_source_ref')) {
    gatedExec(`ALTER TABLE agents ADD COLUMN provider_token_source_ref TEXT`)
  }
  if (!agentsColNames.has('expected_provider_identity')) {
    gatedExec(`ALTER TABLE agents ADD COLUMN expected_provider_identity TEXT NOT NULL DEFAULT '{}'`)
  }
  if (!agentsColNames.has('profile_enabled')) {
    gatedExec(`ALTER TABLE agents ADD COLUMN profile_enabled INTEGER NOT NULL DEFAULT 1`)
  }
  if (!agentsColNames.has('profile_revision')) {
    gatedExec(`ALTER TABLE agents ADD COLUMN profile_revision INTEGER NOT NULL DEFAULT 1`)
  }
  if (!agentsColNames.has('profile_source')) {
    gatedExec(`ALTER TABLE agents ADD COLUMN profile_source TEXT NOT NULL DEFAULT 'legacy'`)
  }
  if (!agentsColNames.has('profile_updated_at')) {
    gatedExec(`ALTER TABLE agents ADD COLUMN profile_updated_at TEXT`)
  }
  if (!agentsColNames.has('historical_only')) {
    gatedExec(`ALTER TABLE agents ADD COLUMN historical_only INTEGER NOT NULL DEFAULT 0`)
  }
  if (!agentsColNames.has('new_work_allowed')) {
    gatedExec(`ALTER TABLE agents ADD COLUMN new_work_allowed INTEGER NOT NULL DEFAULT 1`)
  }
  if (!agentsColNames.has('registered_at')) {
    gatedExec(`ALTER TABLE agents ADD COLUMN registered_at TEXT`)
  }
  gatedExec(`UPDATE agents SET agent_uri = 'aun://default/agents/' || agent_id WHERE agent_uri IS NULL OR agent_uri = ''`)
  gatedExec(`UPDATE agents SET expected_provider_identity = '{}' WHERE expected_provider_identity IS NULL`)
  gatedExec(`UPDATE agents SET metadata = '{}' WHERE metadata IS NULL OR metadata = ''`)
  gatedExec(`UPDATE agents SET profile_enabled = 1 WHERE profile_enabled IS NULL`)
  gatedExec(`UPDATE agents SET profile_revision = 1 WHERE profile_revision IS NULL OR profile_revision < 1`)
  gatedExec(`UPDATE agents SET profile_source = 'legacy' WHERE profile_source IS NULL OR profile_source = ''`)
  gatedExec(`UPDATE agents SET historical_only = 0 WHERE historical_only IS NULL`)
  gatedExec(`UPDATE agents SET new_work_allowed = 1 WHERE new_work_allowed IS NULL`)
  gatedExec(`
    UPDATE agents
       SET ui_id = rowid
     WHERE ui_id IS NULL
       AND agent_type <> 'human'
       AND COALESCE(profile_enabled, 1) = 1
  `)
  gatedExec(`
    UPDATE agents
       SET ui_handle = COALESCE(NULLIF(CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.replaces') ELSE NULL END, ''), agent_id)
     WHERE (ui_handle IS NULL OR ui_handle = '')
       AND agent_type <> 'human'
       AND COALESCE(profile_enabled, 1) = 1
  `)
  gatedExec(`UPDATE agents SET runtime = cli_type WHERE (runtime IS NULL OR runtime = '' OR runtime = 'unknown' OR runtime = 'TUI') AND cli_type IS NOT NULL AND cli_type <> ''`)
  gatedExec(`UPDATE agents SET runtime = 'TUI' WHERE runtime IS NULL OR runtime = '' OR runtime = 'unknown'`)
  gatedExec(`UPDATE agents SET registered_at = COALESCE(registered_at, created_at, datetime('now')) WHERE registered_at IS NULL OR registered_at = ''`)
  gatedExec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_agent_uri ON agents(agent_uri) WHERE agent_uri IS NOT NULL`)
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_agents_identity_scope ON agents(identity_scope)`)
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_agents_trust_status ON agents(trust_status)`)
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_agents_home_directory ON agents(org_id, home_directory) WHERE home_directory IS NOT NULL`)
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_agents_profile_enabled ON agents(profile_enabled)`)
  gatedExec(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_agents_ui_id_active
      ON agents(ui_id)
      WHERE ui_id IS NOT NULL
        AND agent_type <> 'human'
        AND COALESCE(profile_enabled, 1) = 1
  `)
  gatedExec(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_agents_ui_handle_active
      ON agents(lower(ui_handle))
      WHERE ui_handle IS NOT NULL
        AND ui_handle <> ''
        AND agent_type <> 'human'
        AND COALESCE(profile_enabled, 1) = 1
  `)
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
             identity_metadata = COALESCE(NEW.identity_metadata, '{}'),
             expected_provider_identity = COALESCE(NEW.expected_provider_identity, '{}'),
             profile_enabled = COALESCE(NEW.profile_enabled, 1),
             profile_revision = COALESCE(NULLIF(NEW.profile_revision, 0), 1),
             profile_source = COALESCE(NULLIF(NEW.profile_source, ''), 'legacy')
       WHERE agent_id = NEW.agent_id;
    END;
  `)
  gatedExec(`
    CREATE TRIGGER IF NOT EXISTS trg_agents_runtime_after_insert
    AFTER INSERT ON agents
    WHEN (NEW.runtime IS NULL OR NEW.runtime = '' OR NEW.runtime = 'unknown') AND NEW.cli_type IS NOT NULL
    BEGIN
      UPDATE agents
         SET runtime = NEW.cli_type
       WHERE agent_id = NEW.agent_id;
    END;
  `)
  gatedExec(`
    CREATE TRIGGER IF NOT EXISTS trg_agents_ui_identity_after_insert
    AFTER INSERT ON agents
    WHEN NEW.agent_type <> 'human'
      AND COALESCE(NEW.profile_enabled, 1) = 1
      AND (NEW.ui_id IS NULL OR NEW.ui_handle IS NULL OR NEW.ui_handle = '')
    BEGIN
      UPDATE agents
         SET ui_id = COALESCE(NEW.ui_id, (SELECT COALESCE(MAX(ui_id), 0) + 1 FROM agents WHERE agent_id <> NEW.agent_id)),
             ui_handle = COALESCE(
               NULLIF(NEW.ui_handle, ''),
               NULLIF(CASE WHEN json_valid(NEW.metadata) THEN json_extract(NEW.metadata, '$.replaces') ELSE NULL END, ''),
               NEW.agent_id
             )
       WHERE agent_id = NEW.agent_id;
    END;
  `)
  gatedExec(`
    CREATE TRIGGER IF NOT EXISTS trg_agents_ui_identity_after_update
    AFTER UPDATE ON agents
    WHEN NEW.agent_type <> 'human'
      AND COALESCE(NEW.profile_enabled, 1) = 1
      AND (NEW.ui_id IS NULL OR NEW.ui_handle IS NULL OR NEW.ui_handle = '')
    BEGIN
      UPDATE agents
         SET ui_id = COALESCE(NEW.ui_id, (SELECT COALESCE(MAX(ui_id), 0) + 1 FROM agents WHERE agent_id <> NEW.agent_id)),
             ui_handle = COALESCE(
               NULLIF(NEW.ui_handle, ''),
               NULLIF(CASE WHEN json_valid(NEW.metadata) THEN json_extract(NEW.metadata, '$.replaces') ELSE NULL END, ''),
               NEW.agent_id
             )
       WHERE agent_id = NEW.agent_id;
    END;
  `)

  gatedExec(`
    CREATE TABLE IF NOT EXISTS agent_workspaces (
      workspace_id TEXT PRIMARY KEY NOT NULL,
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
      runtime_instance_id TEXT PRIMARY KEY NOT NULL DEFAULT ${uuidDefault},
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
    CREATE TABLE IF NOT EXISTS runtime_memory_ready_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
      project TEXT NOT NULL,
      runtime_instance_id TEXT NOT NULL,
      profile_revision INTEGER,
      profile_source TEXT,
      session_name TEXT NOT NULL,
      port INTEGER NOT NULL,
      expected_agent_id TEXT NOT NULL,
      checkout_path TEXT,
      checkout_commit_sha TEXT,
      recovery_command TEXT NOT NULL,
      result_status TEXT NOT NULL CHECK (result_status IN ('ready', 'failed', 'bypassed')),
      failure_reason TEXT,
      completed_at TEXT NOT NULL,
      evidence_path TEXT,
      evidence_log_id TEXT,
      valid_until TEXT NOT NULL,
      source TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_runtime_memory_ready_latest ON runtime_memory_ready_evidence(agent_id, project, completed_at DESC)`)
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_runtime_memory_ready_runtime ON runtime_memory_ready_evidence(runtime_instance_id, valid_until DESC)`)

  gatedExec(`
    CREATE TABLE IF NOT EXISTS agent_endpoints (
      endpoint_id TEXT PRIMARY KEY NOT NULL DEFAULT ${uuidDefault},
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
      key_id TEXT PRIMARY KEY NOT NULL DEFAULT ${uuidDefault},
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
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT,
      type TEXT DEFAULT 'channel',
      topic TEXT,
      members TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  gatedExec(`
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY NOT NULL,
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
    CREATE TABLE IF NOT EXISTS connector_instances (
      connector_instance_id TEXT PRIMARY KEY NOT NULL DEFAULT ${uuidDefault},
      agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
      runtime_instance_id TEXT REFERENCES agent_runtime_instances(runtime_instance_id) ON DELETE SET NULL,
      provider TEXT NOT NULL DEFAULT 'discord',
      connector_kind TEXT NOT NULL DEFAULT 'chat_adapter',
      transport TEXT NOT NULL DEFAULT 'discord_gateway',
      connector_uri TEXT,
      status TEXT NOT NULL DEFAULT 'registered' CHECK (status IN ('registered', 'active', 'standby', 'draining', 'stopped', 'disabled')),
      trust_status TEXT NOT NULL DEFAULT 'local' CHECK (trust_status IN ('local', 'unverified', 'verified', 'revoked', 'disabled')),
      capabilities TEXT NOT NULL DEFAULT '{}',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT,
      disabled_at TEXT
    )
  `)
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_connector_instances_agent_status ON connector_instances(agent_id, status)`)
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_connector_instances_runtime ON connector_instances(runtime_instance_id) WHERE runtime_instance_id IS NOT NULL`)
  gatedExec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_connector_instances_provider_uri ON connector_instances(provider, connector_uri) WHERE connector_uri IS NOT NULL`)

  gatedExec(`
    CREATE TABLE IF NOT EXISTS channel_connector_bindings (
      channel_binding_id TEXT PRIMARY KEY NOT NULL DEFAULT ${uuidDefault},
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      provider TEXT NOT NULL DEFAULT 'discord',
      connector_instance_id TEXT REFERENCES connector_instances(connector_instance_id) ON DELETE SET NULL,
      binding_role TEXT NOT NULL DEFAULT 'outbound' CHECK (binding_role IN ('inbound', 'outbound', 'bidirectional', 'projection', 'presence', 'worker')),
      priority INTEGER NOT NULL DEFAULT 100,
      max_concurrency INTEGER NOT NULL DEFAULT 1,
      ordering_scope TEXT NOT NULL DEFAULT 'thread' CHECK (ordering_scope IN ('none', 'channel', 'thread', 'custom')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'standby', 'disabled')),
      policy_source TEXT NOT NULL DEFAULT 'db',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      disabled_at TEXT
    )
  `)
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_channel_connector_bindings_channel ON channel_connector_bindings(channel_id, provider, binding_role, status)`)
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_channel_connector_bindings_connector ON channel_connector_bindings(connector_instance_id) WHERE connector_instance_id IS NOT NULL`)
  gatedExec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_connector_bindings_active_unique ON channel_connector_bindings(channel_id, provider, binding_role, connector_instance_id) WHERE status = 'active' AND connector_instance_id IS NOT NULL`)

  gatedExec(`
    CREATE TABLE IF NOT EXISTS connector_credentials (
      credential_id TEXT PRIMARY KEY NOT NULL DEFAULT ${uuidDefault},
      provider TEXT NOT NULL DEFAULT 'discord',
      agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
      connector_instance_id TEXT REFERENCES connector_instances(connector_instance_id) ON DELETE SET NULL,
      credential_kind TEXT NOT NULL DEFAULT 'bot_token',
      secret_ref TEXT NOT NULL,
      token_fingerprint TEXT,
      status TEXT NOT NULL DEFAULT 'registered' CHECK (status IN ('registered', 'active', 'disabled', 'rotated', 'revoked')),
      trust_status TEXT NOT NULL DEFAULT 'local' CHECK (trust_status IN ('local', 'unverified', 'verified', 'revoked', 'disabled')),
      source TEXT NOT NULL DEFAULT 'bot_profile_projector',
      evidence_revision INTEGER NOT NULL DEFAULT 1,
      last_verified_at TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      disabled_at TEXT,
      revoked_at TEXT
    )
  `)
  gatedExec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_connector_credentials_provider_secret_ref_live ON connector_credentials(provider, secret_ref) WHERE status IN ('registered', 'active')`)
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_connector_credentials_agent_status ON connector_credentials(agent_id, provider, status)`)
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_connector_credentials_connector ON connector_credentials(connector_instance_id) WHERE connector_instance_id IS NOT NULL`)

  gatedExec(`
    CREATE TABLE IF NOT EXISTS agent_provider_identities (
      provider_identity_id TEXT PRIMARY KEY NOT NULL DEFAULT ${uuidDefault},
      agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
      provider TEXT NOT NULL DEFAULT 'discord',
      provider_subject_id TEXT NOT NULL,
      provider_handle TEXT,
      identity_kind TEXT NOT NULL DEFAULT 'bot',
      status TEXT NOT NULL DEFAULT 'expected' CHECK (status IN ('expected', 'verified', 'disabled', 'revoked')),
      trust_status TEXT NOT NULL DEFAULT 'unverified' CHECK (trust_status IN ('local', 'unverified', 'verified', 'revoked', 'disabled')),
      source TEXT NOT NULL DEFAULT 'bot_profile_projector',
      evidence_revision INTEGER NOT NULL DEFAULT 1,
      last_verified_at TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      disabled_at TEXT,
      revoked_at TEXT
    )
  `)
  gatedExec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_provider_identities_provider_subject_live ON agent_provider_identities(provider, provider_subject_id) WHERE status IN ('expected', 'verified')`)
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_agent_provider_identities_agent_provider ON agent_provider_identities(agent_id, provider, status)`)

  gatedExec(`
    CREATE TABLE IF NOT EXISTS provider_channel_access (
      provider_channel_access_id TEXT PRIMARY KEY NOT NULL DEFAULT ${uuidDefault},
      provider TEXT NOT NULL DEFAULT 'discord',
      provider_channel_id TEXT NOT NULL,
      connector_instance_id TEXT REFERENCES connector_instances(connector_instance_id) ON DELETE CASCADE,
      agent_id TEXT REFERENCES agents(agent_id) ON DELETE CASCADE,
      capabilities TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stale', 'disabled', 'revoked')),
      trust_status TEXT NOT NULL DEFAULT 'local' CHECK (trust_status IN ('local', 'unverified', 'verified', 'revoked', 'disabled')),
      source TEXT NOT NULL DEFAULT 'provider_discovery',
      discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      disabled_at TEXT
    )
  `)
  gatedExec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_channel_access_connector_channel_live ON provider_channel_access(provider, provider_channel_id, connector_instance_id) WHERE status = 'active' AND connector_instance_id IS NOT NULL`)
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_provider_channel_access_agent ON provider_channel_access(agent_id, provider, status) WHERE agent_id IS NOT NULL`)
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_provider_channel_access_channel ON provider_channel_access(provider, provider_channel_id, status)`)

  gatedExec(`
    CREATE TABLE IF NOT EXISTS agent_ui_bindings (
      binding_id TEXT PRIMARY KEY NOT NULL DEFAULT ${uuidDefault},
      agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
      ui_type TEXT NOT NULL DEFAULT 'discord',
      ui_id TEXT NOT NULL,
      ui_handle TEXT,
      ui_token_ref TEXT,
      ui_token_fingerprint TEXT,
      connector_instance_id TEXT REFERENCES connector_instances(connector_instance_id) ON DELETE SET NULL,
      credential_id TEXT REFERENCES connector_credentials(credential_id) ON DELETE SET NULL,
      provider_identity_id TEXT REFERENCES agent_provider_identities(provider_identity_id) ON DELETE SET NULL,
      surface_role TEXT NOT NULL DEFAULT 'primary',
      status TEXT NOT NULL DEFAULT 'registered' CHECK (status IN ('registered', 'active', 'disabled', 'revoked')),
      trust_status TEXT NOT NULL DEFAULT 'unverified' CHECK (trust_status IN ('local', 'unverified', 'verified', 'revoked', 'disabled')),
      last_verified_at TEXT,
      evidence_revision INTEGER NOT NULL DEFAULT 1,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      disabled_at TEXT
    )
  `)
  gatedExec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_ui_bindings_ui_live ON agent_ui_bindings(ui_type, ui_id) WHERE status IN ('registered', 'active')`)
  gatedExec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_ui_bindings_agent_role_live ON agent_ui_bindings(agent_id, ui_type, surface_role) WHERE status IN ('registered', 'active')`)
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_agent_ui_bindings_connector ON agent_ui_bindings(connector_instance_id) WHERE connector_instance_id IS NOT NULL`)
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_agent_ui_bindings_credential ON agent_ui_bindings(credential_id) WHERE credential_id IS NOT NULL`)

  gatedExec(`
    CREATE TABLE IF NOT EXISTS control_plane_leases (
      lease_id TEXT PRIMARY KEY NOT NULL DEFAULT ${uuidDefault},
      lease_scope_type TEXT NOT NULL CHECK (lease_scope_type IN ('connector_instance', 'channel_binding', 'queue_partition', 'runtime_instance')),
      lease_scope_id TEXT NOT NULL,
      lease_purpose TEXT NOT NULL DEFAULT 'worker' CHECK (lease_purpose IN ('inbound', 'outbound', 'worker', 'leader', 'presence', 'maintenance')),
      holder_agent_id TEXT REFERENCES agents(agent_id) ON DELETE SET NULL,
      holder_runtime_instance_id TEXT REFERENCES agent_runtime_instances(runtime_instance_id) ON DELETE SET NULL,
      holder_connector_instance_id TEXT REFERENCES connector_instances(connector_instance_id) ON DELETE SET NULL,
      fencing_token INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released', 'expired', 'revoked')),
      acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
      heartbeat_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      released_at TEXT,
      metadata TEXT NOT NULL DEFAULT '{}'
    )
  `)
  gatedExec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_control_plane_leases_active_scope ON control_plane_leases(lease_scope_type, lease_scope_id, lease_purpose) WHERE status = 'active'`)
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_control_plane_leases_expiry ON control_plane_leases(status, expires_at)`)
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_control_plane_leases_holder_runtime ON control_plane_leases(holder_runtime_instance_id) WHERE holder_runtime_instance_id IS NOT NULL`)

  // AUN control-plane conversation/baton compatibility layer. Schema-only:
  // existing rows remain nullable until the resolver/wiring slice stamps ids.
  gatedExec(`
    CREATE TABLE IF NOT EXISTS conversations (
      conversation_id TEXT PRIMARY KEY NOT NULL DEFAULT ${uuidDefault},
      conversation_key_hash TEXT NOT NULL UNIQUE,
      conversation_key TEXT NOT NULL DEFAULT '{}',
      surface TEXT NOT NULL,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE RESTRICT,
      thread_scope_id TEXT NOT NULL,
      root_message_id TEXT REFERENCES agent_messages(id) ON DELETE RESTRICT,
      root_request_id TEXT,
      parent_conversation_id TEXT REFERENCES conversations(conversation_id) ON DELETE SET NULL,
      conversation_kind TEXT NOT NULL DEFAULT 'request' CHECK (conversation_kind IN ('request', 'audit', 'handoff', 'fanout_child', 'system')),
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'quarantined')),
      terminal_outcome TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      closed_at TEXT,
      CHECK ((root_message_id IS NOT NULL AND root_request_id IS NULL) OR (root_message_id IS NULL AND root_request_id IS NOT NULL))
    )
  `)
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_conversations_channel_status ON conversations(channel_id, status, created_at DESC)`)
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_conversations_parent ON conversations(parent_conversation_id) WHERE parent_conversation_id IS NOT NULL`)
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_conversations_root_message ON conversations(root_message_id) WHERE root_message_id IS NOT NULL`)

  gatedExec(`
    CREATE TABLE IF NOT EXISTS conversation_batons (
      baton_id TEXT PRIMARY KEY NOT NULL DEFAULT ${uuidDefault},
      conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
      owner_agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE RESTRICT,
      state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('pending', 'active', 'escalated', 'transferred', 'closed', 'failed', 'quarantined')),
      source_queue_id INTEGER REFERENCES message_queue(id) ON DELETE SET NULL,
      lease_id TEXT REFERENCES control_plane_leases(lease_id) ON DELETE SET NULL,
      claim_id TEXT,
      started_at TEXT,
      expires_at TEXT,
      heartbeat_at TEXT,
      completed_at TEXT,
      completion_outcome TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  gatedExec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_conversation_batons_one_open ON conversation_batons(conversation_id) WHERE state IN ('pending', 'active', 'escalated')`)
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_conversation_batons_owner_state ON conversation_batons(owner_agent_id, state, created_at DESC)`)
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_conversation_batons_source_queue ON conversation_batons(source_queue_id) WHERE source_queue_id IS NOT NULL`)

  gatedExec(`
    CREATE TABLE IF NOT EXISTS conversation_observers (
      conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
      visibility_kind TEXT NOT NULL DEFAULT 'observer' CHECK (visibility_kind IN ('cc', 'fyi', 'observer')),
      source_message_id TEXT REFERENCES agent_messages(id) ON DELETE SET NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (conversation_id, agent_id, visibility_kind)
    )
  `)
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_conversation_observers_agent ON conversation_observers(agent_id, created_at DESC)`)

  const conversationAgentMessageCols = db.query(`PRAGMA table_info(agent_messages)`).all() as Array<{ name: string }>
  const conversationAgentMessageColNames = new Set(conversationAgentMessageCols.map((c) => c.name))
  if (!conversationAgentMessageColNames.has('conversation_id')) {
    gatedExec(`ALTER TABLE agent_messages ADD COLUMN conversation_id TEXT REFERENCES conversations(conversation_id) ON DELETE SET NULL`)
  }
  if (!conversationAgentMessageColNames.has('baton_id')) {
    gatedExec(`ALTER TABLE agent_messages ADD COLUMN baton_id TEXT REFERENCES conversation_batons(baton_id) ON DELETE SET NULL`)
  }

  const conversationMessageQueueCols = db.query(`PRAGMA table_info(message_queue)`).all() as Array<{ name: string }>
  const conversationMessageQueueColNames = new Set(conversationMessageQueueCols.map((c) => c.name))
  if (!conversationMessageQueueColNames.has('conversation_id')) {
    gatedExec(`ALTER TABLE message_queue ADD COLUMN conversation_id TEXT REFERENCES conversations(conversation_id) ON DELETE SET NULL`)
  }
  if (!conversationMessageQueueColNames.has('baton_id')) {
    gatedExec(`ALTER TABLE message_queue ADD COLUMN baton_id TEXT REFERENCES conversation_batons(baton_id) ON DELETE SET NULL`)
  }
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_agent_messages_conversation ON agent_messages(conversation_id, created_at) WHERE conversation_id IS NOT NULL`)
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_message_queue_conversation ON message_queue(conversation_id, status, created_at) WHERE conversation_id IS NOT NULL`)
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_message_queue_baton ON message_queue(baton_id, status, created_at) WHERE baton_id IS NOT NULL`)

  gatedExec(`
    CREATE TABLE IF NOT EXISTS worker_activity (
      activity_id TEXT PRIMARY KEY NOT NULL DEFAULT ${uuidDefault},
      agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
      runtime_instance_id TEXT REFERENCES agent_runtime_instances(runtime_instance_id) ON DELETE SET NULL,
      lease_id TEXT REFERENCES control_plane_leases(lease_id) ON DELETE SET NULL,
      queue_id INTEGER REFERENCES message_queue(id) ON DELETE SET NULL,
      activity_type TEXT NOT NULL DEFAULT 'worker',
      status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('planned', 'running', 'blocked', 'stalled', 'failed', 'completed', 'handoff')),
      summary TEXT NOT NULL,
      repository TEXT,
      branch TEXT,
      pull_request TEXT,
      artifact_uri TEXT,
      blocked_reason TEXT,
      handoff_target_agent_id TEXT REFERENCES agents(agent_id) ON DELETE SET NULL,
      progress_percent INTEGER CHECK (progress_percent IS NULL OR (progress_percent >= 0 AND progress_percent <= 100)),
      progress_label TEXT,
      stale_after_sec INTEGER NOT NULL DEFAULT 120 CHECK (stale_after_sec > 0),
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      heartbeat_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      metadata TEXT NOT NULL DEFAULT '{}'
    )
  `)
  const workerActivityCols = db.query(`PRAGMA table_info(worker_activity)`).all() as Array<{ name: string }>
  const workerActivityColNames = new Set(workerActivityCols.map((c) => c.name))
  if (!workerActivityColNames.has('progress_percent')) {
    gatedExec(`ALTER TABLE worker_activity ADD COLUMN progress_percent INTEGER CHECK (progress_percent IS NULL OR (progress_percent >= 0 AND progress_percent <= 100))`)
  }
  if (!workerActivityColNames.has('progress_label')) {
    gatedExec(`ALTER TABLE worker_activity ADD COLUMN progress_label TEXT`)
  }
  if (!workerActivityColNames.has('stale_after_sec')) {
    gatedExec(`ALTER TABLE worker_activity ADD COLUMN stale_after_sec INTEGER NOT NULL DEFAULT 120 CHECK (stale_after_sec > 0)`)
  }
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_worker_activity_open ON worker_activity(agent_id, status, updated_at DESC) WHERE status IN ('planned', 'running', 'blocked', 'stalled')`)
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_worker_activity_queue ON worker_activity(queue_id) WHERE queue_id IS NOT NULL`)
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_worker_activity_runtime ON worker_activity(runtime_instance_id, status, updated_at DESC) WHERE runtime_instance_id IS NOT NULL`)
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_worker_activity_repo ON worker_activity(repository, branch, updated_at DESC) WHERE repository IS NOT NULL`)
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_worker_activity_handoff ON worker_activity(handoff_target_agent_id, status, updated_at DESC) WHERE handoff_target_agent_id IS NOT NULL`)

  gatedExec(`
    CREATE TABLE IF NOT EXISTS channel_routing_policy (
      channel_id TEXT PRIMARY KEY NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
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
      role_key TEXT PRIMARY KEY NOT NULL,
      channel_id TEXT REFERENCES channels(id),
      agent_id TEXT REFERENCES agents(agent_id),
      description TEXT,
      new_work_allowed INTEGER NOT NULL DEFAULT 1,
      active_function TEXT,
      canonical_seat TEXT,
      historical_only INTEGER NOT NULL DEFAULT 0,
      policy_source TEXT NOT NULL DEFAULT 'db',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  const roleCols = db.query(`PRAGMA table_info(role_routing)`).all() as Array<{ name: string }>
  const roleColNames = new Set(roleCols.map((c) => c.name))
  if (!roleColNames.has('active_function')) {
    gatedExec(`ALTER TABLE role_routing ADD COLUMN active_function TEXT`)
  }
  if (!roleColNames.has('canonical_seat')) {
    gatedExec(`ALTER TABLE role_routing ADD COLUMN canonical_seat TEXT`)
  }
  if (!roleColNames.has('historical_only')) {
    gatedExec(`ALTER TABLE role_routing ADD COLUMN historical_only INTEGER NOT NULL DEFAULT 0`)
  }
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_role_routing_agent ON role_routing(agent_id) WHERE agent_id IS NOT NULL`)

  gatedExec(`
    CREATE TABLE IF NOT EXISTS agent_aliases (
      alias TEXT PRIMARY KEY NOT NULL,
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
      hash TEXT PRIMARY KEY NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  gatedExec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY NOT NULL DEFAULT ${uuidDefault},
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

  const mqControlCols = db.query(`PRAGMA table_info(message_queue)`).all() as Array<{ name: string }>
  const mqControlColNames = new Set(mqControlCols.map((c) => c.name))
  if (!mqControlColNames.has('assigned_runtime_instance_id')) {
    gatedExec(`ALTER TABLE message_queue ADD COLUMN assigned_runtime_instance_id TEXT REFERENCES agent_runtime_instances(runtime_instance_id) ON DELETE SET NULL`)
  }
  if (!mqControlColNames.has('claimed_runtime_instance_id')) {
    gatedExec(`ALTER TABLE message_queue ADD COLUMN claimed_runtime_instance_id TEXT REFERENCES agent_runtime_instances(runtime_instance_id) ON DELETE SET NULL`)
  }
  if (!mqControlColNames.has('channel_binding_id')) {
    gatedExec(`ALTER TABLE message_queue ADD COLUMN channel_binding_id TEXT REFERENCES channel_connector_bindings(channel_binding_id) ON DELETE SET NULL`)
  }
  if (!mqControlColNames.has('ordering_key')) {
    gatedExec(`ALTER TABLE message_queue ADD COLUMN ordering_key TEXT`)
  }
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_mq_assigned_runtime ON message_queue(assigned_runtime_instance_id, status, priority DESC, created_at ASC) WHERE assigned_runtime_instance_id IS NOT NULL AND status = 'pending'`)
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_mq_channel_binding_ordering ON message_queue(channel_binding_id, ordering_key, status, created_at ASC) WHERE channel_binding_id IS NOT NULL`)

  const oqControlCols = db.query(`PRAGMA table_info(outbound_queue)`).all() as Array<{ name: string }>
  const oqControlColNames = new Set(oqControlCols.map((c) => c.name))
  if (!oqControlColNames.has('delivery_connector_instance_id')) {
    gatedExec(`ALTER TABLE outbound_queue ADD COLUMN delivery_connector_instance_id TEXT REFERENCES connector_instances(connector_instance_id) ON DELETE SET NULL`)
  }
  if (!oqControlColNames.has('channel_binding_id')) {
    gatedExec(`ALTER TABLE outbound_queue ADD COLUMN channel_binding_id TEXT REFERENCES channel_connector_bindings(channel_binding_id) ON DELETE SET NULL`)
  }
  if (!oqControlColNames.has('provider_channel_access_id')) {
    gatedExec(`ALTER TABLE outbound_queue ADD COLUMN provider_channel_access_id TEXT REFERENCES provider_channel_access(provider_channel_access_id) ON DELETE SET NULL`)
  }
  if (!oqControlColNames.has('consumer_source')) {
    gatedExec(`ALTER TABLE outbound_queue ADD COLUMN consumer_source TEXT`)
  }
  if (!oqControlColNames.has('delivery_fallback_reason')) {
    gatedExec(`ALTER TABLE outbound_queue ADD COLUMN delivery_fallback_reason TEXT`)
  }
  if (!oqControlColNames.has('delivery_diagnostics')) {
    gatedExec(`ALTER TABLE outbound_queue ADD COLUMN delivery_diagnostics TEXT DEFAULT '[]'`)
  }
  if (!oqControlColNames.has('claimed_runtime_instance_id')) {
    gatedExec(`ALTER TABLE outbound_queue ADD COLUMN claimed_runtime_instance_id TEXT REFERENCES agent_runtime_instances(runtime_instance_id) ON DELETE SET NULL`)
  }
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_outbound_queue_delivery_connector_pending ON outbound_queue(delivery_connector_instance_id, status, next_retry_at) WHERE delivery_connector_instance_id IS NOT NULL AND status = 'pending'`)
  gatedExec(`CREATE INDEX IF NOT EXISTS idx_outbound_queue_channel_binding_pending ON outbound_queue(channel_binding_id, status, next_retry_at) WHERE channel_binding_id IS NOT NULL AND status = 'pending'`)

  gatedExec(`DROP TRIGGER IF EXISTS trg_connector_instances_routable_insert`)
  gatedExec(`DROP TRIGGER IF EXISTS trg_connector_instances_routable_update`)
  gatedExec(`
    CREATE TRIGGER IF NOT EXISTS trg_connector_instances_routable_insert
    BEFORE INSERT ON connector_instances
    WHEN NEW.status IN ('registered', 'active', 'standby', 'draining')
      OR EXISTS (
        SELECT 1
          FROM channel_connector_bindings b
         WHERE b.connector_instance_id = NEW.connector_instance_id
           AND b.status IN ('active', 'standby')
      )
      OR EXISTS (
        SELECT 1
          FROM provider_channel_access pca
         WHERE pca.connector_instance_id = NEW.connector_instance_id
           AND pca.agent_id IS NULL
           AND pca.status = 'active'
      )
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM agents a
         WHERE a.agent_id = NEW.agent_id
           AND COALESCE(a.historical_only, 0) = 0
           AND COALESCE(a.new_work_allowed, 1) = 1
           AND COALESCE(a.profile_enabled, 1) = 1
           AND a.disabled_at IS NULL
           AND COALESCE(a.status, '') NOT IN ('disabled', 'retired')
      ) THEN RAISE(ABORT, 'DISABLED_OR_HISTORICAL_AGENT_ACTIVE_CONNECTOR') END;
    END
  `)
  gatedExec(`
    CREATE TRIGGER IF NOT EXISTS trg_connector_instances_routable_update
    BEFORE UPDATE OF agent_id, status ON connector_instances
    WHEN NEW.status IN ('registered', 'active', 'standby', 'draining')
      OR EXISTS (
        SELECT 1
          FROM channel_connector_bindings b
         WHERE b.connector_instance_id = NEW.connector_instance_id
           AND b.status IN ('active', 'standby')
      )
      OR EXISTS (
        SELECT 1
          FROM provider_channel_access pca
         WHERE pca.connector_instance_id = NEW.connector_instance_id
           AND pca.agent_id IS NULL
           AND pca.status = 'active'
      )
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM agents a
         WHERE a.agent_id = NEW.agent_id
           AND COALESCE(a.historical_only, 0) = 0
           AND COALESCE(a.new_work_allowed, 1) = 1
           AND COALESCE(a.profile_enabled, 1) = 1
           AND a.disabled_at IS NULL
           AND COALESCE(a.status, '') NOT IN ('disabled', 'retired')
      ) THEN RAISE(ABORT, 'DISABLED_OR_HISTORICAL_AGENT_ACTIVE_CONNECTOR') END;
    END
  `)
  gatedExec(`
    CREATE TRIGGER IF NOT EXISTS trg_channel_connector_bindings_routable_insert
    BEFORE INSERT ON channel_connector_bindings
    WHEN NEW.status IN ('active', 'standby') AND NEW.connector_instance_id IS NOT NULL
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1
          FROM connector_instances ci
          JOIN agents a ON a.agent_id = ci.agent_id
         WHERE ci.connector_instance_id = NEW.connector_instance_id
           AND COALESCE(a.historical_only, 0) = 0
           AND COALESCE(a.new_work_allowed, 1) = 1
           AND COALESCE(a.profile_enabled, 1) = 1
           AND a.disabled_at IS NULL
           AND COALESCE(a.status, '') NOT IN ('disabled', 'retired')
      ) THEN RAISE(ABORT, 'DISABLED_OR_HISTORICAL_AGENT_ACTIVE_BINDING') END;
    END
  `)
  gatedExec(`
    CREATE TRIGGER IF NOT EXISTS trg_channel_connector_bindings_routable_update
    BEFORE UPDATE OF connector_instance_id, status ON channel_connector_bindings
    WHEN NEW.status IN ('active', 'standby') AND NEW.connector_instance_id IS NOT NULL
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1
          FROM connector_instances ci
          JOIN agents a ON a.agent_id = ci.agent_id
         WHERE ci.connector_instance_id = NEW.connector_instance_id
           AND COALESCE(a.historical_only, 0) = 0
           AND COALESCE(a.new_work_allowed, 1) = 1
           AND COALESCE(a.profile_enabled, 1) = 1
           AND a.disabled_at IS NULL
           AND COALESCE(a.status, '') NOT IN ('disabled', 'retired')
      ) THEN RAISE(ABORT, 'DISABLED_OR_HISTORICAL_AGENT_ACTIVE_BINDING') END;
    END
  `)
  gatedExec(`
    CREATE TRIGGER IF NOT EXISTS trg_provider_channel_access_routable_insert
    BEFORE INSERT ON provider_channel_access
    WHEN NEW.status = 'active'
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1
          FROM agents a
          LEFT JOIN connector_instances ci ON ci.connector_instance_id = NEW.connector_instance_id
         WHERE a.agent_id = COALESCE(NEW.agent_id, ci.agent_id)
           AND COALESCE(a.historical_only, 0) = 0
           AND COALESCE(a.new_work_allowed, 1) = 1
           AND COALESCE(a.profile_enabled, 1) = 1
           AND a.disabled_at IS NULL
           AND COALESCE(a.status, '') NOT IN ('disabled', 'retired')
      ) THEN RAISE(ABORT, 'DISABLED_OR_HISTORICAL_AGENT_ACTIVE_ACCESS') END;
    END
  `)
  gatedExec(`
    CREATE TRIGGER IF NOT EXISTS trg_provider_channel_access_routable_update
    BEFORE UPDATE OF agent_id, connector_instance_id, status ON provider_channel_access
    WHEN NEW.status = 'active'
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1
          FROM agents a
          LEFT JOIN connector_instances ci ON ci.connector_instance_id = NEW.connector_instance_id
         WHERE a.agent_id = COALESCE(NEW.agent_id, ci.agent_id)
           AND COALESCE(a.historical_only, 0) = 0
           AND COALESCE(a.new_work_allowed, 1) = 1
           AND COALESCE(a.profile_enabled, 1) = 1
           AND a.disabled_at IS NULL
           AND COALESCE(a.status, '') NOT IN ('disabled', 'retired')
      ) THEN RAISE(ABORT, 'DISABLED_OR_HISTORICAL_AGENT_ACTIVE_ACCESS') END;
    END
  `)
  gatedExec(`
    CREATE TRIGGER IF NOT EXISTS trg_agent_ui_bindings_routable_insert
    BEFORE INSERT ON agent_ui_bindings
    WHEN NEW.status IN ('registered', 'active')
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM agents a
         WHERE a.agent_id = NEW.agent_id
           AND COALESCE(a.historical_only, 0) = 0
           AND COALESCE(a.new_work_allowed, 1) = 1
           AND COALESCE(a.profile_enabled, 1) = 1
           AND a.disabled_at IS NULL
           AND COALESCE(a.status, '') NOT IN ('disabled', 'retired')
      ) THEN RAISE(ABORT, 'DISABLED_OR_HISTORICAL_AGENT_ACTIVE_UI_BINDING') END;
    END
  `)
  gatedExec(`
    CREATE TRIGGER IF NOT EXISTS trg_agent_ui_bindings_routable_update
    BEFORE UPDATE OF agent_id, status ON agent_ui_bindings
    WHEN NEW.status IN ('registered', 'active')
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM agents a
         WHERE a.agent_id = NEW.agent_id
           AND COALESCE(a.historical_only, 0) = 0
           AND COALESCE(a.new_work_allowed, 1) = 1
           AND COALESCE(a.profile_enabled, 1) = 1
           AND a.disabled_at IS NULL
           AND COALESCE(a.status, '') NOT IN ('disabled', 'retired')
      ) THEN RAISE(ABORT, 'DISABLED_OR_HISTORICAL_AGENT_ACTIVE_UI_BINDING') END;
    END
  `)
  gatedExec(`
    CREATE TRIGGER IF NOT EXISTS trg_agent_workspace_bindings_routable_insert
    BEFORE INSERT ON agent_workspace_bindings
    WHEN NEW.active = 1
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM agents a
         WHERE a.agent_id = NEW.agent_id
           AND COALESCE(a.historical_only, 0) = 0
           AND COALESCE(a.new_work_allowed, 1) = 1
           AND COALESCE(a.profile_enabled, 1) = 1
           AND a.disabled_at IS NULL
           AND COALESCE(a.status, '') NOT IN ('disabled', 'retired')
      ) THEN RAISE(ABORT, 'DISABLED_OR_HISTORICAL_AGENT_ACTIVE_WORKSPACE_BINDING') END;
    END
  `)
  gatedExec(`
    CREATE TRIGGER IF NOT EXISTS trg_agent_workspace_bindings_routable_update
    BEFORE UPDATE OF agent_id, active ON agent_workspace_bindings
    WHEN NEW.active = 1
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM agents a
         WHERE a.agent_id = NEW.agent_id
           AND COALESCE(a.historical_only, 0) = 0
           AND COALESCE(a.new_work_allowed, 1) = 1
           AND COALESCE(a.profile_enabled, 1) = 1
           AND a.disabled_at IS NULL
           AND COALESCE(a.status, '') NOT IN ('disabled', 'retired')
      ) THEN RAISE(ABORT, 'DISABLED_OR_HISTORICAL_AGENT_ACTIVE_WORKSPACE_BINDING') END;
    END
  `)
  gatedExec(`
    CREATE TRIGGER IF NOT EXISTS trg_agents_no_disable_with_active_dependencies
    BEFORE UPDATE OF status, disabled_at, profile_enabled, historical_only, new_work_allowed ON agents
    WHEN (
      NEW.status IN ('disabled', 'retired') OR
      NEW.disabled_at IS NOT NULL OR
      COALESCE(NEW.profile_enabled, 1) = 0 OR
      COALESCE(NEW.historical_only, 0) = 1 OR
      COALESCE(NEW.new_work_allowed, 1) = 0
    )
    BEGIN
      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM connector_instances ci
         WHERE ci.agent_id = NEW.agent_id
           AND ci.status IN ('registered', 'active', 'standby', 'draining')
        UNION ALL
        SELECT 1 FROM channel_connector_bindings b
          JOIN connector_instances ci
            ON ci.connector_instance_id = b.connector_instance_id
         WHERE ci.agent_id = NEW.agent_id
           AND b.status IN ('active', 'standby')
        UNION ALL
        SELECT 1 FROM agent_ui_bindings ub
         WHERE ub.agent_id = NEW.agent_id
           AND ub.status IN ('registered', 'active')
        UNION ALL
        SELECT 1 FROM provider_channel_access pca
         WHERE pca.agent_id = NEW.agent_id
           AND pca.status = 'active'
        UNION ALL
        SELECT 1 FROM provider_channel_access pca
          JOIN connector_instances ci
            ON ci.connector_instance_id = pca.connector_instance_id
         WHERE pca.agent_id IS NULL
           AND ci.agent_id = NEW.agent_id
           AND pca.status = 'active'
        UNION ALL
        SELECT 1 FROM agent_workspace_bindings awb
         WHERE awb.agent_id = NEW.agent_id
           AND awb.active = 1
        UNION ALL
        SELECT 1 FROM agent_runtime_instances ari
         WHERE ari.agent_id = NEW.agent_id
           AND ari.status IN ('running', 'active')
      ) THEN RAISE(ABORT, 'DISABLED_OR_HISTORICAL_AGENT_HAS_ACTIVE_DEPENDENCIES') END;
    END
  `)

  db.close()
  console.log(`SQLite migration complete: ${path}`)
}

if (import.meta.main) {
  migrateSqlite()
}
