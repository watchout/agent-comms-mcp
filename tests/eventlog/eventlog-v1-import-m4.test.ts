// V2 cutover M4 fixtures — the V1→V2 import bridge + typed V1 closure.
//
// Pins: exact seat allowlist scoping; deterministic-id convergence with
// the M1 dual-write (double import = no-op); V1 stays read-only during
// import; closure marks ONLY the answered row, only from non-terminal
// states, with the evidence reason.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import { ensureEventLogSchema, openTurnCount } from '../../core/eventlog'
import { importPendingV1Rows, closeAnsweredV1Row } from '../../core/eventlog/v1-import'

// fence older than every seeded row → rows qualify; the garbage-barrier
// suite below uses a FUTURE fence to prove exclusion
const FENCE_PAST = '2000-01-01T00:00:00Z'

let dir: string
let db: SqliteAdapter

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'eventlog-m4-'))
  db = new SqliteAdapter(join(dir, 'm4.db'))
  await ensureEventLogSchema(db)
  // minimal V1 shape the importer touches
  await db.execute(`CREATE TABLE agent_messages (
    id TEXT PRIMARY KEY, channel_id TEXT, thread_id TEXT, author_id TEXT, content TEXT
  )`)
  await db.execute(`CREATE TABLE message_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, message_id TEXT,
    status TEXT DEFAULT 'pending', failed_reason TEXT, done_at TEXT,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`)
})

afterEach(async () => {
  await db.close()
  rmSync(dir, { recursive: true, force: true })
})

async function seedV1(seat: string, messageId: string, content: string) {
  await db.execute(
    `INSERT INTO agent_messages (id, channel_id, author_id, content) VALUES ($1, 'chan-1', 'ceo', $2)`,
    [messageId, content],
  )
  await db.execute(
    `INSERT INTO message_queue (agent_id, message_id) VALUES ($1, $2)`,
    [seat, messageId],
  )
}

describe('V1→V2 import bridge', () => {
  test('imports pending rows for allowlisted seats only, read-only on V1', async () => {
    await seedV1('spec', 'm-1', 'やって')
    await seedV1('kodama', 'm-2', 'こっちも')
    await seedV1('outsider', 'm-3', '対象外')

    const imported = await importPendingV1Rows(db, { seats: ['spec', 'kodama'], createdAfter: FENCE_PAST })
    expect(imported.map(i => i.seatId).sort()).toEqual(['kodama', 'spec'])
    expect(await openTurnCount(db)).toBe(2)

    // V1 untouched: all three rows still pending
    const v1 = await db.query<{ status: string }>(`SELECT status FROM message_queue`)
    expect(v1.every(r => r.status === 'pending')).toBe(true)
  })

  test('re-import is a no-op (deterministic ids = dual-write convergence)', async () => {
    await seedV1('spec', 'm-1', 'やって')
    const first = await importPendingV1Rows(db, { seats: ['spec'], createdAfter: FENCE_PAST })
    const second = await importPendingV1Rows(db, { seats: ['spec'], createdAfter: FENCE_PAST })
    expect(first.length).toBe(1)
    expect(second.length).toBe(0) // inserted=false → not reported, nothing appended
    expect(await openTurnCount(db)).toBe(1)
    const events = await db.query(`SELECT * FROM event_log WHERE event_type = 'message.received'`)
    expect(events.length).toBe(1)
  })
})

describe('typed V1 closure after V2 answers', () => {
  test('closes exactly the answered pending row with the evidence reason', async () => {
    await seedV1('spec', 'm-1', 'やって')
    await seedV1('spec', 'm-2', '別件')
    const closed = await closeAnsweredV1Row(db, {
      seatId: 'spec', messageId: 'm-1', evidenceRef: 'event_log turn turn:spec:m-1',
    })
    expect(closed).toBe(true)
    const rows = await db.query<{ message_id: string; status: string; failed_reason: string | null }>(
      `SELECT message_id, status, failed_reason FROM message_queue ORDER BY id`,
    )
    expect(rows[0].status).toBe('skipped')
    expect(rows[0].failed_reason).toContain('event_log turn turn:spec:m-1')
    expect(rows[1].status).toBe('pending') // untouched
  })

  test('closure is a no-op on already-terminal rows (idempotent re-scan)', async () => {
    await seedV1('spec', 'm-1', 'やって')
    await closeAnsweredV1Row(db, { seatId: 'spec', messageId: 'm-1', evidenceRef: 'x' })
    const again = await closeAnsweredV1Row(db, { seatId: 'spec', messageId: 'm-1', evidenceRef: 'y' })
    expect(again).toBe(false)
    const row = await db.queryOne<{ failed_reason: string }>(
      `SELECT failed_reason FROM message_queue WHERE message_id = 'm-1'`,
    )
    expect(row?.failed_reason).toContain('(x)') // first reason preserved
  })
})

describe('garbage barrier (owner directive: V1 residue never crosses)', () => {
  test('rows older than the fence are NOT imported — they stay V1-only', async () => {
    await seedV1('spec', 'm-old', '大昔の放置指示')
    // fence in the future of the seeded row = row is "historic garbage"
    const imported = await importPendingV1Rows(db, {
      seats: ['spec'],
      createdAfter: new Date(Date.now() + 60_000).toISOString(),
    })
    expect(imported.length).toBe(0)
    expect(await openTurnCount(db)).toBe(0) // V2 log untouched
    const v1 = await db.queryOne<{ status: string }>(`SELECT status FROM message_queue WHERE message_id = 'm-old'`)
    expect(v1?.status).toBe('pending') // stays in V1 for typed disposition
  })

  test('the fence is mandatory — a missing/invalid fence throws, never imports everything', async () => {
    await seedV1('spec', 'm-1', 'x')
    expect(importPendingV1Rows(db, { seats: ['spec'], createdAfter: '' })).rejects.toThrow(/fence is mandatory/)
    expect(importPendingV1Rows(db, { seats: ['spec'], createdAfter: 'not-a-date' })).rejects.toThrow(/fence is mandatory/)
    expect(await openTurnCount(db)).toBe(0)
  })
})
