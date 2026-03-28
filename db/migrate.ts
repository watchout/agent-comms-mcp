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
      channel_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      author_bot BOOLEAN DEFAULT true,
      content TEXT NOT NULL,
      message_type TEXT,
      reply_to UUID REFERENCES agent_messages(id),
      attachments JSONB,
      metadata JSONB,
      depth INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_agent_messages_channel ON agent_messages(channel_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_agent_messages_author ON agent_messages(author_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_agent_messages_type ON agent_messages(message_type, created_at);

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
