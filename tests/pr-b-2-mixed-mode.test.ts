#!/usr/bin/env bun
/**
 * PR-B.2 mixed-mode receiver pipeline tests.
 *
 * Verifies:
 * 1. Source-level regression — RECEIVER_PIPELINE_BOTS, §H2 dedup-safe saveMessage path,
 *    receiver-pipeline pg_notify fanout in handleInboundMessage
 * 2. Migration regression — discord_message_id column + partial unique index exist
 * 3. DB integration — INSERT ON CONFLICT with predicate-repeat dedups parallel inserts
 *    to a single row, and SELECT fallback returns the surviving id
 *
 * Usage: bun test tests/pr-b-2-mixed-mode.test.ts
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { Client, Pool } from 'pg'

const PROJECT_ROOT = join(dirname(new URL(import.meta.url).pathname), '..')
// FEAT-005 (adapter rewrite): handleInboundMessage lives in
// adapters/inbound-receiver.ts. Concat so PR-B.2 structural pins fire
// at its new home.
const SERVER_SOURCE =
  readFileSync(join(PROJECT_ROOT, 'server.ts'), 'utf-8')
  + '\n'
  + readFileSync(join(PROJECT_ROOT, 'adapters/inbound-receiver.ts'), 'utf-8')

let databaseUrl = process.env.DATABASE_URL ?? 'postgresql://localhost/agent_comms'
const configPath = join(PROJECT_ROOT, 'config.json')
if (existsSync(configPath)) {
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    databaseUrl = config.database_url ?? databaseUrl
  } catch {}
}

// ============================================================
// 1. Source-level regression
// ============================================================
describe('PR-B.2 — Source Structure', () => {
  test('RECEIVER_PIPELINE_BOTS canary set is declared and env-overridable', () => {
    expect(SERVER_SOURCE).toContain('const RECEIVER_PIPELINE_BOTS = new Set<string>(')
    expect(SERVER_SOURCE).toContain("process.env.RECEIVER_PIPELINE_BOTS ?? 'auditor'")
  })

  test('saveMessage uses INSERT ON CONFLICT with predicate-repeat for §H2 dedup', () => {
    const fnIdx = SERVER_SOURCE.indexOf('async function saveMessage(')
    const fnBody = SERVER_SOURCE.slice(fnIdx, fnIdx + 5000)
    // Predicate-repeat on ON CONFLICT (Spike 2 finding — required for partial index match)
    expect(fnBody).toContain('ON CONFLICT (discord_message_id) WHERE discord_message_id IS NOT NULL DO NOTHING')
    expect(fnBody).toContain('RETURNING id')
    // §H2 SELECT fallback
    expect(fnBody).toContain('SELECT id FROM agent_messages WHERE discord_message_id = $1')
  })

  test('handleInboundMessage fires receiver-pipeline pg_notify for RECEIVER_PIPELINE_BOTS', () => {
    const fnIdx = SERVER_SOURCE.indexOf('async function handleInboundMessage(')
    // PR-β: window widened (handleInboundMessage grew from ~9K to ~11K chars
    // when the reply_to UUID resolution + mentions auto-fill blocks landed).
    const fnBody = SERVER_SOURCE.slice(fnIdx, fnIdx + 16000)
    expect(fnBody).toContain('RECEIVER_PIPELINE_BOTS.has(receiverAgentId)')
    expect(fnBody).toContain("pg_notify('agent_inbox'")
    expect(fnBody).toContain("'message.created'")
    expect(fnBody).toContain("'receiver-pipeline'")
  })
})

// ============================================================
// 2. DB integration
// ============================================================
describe('PR-B.2 — DB Migration & Dedup', () => {
  let client: Client

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl })
    await client.connect()
  })

  afterAll(async () => {
    // Cleanup any test rows we created
    await client.query(`DELETE FROM agent_messages WHERE discord_message_id LIKE 'pr-b-2-test-%'`).catch(() => {})
    await client.end()
  })

  test('agent_messages has discord_message_id column', async () => {
    const r = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'agent_messages' AND column_name = 'discord_message_id'`,
    )
    expect(r.rows.length).toBe(1)
  })

  test('agent_messages has partial unique index uq_agent_messages_discord_id', async () => {
    const r = await client.query(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE tablename = 'agent_messages'
          AND indexname = 'uq_agent_messages_discord_id'`,
    )
    expect(r.rows.length).toBe(1)
    expect(r.rows[0].indexdef).toContain('UNIQUE')
    expect(r.rows[0].indexdef).toContain('WHERE')
    expect(r.rows[0].indexdef).toContain('discord_message_id IS NOT NULL')
  })

  test('parallel INSERTs with same discord_message_id dedup to 1 row', async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 10 })
    const discordId = `pr-b-2-test-${Date.now()}-${Math.random()}`
    const insertOne = (idx: number) =>
      pool.query(
        `INSERT INTO agent_messages
           (id, channel_id, author_id, content, discord_message_id, source, direction)
         VALUES (gen_random_uuid(), 'pr-b-2-channel', $1, $2, $3, 'discord', 'inbound')
         ON CONFLICT (discord_message_id) WHERE discord_message_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [`pr-b-2-author-${idx}`, `pr-b-2 racer ${idx}`, discordId],
      )

    // 10 parallel racers, same discord_message_id
    const results = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(insertOne))

    // Exactly 1 winner returned a row id
    const winners = results.filter(r => r.rows.length > 0)
    expect(winners.length).toBe(1)

    // Exactly 1 row in the table for this discord_message_id
    const r = await pool.query(
      `SELECT count(*)::int AS c FROM agent_messages WHERE discord_message_id = $1`,
      [discordId],
    )
    expect(r.rows[0].c).toBe(1)

    // SELECT fallback returns the same id as the winner
    const sel = await pool.query(
      `SELECT id FROM agent_messages WHERE discord_message_id = $1`,
      [discordId],
    )
    expect(sel.rows[0].id).toBe(winners[0].rows[0].id)

    await pool.end()
  })

  test('NULL discord_message_id INSERTs are not constrained by the partial unique index', async () => {
    // Two outbound-style rows with no discord_message_id should both succeed
    const r1 = await client.query(
      `INSERT INTO agent_messages
         (id, channel_id, author_id, content, source, direction)
       VALUES (gen_random_uuid(), 'pr-b-2-channel', 'pr-b-2-author', 'pr-b-2-test-null-1', 'agent-comms', 'outbound')
       RETURNING id`,
    )
    const r2 = await client.query(
      `INSERT INTO agent_messages
         (id, channel_id, author_id, content, source, direction)
       VALUES (gen_random_uuid(), 'pr-b-2-channel', 'pr-b-2-author', 'pr-b-2-test-null-2', 'agent-comms', 'outbound')
       RETURNING id`,
    )
    expect(r1.rows.length).toBe(1)
    expect(r2.rows.length).toBe(1)
    // Cleanup
    await client.query(`DELETE FROM agent_messages WHERE id IN ($1, $2)`, [r1.rows[0].id, r2.rows[0].id])
  })
})
