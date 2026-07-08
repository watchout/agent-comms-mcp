// EventLogCore/v1 — turn lifecycle fixture.
// Proves: pull-claim (conditional insert wins, losers back off), zero
// double-processing, per-conversation serialization, claim fencing, and
// timer-free stall detection (stuck = a query over unfinished work).

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import {
  EventLog,
  ClaimLostError,
  StaleClaimError,
  ensureEventLogSchema,
  receiveMessage,
  claimNextTurn,
  completeTurn,
  releaseClaim,
  recoverSeatClaims,
  claimableTurns,
  inboxView,
  openTurnCount,
  openTurns,
  queueView,
} from '../../core/eventlog'

let dir: string
let db: SqliteAdapter

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'eventlog-turns-'))
  db = new SqliteAdapter(join(dir, 'log.db'))
  await ensureEventLogSchema(db)
})

afterEach(async () => {
  await db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('pull-claim', () => {
  test('an idle seat claims exactly one turn, first come first served', async () => {
    await receiveMessage(db, { messageId: 'm1', seatId: 'kodama' })
    await receiveMessage(db, { messageId: 'm2', seatId: 'kodama' })
    const claimed = await claimNextTurn(db, { seatId: 'kodama', seatInstanceId: 'i1' })
    expect(claimed?.turn.message_id).toBe('m1')
    const inbox = await inboxView(db, 'kodama')
    expect(inbox.filter(r => r.claim_event_id !== null).length).toBe(1)
  })

  test('conditional insert wins: same (turn, epoch) claim loses the race', async () => {
    await receiveMessage(db, { messageId: 'm1', seatId: 'kodama' })
    const log = new EventLog(db)
    const turnId = 'turn:kodama:m1'
    await log.append({
      eventId: 'claim-a', eventType: 'turn.claimed', turnId,
      seatId: 'kodama', seatInstanceId: 'i1', claimEpoch: 0,
    })
    expect(
      log.append({
        eventId: 'claim-b', eventType: 'turn.claimed', turnId,
        seatId: 'kodama', seatInstanceId: 'i2', claimEpoch: 0,
      }),
    ).rejects.toThrow(ClaimLostError)
  })

  test('two concurrent claimers over one message: exactly one wins', async () => {
    await receiveMessage(db, { messageId: 'm1', seatId: 'kodama' })
    const results = await Promise.all([
      claimNextTurn(db, { seatId: 'kodama', seatInstanceId: 'i1' }),
      claimNextTurn(db, { seatId: 'kodama', seatInstanceId: 'i2' }),
    ])
    const winners = results.filter(r => r !== null)
    expect(winners.length).toBe(1)
  })
})

describe('zero double-processing', () => {
  test('a completed turn cannot be completed again by another claim', async () => {
    await receiveMessage(db, { messageId: 'm1', seatId: 'kodama' })
    const claimed = await claimNextTurn(db, { seatId: 'kodama', seatInstanceId: 'i1' })
    await completeTurn(db, {
      turnId: claimed!.turn.turn_id,
      seatId: 'kodama',
      seatInstanceId: 'i1',
      claimEventId: claimed!.claimEventId,
      outcome: 'replied',
    })
    // completed turn leaves the queue → nothing claimable
    expect(await claimNextTurn(db, { seatId: 'kodama', seatInstanceId: 'i2' })).toBeNull()
    // a forged second completion under a different claim is rejected
    expect(
      completeTurn(db, {
        turnId: claimed!.turn.turn_id,
        seatId: 'kodama',
        seatInstanceId: 'i2',
        claimEventId: 'not-the-claim',
        outcome: 'replied',
      }),
    ).rejects.toThrow(StaleClaimError)
  })

  test('crash-retry of the same completion is idempotent, not a duplicate', async () => {
    await receiveMessage(db, { messageId: 'm1', seatId: 'kodama' })
    const claimed = await claimNextTurn(db, { seatId: 'kodama', seatInstanceId: 'i1' })
    const input = {
      turnId: claimed!.turn.turn_id,
      seatId: 'kodama',
      seatInstanceId: 'i1',
      claimEventId: claimed!.claimEventId,
      outcome: 'replied' as const,
      replies: [{ content: 'hi' }],
    }
    const first = await completeTurn(db, input)
    const retry = await completeTurn(db, input)
    expect(retry.completion.inserted).toBe(false)
    expect(retry.completion.event.seq).toBe(first.completion.event.seq)
    const completions = await db.query(
      `SELECT * FROM event_log WHERE event_type = 'turn.completed' AND turn_id = $1`,
      [input.turnId],
    )
    expect(completions.length).toBe(1)
    const enqueues = await db.query(
      `SELECT * FROM event_log WHERE event_type = 'reply.enqueued' AND turn_id = $1`,
      [input.turnId],
    )
    expect(enqueues.length).toBe(1)
  })
})

describe('per-conversation serialization', () => {
  test('only the earliest open turn of a conversation is claimable', async () => {
    await receiveMessage(db, { messageId: 'm1', seatId: 'kodama', conversationId: 'c1' })
    await receiveMessage(db, { messageId: 'm2', seatId: 'kodama', conversationId: 'c1' })
    await receiveMessage(db, { messageId: 'm3', seatId: 'kodama', conversationId: 'c2' })

    let claimable = await claimableTurns(db, 'kodama')
    expect(claimable.map(r => r.message_id).sort()).toEqual(['m1', 'm3'])

    // claim m1 → m2 still blocked (m1 open until completed)
    const first = await claimNextTurn(db, { seatId: 'kodama', seatInstanceId: 'i1' })
    expect(first?.turn.message_id).toBe('m1')
    claimable = await claimableTurns(db, 'kodama')
    expect(claimable.map(r => r.message_id)).toEqual(['m3'])

    // complete m1 → m2 becomes claimable
    await completeTurn(db, {
      turnId: first!.turn.turn_id,
      seatId: 'kodama',
      seatInstanceId: 'i1',
      claimEventId: first!.claimEventId,
      outcome: 'no_reply',
    })
    claimable = await claimableTurns(db, 'kodama')
    expect(claimable.map(r => r.message_id).sort()).toEqual(['m2', 'm3'])
  })
})

describe('claim fencing and recovery', () => {
  test('a released claim cannot complete the turn (fenced out)', async () => {
    await receiveMessage(db, { messageId: 'm1', seatId: 'kodama' })
    const claimed = await claimNextTurn(db, { seatId: 'kodama', seatInstanceId: 'i-dead' })
    await releaseClaim(db, {
      turnId: claimed!.turn.turn_id,
      claimEpoch: claimed!.claimEpoch,
      claimEventId: claimed!.claimEventId,
      seatId: 'kodama',
      seatInstanceId: 'i-new',
      reason: 'test',
    })
    expect(
      completeTurn(db, {
        turnId: claimed!.turn.turn_id,
        seatId: 'kodama',
        seatInstanceId: 'i-dead',
        claimEventId: claimed!.claimEventId,
        outcome: 'replied',
      }),
    ).rejects.toThrow(StaleClaimError)
  })

  test('restarting seat instance releases its predecessors claims; work is re-claimable', async () => {
    await receiveMessage(db, { messageId: 'm1', seatId: 'kodama' })
    const claimed = await claimNextTurn(db, { seatId: 'kodama', seatInstanceId: 'gen-1' })
    expect(claimed).not.toBeNull()

    // instance gen-1 dies; gen-2 starts and recovers
    const released = await recoverSeatClaims(db, { seatId: 'kodama', activeInstanceId: 'gen-2' })
    expect(released.length).toBe(1)

    const reclaimed = await claimNextTurn(db, { seatId: 'kodama', seatInstanceId: 'gen-2' })
    expect(reclaimed?.turn.turn_id).toBe(claimed!.turn.turn_id)
    expect(reclaimed?.claimEpoch).toBe(claimed!.claimEpoch + 1)

    // and the old fenced-out claim cannot complete
    expect(
      completeTurn(db, {
        turnId: claimed!.turn.turn_id,
        seatId: 'kodama',
        seatInstanceId: 'gen-1',
        claimEventId: claimed!.claimEventId,
        outcome: 'replied',
      }),
    ).rejects.toThrow(StaleClaimError)
  })
})

describe('timer-free stall detection', () => {
  test('stuck work is a query over unfinished turns, not a timer', async () => {
    await receiveMessage(db, { messageId: 'm1', seatId: 'kodama' })
    await receiveMessage(db, { messageId: 'm2', seatId: 'kodama' })
    await receiveMessage(db, { messageId: 'm3', seatId: 'lead' })
    expect(await openTurnCount(db)).toBe(3)
    expect(await openTurnCount(db, { seatId: 'kodama' })).toBe(2)

    const claimed = await claimNextTurn(db, { seatId: 'kodama', seatInstanceId: 'i1' })
    await completeTurn(db, {
      turnId: claimed!.turn.turn_id,
      seatId: 'kodama',
      seatInstanceId: 'i1',
      claimEventId: claimed!.claimEventId,
      outcome: 'replied',
    })
    expect(await openTurnCount(db)).toBe(2)

    // olderThan is a data filter over the log, usable for "open turns older than T"
    const future = '2999-01-01T00:00:00Z'
    expect((await openTurns(db, { olderThan: future })).length).toBe(2)
    const past = '2000-01-01T00:00:00Z'
    expect((await openTurns(db, { olderThan: past })).length).toBe(0)

    // full queue view still reconstructs claim state purely from the log
    const rows = await queueView(db)
    expect(rows.every(r => r.turn_id !== claimed!.turn.turn_id)).toBe(true)
  })
})
