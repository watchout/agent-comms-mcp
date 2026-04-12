#!/usr/bin/env bun
/**
 * Spec-enforcement + integration tests for ADR-048 Phase 0 D3 —
 * status='replied' fallback by reply_to (server.ts send tool).
 *
 * Scope of the fix under test: reply_to passed as an `agent_messages.id`
 * UUID (the canonical in-DB shape). Discord snowflake → UUID resolution
 * is explicitly out of scope for this PR and tracked as follow-up D3b.
 *
 * Part 1 — source guards (regex): pin the code shape so future refactors
 * can't silently drop the fallback branch, the primary branch, or the
 * observability wrappers.
 *
 * Part 2 — DB integration: seed a fixture message_queue row and run the
 * exact UPDATE SQL against a real Postgres instance. This is what codex
 * asked for — "behavior" coverage, not just string matching.
 *
 * See:
 *   - server.ts send tool: primary (current_message_id) + fallback (reply_to)
 *   - docs/investigations/phase0-drift-audit.md §D3
 *   - github.com/watchout/agent-comms-mcp/pull/156
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { Client as PgClient } from 'pg'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const SERVER_SOURCE = readFileSync(join(REPO_ROOT, 'server.ts'), 'utf8')

// ─────────────────────────────────────────────────────────────────────────
// Part 1 — source guards
// ─────────────────────────────────────────────────────────────────────────
describe('D3 source guards — server.ts send tool', () => {
  test('primary branch (current_message_id) UPDATE is present', () => {
    expect(SERVER_SOURCE).toMatch(
      /UPDATE message_queue SET status = 'replied', replied_at = now\(\), replied_with = \$1 WHERE id = \$2/,
    )
  })

  test('fallback branch UPDATE keyed on (agent_id, message_id, status IN pending/read) is present', () => {
    expect(SERVER_SOURCE).toMatch(
      /UPDATE message_queue SET status = 'replied', replied_at = now\(\), replied_with = \$1[\s\S]*?WHERE agent_id = \$2 AND message_id = \$3 AND status IN \('pending', 'read'\)/,
    )
  })

  test('fallback is gated on reply_to being present (else if reply_to)', () => {
    expect(SERVER_SOURCE).toMatch(/else if \(reply_to\)/)
  })

  test('observability — fallback emits structured JSON log on success path', () => {
    expect(SERVER_SOURCE).toMatch(/event:\s*['"]d3_fallback_replied['"]/)
  })

  test('observability — fallback emits structured JSON log + audit event on error (non-fatal)', () => {
    expect(SERVER_SOURCE).toMatch(/event:\s*['"]d3_fallback_error['"]/)
    expect(SERVER_SOURCE).toMatch(/writeAuditLog\(\s*['"]d3\.fallback\.error['"]/)
  })

  test('zero-row fallback miss is surfaced via audit log (d3.fallback.miss)', () => {
    expect(SERVER_SOURCE).toMatch(/writeAuditLog\(\s*['"]d3\.fallback\.miss['"]/)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Part 2 — DB integration (real Postgres)
// ─────────────────────────────────────────────────────────────────────────
// We run the exact UPDATE statements from server.ts against live message_queue
// rows. The SQL literals are duplicated (not imported) on purpose — the test's
// job is to pin the contract of those literals. If the server.ts strings drift,
// Part 1 guards catch it; if the *behavior* of those strings drifts, Part 2
// catches it.

let databaseUrl = process.env.DATABASE_URL ?? 'postgresql://localhost/agent_comms'
const configPath = join(REPO_ROOT, 'config.json')
if (existsSync(configPath)) {
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    databaseUrl = config.database_url ?? databaseUrl
  } catch {}
}

const FIXTURE_AGENT = 'spec-enforcement-d3-agent'
const FIXTURE_REPLY_TO_A = '00000000-0000-0000-0000-0000000000a0'
const FIXTURE_REPLY_TO_B = '00000000-0000-0000-0000-0000000000b0'
const FIXTURE_REPLIED_WITH = '00000000-0000-0000-0000-0000000000ff'

const UPDATE_FALLBACK_SQL =
  `UPDATE message_queue SET status = 'replied', replied_at = now(), replied_with = $1
   WHERE agent_id = $2 AND message_id = $3 AND status IN ('pending', 'read')`

describe('D3 fallback — DB integration (real Postgres)', () => {
  let db: PgClient
  let pendingId: number
  let readId: number
  let alreadyRepliedId: number

  beforeAll(async () => {
    db = new PgClient({ connectionString: databaseUrl })
    await db.connect()
    // Ensure a clean slate for this agent's fixtures.
    await db.query(`DELETE FROM message_queue WHERE agent_id = $1`, [FIXTURE_AGENT])

    const ins = async (messageId: string, status: string) => {
      const r = await db.query(
        `INSERT INTO message_queue (agent_id, message_id, payload, status)
         VALUES ($1, $2, '{}', $3) RETURNING id`,
        [FIXTURE_AGENT, messageId, status],
      )
      return Number(r.rows[0].id)
    }
    pendingId = await ins(FIXTURE_REPLY_TO_A, 'pending')
    readId = await ins(FIXTURE_REPLY_TO_B, 'read')
    alreadyRepliedId = await ins('00000000-0000-0000-0000-0000000000c0', 'replied')
  })

  afterAll(async () => {
    await db.query(`DELETE FROM message_queue WHERE agent_id = $1`, [FIXTURE_AGENT]).catch(() => {})
    await db.end()
  })

  // Case 1: current_message_id=NULL + reply_to matches → exactly 1 row flips to 'replied'.
  test('case 1: reply_to match transitions exactly one row (pending → replied)', async () => {
    const res = await db.query(UPDATE_FALLBACK_SQL, [FIXTURE_REPLIED_WITH, FIXTURE_AGENT, FIXTURE_REPLY_TO_A])
    expect(res.rowCount).toBe(1)
    const after = await db.query(
      `SELECT status, replied_with, replied_at FROM message_queue WHERE id = $1`, [pendingId],
    )
    expect(after.rows[0].status).toBe('replied')
    expect(after.rows[0].replied_with).toBe(FIXTURE_REPLIED_WITH)
    expect(after.rows[0].replied_at).not.toBeNull()
  })

  // Case 2: reply_to mismatch → zero rows touched, no collateral update.
  test('case 2: reply_to mismatch touches zero rows and leaves other rows intact', async () => {
    const BOGUS = '00000000-0000-0000-0000-00000000dead'
    const before = await db.query(
      `SELECT id, status FROM message_queue WHERE agent_id = $1 ORDER BY id`, [FIXTURE_AGENT],
    )
    const res = await db.query(UPDATE_FALLBACK_SQL, [FIXTURE_REPLIED_WITH, FIXTURE_AGENT, BOGUS])
    expect(res.rowCount).toBe(0)
    const after = await db.query(
      `SELECT id, status FROM message_queue WHERE agent_id = $1 ORDER BY id`, [FIXTURE_AGENT],
    )
    expect(after.rows).toEqual(before.rows)
    // Already-replied row must not be re-touched even if we aimed at its message_id.
    const res2 = await db.query(UPDATE_FALLBACK_SQL, [
      FIXTURE_REPLIED_WITH, FIXTURE_AGENT, '00000000-0000-0000-0000-0000000000c0',
    ])
    expect(res2.rowCount).toBe(0)
    const repliedRow = await db.query(
      `SELECT status FROM message_queue WHERE id = $1`, [alreadyRepliedId],
    )
    expect(repliedRow.rows[0].status).toBe('replied')
  })

  // Case 3: DB exception path — invalid parameter shape (e.g., NULL message_id)
  // must not corrupt state. The server.ts try/catch wraps this so send itself
  // succeeds; here we prove the UPDATE either no-ops or raises, never partial-writes.
  test('case 3: DB exception path leaves queue state unchanged (no partial writes)', async () => {
    const before = await db.query(
      `SELECT id, status, replied_with FROM message_queue WHERE id = $1`, [readId],
    )
    // Drive a predictable failure by feeding a non-text value through a CAST
    // the planner will reject. `reply_to` parameter is typed TEXT in production,
    // so we simulate a "malformed reply_to" at the SQL layer via an explicit cast.
    let threw = false
    try {
      await db.query(
        `UPDATE message_queue SET status = 'replied', replied_at = now(), replied_with = $1
         WHERE agent_id = $2 AND message_id = $3::uuid::text AND status IN ('pending', 'read')`,
        [FIXTURE_REPLIED_WITH, FIXTURE_AGENT, 'not-a-uuid'],
      )
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    const after = await db.query(
      `SELECT id, status, replied_with FROM message_queue WHERE id = $1`, [readId],
    )
    expect(after.rows[0]).toEqual(before.rows[0])
  })
})
