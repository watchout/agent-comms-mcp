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

// Load database_url from config.json if available, fallback to env
let databaseUrl = process.env.DATABASE_URL ?? 'postgresql://localhost/agent_comms'
const configPath = join(dirname(new URL(import.meta.url).pathname), '..', 'config.json')
if (existsSync(configPath)) {
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    databaseUrl = config.database_url ?? databaseUrl
  } catch {}
}

async function migrate() {
  const client = new Client({ connectionString: databaseUrl })
  await client.connect()

  await client.query(`
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
      metadata JSONB
    );

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
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$;

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
        CHECK (status IN ('pending', 'read', 'replied', 'skipped')),
      priority INTEGER NOT NULL DEFAULT 0,   -- higher = more urgent
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      read_at TIMESTAMPTZ,
      replied_at TIMESTAMPTZ,
      replied_with TEXT                      -- reply message id
    );
    CREATE INDEX IF NOT EXISTS idx_mq_agent_pending
      ON message_queue(agent_id, status, priority DESC, created_at ASC)
      WHERE status = 'pending';

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

    -- Issue #128 Phase 2: agents.current_message_id (BIGINT, references message_queue.id)
    -- Tracks the in-flight next result so send can resolve reply_to/dest automatically.
    -- DB-backed (not process-memory) so it survives CLI restarts. ADD COLUMN IF NOT
    -- EXISTS is idempotent on its own; no DO block needed.
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS current_message_id BIGINT;

    -- Issue #129 Phase 3: outbound_queue (Discord send queue, message-queue-spec 3.3)
    -- Receiver-side consumer dequeues pending rows on a 1-second tick and posts
    -- them to Discord. Decouples DB INSERT from outbound HTTP so the send-tool
    -- and CLI no longer hold their transactions / agents row lock during the
    -- (potentially slow) Discord REST call.
    CREATE TABLE IF NOT EXISTS outbound_queue (
      id BIGSERIAL PRIMARY KEY,
      message_id TEXT NOT NULL,            -- agent_messages.id of the row to deliver
      agent_id TEXT NOT NULL,              -- sender agent_id (selects bot token / client)
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

    -- Phase C Step 1 PR-A (cycle 3/4 honesty note): observability column for
    -- the returned Discord snowflake. Effective outbound dedup is provided
    -- by (1) Discord's per-channel nonce + enforceNonce flag and (2) the
    -- consumer's 40062 idempotent-collapse branch; this column is NOT the
    -- front-line dedup layer. Because the column is written in the same
    -- UPDATE as `status='sent'`, the pending-filter claim cannot normally
    -- see a row that already carries a non-null id, so the in-code
    -- short-circuit on `row.discord_message_id` is a limited safeguard
    -- only — useful if a row is manually or tool-reset back to 'pending'
    -- after mark-sent. See docs/agent-com-message-queue-spec.md §3.3 / §7.4.
    ALTER TABLE outbound_queue ADD COLUMN IF NOT EXISTS discord_message_id TEXT;

    -- status CHECK mutation: drop + re-add so pre-S2-A DBs accept the
    -- 'processing' claim flip. Postgres does not allow CHECK constraint
    -- mutation in place; bracketed in DO $$ for idempotency.
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

    CREATE INDEX IF NOT EXISTS idx_outbound_queue_processing_claimed_at
      ON outbound_queue(status, claimed_at)
      WHERE status = 'processing';
    CREATE INDEX IF NOT EXISTS idx_outbound_queue_agent_pending_next_retry
      ON outbound_queue(agent_id, status, next_retry_at)
      WHERE status = 'pending';
  `)

  // Sync channel settings from config.json if available
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'))
      for (const [ch, settings] of Object.entries(config.channels ?? {})) {
        const s = settings as { retention_days?: number | null; description?: string }
        await client.query(
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

migrate().catch(e => { console.error(e); process.exit(1) })
