#!/usr/bin/env bun
/**
 * Spike 2 — dedup_test_messages migration.
 *
 * Verifies the §H2 mixed-mode dedup mechanism (PR-B.2) on an isolated table:
 * - mirror agent_messages structure
 * - add discord_message_id TEXT
 * - add PARTIAL UNIQUE INDEX matching the v0.2.0 proposal
 *
 * Production agent_messages is NOT touched.
 *
 * Usage: bun run db/migrate-spike2-dedup.ts
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
    CREATE TABLE IF NOT EXISTS dedup_test_messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      channel_id TEXT,
      author_id TEXT NOT NULL,
      content TEXT NOT NULL,
      message_type TEXT NOT NULL DEFAULT 'chat',
      metadata JSONB,
      source TEXT NOT NULL DEFAULT 'spike2',
      direction TEXT NOT NULL DEFAULT 'inbound',
      created_at TIMESTAMPTZ DEFAULT now(),
      -- §H2 v0.2.0 proposal additions
      discord_message_id TEXT,
      -- spike-specific
      spike_run_id TEXT,
      inserted_by TEXT  -- which racer inserted the surviving row
    );

    -- §H2 partial unique index — matches the v0.2.0 proposal
    CREATE UNIQUE INDEX IF NOT EXISTS uq_dedup_test_messages_discord_id
      ON dedup_test_messages (discord_message_id)
      WHERE discord_message_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_dedup_test_messages_run
      ON dedup_test_messages(spike_run_id);
  `)

  console.log('Spike 2 dedup_test_messages migration complete.')
  await client.end()
}

migrate().catch(e => { console.error(e); process.exit(1) })
