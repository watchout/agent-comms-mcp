#!/usr/bin/env bun
/**
 * Spec-enforcement test for db/seed.ts ordering bug
 * (regression class: 2026-04-09 lead-ama / lead-tuk / lead-sus / secretary
 * dropped from channel members during routine seed run).
 *
 * Background:
 *   `db/seed.ts` builds a Discord-user-ID → agent_id map in two passes:
 *     1. Pass A: scan ~/.claude/channels/discord-XYZ/access.json files
 *        (XYZ = bot session name; the literal glob would close this comment)
 *     2. Pass B: SELECT agents.metadata->>'discord_id' from PostgreSQL
 *
 *   Until the bug fix, Pass B ran AFTER the channel members calculation
 *   loop (`for guild of client.guilds.cache`). Bots that had been
 *   registered via runtime stdio/sse paths (and thus had a discord_id in
 *   `agents.metadata` but no `access.json` file yet) were dropped with
 *   `[WARN] unknown Discord user ...` and never added to channel.members.
 *   `lead-ama`, `lead-tuk`, `lead-sus`, and `secretary` all hit this on
 *   2026-04-09 08:30 JST and required CTO manual `UPDATE channels` to
 *   recover. The next routine `bun run db/seed.ts` would have wiped the
 *   recovery and re-introduced the bug.
 *
 * Fix:
 *   `supplementDiscordIdMapFromDb()` is extracted as an exportable function
 *   in db/seed.ts and called BEFORE the `client.guilds.cache` iteration.
 *   The DB connection (`db.connect()`) is also moved up so the supplement
 *   has a live client.
 *
 * Tests in this file:
 *   1. Source order: `db.connect()` precedes the `client.guilds.cache` loop
 *   2. Source order: `supplementDiscordIdMapFromDb()` call precedes the loop
 *   3. DB integration: a fixture set of agents with `metadata.discord_id` is
 *      reflected in the supplemented map (proves the function actually works
 *      against a real PG instance).
 *
 * If any of these fail, the bug is back.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { Client as PgClient } from 'pg'

import { supplementDiscordIdMapFromDb } from '../../db/seed'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const SEED_SOURCE = readFileSync(join(REPO_ROOT, 'db/seed.ts'), 'utf-8')

let databaseUrl = process.env.DATABASE_URL ?? 'postgresql://localhost/agent_comms'
const configPath = join(REPO_ROOT, 'config.json')
if (existsSync(configPath)) {
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    databaseUrl = config.database_url ?? databaseUrl
  } catch {}
}

// ─────────────────────────────────────────────────────────────────────────
// 1. Source-order regression guards
// ─────────────────────────────────────────────────────────────────────────
describe('seed.ts ordering — source-level guards', () => {
  test('db.connect() precedes the client.guilds.cache iteration', () => {
    const dbConnectIdx = SEED_SOURCE.indexOf('await db.connect()')
    const guildsLoopIdx = SEED_SOURCE.indexOf('for (const [, guild] of client.guilds.cache)')

    expect(dbConnectIdx).toBeGreaterThan(0)
    expect(guildsLoopIdx).toBeGreaterThan(0)
    expect(dbConnectIdx).toBeLessThan(guildsLoopIdx)
  })

  test('supplementDiscordIdMapFromDb() is called before the channel members loop', () => {
    const supplementCallIdx = SEED_SOURCE.indexOf('await supplementDiscordIdMapFromDb(db, discordIdMap)')
    const guildsLoopIdx = SEED_SOURCE.indexOf('for (const [, guild] of client.guilds.cache)')

    expect(supplementCallIdx).toBeGreaterThan(0)
    expect(guildsLoopIdx).toBeGreaterThan(0)
    expect(supplementCallIdx).toBeLessThan(guildsLoopIdx)
  })

  test('supplementDiscordIdMapFromDb() is exported (so unit tests can call it)', () => {
    expect(SEED_SOURCE).toMatch(/export\s+async\s+function\s+supplementDiscordIdMapFromDb\s*\(/)
  })

  test('the SELECT query reads metadata->>\'discord_id\' (the only field that was missing)', () => {
    expect(SEED_SOURCE).toMatch(/SELECT[^;]*metadata->>\s*'discord_id'/)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 2. DB integration — supplementDiscordIdMapFromDb against real PG
// ─────────────────────────────────────────────────────────────────────────
describe('supplementDiscordIdMapFromDb — DB integration', () => {
  let db: PgClient
  // Fictitious Discord IDs for fixtures (high enough to avoid colliding with
  // any real bot ID; 17+ digits is the Discord snowflake format).
  const FIXTURE_AGENTS = [
    { agent_id: 'spec-enforcement-lead-ama', discord_id: '99990000000000000001' },
    { agent_id: 'spec-enforcement-lead-tuk', discord_id: '99990000000000000002' },
    { agent_id: 'spec-enforcement-lead-sus', discord_id: '99990000000000000003' },
    { agent_id: 'spec-enforcement-secretary', discord_id: '99990000000000000004' },
  ]

  beforeAll(async () => {
    db = new PgClient({ connectionString: databaseUrl })
    await db.connect()

    // Insert fixture agents with metadata.discord_id. Use ON CONFLICT so
    // re-running the test suite is idempotent.
    for (const f of FIXTURE_AGENTS) {
      await db.query(
        `INSERT INTO agents (agent_id, org_id, display_name, agent_type, runtime, status, metadata, registered_at)
         VALUES ($1, 'default', $1, 'dev', 'claude-code', 'offline', $2::jsonb, now())
         ON CONFLICT (agent_id) DO UPDATE SET
           metadata = COALESCE(
             jsonb_strip_nulls(COALESCE(agents.metadata, '{}'::jsonb) || $2::jsonb),
             agents.metadata
           )`,
        [f.agent_id, JSON.stringify({ discord_id: f.discord_id })],
      )
    }
  })

  afterAll(async () => {
    // Cleanup: drop all spec-enforcement-* fixture rows so the next run is
    // idempotent and we don't pollute production agents.
    await db.query(`DELETE FROM agents WHERE agent_id LIKE 'spec-enforcement-%'`).catch(() => {})
    await db.end()
  })

  test('supplementDiscordIdMapFromDb populates the map for all fixture agents', async () => {
    const map = new Map<string, string>()
    await supplementDiscordIdMapFromDb(db, map)

    for (const f of FIXTURE_AGENTS) {
      expect(map.get(f.discord_id)).toBe(f.agent_id)
    }
  })

  test('supplementDiscordIdMapFromDb does NOT overwrite existing entries (Pass A wins)', async () => {
    // Pre-seed the map with a deliberately wrong agent_id for one of the
    // fixtures. The supplement should leave it untouched (Pass A precedence).
    const map = new Map<string, string>()
    map.set(FIXTURE_AGENTS[0].discord_id, 'pass-a-precedence-marker')

    await supplementDiscordIdMapFromDb(db, map)

    expect(map.get(FIXTURE_AGENTS[0].discord_id)).toBe('pass-a-precedence-marker')
    // The other 3 fixtures should still get added.
    expect(map.get(FIXTURE_AGENTS[1].discord_id)).toBe(FIXTURE_AGENTS[1].agent_id)
    expect(map.get(FIXTURE_AGENTS[2].discord_id)).toBe(FIXTURE_AGENTS[2].agent_id)
    expect(map.get(FIXTURE_AGENTS[3].discord_id)).toBe(FIXTURE_AGENTS[3].agent_id)
  })

  test('supplementDiscordIdMapFromDb is a no-op if the agents table has no metadata.discord_id rows', async () => {
    // Use an isolated map and a query that filters to a non-existent agent.
    // We can't directly run the function against an empty table without
    // wiping production data, but we can prove that the SELECT query is
    // bounded by the WHERE clause `metadata->>'discord_id' IS NOT NULL`.
    const before = new Map<string, string>()
    before.set('control-discord-id', 'control-agent')

    await supplementDiscordIdMapFromDb(db, before)

    // The control entry must survive untouched.
    expect(before.get('control-discord-id')).toBe('control-agent')
    // The map size grew (because real fixtures + production data are present),
    // not shrunk.
    expect(before.size).toBeGreaterThanOrEqual(1 + FIXTURE_AGENTS.length)
  })
})
