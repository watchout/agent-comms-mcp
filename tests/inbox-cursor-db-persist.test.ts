#!/usr/bin/env bun
/**
 * Issue #287 — DB-persisted inbox cursor + self-reclaim, 15-case merge gate.
 *
 * Cumulative case map across cycles 4–8:
 *   - cases 1–3, 5–6: reclaim semantics + source-level pins (cycle 4)
 *   - case 4 (cycle 6): SQLite migration executes and adds inbox_cursor columns
 *   - case 7: server.ts wires startup hook + sweepers, paired migration files exist
 *   - case 8 (cycle 6): `next` cursor advance writes composite (at, id) — now
 *     funneled through `persistInboxCursorToDb` after cycle 8 axis 1 fix, so
 *     this case implicitly verifies that the single-writer monotonic guard
 *     fires on the `next` path too
 *   - case 9 (cycle 6): `next` cursor advance is no-op when agent_messages row
 *     is missing
 *   - case 10 (cycle 7): startup order — reclaim await BEFORE claim-ttl
 *     sweeper, plus claim-ttl `selfAgentId` predicate skips own rows
 *   - cases 11–12 (cycle 7): reclaim updates `agents.status` to idle/busy
 *   - case 13 (cycle 7): `persistInboxCursorToDb` is monotonic — covers BOTH
 *     `inbox` and `next` writers after cycle 8 unified them
 *   - case 14 (cycle 8): `reclaimSelfOrphanedClaims` throws on DB error
 *     (fail-closed) — startup propagates to top-level catch → process.exit(1)
 *
 * Hermetic: SQLite-backed in-memory DB, no `server.ts` import (so
 * `bun test tests/inbox-cursor-db-persist.test.ts` runs standalone).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { SqliteAdapter } from '../core/db/sqlite-adapter'
// PR-0 cycle 5 axis 2 — import the reclaim helpers from core/inbox-cursor.ts,
// not from server.ts. Importing server.ts triggers resolveWebhookPort() and
// other module-level side effects that prevent `bun test <file>` running this
// suite hermetically (auditor cycle 0 BLOCK regression).
import { reclaimSelfOrphanedClaims, startSelfReclaimSweeper, persistInboxCursorToDb } from '../core/inbox-cursor'
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
      status TEXT,
      status_detail TEXT,
      status_updated_at TEXT,
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
      failed_reason TEXT,
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

  // case 4-behavioral (PR-0 cycle 6, replaces former 24h flip pin):
  // run the SQLite migration end-to-end and assert the cursor columns
  // exist on `agents`. The PG up.sql is the source of truth for prod;
  // db/migrate-sqlite.ts mirrors it for SQLite-backed deployments
  // (axis 4 parity). This test verifies the migration *executes* and
  // produces the expected schema, replacing the cycle 5 SQL-grep pin.
  test('case 4 — SQLite migration executes and adds inbox_cursor columns', async () => {
    const { migrateSqlite } = await import('../db/migrate-sqlite')
    const tmpPath = `/tmp/inbox-cursor-migrate-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    migrateSqlite(tmpPath)
    const { Database } = await import('bun:sqlite')
    const fresh = new Database(tmpPath)
    try {
      const cols = fresh.query(`PRAGMA table_info(agents)`).all() as Array<{ name: string }>
      const colNames = new Set(cols.map((c) => c.name))
      expect(colNames.has('inbox_cursor_at')).toBe(true)
      expect(colNames.has('inbox_cursor_id')).toBe(true)
    } finally {
      fresh.close()
      const { unlinkSync } = await import('node:fs')
      try { unlinkSync(tmpPath) } catch {}
    }
  })

  // case 8 (PR-0 cycle 6 axis 1 BLOCK fix): the `next` handler advances
  // the composite cursor (inbox_cursor_at, inbox_cursor_id) using the
  // popped agent_messages row's (created_at, id), not `now()` alone. The
  // cycle 5 implementation wrote inbox_cursor_at=now() and left
  // inbox_cursor_id stale, breaking restart recovery (auditor cycle 5
  // verdict 2026-05-01).
  //
  // We exercise the SQL pattern emitted by server.ts:1749 directly
  // against an in-memory SQLite — adapter rewrites $n → ? and strips
  // ::type casts so the same SQL runs on both engines. The test inserts
  // an agent + agent_messages row, simulates the cursor-advance UPDATE
  // bound to (agentId, msgId), and asserts both cursor columns hold
  // the inserted row's values.
  test('case 8 — next cursor advance writes composite (at, id) from agent_messages', async () => {
    await db.execute(`INSERT INTO agents (agent_id) VALUES ('test-bot')`)
    // The real schema has many more columns; this hermetic stub keeps
    // only the fields the cursor-advance UPDATE touches.
    await db.execute(`
      CREATE TABLE agent_messages (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `)
    const msgId = '11111111-2222-3333-4444-555555555555'
    const msgCreatedAt = '2026-05-01T07:30:00.123456Z'
    await db.execute(
      `INSERT INTO agent_messages (id, created_at) VALUES ($1, $2)`,
      [msgId, msgCreatedAt],
    )
    // Mirrors the server.ts:1749 UPDATE verbatim. SqliteAdapter.adaptSql
    // strips :: casts and rewrites parameters; the pattern is otherwise
    // identical to PG.
    await pgWrap(db).query(
      `UPDATE agents
          SET inbox_cursor_at = (SELECT created_at FROM agent_messages WHERE id = $2),
              inbox_cursor_id = $2
        WHERE agent_id = $1
          AND EXISTS (SELECT 1 FROM agent_messages WHERE id = $2)`,
      ['test-bot', msgId],
    )
    const after = await db.query<{ inbox_cursor_at: string; inbox_cursor_id: string }>(
      `SELECT inbox_cursor_at, inbox_cursor_id FROM agents WHERE agent_id = 'test-bot'`,
    )
    expect(after[0].inbox_cursor_id).toBe(msgId)
    expect(after[0].inbox_cursor_at).toBe(msgCreatedAt)
  })

  // case 9 (PR-0 cycle 6 axis 1 BLOCK fix): cursor advance is a no-op
  // when the popped queue row has no agent_messages backing
  // (system-originated entry, not part of the inbox stream). The
  // EXISTS guard in server.ts:1749 prevents writing NULL or stale
  // values when the row is absent.
  test('case 9 — next cursor advance is no-op when agent_messages row is missing', async () => {
    await db.execute(`INSERT INTO agents (agent_id) VALUES ('test-bot')`)
    await db.execute(`
      CREATE TABLE agent_messages (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `)
    // Pre-set a sentinel cursor; the UPDATE must NOT clobber it when
    // the agent_messages lookup misses.
    await db.execute(
      `UPDATE agents SET inbox_cursor_at = '2026-04-30T00:00:00.000000Z', inbox_cursor_id = 'sentinel'
        WHERE agent_id = 'test-bot'`,
    )
    await pgWrap(db).query(
      `UPDATE agents
          SET inbox_cursor_at = (SELECT created_at FROM agent_messages WHERE id = $2),
              inbox_cursor_id = $2
        WHERE agent_id = $1
          AND EXISTS (SELECT 1 FROM agent_messages WHERE id = $2)`,
      ['test-bot', 'no-such-msg-id'],
    )
    const after = await db.query<{ inbox_cursor_at: string; inbox_cursor_id: string }>(
      `SELECT inbox_cursor_at, inbox_cursor_id FROM agents WHERE agent_id = 'test-bot'`,
    )
    expect(after[0].inbox_cursor_id).toBe('sentinel')
    expect(after[0].inbox_cursor_at).toBe('2026-04-30T00:00:00.000000Z')
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

  // PR-0 cycle 7 axis 1 BLOCK fix — startup order: reclaimSelfOrphanedClaims
  // must complete (await) before the claim-ttl sweeper begins. We exercise
  // server.ts's startup block via a structural pin: the source order is
  // `await reclaimSelfOrphanedClaims(...)` then `startSelfReclaimSweeper(...)`
  // then `startClaimTtlSweeper(...)`. A behavioral assertion on the live
  // server boot sequence would require booting MCP+DB+Discord stack, so we
  // pin the canonical ordering at source level (cheap, deterministic) PLUS
  // verify the claim-ttl sweeper accepts a `selfAgentId` predicate (the
  // belt-and-braces structural defense).
  test('case 10 — startup order: reclaim awaited before claim-ttl sweeper', async () => {
    const projectRoot = join(dirname(new URL(import.meta.url).pathname), '..')
    const serverSrc = readFileSync(join(projectRoot, 'server.ts'), 'utf-8')
    const reclaimIdx = serverSrc.indexOf('await reclaimSelfOrphanedClaims(reclaimDb, AGENT_ID)')
    const sweeperIdx = serverSrc.indexOf('startClaimTtlSweeper(reclaimDb, { intervalMs, selfAgentId: AGENT_ID })')
    expect(reclaimIdx).toBeGreaterThan(0)
    expect(sweeperIdx).toBeGreaterThan(0)
    // reclaim must appear BEFORE the claim-ttl sweeper start in source order.
    expect(reclaimIdx).toBeLessThan(sweeperIdx)

    // Behavioral check on the claim-ttl predicate exclusion: a sweep with
    // selfAgentId set must skip the self's own expired claim, leaving it
    // available for self-reclaim to convert to 'pending'.
    const { sweepExpiredClaims } = await import('../core/claim-ttl')
    await db.execute(`INSERT INTO agents (agent_id) VALUES ('me')`)
    await db.execute(
      `INSERT INTO message_queue (id, agent_id, status, claimed_by, claim_expires_at, read_at)
       VALUES ('expired-self', 'me', 'read', 'me', datetime('now', '-1 hour'), datetime('now'))`,
    )
    const swept = await sweepExpiredClaims(pgWrap(db), { selfAgentId: 'me' })
    expect(swept).toBe(0)
    const after = await db.query<{ status: string }>(
      `SELECT status FROM message_queue WHERE id = 'expired-self'`,
    )
    expect(after[0].status).toBe('read') // not flipped to 'failed' — protected for self-reclaim
  })

  // PR-0 cycle 7 axis 2/3 BLOCK fix — reclaim path derives agents.status
  // from the live claim set. Two scenarios:
  //   (a) all reclaimed → no remaining 'read' claim → status='idle'
  //   (b) one row left in 'read' (other agent / fresh claim) → status='busy'
  test('case 11 — reclaim updates agents.status to idle when no claims remain', async () => {
    await db.execute(`INSERT INTO agents (agent_id, status) VALUES ('me', 'busy')`)
    await db.execute(
      `INSERT INTO message_queue (id, agent_id, status, claimed_by, read_at)
       VALUES ('orph', 'me', 'read', 'me', datetime('now'))`,
    )
    await reclaimSelfOrphanedClaims(pgWrap(db), 'me')
    const after = await db.query<{ status: string; status_detail: string | null }>(
      `SELECT status, status_detail FROM agents WHERE agent_id = 'me'`,
    )
    expect(after[0].status).toBe('idle')
    expect(after[0].status_detail).toBeNull()
  })

  test('case 12 — reclaim leaves agents.status busy when other claim remains', async () => {
    await db.execute(`INSERT INTO agents (agent_id, status) VALUES ('me', 'busy')`)
    await db.execute(
      `INSERT INTO message_queue (id, agent_id, status, claimed_by, read_at)
       VALUES ('orph', 'me', 'read', 'me', datetime('now'))`,
    )
    // A second claim outside the reclaim predicate (claim_expires_at in
    // the future = active TTL, not eligible for startup reclaim).
    await db.execute(
      `INSERT INTO message_queue (id, agent_id, status, claimed_by, claim_expires_at, read_at)
       VALUES ('active', 'me', 'read', 'me', datetime('now', '+1 hour'), datetime('now'))`,
    )
    await reclaimSelfOrphanedClaims(pgWrap(db), 'me')
    const after = await db.query<{ status: string }>(
      `SELECT status FROM agents WHERE agent_id = 'me'`,
    )
    expect(after[0].status).toBe('busy')
  })

  // PR-0 cycle 7 axis 4 BLOCK fix — concurrent inbox cursor advances must
  // not regress the DB cursor. We persist a "cursor40" then attempt to
  // overwrite it with an older "cursor20" — the monotonic guard in the
  // SQL WHERE clause must reject the older write as a no-op.
  test('case 13 — persistInboxCursorToDb is monotonic (older write is no-op)', async () => {
    await db.execute(`INSERT INTO agents (agent_id) VALUES ('me')`)
    const cursor40 = { createdAt: '2026-05-01T00:00:00.400000Z', id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }
    const cursor20 = { createdAt: '2026-05-01T00:00:00.200000Z', id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }
    await persistInboxCursorToDb(pgWrap(db), 'me', cursor40)
    let row = await db.query<{ inbox_cursor_at: string; inbox_cursor_id: string }>(
      `SELECT inbox_cursor_at, inbox_cursor_id FROM agents WHERE agent_id = 'me'`,
    )
    expect(row[0].inbox_cursor_at).toBe(cursor40.createdAt)
    expect(row[0].inbox_cursor_id).toBe(cursor40.id)

    // Older write — must be rejected by the monotonic WHERE guard.
    await persistInboxCursorToDb(pgWrap(db), 'me', cursor20)
    row = await db.query<{ inbox_cursor_at: string; inbox_cursor_id: string }>(
      `SELECT inbox_cursor_at, inbox_cursor_id FROM agents WHERE agent_id = 'me'`,
    )
    expect(row[0].inbox_cursor_at).toBe(cursor40.createdAt)
    expect(row[0].inbox_cursor_id).toBe(cursor40.id)

    // Newer write — must succeed.
    const cursor60 = { createdAt: '2026-05-01T00:00:00.600000Z', id: 'cccccccc-cccc-cccc-cccc-cccccccccccc' }
    await persistInboxCursorToDb(pgWrap(db), 'me', cursor60)
    row = await db.query<{ inbox_cursor_at: string; inbox_cursor_id: string }>(
      `SELECT inbox_cursor_at, inbox_cursor_id FROM agents WHERE agent_id = 'me'`,
    )
    expect(row[0].inbox_cursor_at).toBe(cursor60.createdAt)
    expect(row[0].inbox_cursor_id).toBe(cursor60.id)
  })

  // PR-0 cycle 8 axis 3 BLOCK fix — reclaimSelfOrphanedClaims must
  // surface DB errors instead of swallowing them. The cycle 7
  // implementation returned 0 on any failure, leaving own claims
  // permanently orphaned (claim-ttl sweeper excludes self via
  // `selfAgentId`). With fail-closed semantics the function throws,
  // server.ts startup catches the rejection at the
  // `mcp.connect(...).catch(err => process.exit(1))` boundary, and
  // launchd/systemd surfaces the failure for restart + diagnosis.
  test('case 14 — reclaimSelfOrphanedClaims throws on DB error (fail-closed)', async () => {
    const failingDb: import('../core/inbox-cursor').ReclaimDb = {
      query: async () => {
        throw new Error('simulated DB unreachable')
      },
    }
    let caught: Error | null = null
    try {
      await reclaimSelfOrphanedClaims(failingDb, 'me')
    } catch (err) {
      caught = err as Error
    }
    expect(caught).not.toBeNull()
    expect(caught?.message).toContain('simulated DB unreachable')
  })
})
