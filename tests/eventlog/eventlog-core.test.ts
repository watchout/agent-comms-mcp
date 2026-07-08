// EventLogCore/v1 — log invariants fixture.
// Proves: append-only enforcement, event_id idempotency (zero
// double-processing at the storage layer), atomic batch append, and
// rebuild-by-replay equivalence (state is a pure function of the log).

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import {
  EventLog,
  ensureEventLogSchema,
  queueView,
  outboxView,
  receiveMessage,
  claimNextTurn,
  completeTurn,
} from '../../core/eventlog'

let dir: string
let db: SqliteAdapter

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'eventlog-core-'))
  db = new SqliteAdapter(join(dir, 'log.db'))
  await ensureEventLogSchema(db)
})

afterEach(async () => {
  await db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('append-only invariant', () => {
  test('UPDATE on event_log is rejected by the storage layer', async () => {
    const log = new EventLog(db)
    await log.append({ eventId: 'e1', eventType: 'message.received', turnId: 't1' })
    expect(db.execute(`UPDATE event_log SET payload = '{"tampered":true}' WHERE event_id = 'e1'`))
      .rejects.toThrow(/append-only/)
  })

  test('DELETE on event_log is rejected by the storage layer', async () => {
    const log = new EventLog(db)
    await log.append({ eventId: 'e1', eventType: 'message.received', turnId: 't1' })
    expect(db.execute(`DELETE FROM event_log WHERE event_id = 'e1'`))
      .rejects.toThrow(/append-only/)
  })
})

describe('event_id idempotency', () => {
  test('appending the same event twice stores exactly one row', async () => {
    const log = new EventLog(db)
    const first = await log.append({
      eventId: 'dup-1',
      eventType: 'message.received',
      turnId: 't1',
      payload: { message_id: 'm1' },
    })
    const second = await log.append({
      eventId: 'dup-1',
      eventType: 'message.received',
      turnId: 't1',
      payload: { message_id: 'm1' },
    })
    expect(first.inserted).toBe(true)
    expect(second.inserted).toBe(false)
    expect(second.event.seq).toBe(first.event.seq)
    expect(await log.count()).toBe(1)
  })

  test('redelivered inbound message does not open a second turn', async () => {
    await receiveMessage(db, { messageId: 'm1', seatId: 'kodama' })
    await receiveMessage(db, { messageId: 'm1', seatId: 'kodama' })
    const rows = await queueView(db)
    expect(rows.length).toBe(1)
  })
})

describe('atomic batch append', () => {
  test('a failing event in a batch rolls back the whole batch', async () => {
    const log = new EventLog(db)
    await log.append({ eventId: 'c0', eventType: 'turn.claimed', turnId: 'tx', claimEpoch: 0 })
    const before = await log.count()
    // second row conflicts on the claim arbiter (same turn, same epoch,
    // different event_id) → whole batch must roll back
    expect(
      log.appendBatch([
        { eventId: 'b1', eventType: 'message.received', turnId: 'tb' },
        { eventId: 'c1', eventType: 'turn.claimed', turnId: 'tx', claimEpoch: 0 },
      ]),
    ).rejects.toThrow()
    expect(await log.count()).toBe(before)
    expect(await log.getByEventId('b1')).toBeNull()
  })
})

describe('rebuild by replay', () => {
  test('copying the log to a fresh DB reproduces identical views', async () => {
    // build some real state: 3 messages, claim + complete one with a reply
    for (const m of ['m1', 'm2', 'm3']) {
      await receiveMessage(db, { messageId: m, seatId: 'kodama', conversationId: 'conv-1' })
    }
    const claimed = await claimNextTurn(db, { seatId: 'kodama', seatInstanceId: 'i1' })
    expect(claimed).not.toBeNull()
    await completeTurn(db, {
      turnId: claimed!.turn.turn_id,
      seatId: 'kodama',
      seatInstanceId: 'i1',
      claimEventId: claimed!.claimEventId,
      outcome: 'replied',
      conversationId: 'conv-1',
      replies: [{ content: 'hello', channelExternalId: 'chan-9' }],
    })

    // "rebuild": replay every log row into a brand-new database
    const rebuilt = new SqliteAdapter(join(dir, 'rebuilt.db'))
    await ensureEventLogSchema(rebuilt)
    const events = await db.query('SELECT * FROM event_log ORDER BY seq ASC')
    for (const e of events) {
      await rebuilt.execute(
        `INSERT INTO event_log (seq, event_id, event_type, occurred_at, seat_id,
           seat_instance_id, conversation_id, causation_id, correlation_id,
           turn_id, reply_id, claim_epoch, payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [e.seq, e.event_id, e.event_type, e.occurred_at, e.seat_id,
         e.seat_instance_id, e.conversation_id, e.causation_id, e.correlation_id,
         e.turn_id, e.reply_id, e.claim_epoch, e.payload],
      )
    }

    expect(await queueView(rebuilt)).toEqual(await queueView(db))
    expect(await outboxView(rebuilt)).toEqual(await outboxView(db))
    await rebuilt.close()
  })
})
