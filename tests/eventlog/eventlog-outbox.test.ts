// EventLogCore/v1 — transactional outbox fixture.
// Proves: reply.enqueued commits atomically with turn.completed, zero
// lost sends, unknown-not-pending after an ambiguous started attempt,
// bounded retry, and identity-based dispatcher crash recovery.

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
  dispatchOutboxOnce,
  recoverDispatcherClaims,
  pendingDeliveries,
  outboxView,
  PermanentDeliveryError,
  AmbiguousDeliveryOutcomeError,
  startProviderInvocation,
  type OutboxDelivery,
  type OutboxTransport,
} from '../../core/eventlog'

let dir: string
let db: SqliteAdapter

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'eventlog-outbox-'))
  db = new SqliteAdapter(join(dir, 'log.db'))
  await ensureEventLogSchema(db)
})

afterEach(async () => {
  await db.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Legacy transport fake; typed ambiguity is never converted to success. */
class RecordingTransport implements OutboxTransport {
  sends: OutboxDelivery[] = []
  private byNonce = new Map<string, string>()
  /** Queue of behaviors for upcoming sends: 'ok' | 'ambiguous' | 'retryable' | 'permanent'. */
  script: string[] = []

  async send(delivery: OutboxDelivery) {
    const existing = this.byNonce.get(delivery.nonce)
    if (existing) {
      // duplicate nonce: transport already performed this send → idempotent success
      return { transportMessageId: existing }
    }
    const behavior = this.script.shift() ?? 'ok'
    if (behavior === 'retryable') throw new Error('transport unavailable (retryable)')
    if (behavior === 'permanent') throw new PermanentDeliveryError('channel gone')
    // the send happens
    const id = `transport-${this.sends.length + 1}`
    this.sends.push(delivery)
    this.byNonce.set(delivery.nonce, id)
    if (behavior === 'ambiguous') {
      throw new AmbiguousDeliveryOutcomeError('connection reset while reading response')
    }
    return { transportMessageId: id }
  }
}

async function completeWithReply(seatId: string, messageId: string, content: string, payload?: Record<string, unknown>) {
  await receiveMessage(db, { messageId, seatId, conversationId: 'conv-1' })
  const claimed = await claimNextTurn(db, { seatId, seatInstanceId: 'i1' })
  return completeTurn(db, {
    turnId: claimed!.turn.turn_id,
    seatId,
    seatInstanceId: 'i1',
    claimEventId: claimed!.claimEventId,
    outcome: 'replied',
    conversationId: 'conv-1',
    replies: [{ content, channelExternalId: 'chan-1', payload }],
  })
}

describe('transactional outbox', () => {
  test('completion and enqueue are one transaction; dispatch delivers with evidence', async () => {
    await completeWithReply('kodama', 'm1', 'hello world')
    const pending = await pendingDeliveries(db)
    expect(pending.length).toBe(1)

    const transport = new RecordingTransport()
    const result = await dispatchOutboxOnce(db, transport, {
      dispatcherId: 'outbox', dispatcherInstanceId: 'd1',
    })
    expect(result.delivered.length).toBe(1)
    expect(transport.sends.length).toBe(1)
    expect(transport.sends[0].content).toBe('hello world')

    const delivered = await db.queryOne(
      `SELECT * FROM event_log WHERE event_type = 'reply.delivered' AND reply_id = $1`,
      [result.delivered[0]],
    )
    expect(delivered).not.toBeNull()
    expect(JSON.parse(delivered!.payload).transport_message_id).toBe('transport-1')
    expect((await pendingDeliveries(db)).length).toBe(0)
  })

  test('ambiguous started attempt becomes delivery_unknown and is never blindly retried', async () => {
    const start = {
      delivery_id: 'delivery-unknown-1', reply_id: 'reply:turn:kodama:m1:0', recipient_seat_id: 'spec', attempt_ordinal: 0,
      provider_nonce: 'a1_abcdefghijklmnopqrstuv', delivery_digest: '2'.repeat(64), provider_request_digest: '3'.repeat(64),
    }
    const invocation = await startProviderInvocation(db, start)
    await completeWithReply('kodama', 'm1', 'exactly once', {
      delivery_unknown_payload: {
        reply_id: start.reply_id,
        delivery_id: start.delivery_id,
        recipient_seat_id: start.recipient_seat_id,
        attempt_ordinal: 0,
        connector_instance_id: '11111111-1111-4111-8111-111111111111',
        resolved_binding_snapshot_digest: '4'.repeat(64),
        resolved_delivery_decision_digest: '5'.repeat(64),
        delivery_digest: start.delivery_digest,
        provider_request_digest: start.provider_request_digest,
        business_nonce: 'business-1',
        provider_nonce: start.provider_nonce,
        capability_digest: '6'.repeat(64),
        invocation_started_event_id: invocation.eventId,
        reconciliation_mode: 'none',
        fanout_child_provenance_digest: null,
      },
    })
    const transport = new RecordingTransport()
    transport.script = ['ambiguous']

    const result = await dispatchOutboxOnce(db, transport, {
      dispatcherId: 'outbox', dispatcherInstanceId: 'd1',
    })
    expect(result.deliveryUnknown).toEqual([start.reply_id])
    expect((await pendingDeliveries(db)).length).toBe(0)
    const retry = await dispatchOutboxOnce(db, transport, {
      dispatcherId: 'outbox', dispatcherInstanceId: 'd1',
    })
    expect(retry.delivered).toHaveLength(0)
    expect(transport.sends.length).toBe(1)
    expect(await db.query(`SELECT * FROM event_log WHERE event_type = 'reply.delivered'`)).toHaveLength(0)
  })

  test('two concurrent dispatchers never double-deliver one reply', async () => {
    await completeWithReply('kodama', 'm1', 'contested')
    const transport = new RecordingTransport()
    const [a, b] = await Promise.all([
      dispatchOutboxOnce(db, transport, { dispatcherId: 'outbox', dispatcherInstanceId: 'dA' }),
      dispatchOutboxOnce(db, transport, { dispatcherId: 'outbox', dispatcherInstanceId: 'dB' }),
    ])
    expect(a.delivered.length + b.delivered.length).toBe(1)
    expect(transport.sends.length).toBe(1)
  })

  test('permanent failure terminates the reply; retryable failure is bounded', async () => {
    await completeWithReply('kodama', 'm1', 'doomed')
    const transport = new RecordingTransport()
    transport.script = ['permanent']
    const result = await dispatchOutboxOnce(db, transport, {
      dispatcherId: 'outbox', dispatcherInstanceId: 'd1',
    })
    expect(result.failedPermanent.length).toBe(1)
    expect((await pendingDeliveries(db)).length).toBe(0)

    // bounded retry: retryable failures exhaust into a permanent failure
    await completeWithReply('kodama', 'm2', 'flaky')
    const flaky = new RecordingTransport()
    flaky.script = ['retryable', 'retryable']
    await dispatchOutboxOnce(db, flaky, {
      dispatcherId: 'outbox', dispatcherInstanceId: 'd1', maxAttempts: 2,
    })
    await dispatchOutboxOnce(db, flaky, {
      dispatcherId: 'outbox', dispatcherInstanceId: 'd1', maxAttempts: 2,
    })
    const final = await dispatchOutboxOnce(db, flaky, {
      dispatcherId: 'outbox', dispatcherInstanceId: 'd1', maxAttempts: 2,
    })
    expect(final.failedPermanent.length).toBe(1)
    expect((await pendingDeliveries(db)).length).toBe(0)
    expect(flaky.sends.length).toBe(0) // retryable script rows never hit the wire
  })
})

describe('dispatcher crash recovery', () => {
  test('a restarted dispatcher releases its predecessors claim; reply is re-dispatchable', async () => {
    await completeWithReply('kodama', 'm1', 'orphaned mid-flight')

    // d-gen1 claims the delivery then "crashes" (we simulate by claiming
    // via a transport that fails retryably — claim epoch stays active? No:
    // a failed attempt releases the epoch. To model a TRUE crash we claim
    // manually and never write an outcome.)
    const { EventLog } = await import('../../core/eventlog')
    const log = new EventLog(db)
    const row = (await pendingDeliveries(db))[0]
    await log.append({
      eventId: 'stale-claim',
      eventType: 'reply.delivery_claimed',
      seatId: 'outbox',
      seatInstanceId: 'd-gen1',
      replyId: row.reply_id,
      claimEpoch: 0,
      causationId: row.enqueued_event_id,
    })
    expect((await pendingDeliveries(db)).length).toBe(0) // claimed → not pending

    // d-gen2 starts, recovers, dispatches
    const released = await recoverDispatcherClaims(db, {
      dispatcherId: 'outbox', activeInstanceId: 'd-gen2',
    })
    expect(released.length).toBe(1)
    const transport = new RecordingTransport()
    const result = await dispatchOutboxOnce(db, transport, {
      dispatcherId: 'outbox', dispatcherInstanceId: 'd-gen2',
    })
    expect(result.delivered.length).toBe(1)
    expect(transport.sends.length).toBe(1)
  })

  test('recovery does not touch claims held by a different live dispatcher', async () => {
    await completeWithReply('kodama', 'm1', 'someone elses work')
    const { EventLog } = await import('../../core/eventlog')
    const log = new EventLog(db)
    const row = (await pendingDeliveries(db))[0]
    await log.append({
      eventId: 'live-claim',
      eventType: 'reply.delivery_claimed',
      seatId: 'other-outbox',
      seatInstanceId: 'x1',
      replyId: row.reply_id,
      claimEpoch: 0,
      causationId: row.enqueued_event_id,
    })
    const released = await recoverDispatcherClaims(db, {
      dispatcherId: 'outbox', activeInstanceId: 'd-gen2',
    })
    expect(released.length).toBe(0)
    const view = await outboxView(db)
    expect(view[0].claimed_by_dispatcher).toBe('other-outbox')
  })
})
