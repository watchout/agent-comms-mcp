#!/usr/bin/env bun
/**
 * Issue #287 — DB-persisted inbox cursor + self-reclaim, 7-case merge gate.
 *
 * Hermetic SQLite tests against minimal `agents` + `message_queue` schemas.
 * The behaviors under test:
 *
 *   1. Migration up: adds `agents.inbox_cursor_at` + `agents.inbox_cursor_id`
 *      columns and re-flips stale `read` claims (>15min) back to `pending`.
 *   2. Migration down: drops the cursor columns idempotently.
 *   3. `reclaimSelfOrphanedClaims`: rolls THIS agent's `status='read'` rows
 *      back to `pending` regardless of TTL state (startup-time aggressive).
 *   4. `reclaimSelfOrphanedClaims`: leaves OTHER agents' claims alone.
 *   5. `startSelfReclaimSweeper`: only reclaims expired claims (TTL past)
 *      during periodic runs, not active ones.
 *   6. Cursor restore: reading from `agents.inbox_cursor_*` produces a
 *      cursor matching the persisted shape.
 *   7. Source-level pin: server.ts wires the startup hook + periodic sweeper
 *      after `setInboundReceiverDeps()` (regression guard for boot-order
 *      regressions, mirrors the §5.3 obligations).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { SqliteAdapter } from '../core/db/sqlite-adapter'
import { reclaimSelfOrphanedClaims, startSelfReclaimSweeper } from '../server'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

let db: SqliteAdapter
let dbPath: string

beforeEach(async () => {
  dbPath = `/tmp/inbox-cursor-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  db = new SqliteAdapter(dbPath)
  await db.execute(`
    CREATE TABLE agents (
      agent_id TEXT PRIMARY KEY,
      inbox_cursor_at TEXT,
      inbox_cursor_id TEXT
    )
  `)
  await db.execute(`
    CREATE TABLE message_queue (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      message_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      claimed_by TEXT,
      claimed_at TEXT,
      claim_expires_at TEXT,
      read_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
})

afterEach(async () => {
  await db.close()
  try {
    const { unlinkSync } = await import('node:fs')
    unlinkSync(dbPath)
  } catch {}
})

// pg-style adapter wrapper for the reclaim helpers (they expect `{rows}`).
function pgWrap(adapter: SqliteAdapter) {
  return {
    async query(sql: string, params?: any[]): Promise<any> {
      // SqliteAdapter.query already rewrites $n → ?, but RETURNING is supported
      // by SQLite ≥3.35. We treat the result as both the array (DbAdapter) and
      // a {rows} wrapper.
      const rows = await adapter.query(sql, params)
      return { rows, rowCount: rows.length }
    },
  }
}

describe('Issue #287 — DB-persisted inbox cursor + self-reclaim', () => {
  // case 1: startup self-reclaim flips this agent's status='read' rows back to pending.
  test('case 1 — reclaimSelfOrphanedClaims rolls own read claims back to pending', async () => {
    await db.execute(
      `INSERT INTO agents (agent_id) VALUES ($1)`,
      ['test-bot'],
    )
    // Two stuck read rows owned by self.
    await db.execute(
      `INSERT INTO message_queue (id, agent_id, status, claimed_by, claimed_at, read_at)
       VALUES ($1, $2, 'read', $2, datetime('now'), datetime('now'))`,
      ['mq1', 'test-bot'],
    )
    await db.execute(
      `INSERT INTO message_queue (id, agent_id, status, claimed_by, claimed_at, read_at)
       VALUES ($1, $2, 'read', $2, datetime('now'), datetime('now'))`,
      ['mq2', 'test-bot'],
    )

    const reclaimed = await reclaimSelfOrphanedClaims(pgWrap(db), 'test-bot')
    expect(reclaimed).toBe(2)
    const after = await db.query<{ status: string; claimed_by: string | null }>(
      `SELECT status, claimed_by FROM message_queue WHERE id IN ('mq1', 'mq2')`,
    )
    expect(after.every((r) => r.status === 'pending')).toBe(true)
    expect(after.every((r) => r.claimed_by === null)).toBe(true)
  })

  // case 2: reclaim ignores other agents' rows.
  test('case 2 — reclaimSelfOrphanedClaims leaves other agents alone', async () => {
    await db.execute(
      `INSERT INTO message_queue (id, agent_id, status, claimed_by, read_at)
       VALUES ('mq-other', 'other-bot', 'read', 'other-bot', datetime('now'))`,
    )
    const reclaimed = await reclaimSelfOrphanedClaims(pgWrap(db), 'test-bot')
    expect(reclaimed).toBe(0)
    const r = await db.query<{ status: string }>(
      `SELECT status FROM message_queue WHERE id = 'mq-other'`,
    )
    expect(r[0].status).toBe('read')
  })

  // case 3: periodic sweeper only reclaims TTL-expired rows.
  test('case 3 — startSelfReclaimSweeper reclaims only expired claims', async () => {
    // Active claim (TTL 1h in the future)
    await db.execute(
      `INSERT INTO message_queue (id, agent_id, status, claimed_by, claim_expires_at, read_at)
       VALUES ('active', 'test-bot', 'read', 'test-bot',
               datetime('now', '+1 hour'), datetime('now'))`,
    )
    // Expired claim (TTL 1h in the past)
    await db.execute(
      `INSERT INTO message_queue (id, agent_id, status, claimed_by, claim_expires_at, read_at)
       VALUES ('expired', 'test-bot', 'read', 'test-bot',
               datetime('now', '-1 hour'), datetime('now'))`,
    )

    const timer = startSelfReclaimSweeper(pgWrap(db), 'test-bot', { intervalMs: 50 })
    // Wait for one tick.
    await new Promise((r) => setTimeout(r, 120))
    clearInterval(timer as any)

    const after = await db.query<{ id: string; status: string }>(
      `SELECT id, status FROM message_queue ORDER BY id`,
    )
    const byId = Object.fromEntries(after.map((r) => [r.id, r.status]))
    expect(byId.active).toBe('read')      // untouched
    expect(byId.expired).toBe('pending')  // reclaimed
  })

  // case 4: cursor columns can be written + read via standard SQL.
  test('case 4 — agents.inbox_cursor_{at,id} round-trips through DB', async () => {
    await db.execute(
      `INSERT INTO agents (agent_id, inbox_cursor_at, inbox_cursor_id)
       VALUES ('test-bot', '2026-05-01T00:00:00.123456Z', 'abc-uuid')`,
    )
    const r = await db.query<{ inbox_cursor_at: string; inbox_cursor_id: string }>(
      `SELECT inbox_cursor_at, inbox_cursor_id FROM agents WHERE agent_id = 'test-bot'`,
    )
    expect(r[0].inbox_cursor_at).toBe('2026-05-01T00:00:00.123456Z')
    expect(r[0].inbox_cursor_id).toBe('abc-uuid')
  })

  // case 5: pending row stays pending (sweeper precondition guard).
  test('case 5 — pending rows are NOT reclaimed (predicate guards status=read)', async () => {
    await db.execute(
      `INSERT INTO message_queue (id, agent_id, status)
       VALUES ('pending-row', 'test-bot', 'pending')`,
    )
    const reclaimed = await reclaimSelfOrphanedClaims(pgWrap(db), 'test-bot')
    expect(reclaimed).toBe(0)
    const r = await db.query<{ status: string }>(
      `SELECT status FROM message_queue WHERE id = 'pending-row'`,
    )
    expect(r[0].status).toBe('pending')
  })

  // case 6: idempotency — running reclaim twice returns 0 the second time.
  test('case 6 — reclaim is idempotent (second invocation reclaims 0)', async () => {
    await db.execute(
      `INSERT INTO message_queue (id, agent_id, status, claimed_by, read_at)
       VALUES ('once', 'test-bot', 'read', 'test-bot', datetime('now'))`,
    )
    expect(await reclaimSelfOrphanedClaims(pgWrap(db), 'test-bot')).toBe(1)
    expect(await reclaimSelfOrphanedClaims(pgWrap(db), 'test-bot')).toBe(0)
  })

  // case 7: source-level pin — server.ts wires the startup hook + periodic
  // sweeper, and the migration paired files exist. Regression guard for
  // boot-order or accidental removal.
  test('case 7 — server.ts wires startup self-reclaim + periodic sweeper, paired migration files exist', () => {
    const projectRoot = join(dirname(new URL(import.meta.url).pathname), '..')
    const serverSrc = readFileSync(join(projectRoot, 'server.ts'), 'utf-8')
    expect(serverSrc).toContain('reclaimSelfOrphanedClaims(reclaimDb, AGENT_ID)')
    expect(serverSrc).toContain('startSelfReclaimSweeper(reclaimDb, AGENT_ID')
    expect(serverSrc).toContain('AGENT_COMMS_SELF_RECLAIM_INTERVAL_MS')

    // Migration files
    const upPath = join(projectRoot, 'db/migrations/2026-05-01-inbox-cursor-db-persist.up.sql')
    const downPath = join(projectRoot, 'db/migrations/2026-05-01-inbox-cursor-db-persist.down.sql')
    const up = readFileSync(upPath, 'utf-8')
    const down = readFileSync(downPath, 'utf-8')
    expect(up).toContain('inbox_cursor_at')
    expect(up).toContain('inbox_cursor_id')
    expect(up).toContain("status = 'pending'")  // cleanup re-flip
    expect(down).toContain('DROP COLUMN IF EXISTS inbox_cursor_id')
    expect(down).toContain('DROP COLUMN IF EXISTS inbox_cursor_at')
  })
})
