import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import {
  EventIdCanonicalMaterialCollisionError,
  EventLog,
  ProtectedAuthorityAppendForbiddenError,
  ensureEventLogSchema,
  type AppendEvent,
} from '../../core/eventlog'

let dir: string
let path: string
let db: SqliteAdapter

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'eventlog-collision-'))
  path = join(dir, 'eventlog.db')
  db = new SqliteAdapter(path)
  await ensureEventLogSchema(db)
})

afterEach(async () => {
  await db.close().catch(() => {})
  rmSync(dir, { recursive: true, force: true })
})

function baseEvent(): AppendEvent {
  return {
    eventId: 'same-id',
    eventType: 'message.received',
    seatId: 'aun',
    seatInstanceId: 'instance-1',
    conversationId: 'conversation-1',
    causationId: 'cause-1',
    correlationId: 'correlation-1',
    turnId: 'turn-1',
    replyId: 'reply-1',
    claimEpoch: 1,
    payload: { a: 1, nested: { z: true } },
  }
}

describe('AppendEventConflictMaterialV1', () => {
  test('same ID plus byte-identical canonical material is idempotent', async () => {
    const log = new EventLog(db)
    expect((await log.append(baseEvent())).inserted).toBe(true)
    const reordered = { ...baseEvent(), payload: { nested: { z: true }, a: 1 } }
    expect((await log.append(reordered)).inserted).toBe(false)
    expect(await log.count()).toBe(1)
  })

  test('every event type, identity, claim, and payload difference is a typed collision', async () => {
    const mutations: Array<(event: AppendEvent) => void> = [
      event => { event.eventType = 'conversation.linked' },
      event => { event.seatId = 'other-seat' },
      event => { event.seatInstanceId = 'instance-2' },
      event => { event.conversationId = 'conversation-2' },
      event => { event.causationId = 'cause-2' },
      event => { event.correlationId = 'correlation-2' },
      event => { event.turnId = 'turn-2' },
      event => { event.replyId = 'reply-2' },
      event => { event.claimEpoch = 2 },
      event => { event.payload = { a: 2, nested: { z: true } } },
    ]
    for (const [index, mutate] of mutations.entries()) {
      const isolated = new SqliteAdapter(join(dir, `field-${index}.db`))
      await ensureEventLogSchema(isolated)
      const log = new EventLog(isolated)
      await log.append(baseEvent())
      const changed = structuredClone(baseEvent())
      mutate(changed)
      await expect(log.append(changed)).rejects.toBeInstanceOf(EventIdCanonicalMaterialCollisionError)
      expect(await log.count()).toBe(1)
      await isolated.close()
    }
  })

  test('collision at every N-event position rolls back the complete batch', async () => {
    for (let collisionIndex = 0; collisionIndex < 4; collisionIndex += 1) {
      const isolated = new SqliteAdapter(join(dir, `batch-${collisionIndex}.db`))
      await ensureEventLogSchema(isolated)
      const log = new EventLog(isolated)
      await log.append({ eventId: `collision-${collisionIndex}`, eventType: 'conversation.linked', payload: { original: true } })
      const batch: AppendEvent[] = Array.from({ length: 4 }, (_, index) => ({
        eventId: index === collisionIndex ? `collision-${collisionIndex}` : `batch-${collisionIndex}-${index}`,
        eventType: 'conversation.linked',
        payload: index === collisionIndex ? { original: false } : { index },
      }))
      await expect(log.appendBatch(batch)).rejects.toBeInstanceOf(EventIdCanonicalMaterialCollisionError)
      expect(await log.count()).toBe(1)
      for (const event of batch) {
        if (event.eventId !== `collision-${collisionIndex}`) expect(await log.getByEventId(event.eventId)).toBeNull()
      }
      await isolated.close()
    }
  })
})

describe('registered-loader protected append boundary', () => {
  const protectedTypes = [
    'authority.loaded_connector_registered',
    'authority.zero_effect_producer_registered',
    'authority.retry_budget_issuer_registered',
    'authority.connector_registry_admission_recorded',
    'authority.reopen_scan_cursor_advanced',
  ] as const

  test('generic append rejects all five protected event types before a transaction writes', async () => {
    const log = new EventLog(db)
    for (const [index, eventType] of protectedTypes.entries()) {
      await expect(log.append({
        eventId: `protected-${index}`,
        eventType,
        payload: {},
      })).rejects.toBeInstanceOf(ProtectedAuthorityAppendForbiddenError)
    }
    expect(await log.count()).toBe(0)
  })

  test('mixed and pure protected batches are rejected as a whole', async () => {
    const log = new EventLog(db)
    await expect(log.appendBatch([
      { eventId: 'ordinary-before-protected', eventType: 'conversation.linked', payload: {} },
      { eventId: 'protected-in-batch', eventType: protectedTypes[0], payload: {} },
    ])).rejects.toBeInstanceOf(ProtectedAuthorityAppendForbiddenError)
    await expect(log.appendBatch(protectedTypes.map((eventType, index) => ({
      eventId: `pure-protected-${index}`,
      eventType,
      payload: {},
    })))).rejects.toBeInstanceOf(ProtectedAuthorityAppendForbiddenError)
    expect(await log.count()).toBe(0)
  })
})
