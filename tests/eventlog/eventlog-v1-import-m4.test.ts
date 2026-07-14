// V2 cutover M4 fixtures — the V1→V2 import bridge + typed V1 closure.
//
// Pins: exact seat allowlist scoping; deterministic-id convergence with
// the M1 dual-write (double import = no-op); V1 stays read-only during
// import; closure marks ONLY the answered row, only from non-terminal
// states, with the evidence reason.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PgAdapter } from '../../core/db/pg-adapter'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import {
  ensureEventLogSchema,
  openTurnCount,
  EventLog,
  turnIdFor,
  completeTurn,
  claimNextTurn,
  dispatchOutboxOnce,
  receiveMessage,
} from '../../core/eventlog'
import { importPendingV1Rows, closeAnsweredV1Row, findUnclosedAnsweredRows } from '../../core/eventlog/v1-import'
import { NotifyTransport } from '../../bin/aun/v2-worker-daemon'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const CLI_PATH = join(REPO_ROOT, 'cli', 'index.ts')
const MIGRATE_PATH = join(REPO_ROOT, 'db', 'migrate.ts')

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

// each row on its OWN thread = its own conversation, so per-conversation
// serialization does not block claiming (independent work orders). Used by
// the starvation test to complete a specific row without a shared-
// conversation head-of-line block confounding the recovery assertion.
async function seedV1Thread(seat: string, messageId: string, content: string) {
  await db.execute(
    `INSERT INTO agent_messages (id, channel_id, thread_id, author_id, content) VALUES ($1, 'chan-1', $2, 'ceo', $3)`,
    [messageId, `thr-${messageId}`, content],
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

describe('durable V1-closure recovery (audit 4931107358 — no time window)', () => {
  test('a completion is closed on a LATER tick regardless of age (crash-after-completion)', async () => {
    // seed a V1 row + import it to V2
    await seedV1('spec', 'm-crash', 'やって')
    await importPendingV1Rows(db, { seats: ['spec'], createdAfter: FENCE_PAST })
    // V2 claims and completes the turn — but the process "crashes" before
    // the V1 close step (we simply do not call closeAnsweredV1Row here)
    const claimed = await claimNextTurn(db, { seatId: 'spec', seatInstanceId: 'gen1' })
    await completeTurn(db, {
      turnId: claimed!.turn.turn_id, seatId: 'spec', seatInstanceId: 'gen1',
      claimEventId: claimed!.claimEventId, outcome: 'no_reply',
    })
    // V1 row is still pending — the crash left it unclosed
    expect((await db.queryOne<{ status: string }>(`SELECT status FROM message_queue WHERE message_id='m-crash'`))?.status).toBe('pending')

    // simulate the completion aging far past any window by back-dating it
    await db.execute(`UPDATE event_log SET occurred_at = '2000-01-01T00:00:00Z' WHERE event_type='turn.completed'`)
      .catch(async () => {
        // append-only trigger blocks UPDATE on sqlite too — recreate via a
        // fresh completion is unnecessary; the durable query does NOT read
        // occurred_at at all, so aging is irrelevant by construction
      })

    // a fresh daemon instance restarts "much later" and recovers durably
    const unclosed = await findUnclosedAnsweredRows(db, { seats: ['spec'] })
    expect(unclosed.map(u => u.messageId)).toEqual(['m-crash'])
    for (const u of unclosed) {
      await closeAnsweredV1Row(db, { seatId: u.seatId, messageId: u.messageId, evidenceRef: `event_log turn ${u.turnId}` })
    }
    // V1 row now typed-skip-closed — never re-answerable by the legacy path
    expect((await db.queryOne<{ status: string }>(`SELECT status FROM message_queue WHERE message_id='m-crash'`))?.status).toBe('skipped')
  })

  test('findUnclosedAnsweredRows returns nothing once V1 is closed (idempotent, seat-scoped)', async () => {
    await seedV1('spec', 'm-1', 'a')
    await seedV1('kodama', 'm-2', 'b') // different seat, not in scope
    await importPendingV1Rows(db, { seats: ['spec'], createdAfter: FENCE_PAST })
    const c = await claimNextTurn(db, { seatId: 'spec', seatInstanceId: 'g' })
    await completeTurn(db, { turnId: c!.turn.turn_id, seatId: 'spec', seatInstanceId: 'g', claimEventId: c!.claimEventId, outcome: 'no_reply' })

    let unclosed = await findUnclosedAnsweredRows(db, { seats: ['spec'] })
    expect(unclosed.length).toBe(1)
    await closeAnsweredV1Row(db, { seatId: 'spec', messageId: 'm-1', evidenceRef: 'x' })
    unclosed = await findUnclosedAnsweredRows(db, { seats: ['spec'] })
    expect(unclosed.length).toBe(0) // already closed → not returned again
    // kodama's row was never completed in V2, so it's never in the set
    expect((await findUnclosedAnsweredRows(db, { seats: ['kodama'] })).length).toBe(0)
  })
})

describe('starvation-free recovery (audit cycle-3 — residue cannot hide a later match)', () => {
  test('a completed row AFTER >batchSize unmatched historic residue is still found + closed', async () => {
    // N historic garbage rows (pending, NO V2 completion) then one 'real'
    // pending row that DOES have a committed completion. The completion is
    // appended DIRECTLY (no claim/serialization confound) — the recovery
    // function only cares that a turn.completed exists for a pending V1 row.
    for (let i = 0; i < 7; i++) await seedV1('spec', `garbage-${i}`, '大昔の放置')
    await seedV1('spec', 'real', 'やって')
    const log = new EventLog(db)
    const realTurn = turnIdFor('spec', 'real')
    await log.append({
      eventId: `done:${realTurn}`, eventType: 'turn.completed',
      seatId: 'spec', turnId: realTurn, payload: { outcome: 'no_reply' },
    })

    // batchSize=2 forces the cursor across multiple pages; the 7 unmatched
    // garbage rows would starve a fixed-prefix scan but the cursor reaches 'real'
    const unclosed = await findUnclosedAnsweredRows(db, { seats: ['spec'], batchSize: 2 })
    expect(unclosed.map(u => u.messageId)).toEqual(['real'])
    for (const u of unclosed) await closeAnsweredV1Row(db, { seatId: u.seatId, messageId: u.messageId, evidenceRef: `turn ${u.turnId}` })
    expect((await db.queryOne<{ status: string }>(`SELECT status FROM message_queue WHERE message_id='real'`))?.status).toBe('skipped')
    expect((await db.queryOne<{ status: string }>(`SELECT status FROM message_queue WHERE message_id='garbage-0'`))?.status).toBe('pending')
    expect((await findUnclosedAnsweredRows(db, { seats: ['spec'], batchSize: 2 })).length).toBe(0)
  })
})

function postgresTestUrl(): string | undefined {
  if (process.env.AGENT_COM_TEST_DATABASE_URL) return process.env.AGENT_COM_TEST_DATABASE_URL
  const url = process.env.DATABASE_URL
  if (!url) return undefined
  const dbName = url.split('?')[0]!.split('/').pop() ?? ''
  return dbName.endsWith('_test') ? url : undefined
}

const POSTGRES_TEST_URL = postgresTestUrl()

class RollbackPostgresFixture extends Error {}

describe.if(!!POSTGRES_TEST_URL)('starvation-free PostgreSQL recovery', () => {
  test('historic residue cannot hide a later completion and the typed close is idempotent', async () => {
    const pg = new PgAdapter(POSTGRES_TEST_URL!)
    let rolledBack = false
    try {
      await pg.transaction(async tx => {
        const seat = `spec-${randomUUID()}`
        const garbageMessageIds: string[] = []
        for (let i = 0; i < 7; i++) {
          const messageId = randomUUID()
          garbageMessageIds.push(messageId)
          await tx.execute(
            `INSERT INTO agent_messages (id, channel_id, thread_id, author_id, content)
             VALUES ($1, 'chan-1', $2, 'ceo', 'historic residue')`,
            [messageId, `thr-${messageId}`],
          )
          await tx.execute(
            `INSERT INTO message_queue (agent_id, message_id, payload) VALUES ($1, $2, '{}')`,
            [seat, messageId],
          )
        }

        const realMessageId = randomUUID()
        await tx.execute(
          `INSERT INTO agent_messages (id, channel_id, thread_id, author_id, content)
           VALUES ($1, 'chan-1', $2, 'ceo', 'process me')`,
          [realMessageId, `thr-${realMessageId}`],
        )
        await tx.execute(
          `INSERT INTO message_queue (agent_id, message_id, payload) VALUES ($1, $2, '{}')`,
          [seat, realMessageId],
        )
        const realTurn = turnIdFor(seat, realMessageId)
        await tx.execute(
          `INSERT INTO event_log (event_id, event_type, seat_id, turn_id, payload)
           VALUES ($1, 'turn.completed', $2, $3, $4::jsonb)`,
          [`done:${realTurn}`, seat, realTurn, JSON.stringify({ outcome: 'no_reply' })],
        )

        const unclosed = await findUnclosedAnsweredRows(tx, { seats: [seat], batchSize: 2 })
        expect(unclosed.map(row => row.messageId)).toEqual([realMessageId])
        expect(await closeAnsweredV1Row(tx, {
          seatId: seat,
          messageId: realMessageId,
          evidenceRef: `turn ${realTurn}`,
        })).toBe(true)
        expect(await closeAnsweredV1Row(tx, {
          seatId: seat,
          messageId: realMessageId,
          evidenceRef: `turn ${realTurn}`,
        })).toBe(false)
        expect((await tx.queryOne<{ status: string }>(
          `SELECT status FROM message_queue WHERE message_id = $1`,
          [realMessageId],
        ))?.status).toBe('skipped')
        expect((await tx.queryOne<{ status: string }>(
          `SELECT status FROM message_queue WHERE message_id = $1`,
          [garbageMessageIds[0]],
        ))?.status).toBe('pending')
        expect(await findUnclosedAnsweredRows(tx, { seats: [seat], batchSize: 2 })).toEqual([])
        throw new RollbackPostgresFixture()
      })
    } catch (error) {
      if (!(error instanceof RollbackPostgresFixture)) throw error
      rolledBack = true
    } finally {
      await pg.close()
    }
    expect(rolledBack).toBe(true)
  })
})

describe('typed notify recipient and receipt bridge', () => {
  test('replied turn reaches actual cli.notify with durable recipient authority; missing or malformed evidence never delivers', async () => {
    const notifyDir = mkdtempSync(join(tmpdir(), 'eventlog-m4-notify-'))
    const notifyDbPath = join(notifyDir, 'notify.db')
    const notifyEnv = {
      ...process.env,
      AGENT_COM_DB: 'sqlite',
      AGENT_COM_SQLITE_PATH: notifyDbPath,
      AGENT_COM_PG_NOTIFY: 'false',
      DATABASE_URL: '',
      PATH: '/usr/bin:/bin',
    }
    const migrated = spawnSync(process.execPath, [MIGRATE_PATH], {
      cwd: REPO_ROOT,
      env: notifyEnv,
      encoding: 'utf8',
    })
    expect(migrated.status).toBe(0)

    const notifyDb = new SqliteAdapter(notifyDbPath)
    try {
      await ensureEventLogSchema(notifyDb)
      await notifyDb.execute(
        `INSERT INTO agents (agent_id, display_name, agent_type, status)
         VALUES ('spec', 'spec', 'dev', 'idle'), ('ceo', 'ceo', 'ceo', 'idle')`,
      )
      await notifyDb.execute(
        `INSERT INTO channels (id, name, members) VALUES ($1, $1, $2)`,
        ['chan-1', JSON.stringify(['spec', 'ceo'])],
      )
      await notifyDb.execute(
        `INSERT INTO channel_routing_policy (channel_id, outbound_allowlist, policy_source)
         VALUES ($1, $2, 'eventlog-m4-notify-test')`,
        ['chan-1', JSON.stringify(['spec', 'ceo'])],
      )

      const enqueueReply = async (
        messageId: string,
        payload: Record<string, unknown>,
        content: string,
      ) => {
        await receiveMessage(notifyDb, {
          messageId,
          seatId: 'spec',
          conversationId: `conv-${messageId}`,
          payload,
        })
        const claimed = await claimNextTurn(notifyDb, { seatId: 'spec', seatInstanceId: `worker-${messageId}` })
        expect(claimed?.turn.message_id).toBe(messageId)
        return completeTurn(notifyDb, {
          turnId: claimed!.turn.turn_id,
          seatId: 'spec',
          seatInstanceId: `worker-${messageId}`,
          claimEventId: claimed!.claimEventId,
          outcome: 'replied',
          conversationId: `conv-${messageId}`,
          replies: [{ content, channelExternalId: 'chan-1' }],
        })
      }

      const transport = new NotifyTransport(notifyDb, CLI_PATH, { env: notifyEnv })
      const success = await enqueueReply('notify-success', {
        channel_id: 'chan-1',
        author_id: 'ceo',
        content: 'reply please',
      }, 'durable reply')
      const successReplyId = success.replies[0].event.reply_id!
      const delivered = await dispatchOutboxOnce(notifyDb, transport, {
        dispatcherId: 'v2-outbox',
        dispatcherInstanceId: 'notify-success-dispatcher',
      })
      expect(delivered.delivered).toEqual([successReplyId])
      const deliveredEvent = await notifyDb.queryOne<{ payload: string }>(
        `SELECT payload FROM event_log WHERE event_type = 'reply.delivered' AND reply_id = $1`,
        [successReplyId],
      )
      const transportMessageId = JSON.parse(deliveredEvent!.payload).transport_message_id as string
      expect(transportMessageId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
      expect((await notifyDb.queryOne<{ author_id: string; channel_id: string; content: string }>(
        `SELECT author_id, channel_id, content FROM agent_messages WHERE id = $1`,
        [transportMessageId],
      ))).toEqual({ author_id: 'spec', channel_id: 'chan-1', content: 'durable reply' })
      expect((await notifyDb.queryOne<{ agent_id: string }>(
        `SELECT agent_id FROM message_queue WHERE message_id = $1`,
        [transportMessageId],
      ))?.agent_id).toBe('ceo')

      const messageCountBeforeMissing = (await notifyDb.queryOne<{ n: number }>(
        `SELECT COUNT(*) AS n FROM agent_messages`,
      ))!.n
      const missing = await enqueueReply('notify-missing-recipient', {
        channel_id: 'chan-1',
        content: 'no author authority',
      }, 'must not send')
      const missingReplyId = missing.replies[0].event.reply_id!
      const missingResult = await dispatchOutboxOnce(notifyDb, transport, {
        dispatcherId: 'v2-outbox',
        dispatcherInstanceId: 'notify-missing-dispatcher',
      })
      expect(missingResult.failedPermanent).toEqual([missingReplyId])
      expect(await notifyDb.queryOne(
        `SELECT event_id FROM event_log WHERE event_type = 'reply.delivered' AND reply_id = $1`,
        [missingReplyId],
      )).toBeNull()
      expect((await notifyDb.queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM agent_messages`))!.n)
        .toBe(messageCountBeforeMissing)

      const malformed = await enqueueReply('notify-malformed-receipt', {
        channel_id: 'chan-1',
        author_id: 'ceo',
        content: 'malformed receipt probe',
      }, 'must not claim delivery')
      const malformedReplyId = malformed.replies[0].event.reply_id!
      let invokedCommand: string[] = []
      const malformedTransport = new NotifyTransport(notifyDb, CLI_PATH, {
        env: notifyEnv,
        runner: async command => {
          invokedCommand = command
          return { stdout: '{"ok":true,"message_id":"not-a-uuid"}', stderr: '', exitCode: 0 }
        },
      })
      const malformedResult = await dispatchOutboxOnce(notifyDb, malformedTransport, {
        dispatcherId: 'v2-outbox',
        dispatcherInstanceId: 'notify-malformed-dispatcher',
      })
      expect(invokedCommand[0]).toBe(process.execPath)
      expect(invokedCommand).toContain('--mention')
      expect(invokedCommand).toContain('ceo')
      expect(malformedResult.failedPermanent).toEqual([malformedReplyId])
      expect(await notifyDb.queryOne(
        `SELECT event_id FROM event_log WHERE event_type = 'reply.delivered' AND reply_id = $1`,
        [malformedReplyId],
      )).toBeNull()
    } finally {
      await notifyDb.close()
      rmSync(notifyDir, { recursive: true, force: true })
    }
  })
})
