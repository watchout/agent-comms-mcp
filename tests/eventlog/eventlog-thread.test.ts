// EventLogCore/v1 — causation-chain thread view fixture.
// Proves: a conversation thread is traceable from the log alone
// (Discord-thread-agnostic), as a tree following causation_id.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import {
  ensureEventLogSchema,
  receiveMessage,
  claimNextTurn,
  completeTurn,
  threadView,
} from '../../core/eventlog'

let dir: string
let db: SqliteAdapter

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'eventlog-thread-'))
  db = new SqliteAdapter(join(dir, 'log.db'))
  await ensureEventLogSchema(db)
})

afterEach(async () => {
  await db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('thread view reconstructs the full causation chain of a turn', async () => {
  // inbound message → claim → completion → reply, each caused by the previous
  const received = await receiveMessage(db, {
    messageId: 'm1',
    seatId: 'kodama',
    conversationId: 'conv-1',
    correlationId: 'corr-1',
  })
  const claimed = await claimNextTurn(db, { seatId: 'kodama', seatInstanceId: 'i1' })
  const done = await completeTurn(db, {
    turnId: claimed!.turn.turn_id,
    seatId: 'kodama',
    seatInstanceId: 'i1',
    claimEventId: claimed!.claimEventId,
    outcome: 'replied',
    conversationId: 'conv-1',
    correlationId: 'corr-1',
    replies: [{ content: 'answer', channelExternalId: 'chan-1' }],
  })

  const root = await threadView(db, received.event.event_id)
  expect(root).not.toBeNull()
  expect(root!.event.event_type).toBe('message.received')

  // received → claimed → completed → enqueued, one straight chain
  const claimNode = root!.children.find(c => c.event.event_type === 'turn.claimed')
  expect(claimNode).toBeDefined()
  const doneNode = claimNode!.children.find(c => c.event.event_type === 'turn.completed')
  expect(doneNode).toBeDefined()
  expect(doneNode!.event.event_id).toBe(done.completion.event.event_id)
  const replyNode = doneNode!.children.find(c => c.event.event_type === 'reply.enqueued')
  expect(replyNode).toBeDefined()
  expect(JSON.parse(replyNode!.event.payload).content).toBe('answer')

  // a follow-up message caused by the reply extends the same chain
  await receiveMessage(db, {
    messageId: 'm2',
    seatId: 'kodama',
    conversationId: 'conv-1',
    correlationId: 'corr-1',
    causationId: replyNode!.event.event_id,
  })
  const extended = await threadView(db, received.event.event_id)
  const replyNode2 = extended!.children[0].children[0].children[0]
  expect(replyNode2.children.length).toBe(1)
  expect(replyNode2.children[0].event.event_type).toBe('message.received')
})

test('thread view of an unknown event is null, and correlation stays queryable', async () => {
  expect(await threadView(db, 'nope')).toBeNull()
  await receiveMessage(db, {
    messageId: 'm1', seatId: 'kodama', conversationId: 'c1', correlationId: 'corr-9',
  })
  const rows = await db.query(
    `SELECT * FROM event_log WHERE correlation_id = $1`, ['corr-9'],
  )
  expect(rows.length).toBe(1)
})
