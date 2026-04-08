#!/usr/bin/env bun
/**
 * Spike 1 — shadow_messages migration.
 *
 * Creates an isolated table that mirrors agent_messages for shadow-mode
 * receiver verification. Production agent_messages is NOT touched.
 *
 * Channel name for pg_notify fanout: 'shadow_inbox' (separate from
 * 'agent_inbox' to keep production listeners unaffected).
 *
 * Usage: bun run db/migrate-spike1-shadow.ts
 */
import { Client } from 'pg'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'

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
    CREATE TABLE IF NOT EXISTS shadow_messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      channel_id TEXT,
      author_id TEXT NOT NULL,
      content TEXT NOT NULL,
      message_type TEXT NOT NULL DEFAULT 'chat',
      metadata JSONB,
      source TEXT NOT NULL DEFAULT 'spike1',
      thread_id TEXT,
      direction TEXT NOT NULL DEFAULT 'inbound',
      created_at TIMESTAMPTZ DEFAULT now(),
      -- spike-specific bookkeeping
      spike_run_id TEXT,
      received_via_listen_at TIMESTAMPTZ,
      received_via_poll_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_shadow_messages_created ON shadow_messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_shadow_messages_run ON shadow_messages(spike_run_id);
  `)

  console.log('Spike 1 shadow_messages migration complete.')
  await client.end()
}

migrate().catch(e => { console.error(e); process.exit(1) })
