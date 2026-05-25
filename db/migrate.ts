#!/usr/bin/env bun
/**
 * Database migration for agent-comms-mcp.
 * Safe to run multiple times (IF NOT EXISTS).
 *
 * Usage: bun run migrate
 * Or:    DATABASE_URL=postgresql://... bun db/migrate.ts
 */
import { Client } from 'pg'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { migrateSqlite } from './migrate-sqlite'
import {
  assertDestructiveMigrationAllowed,
  assertNoProductionDestructiveMigration,
  destructiveGateLogLine,
} from './destructive-migration-gate'

// incident #339: every SQL string handed to pg passes through the gate.
async function gatedQuery(client: Client, sql: string, params?: unknown[], targetUrl = databaseUrl) {
  assertDestructiveMigrationAllowed(sql)
  assertNoProductionDestructiveMigration(sql, targetUrl)
  return params === undefined ? client.query(sql) : client.query(sql, params)
}

const dbType = process.env.AGENT_COM_DB || (process.env.DATABASE_URL ? 'postgres' : 'sqlite')

// Load database_url from env first. config.json is a fallback only; tests and
// operators must be able to override the local config with DATABASE_URL.
let databaseUrl = process.env.DATABASE_URL
const configPath = join(dirname(new URL(import.meta.url).pathname), '..', 'config.json')
if (existsSync(configPath)) {
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    databaseUrl = databaseUrl ?? config.database_url
  } catch {}
}
databaseUrl = databaseUrl ?? 'postgresql://localhost/agent_comms'

async function migrate() {
  console.log(destructiveGateLogLine())
  const client = new Client({ connectionString: databaseUrl })
  await client.connect()

  await gatedQuery(client, `
    CREATE TABLE IF NOT EXISTS agent_messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      channel_id TEXT,
      author_id TEXT NOT NULL,
      author_bot BOOLEAN DEFAULT true,
      content TEXT NOT NULL,
      message_type TEXT NOT NULL DEFAULT 'chat',
      reply_to UUID REFERENCES agent_messages(id),
      attachments JSONB,
      metadata JSONB,
      depth INTEGER DEFAULT 0,
      -- ADR-026: unified schema columns
      source TEXT NOT NULL DEFAULT 'agent-comms',
      thread_id TEXT,
      direction TEXT NOT NULL DEFAULT 'inbound',
      role TEXT NOT NULL DEFAULT 'agent',
      session_id TEXT,
      project TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_agent_messages_channel ON agent_messages(channel_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_agent_messages_author ON agent_messages(author_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_agent_messages_type ON agent_messages(message_type, created_at);
    CREATE INDEX IF NOT EXISTS idx_agent_messages_source ON agent_messages(source, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_messages_session ON agent_messages(session_id, created_at DESC) WHERE session_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_agent_messages_project ON agent_messages(project) WHERE project IS NOT NULL;

    -- ADR-026: add new columns to existing tables (safe with IF NOT EXISTS pattern)
    DO $$ BEGIN
      ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'agent-comms';
      ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS thread_id TEXT;
      ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'inbound';
      ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'agent';
      ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS session_id TEXT;
      ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS project TEXT;
      -- Issue #266: raw args.mentions trace for outbound send/notify so that
      -- recurrences (e.g. PR #263 mention-prepend bug) can be diagnosed by
      -- comparing raw input vs final content without relying on stderr logs.
      ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS input_mentions TEXT[];
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$;

    CREATE TABLE IF NOT EXISTS channel_settings (
      channel_id TEXT PRIMARY KEY,
      retention_days INTEGER,
      description TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );

    -- Phase 2: Rate limits (§5.1)
    CREATE TABLE IF NOT EXISTS rate_limits (
      agent_id TEXT NOT NULL,
      window_start TIMESTAMPTZ NOT NULL,
      message_count INTEGER DEFAULT 1,
      PRIMARY KEY (agent_id, window_start)
    );

    -- Phase 2: Loop counters (§5.2)
    CREATE TABLE IF NOT EXISTS loop_counters (
      agent_pair TEXT NOT NULL,
      window_start TIMESTAMPTZ NOT NULL,
      exchange_count INTEGER DEFAULT 1,
      PRIMARY KEY (agent_pair, window_start)
    );

    -- Phase 2: Duplicate hashes (§5.3)
    CREATE TABLE IF NOT EXISTS duplicate_hashes (
      hash TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_duplicate_hashes_created ON duplicate_hashes(created_at);

    -- Phase 2: Agents (§12)
    CREATE TABLE IF NOT EXISTS agents (
      agent_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      runtime TEXT NOT NULL,
      status TEXT DEFAULT 'offline',
      last_seen_at TIMESTAMPTZ,
      registered_at TIMESTAMPTZ DEFAULT now(),
      metadata JSONB,
      -- Issue #287 (PR-0 cycle 12) — DB-persisted inbox cursor mirrors
      -- the SQLite parity added in cycle 5 (db/migrate-sqlite.ts).
      -- NULL on first boot = legitimate "row absent / cursor unset"
      -- signal per cycle 11 contract; first inbox/next call populates.
      inbox_cursor_at TIMESTAMPTZ,
      inbox_cursor_id UUID,
      -- State-daemon wake suppression SSOT. This is bot runtime state,
      -- not message row state; message_queue.last_wake_attempt_at remains
      -- row-level audit/diagnostic data only.
      last_wake_attempt_at TIMESTAMPTZ
    );

    CREATE SEQUENCE IF NOT EXISTS agent_ui_id_seq;

    -- v0.1.0: Add org_id, active_thread, observer_mode, channel_port to agents
    DO $$ BEGIN
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'default';
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS active_thread TEXT;
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS observer_mode BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS channel_port INTEGER;
      -- v0.2.0: channel-thread-control-spec (active_thread→last_received_context)
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_received_channel TEXT;
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_received_thread TEXT;
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS default_channel TEXT;
      -- Issue #287 (PR-0 cycle 12) — idempotent ALTER for pre-#287 PG
      -- environments. Mirrors the paired-migration up.sql columns;
      -- this canonical add ensures bun db/migrate.ts (CI / fresh PG /
      -- rebuilt env) leaves the schema parity-correct without manual
      -- paired migration.
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS inbox_cursor_at TIMESTAMPTZ;
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS inbox_cursor_id UUID;
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_wake_attempt_at TIMESTAMPTZ;
      -- Agent identity/runtime foundation. These columns make the stable
      -- identity explicit while keeping local-only deployments fully
      -- compatible. External/federated agents will use the same columns later.
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS agent_uri TEXT;
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS identity_scope TEXT NOT NULL DEFAULT 'local';
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS trust_status TEXT NOT NULL DEFAULT 'local';
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS auth_method TEXT NOT NULL DEFAULT 'local';
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS auth_subject TEXT;
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS identity_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
      -- NORM-021 bot profile SSOT. These are the normal operator-editable
      -- local profile fields. Workspace/runtime/connector rows are generated
      -- evidence and must not duplicate these as manual setup.
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS ui_id BIGINT;
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS ui_handle TEXT;
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS home_directory TEXT;
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS runtime_engine_preference TEXT;
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS provider_token_source_ref TEXT;
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS expected_provider_identity JSONB NOT NULL DEFAULT '{}'::jsonb;
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS profile_enabled BOOLEAN NOT NULL DEFAULT true;
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS profile_revision INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS profile_source TEXT NOT NULL DEFAULT 'legacy';
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS profile_updated_at TIMESTAMPTZ;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$;
    UPDATE agents
       SET agent_uri = 'aun://' || COALESCE(org_id, 'default') || '/agents/' || agent_id
     WHERE agent_uri IS NULL OR agent_uri = '';
    UPDATE agents
       SET ui_id = nextval('agent_ui_id_seq')
     WHERE ui_id IS NULL
       AND agent_type <> 'human'
       AND COALESCE(profile_enabled, true) = true;
    SELECT setval(
      'agent_ui_id_seq',
      GREATEST((SELECT COALESCE(MAX(ui_id), 0) FROM agents), 1),
      (SELECT COALESCE(MAX(ui_id), 0) FROM agents) > 0
    );
    UPDATE agents
       SET ui_handle = COALESCE(NULLIF(metadata->>'replaces', ''), agent_id)
     WHERE (ui_handle IS NULL OR ui_handle = '')
       AND agent_type <> 'human'
       AND COALESCE(profile_enabled, true) = true;
    CREATE OR REPLACE FUNCTION set_agent_identity_defaults()
    RETURNS trigger AS $$
    BEGIN
      IF NEW.agent_uri IS NULL OR NEW.agent_uri = '' THEN
        NEW.agent_uri := 'aun://' || COALESCE(NEW.org_id, 'default') || '/agents/' || NEW.agent_id;
      END IF;
      IF NEW.identity_scope IS NULL OR NEW.identity_scope = '' THEN
        NEW.identity_scope := 'local';
      END IF;
      IF NEW.trust_status IS NULL OR NEW.trust_status = '' THEN
        NEW.trust_status := 'local';
      END IF;
      IF NEW.auth_method IS NULL OR NEW.auth_method = '' THEN
        NEW.auth_method := 'local';
      END IF;
      IF NEW.identity_metadata IS NULL THEN
        NEW.identity_metadata := '{}'::jsonb;
      END IF;
      IF NEW.expected_provider_identity IS NULL THEN
        NEW.expected_provider_identity := '{}'::jsonb;
      END IF;
      IF NEW.profile_enabled IS NULL THEN
        NEW.profile_enabled := true;
      END IF;
      IF NEW.profile_revision IS NULL OR NEW.profile_revision < 1 THEN
        NEW.profile_revision := 1;
      END IF;
      IF NEW.profile_source IS NULL OR NEW.profile_source = '' THEN
        NEW.profile_source := 'legacy';
      END IF;
      IF NEW.agent_type <> 'human' AND COALESCE(NEW.profile_enabled, true) = true THEN
        IF NEW.ui_id IS NULL THEN
          NEW.ui_id := nextval('agent_ui_id_seq');
        END IF;
        IF NEW.ui_handle IS NULL OR NEW.ui_handle = '' THEN
          NEW.ui_handle := COALESCE(NULLIF(NEW.metadata->>'replaces', ''), NEW.agent_id);
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS trg_agents_identity_defaults ON agents;
    CREATE TRIGGER trg_agents_identity_defaults
      BEFORE INSERT OR UPDATE ON agents
      FOR EACH ROW
      EXECUTE FUNCTION set_agent_identity_defaults();
    DO $$ BEGIN
      ALTER TABLE agents ADD CONSTRAINT agents_identity_scope_check
        CHECK (identity_scope IN ('local', 'external', 'federated'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
    DO $$ BEGIN
      ALTER TABLE agents ADD CONSTRAINT agents_trust_status_check
        CHECK (trust_status IN ('local', 'unverified', 'verified', 'revoked', 'disabled'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
    DO $$ BEGIN
      ALTER TABLE agents ADD CONSTRAINT agents_auth_method_check
        CHECK (auth_method IN ('local', 'signed_key', 'mcp_token', 'oauth', 'none'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_agent_uri
      ON agents(agent_uri)
      WHERE agent_uri IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_agents_identity_scope ON agents(identity_scope);
    CREATE INDEX IF NOT EXISTS idx_agents_trust_status ON agents(trust_status);
    CREATE INDEX IF NOT EXISTS idx_agents_home_directory
      ON agents(org_id, home_directory)
      WHERE home_directory IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_agents_profile_enabled ON agents(profile_enabled);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_agents_ui_id_active
      ON agents(ui_id)
      WHERE ui_id IS NOT NULL
        AND agent_type <> 'human'
        AND COALESCE(profile_enabled, true) = true;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_agents_ui_handle_active
      ON agents(lower(ui_handle))
      WHERE ui_handle IS NOT NULL
        AND ui_handle <> ''
        AND agent_type <> 'human'
        AND COALESCE(profile_enabled, true) = true;

    CREATE TABLE IF NOT EXISTS agent_workspaces (
      workspace_id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL DEFAULT 'default',
      name TEXT NOT NULL,
      workspace_type TEXT NOT NULL DEFAULT 'local_path',
      local_path TEXT,
      repo_url TEXT,
      default_branch TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_agent_workspaces_org ON agent_workspaces(org_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_workspaces_local_path
      ON agent_workspaces(org_id, local_path)
      WHERE local_path IS NOT NULL;

    CREATE TABLE IF NOT EXISTS agent_workspace_bindings (
      agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL REFERENCES agent_workspaces(workspace_id) ON DELETE CASCADE,
      binding_role TEXT NOT NULL DEFAULT 'primary',
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (agent_id, workspace_id, binding_role)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_workspace_bindings_workspace
      ON agent_workspace_bindings(workspace_id)
      WHERE active = true;

    CREATE TABLE IF NOT EXISTS agent_runtime_instances (
      runtime_instance_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
      started_at TIMESTAMPTZ DEFAULT now(),
      stopped_at TIMESTAMPTZ,
      last_seen_at TIMESTAMPTZ,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE INDEX IF NOT EXISTS idx_agent_runtime_instances_agent_status
      ON agent_runtime_instances(agent_id, status, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_runtime_instances_workspace
      ON agent_runtime_instances(workspace_id)
      WHERE workspace_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS agent_endpoints (
      endpoint_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
      endpoint_uri TEXT NOT NULL,
      transport TEXT NOT NULL DEFAULT 'local',
      auth_method TEXT NOT NULL DEFAULT 'local',
      trust_status TEXT NOT NULL DEFAULT 'local',
      public_key_fingerprint TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now(),
      disabled_at TIMESTAMPTZ,
      UNIQUE(agent_id, endpoint_uri)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_endpoints_uri ON agent_endpoints(endpoint_uri);
    CREATE INDEX IF NOT EXISTS idx_agent_endpoints_status ON agent_endpoints(status);

    CREATE TABLE IF NOT EXISTS agent_identity_keys (
      key_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
      key_type TEXT NOT NULL DEFAULT 'ed25519',
      public_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active',
      valid_from TIMESTAMPTZ DEFAULT now(),
      valid_until TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_agent_identity_keys_agent_status
      ON agent_identity_keys(agent_id, status);

    -- v0.1.0: Channels (SSOT-4)
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL DEFAULT 'default',
      type TEXT NOT NULL DEFAULT 'channel',
      name TEXT,
      members TEXT[],
      created_by TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_channels_org ON channels(org_id);
    CREATE INDEX IF NOT EXISTS idx_channels_type ON channels(type);
    CREATE INDEX IF NOT EXISTS idx_channels_members ON channels USING GIN(members);

    -- v0.1.0: Channel Adapters (SSOT-4)
    CREATE TABLE IF NOT EXISTS channel_adapters (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      channel_id TEXT NOT NULL REFERENCES channels(id),
      platform TEXT NOT NULL,
      external_id TEXT NOT NULL,
      metadata JSONB,
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(channel_id, platform)
    );

    -- Distributed control plane foundation.
    -- These tables split logical identity (agents) from concrete connector
    -- processes and from the leases that let a worker pool claim work without
    -- a central router/post-office process.
    CREATE TABLE IF NOT EXISTS connector_instances (
      connector_instance_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
      runtime_instance_id UUID REFERENCES agent_runtime_instances(runtime_instance_id) ON DELETE SET NULL,
      provider TEXT NOT NULL DEFAULT 'discord',
      connector_kind TEXT NOT NULL DEFAULT 'chat_adapter',
      transport TEXT NOT NULL DEFAULT 'discord_gateway',
      connector_uri TEXT,
      status TEXT NOT NULL DEFAULT 'registered',
      trust_status TEXT NOT NULL DEFAULT 'local',
      capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now(),
      last_seen_at TIMESTAMPTZ,
      disabled_at TIMESTAMPTZ
    );
    DO $$ BEGIN
      ALTER TABLE connector_instances ADD CONSTRAINT connector_instances_status_check
        CHECK (status IN ('registered', 'active', 'standby', 'draining', 'stopped', 'disabled'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
    DO $$ BEGIN
      ALTER TABLE connector_instances ADD CONSTRAINT connector_instances_trust_status_check
        CHECK (trust_status IN ('local', 'unverified', 'verified', 'revoked', 'disabled'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
    CREATE INDEX IF NOT EXISTS idx_connector_instances_agent_status
      ON connector_instances(agent_id, status);
    CREATE INDEX IF NOT EXISTS idx_connector_instances_runtime
      ON connector_instances(runtime_instance_id)
      WHERE runtime_instance_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_connector_instances_provider_uri
      ON connector_instances(provider, connector_uri)
      WHERE connector_uri IS NOT NULL;

    CREATE TABLE IF NOT EXISTS channel_connector_bindings (
      channel_binding_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      provider TEXT NOT NULL DEFAULT 'discord',
      connector_instance_id UUID REFERENCES connector_instances(connector_instance_id) ON DELETE SET NULL,
      binding_role TEXT NOT NULL DEFAULT 'outbound',
      priority INTEGER NOT NULL DEFAULT 100,
      max_concurrency INTEGER NOT NULL DEFAULT 1,
      ordering_scope TEXT NOT NULL DEFAULT 'thread',
      status TEXT NOT NULL DEFAULT 'active',
      policy_source TEXT NOT NULL DEFAULT 'db',
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now(),
      disabled_at TIMESTAMPTZ
    );
    DO $$ BEGIN
      ALTER TABLE channel_connector_bindings ADD CONSTRAINT channel_connector_bindings_role_check
        CHECK (binding_role IN ('inbound', 'outbound', 'bidirectional', 'projection', 'presence', 'worker'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
    DO $$ BEGIN
      ALTER TABLE channel_connector_bindings ADD CONSTRAINT channel_connector_bindings_ordering_check
        CHECK (ordering_scope IN ('none', 'channel', 'thread', 'custom'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
    DO $$ BEGIN
      ALTER TABLE channel_connector_bindings ADD CONSTRAINT channel_connector_bindings_status_check
        CHECK (status IN ('active', 'standby', 'disabled'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
    CREATE INDEX IF NOT EXISTS idx_channel_connector_bindings_channel
      ON channel_connector_bindings(channel_id, provider, binding_role, status);
    CREATE INDEX IF NOT EXISTS idx_channel_connector_bindings_connector
      ON channel_connector_bindings(connector_instance_id)
      WHERE connector_instance_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_connector_bindings_active_unique
      ON channel_connector_bindings(channel_id, provider, binding_role, connector_instance_id)
      WHERE status = 'active' AND connector_instance_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS control_plane_leases (
      lease_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      lease_scope_type TEXT NOT NULL,
      lease_scope_id TEXT NOT NULL,
      lease_purpose TEXT NOT NULL DEFAULT 'worker',
      holder_agent_id TEXT REFERENCES agents(agent_id) ON DELETE SET NULL,
      holder_runtime_instance_id UUID REFERENCES agent_runtime_instances(runtime_instance_id) ON DELETE SET NULL,
      holder_connector_instance_id UUID REFERENCES connector_instances(connector_instance_id) ON DELETE SET NULL,
      fencing_token BIGINT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      acquired_at TIMESTAMPTZ DEFAULT now(),
      heartbeat_at TIMESTAMPTZ DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      released_at TIMESTAMPTZ,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    );
    DO $$ BEGIN
      ALTER TABLE control_plane_leases ADD CONSTRAINT control_plane_leases_scope_check
        CHECK (lease_scope_type IN ('connector_instance', 'channel_binding', 'queue_partition', 'runtime_instance'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
    DO $$ BEGIN
      ALTER TABLE control_plane_leases ADD CONSTRAINT control_plane_leases_purpose_check
        CHECK (lease_purpose IN ('inbound', 'outbound', 'worker', 'leader', 'presence', 'maintenance'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
    DO $$ BEGIN
      ALTER TABLE control_plane_leases ADD CONSTRAINT control_plane_leases_status_check
        CHECK (status IN ('active', 'released', 'expired', 'revoked'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_control_plane_leases_active_scope
      ON control_plane_leases(lease_scope_type, lease_scope_id, lease_purpose)
      WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS idx_control_plane_leases_expiry
      ON control_plane_leases(status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_control_plane_leases_holder_runtime
      ON control_plane_leases(holder_runtime_instance_id)
      WHERE holder_runtime_instance_id IS NOT NULL;

    -- Bot/channel runtime routing policy. JSON remains a bootstrap/fallback
    -- source, but runtime lookups prefer this DB table once rows exist.
    CREATE TABLE IF NOT EXISTS channel_routing_policy (
      channel_id TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
      primary_agent_id TEXT REFERENCES agents(agent_id),
      adapter_owner_agent_id TEXT REFERENCES agents(agent_id),
      outbound_allowlist JSONB,
      native_role_outbound_owners JSONB NOT NULL DEFAULT '{}'::jsonb,
      native_projection_identities JSONB NOT NULL DEFAULT '{}'::jsonb,
      policy_source TEXT NOT NULL DEFAULT 'db',
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_channel_routing_policy_primary
      ON channel_routing_policy(primary_agent_id)
      WHERE primary_agent_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_channel_routing_policy_adapter_owner
      ON channel_routing_policy(adapter_owner_agent_id)
      WHERE adapter_owner_agent_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS role_routing (
      role_key TEXT PRIMARY KEY,
      channel_id TEXT REFERENCES channels(id),
      agent_id TEXT REFERENCES agents(agent_id),
      description TEXT,
      new_work_allowed BOOLEAN NOT NULL DEFAULT true,
      policy_source TEXT NOT NULL DEFAULT 'db',
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_role_routing_agent
      ON role_routing(agent_id)
      WHERE agent_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS agent_aliases (
      alias TEXT PRIMARY KEY,
      canonical_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
      new_work_allowed BOOLEAN NOT NULL DEFAULT true,
      reason TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );

    -- v0.1.0: Threads (SSOT-4)
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES channels(id),
      title TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_by TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_threads_channel ON threads(channel_id, status);
    CREATE INDEX IF NOT EXISTS idx_threads_status ON threads(status);

    -- v0.1.0: Thread Adapters (SSOT-4)
    CREATE TABLE IF NOT EXISTS thread_adapters (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      thread_id TEXT NOT NULL REFERENCES threads(id),
      platform TEXT NOT NULL,
      external_id TEXT NOT NULL,
      metadata JSONB,
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(thread_id, platform)
    );

    -- v0.1.0: Audit Log (SSOT-4)
    CREATE TABLE IF NOT EXISTS audit_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event_type TEXT NOT NULL,
      agent_id TEXT,
      target TEXT,
      detail JSONB,
      org_id TEXT NOT NULL DEFAULT 'default',
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_audit_log_event ON audit_log(event_type, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_log_agent ON audit_log(agent_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_log_org ON audit_log(org_id, created_at DESC);

    -- v0.1.0: Add sequence and thread_id to agent_messages
    DO $$ BEGIN
      ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS thread_id TEXT;
      ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS sequence INTEGER;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$;
    CREATE INDEX IF NOT EXISTS idx_agent_messages_thread ON agent_messages(thread_id, sequence) WHERE thread_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_agent_messages_sequence ON agent_messages(channel_id, sequence DESC);

    -- v0.2.0 PR-B.2 §H2: discord_message_id column + partial unique index for mixed-mode dedup.
    --
    -- BACKFILL POLICY (divergence from spec §C1):
    --   spec §C1 recommends backfilling discord_message_id from metadata for inbound rows.
    --   In agent-comms-mcp the legacy per-bot architecture inserts ONE row PER BOT for each
    --   inbound Discord message (22-23 dups/discord_message_id observed in production data),
    --   so a backfill would block the partial unique index creation.
    --   PR-B.2 leaves legacy rows with discord_message_id = NULL; the partial unique index
    --   only enforces uniqueness for non-NULL values. New mixed-mode inserts populate the
    --   column going forward. The metadata copy stays intact for backwards-compat reads.
    --   spec §C1 backfill is intended for SQLite mode (full UNIQUE) and does not apply here.
    DO $$ BEGIN
      ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS discord_message_id TEXT;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$;
    CREATE INDEX IF NOT EXISTS idx_agent_messages_discord_id
      ON agent_messages(discord_message_id)
      WHERE discord_message_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_messages_discord_id
      ON agent_messages(discord_message_id)
      WHERE discord_message_id IS NOT NULL;

    -- Issue #128 Phase 2: message_queue (per-agent delivery queue, message-queue-spec 3.2)
    -- Receiver writes one row per pushTarget when a message is delivered. CLI/MCP next
    -- pops the oldest pending row, marks it read, and stamps agents.current_message_id.
    -- send updates the row to replied and clears agents.current_message_id.
    CREATE TABLE IF NOT EXISTS message_queue (
      id BIGSERIAL PRIMARY KEY,
      agent_id TEXT NOT NULL,
      message_id TEXT,                       -- agent_messages.id (NULL for system messages)
      payload TEXT NOT NULL,                 -- enriched JSON payload
      status TEXT NOT NULL DEFAULT 'pending'
        -- Issue #338 / CEO 2026-05-14 hotfix: 8-value union covers both
        -- the v0.8 legacy values ('read' / 'failed' / 'skipped') still
        -- written by un-restarted fleet bots AND the v0.9 vocab
        -- ('received' / 'in_progress' / 'done' / 'replied') from
        -- sub-PR 1 #347, sub-PR 7 #353, sub-PR 7a #355. Additive only —
        -- the destructive narrowing (removing 'read' / 'failed' /
        -- 'skipped') belongs to a future, gated migration once every
        -- bot has rolled to v0.9 vocab.
        CHECK (status IN ('pending', 'read', 'received', 'in_progress', 'done', 'replied', 'skipped', 'failed')),
      priority INTEGER NOT NULL DEFAULT 0,   -- higher = more urgent
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      read_at TIMESTAMPTZ,
      replied_at TIMESTAMPTZ,
      replied_with TEXT,                     -- reply message id
      failed_reason TEXT                     -- v2.1.0: fail CLI で設定 (IMPLICIT_ABANDON / LLM_FAILED / SEND_FAILED_AFTER_N_RETRIES / LOOP_DETECTED / OBSOLETE)
    );
    CREATE INDEX IF NOT EXISTS idx_mq_agent_pending
      ON message_queue(agent_id, status, priority DESC, created_at ASC)
      WHERE status = 'pending';

    -- Issue #278 (A) Per-row claim model. Replaces agents.current_message_id
    -- single-slot guard: a bot now claims individual message_queue rows with
    -- a TTL, allowing concurrent in-flight processing and structured TTL
    -- recovery (IMPLICIT_ABANDON sweeper). The columns are nullable so legacy
    -- pending rows continue to satisfy the existing CHECK / unique pair.
    DO $$ BEGIN
      ALTER TABLE message_queue ADD COLUMN IF NOT EXISTS claimed_by TEXT;
      ALTER TABLE message_queue ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
      ALTER TABLE message_queue ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ;
      ALTER TABLE message_queue ADD COLUMN IF NOT EXISTS assigned_runtime_instance_id UUID REFERENCES agent_runtime_instances(runtime_instance_id) ON DELETE SET NULL;
      ALTER TABLE message_queue ADD COLUMN IF NOT EXISTS claimed_runtime_instance_id UUID REFERENCES agent_runtime_instances(runtime_instance_id) ON DELETE SET NULL;
      ALTER TABLE message_queue ADD COLUMN IF NOT EXISTS channel_binding_id UUID REFERENCES channel_connector_bindings(channel_binding_id) ON DELETE SET NULL;
      ALTER TABLE message_queue ADD COLUMN IF NOT EXISTS ordering_key TEXT;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$;
    CREATE INDEX IF NOT EXISTS idx_mq_assigned_runtime
      ON message_queue(assigned_runtime_instance_id, status, priority DESC, created_at ASC)
      WHERE assigned_runtime_instance_id IS NOT NULL AND status = 'pending';
    CREATE INDEX IF NOT EXISTS idx_mq_channel_binding_ordering
      ON message_queue(channel_binding_id, ordering_key, status, created_at ASC)
      WHERE channel_binding_id IS NOT NULL;
    DROP INDEX IF EXISTS idx_mq_expired_claims;
    CREATE INDEX IF NOT EXISTS idx_mq_expired_claims
      ON message_queue(claim_expires_at)
      WHERE claimed_by IS NOT NULL AND claim_expires_at IS NOT NULL AND status = 'received';

    -- Issue #323 — state-daemon schema (CTO directive 56bd384a per CEO
    -- a4a3be6a). Mirrors db/migrations/2026-05-08-state-daemon-323.up.sql
    -- inline so the default migrate() entry point (which only walks this
    -- inline block, not paired *.up.sql files) installs the columns +
    -- trigger + indexes the StateDaemon class depends on. The paired
    -- files are retained as rollback artifacts (see db/migrations/),
    -- same pattern as the inbox-cursor and stage-b drops above.
    DO $$ BEGIN
      ALTER TABLE message_queue ADD COLUMN IF NOT EXISTS last_wake_attempt_at TIMESTAMPTZ;
      ALTER TABLE message_queue ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$;

    UPDATE agents a
       SET last_wake_attempt_at = q.bot_last_wake
      FROM (
        SELECT agent_id, MAX(last_wake_attempt_at) AS bot_last_wake
          FROM message_queue
         WHERE last_wake_attempt_at IS NOT NULL
         GROUP BY agent_id
      ) q
     WHERE a.agent_id = q.agent_id
       AND (a.last_wake_attempt_at IS NULL OR a.last_wake_attempt_at < q.bot_last_wake);

    CREATE OR REPLACE FUNCTION notify_queue_event() RETURNS trigger AS $func$
    BEGIN
      PERFORM pg_notify('queue_event', json_build_object(
        'op', TG_OP,
        'id', NEW.id,
        'agent_id', NEW.agent_id,
        'status', NEW.status,
        'claim_expires_at', NEW.claim_expires_at
      )::text);
      RETURN NEW;
    END;
    $func$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS message_queue_notify ON message_queue;
    CREATE TRIGGER message_queue_notify
      AFTER INSERT OR UPDATE OF status, claim_expires_at ON message_queue
      FOR EACH ROW EXECUTE FUNCTION notify_queue_event();

    CREATE INDEX IF NOT EXISTS idx_mq_pending_stale
      ON message_queue(status, created_at)
      WHERE status = 'pending';

    DROP INDEX IF EXISTS idx_mq_read_expired;
    CREATE INDEX IF NOT EXISTS idx_mq_read_expired
      ON message_queue(status, claim_expires_at)
      WHERE status = 'received';

    -- Issue #278 (A) Inbound idempotency was already in place as
    -- uq_mq_agent_message ((agent_id, message_id) WHERE message_id IS NOT NULL,
    -- created earlier). The Issue body uq_mq_inbound_idem proposal added
    -- a COALESCE(metadata->>source_path) column that does not
    -- exist on message_queue, so the existing partial unique index is the
    -- canonical guard for #272 2-path bloat — no redundant index needed.

    -- Codex audit (PR#140) refinement: dedup with quarantine.
    --   1. Move non-safe duplicates (non-identical payload / non-pending
    --      status) to message_queue_dedup_quarantine so the operator can
    --      inspect and reconcile manually.
    --   2. Safe-delete remaining identical-pending duplicates in-place.
    --   3. CREATE UNIQUE — fails loud if any unsafe duplicate slipped past
    --      the quarantine step (defense in depth).
    CREATE TABLE IF NOT EXISTS message_queue_dedup_quarantine (
      LIKE message_queue
    );
    ALTER TABLE message_queue_dedup_quarantine
      ADD COLUMN IF NOT EXISTS quarantined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      ADD COLUMN IF NOT EXISTS quarantine_reason TEXT;

    -- Move non-safe duplicates. Keep the lowest id in-place as canonical.
    WITH pairs AS (
      SELECT agent_id, message_id, MIN(id) AS keep_id
      FROM message_queue
      WHERE message_id IS NOT NULL
      GROUP BY agent_id, message_id
      HAVING count(*) > 1
    ),
    unsafe AS (
      SELECT mq.id
      FROM message_queue mq
      JOIN pairs p ON mq.agent_id = p.agent_id AND mq.message_id = p.message_id
      JOIN message_queue kept ON kept.id = p.keep_id
      WHERE mq.id <> p.keep_id
        AND (mq.status <> 'pending' OR kept.status <> 'pending' OR mq.payload <> kept.payload)
    )
    INSERT INTO message_queue_dedup_quarantine (
      id, agent_id, message_id, payload, status, priority, created_at, read_at, replied_at, replied_with,
      quarantine_reason
    )
    SELECT mq.id, mq.agent_id, mq.message_id, mq.payload, mq.status, mq.priority,
           mq.created_at, mq.read_at, mq.replied_at, mq.replied_with,
           'v1.0.3 uq_mq_agent_message migration — non-safe duplicate (payload or status diverges)'
    FROM message_queue mq
    JOIN unsafe u ON u.id = mq.id;

    DELETE FROM message_queue
    WHERE id IN (SELECT id FROM message_queue_dedup_quarantine);

    -- Safe delete: identical-pending duplicates (true replicas of the kept row).
    DELETE FROM message_queue a
    USING message_queue b
    WHERE a.message_id IS NOT NULL
      AND a.agent_id = b.agent_id
      AND a.message_id = b.message_id
      AND a.id > b.id
      AND a.status = 'pending'
      AND b.status = 'pending'
      AND a.payload = b.payload;

    -- Post-run observability (migrate stderr visible to operator).
    DO $$
    DECLARE
      q_count INTEGER;
    BEGIN
      SELECT count(*) INTO q_count FROM message_queue_dedup_quarantine;
      RAISE NOTICE 'message_queue dedup — quarantined rows total: %', q_count;
    END $$;

    CREATE UNIQUE INDEX IF NOT EXISTS uq_mq_agent_message
      ON message_queue(agent_id, message_id)
      WHERE message_id IS NOT NULL;

    -- Issue #278 (A) segment 3d hotfix (lead-ama incident 2026-04-30) —
    -- agents.current_message_id is the legacy single-slot in-flight
    -- pointer (Issue #128 Phase 2). Stage B replaces it with the
    -- per-row claim model on message_queue, but the DROP must NOT run
    -- in this auto-applied bootstrap migration: every fleet restart
    -- would re-fire the DROP and break any old-code bot still reading
    -- the column. The drop is exposed exclusively through the paired
    -- file (db/migrations/2026-04-30-stage-b-drop-current-message-id
    -- .{up,down}.sql), to be applied manually post-merge with a
    -- coordinated fleet restart. Until then we keep the column in the
    -- bootstrap so a fresh DB matches the live fleet shape.
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS current_message_id BIGINT;

    -- Phase C PR #214: idle/busy state machine (spec §4.1 step 4, §4.2 step 11, §8.1)
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS status_detail TEXT;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS status_updated_at TIMESTAMPTZ;

    -- Issue #287 — DB-persisted inbox cursor. The cursor columns are
    -- now part of the canonical bootstrap (PR-0 cycle 12 — see the
    -- agents CREATE TABLE above and the idempotent ALTER block).
    -- The paired migration db/migrations/2026-05-01-inbox-cursor-db-persist.up.sql
    -- remains the operational rollback artifact, but a fresh
    -- bun db/migrate.ts now produces a parity-correct schema
    -- without manual --up apply.

    -- v2.1.0 PR 1/3: message_queue.failed_reason + extend status CHECK to include 'failed'.
    -- fail/skip CLIs store the abandonment reason so operators can distinguish
    -- IMPLICIT_ABANDON / LLM_FAILED / SEND_FAILED_AFTER_N_RETRIES / LOOP_DETECTED / OBSOLETE
    -- without reading logs. Idempotent: the ADD COLUMN is IF NOT EXISTS, the CHECK
    -- constraint swap is DO-guarded so re-runs are safe.
    ALTER TABLE message_queue ADD COLUMN IF NOT EXISTS failed_reason TEXT;

    -- Issue #338 / CEO 2026-05-14 hotfix: align the idempotent ALTER
    -- block with the CREATE TABLE definition above. Drop any existing
    -- constraint whose definition does not already match the 8-value
    -- union, then re-add the canonical 8-value union. Additive: the
    -- legacy values ('read' / 'failed' / 'skipped') remain valid so
    -- un-restarted fleet bots keep functioning while the v0.9 vocab
    -- ('received' / 'in_progress' / 'done' / 'replied') is also
    -- accepted.
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'message_queue_status_check'
           AND conrelid = 'message_queue'::regclass
           AND pg_get_constraintdef(oid) NOT LIKE '%received%'
      ) THEN
        ALTER TABLE message_queue DROP CONSTRAINT message_queue_status_check;
      END IF;
      IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'message_queue_status_check'
           AND conrelid = 'message_queue'::regclass
      ) THEN
        ALTER TABLE message_queue
          ADD CONSTRAINT message_queue_status_check
          CHECK (status IN ('pending', 'read', 'received', 'in_progress', 'done', 'replied', 'skipped', 'failed'));
      END IF;
    END $$;

    -- Issue #338 / CEO 2026-05-14 hotfix: state-transition tools (sub-PR
    -- 6 #348) require a done_at TIMESTAMPTZ for the v0.9 'done' state.
    -- Idempotent ADD so re-running migrate is safe.
    ALTER TABLE message_queue ADD COLUMN IF NOT EXISTS done_at TIMESTAMPTZ;

    -- Issue #129 Phase 3: outbound_queue (Discord send queue, message-queue-spec 3.3)
    -- Receiver-side consumer dequeues pending rows on a 1-second tick and posts
    -- them to Discord. Decouples DB INSERT from outbound HTTP so the send-tool
    -- and CLI no longer hold their transactions / agents row lock during the
    -- (potentially slow) Discord REST call.
    CREATE TABLE IF NOT EXISTS outbound_queue (
      id BIGSERIAL PRIMARY KEY,
      message_id TEXT NOT NULL,            -- agent_messages.id of the row to deliver
      agent_id TEXT NOT NULL,              -- canonical author agent_id
      consumer_agent_id TEXT,              -- adapter owner that claims/posts this row (#410)
      delivery_connector_instance_id UUID REFERENCES connector_instances(connector_instance_id) ON DELETE SET NULL,
      channel_binding_id UUID REFERENCES channel_connector_bindings(channel_binding_id) ON DELETE SET NULL,
      claimed_runtime_instance_id UUID REFERENCES agent_runtime_instances(runtime_instance_id) ON DELETE SET NULL,
      projection_identity_id TEXT,         -- resolved Discord-facing projection identity after fallback (ADR-060)
      intended_projection_identity_id TEXT,-- configured/native projection intent before fallback (ADR-060)
      projection_source TEXT,              -- resolver source for projection identity (ADR-060)
      projection_fallback_reason TEXT,     -- fallback/unavailable reason, if any (ADR-060)
      channel_external_id TEXT NOT NULL,   -- Discord channel or thread snowflake
      content TEXT NOT NULL,
      mentions_display TEXT DEFAULT '[]',  -- pre-rendered Discord mentions (JSON)
      attachments TEXT DEFAULT '[]',       -- attachment paths (JSON, Phase 3 leaves empty)
      reply_to_discord_id TEXT,            -- Discord native reply id (Phase 3 leaves NULL)
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'sent', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      sent_at TIMESTAMPTZ,
      claimed_at TIMESTAMPTZ,
      next_retry_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_oq_pending
      ON outbound_queue(status, created_at ASC)
      WHERE status = 'pending';

    -- S2-A (FEAT-005): atomic claim + exponential backoff support.
    -- Forward-only changes for existing DBs that predate this PR. All
    -- statements are idempotent so the whole migration is safe to re-run.
    -- See: docs/plans/outbound-forwarder-unification.md §3.
    ALTER TABLE outbound_queue ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
    ALTER TABLE outbound_queue ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;
    ALTER TABLE outbound_queue ADD COLUMN IF NOT EXISTS consumer_agent_id TEXT;
    ALTER TABLE outbound_queue ADD COLUMN IF NOT EXISTS delivery_connector_instance_id UUID REFERENCES connector_instances(connector_instance_id) ON DELETE SET NULL;
    ALTER TABLE outbound_queue ADD COLUMN IF NOT EXISTS channel_binding_id UUID REFERENCES channel_connector_bindings(channel_binding_id) ON DELETE SET NULL;
    ALTER TABLE outbound_queue ADD COLUMN IF NOT EXISTS claimed_runtime_instance_id UUID REFERENCES agent_runtime_instances(runtime_instance_id) ON DELETE SET NULL;
    ALTER TABLE outbound_queue ADD COLUMN IF NOT EXISTS projection_identity_id TEXT;
    ALTER TABLE outbound_queue ADD COLUMN IF NOT EXISTS intended_projection_identity_id TEXT;
    ALTER TABLE outbound_queue ADD COLUMN IF NOT EXISTS projection_source TEXT;
    ALTER TABLE outbound_queue ADD COLUMN IF NOT EXISTS projection_fallback_reason TEXT;
    CREATE INDEX IF NOT EXISTS idx_outbound_queue_delivery_connector_pending
      ON outbound_queue(delivery_connector_instance_id, status, next_retry_at)
      WHERE delivery_connector_instance_id IS NOT NULL AND status = 'pending';
    CREATE INDEX IF NOT EXISTS idx_outbound_queue_channel_binding_pending
      ON outbound_queue(channel_binding_id, status, next_retry_at)
      WHERE channel_binding_id IS NOT NULL AND status = 'pending';

    -- Phase C Step 1 PR-A (cycle 3/4 honesty note): observability column for
    -- the returned Discord snowflake. Effective outbound dedup is provided
    -- by (1) Discord's per-channel nonce + enforceNonce flag and (2) the
    -- consumer's 40062 idempotent-collapse branch; this column is NOT the
    -- front-line dedup layer. Because the column is written in the same
    -- UPDATE as 'status=sent', the pending-filter claim cannot normally
    -- see a row that already carries a non-null id, so the in-code
    -- short-circuit on 'row.discord_message_id' is a limited safeguard
    -- only — useful if a row is manually or tool-reset back to 'pending'
    -- after mark-sent. See docs/agent-com-message-queue-spec.md §3.3 / §7.4.
    ALTER TABLE outbound_queue ADD COLUMN IF NOT EXISTS discord_message_id TEXT;

    -- S2-A (FEAT-005 pre-CP-3) CHECK: drop + re-add so pre-S2-A DBs
    -- accept the atomic claim flip. Postgres has no in-place CHECK
    -- mutation; DO $$ for idempotency. CP-3 block below then renames
    -- 'processing' → 'claimed' in a single transaction.
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'outbound_queue'::regclass
           AND conname  = 'outbound_queue_status_check'
      ) THEN
        ALTER TABLE outbound_queue DROP CONSTRAINT outbound_queue_status_check;
      END IF;
      ALTER TABLE outbound_queue
        ADD CONSTRAINT outbound_queue_status_check
        CHECK (status IN ('pending', 'processing', 'sent', 'failed'));
    END $$;

    CREATE INDEX IF NOT EXISTS idx_outbound_queue_agent_pending_next_retry
      ON outbound_queue(agent_id, status, next_retry_at)
      WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS idx_outbound_queue_consumer_pending_next_retry
      ON outbound_queue(consumer_agent_id, status, next_retry_at)
      WHERE status = 'pending' AND consumer_agent_id IS NOT NULL;
  `)

  // FEAT-005 CP-3 forward migration: rename outbound_queue claim state
  // 'processing' → 'claimed'. Semantic clarity — 'claimed' is the
  // standard work-queue vocabulary and matches the claim SQL verb.
  //
  // Forward-only, single transaction, idempotent:
  //   - DROP CONSTRAINT IF EXISTS → never fails on re-run
  //   - UPDATE matches the empty set after first success → no-op
  //   - ADD CONSTRAINT with the new vocabulary is deterministic
  //   - DROP INDEX IF EXISTS + CREATE INDEX IF NOT EXISTS is idempotent
  //
  // Rollback: db/rollback-claim-vocabulary.sql (psql -f).
  await gatedQuery(client, `
    BEGIN;

    DO $$
    BEGIN
      -- 1. Drop the current CHECK so the UPDATE below cannot be rejected.
      IF EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'outbound_queue'::regclass
           AND conname  = 'outbound_queue_status_check'
      ) THEN
        ALTER TABLE outbound_queue DROP CONSTRAINT outbound_queue_status_check;
      END IF;

      -- 2. Migrate in-flight rows from the old vocabulary. Empty on
      --    re-run (all processing rows have already been renamed).
      UPDATE outbound_queue SET status = 'claimed' WHERE status = 'processing';

      -- 3. Install the post-CP-3 CHECK with the new vocabulary. Single
      --    atomic re-statement inside the outer transaction so the
      --    table never sits with no CHECK at all.
      ALTER TABLE outbound_queue
        ADD CONSTRAINT outbound_queue_status_check
        CHECK (status IN ('pending', 'claimed', 'sent', 'failed'));
    END $$;

    -- 4. Partial-index WHERE predicate must follow the new vocabulary
    --    or orphan reclaim cannot use it. DROP old, CREATE new — same
    --    transaction so there is never a window with zero index.
    DROP INDEX IF EXISTS idx_outbound_queue_processing_claimed_at;
    CREATE INDEX IF NOT EXISTS idx_outbound_queue_claimed_claimed_at
      ON outbound_queue(status, claimed_at)
      WHERE status = 'claimed';

    COMMIT;
  `)

  // PR #0 — mq_enqueued NOTIFY channel for wake-on-insert daemon.
  //
  // Fires on every message_queue INSERT within the same transaction as the
  // originating write, so the notification cannot be lost to a crash between
  // INSERT and fanout (spec v3 PR #0 §2.2 frozen: "同 transaction で notify").
  //
  // Payload shape (frozen § 2.2): {"agent_id": "...", "message_id": "..."}.
  // Consumers: bin/wake-daemon.ts (LISTEN mq_enqueued → tmux send-keys).
  //
  // Idempotent: CREATE OR REPLACE FUNCTION + DROP/CREATE TRIGGER inside a
  // transaction, safe on re-run.
  await gatedQuery(client, `
    BEGIN;

    CREATE OR REPLACE FUNCTION fn_notify_mq_enqueued() RETURNS TRIGGER AS $$
    BEGIN
      PERFORM pg_notify('mq_enqueued', json_build_object(
        'agent_id', NEW.agent_id,
        'message_id', NEW.message_id
      )::text);
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_mq_enqueued_notify ON message_queue;
    CREATE TRIGGER trg_mq_enqueued_notify
      AFTER INSERT ON message_queue
      FOR EACH ROW
      EXECUTE FUNCTION fn_notify_mq_enqueued();

    COMMIT;
  `)

  // Sync channel settings from config.json if available
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'))
      for (const [ch, settings] of Object.entries(config.channels ?? {})) {
        const s = settings as { retention_days?: number | null; description?: string }
        await gatedQuery(
          client,
          `INSERT INTO channel_settings (channel_id, retention_days, description, updated_at)
           VALUES ($1, $2, $3, now())
           ON CONFLICT (channel_id) DO UPDATE SET retention_days = $2, description = $3, updated_at = now()`,
          [ch, s.retention_days ?? null, s.description ?? null]
        )
      }
      console.log(`Synced ${Object.keys(config.channels ?? {}).length} channel settings from config.json`)
    } catch {}
  }

  console.log('Migration complete.')
  await client.end()
}

// Issue #278 (G-2) — `--down=<file>` rollback mode. The `up` schema is
// expressed inline in `migrate()`; reversing it requires explicit DROP
// statements that would clutter the up path. We therefore ship reversible
// migrations as paired `db/migrations/<id>.{up,down}.sql` files, applied
// statement-list via the same `pg.Client` that `migrate()` uses. The
// canonical idempotent up still runs from `migrate()`, so the down path
// is informational + operator-driven (CTO directive, msg `167415dc`).
export async function applyDownMigration(
  filePath: string,
  opts: { databaseUrl?: string } = {},
): Promise<void> {
  const targetUrl = opts.databaseUrl ?? databaseUrl
  const sql = readFileSync(filePath, 'utf-8')
  const client = new Client({ connectionString: targetUrl })
  await client.connect()
  try {
    await gatedQuery(client, sql, undefined, targetUrl)
    console.log(`Down migration applied: ${filePath}`)
  } finally {
    await client.end()
  }
}

export async function applyUpMigrationFile(
  filePath: string,
  opts: { databaseUrl?: string } = {},
): Promise<void> {
  const targetUrl = opts.databaseUrl ?? databaseUrl
  const sql = readFileSync(filePath, 'utf-8')
  const client = new Client({ connectionString: targetUrl })
  await client.connect()
  try {
    await gatedQuery(client, sql, undefined, targetUrl)
    console.log(`Up migration applied: ${filePath}`)
  } finally {
    await client.end()
  }
}

function parseDownFlag(argv: readonly string[]): string | null {
  for (const a of argv) {
    if (a.startsWith('--down=')) return a.slice('--down='.length)
  }
  return null
}

function parseUpFlag(argv: readonly string[]): string | null {
  for (const a of argv) {
    if (a.startsWith('--up=')) return a.slice('--up='.length)
  }
  return null
}

// Guardrail 2 (FEAT-005 CP-6): only run when this file is invoked
// directly. Prior behaviour — top-level `migrate().catch(...)` — ran
// the migration on every `import('./db/migrate.ts')` (side effect of
// loading the module), which is how the CP-3 CHECK rename landed on
// the dev DB out of sequence on 2026-04-14 despite CTO holding the
// apply-GO until post-merge. `import.meta.main` is Bun's canonical
// "this module is the entrypoint" flag and matches the behaviour of
// `__name__ == '__main__'` in Python / `require.main === module` in
// Node. Tests / tools that merely import migrate.ts for its exports
// get no side effect.
if (import.meta.main) {
  const downFile = parseDownFlag(process.argv)
  const upFile = parseUpFlag(process.argv)
  if (downFile) {
    applyDownMigration(downFile).catch(e => { console.error(e); process.exit(1) })
  } else if (upFile) {
    applyUpMigrationFile(upFile).catch(e => { console.error(e); process.exit(1) })
  } else if (dbType === 'sqlite') {
    migrateSqlite()
  } else {
    migrate().catch(e => { console.error(e); process.exit(1) })
  }
}
