import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import {
  EventLog,
  ReconciliationTransitionCollisionError,
  canonicalJson,
  ensureEventLogSchema,
  outboxView,
  pendingDeliveries,
  reconciliationObservationDigest,
  reconciliationObservationEventId,
  reconciliationRequestDigest,
  recoverDispatcherClaims,
  sha256Utf8,
  startProviderInvocation,
  storedEventConflictMaterial,
  type CommitReconciliationTerminalCASInputV1,
  type DeliveryUnknownReconciliationObservationV1,
  type DeliveryUnknownReconciliationRequestV1,
  type ReplyDeliveryUnknownPayloadV1,
} from '../../core/eventlog'
import type { DbAdapter } from '../../core/db/adapter'

let dir: string
let db: SqliteAdapter

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'eventlog-views-'))
  db = new SqliteAdapter(join(dir, 'eventlog.db'))
  await ensureEventLogSchema(db)
})

afterEach(async () => {
  await db.close()
  rmSync(dir, { recursive: true, force: true })
})

async function enqueue(replyId: string) {
  return new EventLog(db).append({
    eventId: `enq:${replyId}`,
    eventType: 'reply.enqueued',
    seatId: 'aun',
    conversationId: 'conversation-1',
    turnId: 'turn-1',
    replyId,
    payload: { content: 'hello', channel_external_id: 'channel-1' },
  })
}

async function claim(replyId: string, epoch: number, instance = 'dispatcher-old') {
  return new EventLog(db).append({
    eventId: `claim:${replyId}:${epoch}`,
    eventType: 'reply.delivery_claimed',
    seatId: 'dispatcher',
    seatInstanceId: instance,
    replyId,
    claimEpoch: epoch,
  })
}

describe('unknown, reopened, and handoff projection truth', () => {
  test('delivery_unknown is never ordinary pending; exact reopen admits only the next attempt', async () => {
    const replyId = 'reply-unknown'
    await enqueue(replyId)
    await claim(replyId, 0)
    await new EventLog(db).append({
      eventId: 'unknown-event-0',
      eventType: 'reply.delivery_unknown',
      replyId,
      claimEpoch: 0,
      payload: { delivery_id: 'delivery-1' },
    })
    expect(await pendingDeliveries(db)).toHaveLength(0)
    expect(await outboxView(db)).toHaveLength(0)

    await new EventLog(db).append({
      eventId: 'reopen-event-1',
      eventType: 'reply.delivery_reopened',
      replyId,
      claimEpoch: 1,
      payload: { causation_delivery_unknown_event_id: 'unknown-event-0' },
    })
    const reopened = await pendingDeliveries(db)
    expect(reopened).toHaveLength(1)
    expect(Number(reopened[0]!.attempts)).toBe(1)
    expect(reopened[0]!.delivery_claim_event_id).toBeNull()
    await claim(replyId, 1)
    expect(await pendingDeliveries(db)).toHaveLength(0)
  })

  test('durable_handoff placement is non-delivered and not dispatchable', async () => {
    const replyId = 'reply-handoff'
    await enqueue(replyId)
    await new EventLog(db).append({
      eventId: 'handoff-accepted-1',
      eventType: 'reply.handoff_accepted',
      replyId,
      payload: { reply_id: replyId, delivery_id: 'delivery-handoff', recipient_seat_id: 'spec', receipt_digest: '1'.repeat(64), fanout_child_provenance_digest: null },
    })
    expect(await pendingDeliveries(db)).toHaveLength(0)
  })

  test('strict permanent field terminates while retryable legacy field reopens', async () => {
    await enqueue('reply-permanent')
    await new EventLog(db).append({
      eventId: 'failed-permanent', eventType: 'reply.failed', replyId: 'reply-permanent', claimEpoch: 0,
      payload: { reply_id: 'reply-permanent', delivery_id: 'delivery-permanent', recipient_seat_id: 'spec', failure_code: 'rejected', permanent: true, fanout_child_provenance_digest: null },
    })
    expect(await pendingDeliveries(db)).toHaveLength(0)

    await enqueue('reply-retryable')
    await claim('reply-retryable', 0)
    await new EventLog(db).append({
      eventId: 'failed-retryable', eventType: 'reply.failed', replyId: 'reply-retryable', claimEpoch: 0,
      payload: { kind: 'retryable', reason: 'pre-invocation' },
    })
    expect((await pendingDeliveries(db)).map(row => row.reply_id)).toEqual(['reply-retryable'])
  })
})

describe('restart recovery does not blindly resend a started provider attempt', () => {
  test('stale pre-start claim is released, but invocation-start claim is preserved', async () => {
    await enqueue('reply-before-start')
    await claim('reply-before-start', 0)
    const released = await recoverDispatcherClaims(db, { dispatcherId: 'dispatcher', activeInstanceId: 'dispatcher-new' })
    expect(released.map(row => row.reply_id)).toEqual(['reply-before-start'])
    expect((await pendingDeliveries(db)).map(row => row.reply_id)).toEqual(['reply-before-start'])

    await enqueue('reply-after-start')
    await claim('reply-after-start', 0)
    await startProviderInvocation(db, {
      delivery_id: 'delivery-after-start', reply_id: 'reply-after-start', recipient_seat_id: 'spec', attempt_ordinal: 0,
      provider_nonce: 'a1_abcdefghijklmnopqrstuv', delivery_digest: '2'.repeat(64), provider_request_digest: '3'.repeat(64),
    })
    const afterStart = await recoverDispatcherClaims(db, { dispatcherId: 'dispatcher', activeInstanceId: 'dispatcher-new' })
    expect(afterStart).toHaveLength(0)
    expect((await pendingDeliveries(db)).map(row => row.reply_id)).not.toContain('reply-after-start')
    const retryFailures = await db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM event_log WHERE event_type = 'reply.failed' AND reply_id = $1`,
      ['reply-after-start'],
    )
    expect(Number(retryFailures[0]?.n ?? 0)).toBe(0)
  })
})

interface TerminalFixture {
  log: EventLog
  input: CommitReconciliationTerminalCASInputV1
  outcomeEventId: string
}

async function installTerminalSources(
  target: DbAdapter,
  options: {
    suffix: string
    observedOutcome: 'validated_original_receipt' | 'permanent_failure' | 'not_found'
    replyId?: string
    deliveryId?: string
    appendEnqueued?: boolean
  },
): Promise<TerminalFixture> {
  const log = new EventLog(target)
  const replyId = options.replyId ?? `reply-terminal-${options.suffix}`
  const deliveryId = options.deliveryId ?? `delivery-terminal-${options.suffix}`
  if (options.appendEnqueued !== false) {
    await log.append({
      eventId: `enq-terminal:${options.suffix}`, eventType: 'reply.enqueued', seatId: 'aun',
      conversationId: 'conversation-terminal', turnId: 'turn-terminal', replyId,
      payload: { content: 'terminal fixture', channel_external_id: 'channel-terminal' },
    })
  }
  const unknown: ReplyDeliveryUnknownPayloadV1 = {
    reply_id: replyId, delivery_id: deliveryId, recipient_seat_id: 'spec', attempt_ordinal: 0,
    connector_instance_id: '11111111-1111-4111-8111-111111111111',
    resolved_binding_snapshot_digest: '2'.repeat(64), resolved_delivery_decision_digest: '3'.repeat(64),
    delivery_digest: '4'.repeat(64), provider_request_digest: '5'.repeat(64),
    business_nonce: `business-${options.suffix}`, provider_nonce: `provider-${options.suffix}`,
    capability_digest: '6'.repeat(64), invocation_started_event_id: `provider-started:${options.suffix}`,
    reconciliation_mode: 'provider_lookup', fanout_child_provenance_digest: null,
  }
  const unknownEvent = await log.append({
    eventId: `delivery-unknown:${options.suffix}`, eventType: 'reply.delivery_unknown',
    conversationId: 'conversation-terminal', correlationId: 'correlation-terminal', turnId: 'turn-terminal',
    replyId, claimEpoch: 0, payload: unknown as unknown as Record<string, unknown>,
  })
  const requestMaterial = {
    schema_version: 'aun-delivery-unknown-reconciliation-request/v1' as const,
    reconciliation_id: `reconciliation-${options.suffix}`,
    delivery_unknown_event_id: unknownEvent.event.event_id,
    delivery_unknown_event_digest: sha256Utf8(canonicalJson(storedEventConflictMaterial(unknownEvent.event))),
    reply_id: replyId, delivery_id: deliveryId, recipient_seat_id: 'spec', attempt_ordinal: 0,
    connector_instance_id: unknown.connector_instance_id,
    resolved_binding_snapshot_digest: unknown.resolved_binding_snapshot_digest,
    resolved_delivery_decision_digest: unknown.resolved_delivery_decision_digest,
    delivery_digest: unknown.delivery_digest, provider_request_digest: unknown.provider_request_digest,
    business_nonce: unknown.business_nonce, provider_nonce: unknown.provider_nonce,
    capability_digest: unknown.capability_digest, reconciliation_mode: 'provider_lookup' as const,
    reconciler_registration_digest: '7'.repeat(64),
  }
  const request: DeliveryUnknownReconciliationRequestV1 = {
    ...requestMaterial,
    request_digest: reconciliationRequestDigest(requestMaterial),
  }
  const requestEventId = `delivery-reconciliation-requested:${options.suffix}`
  await log.append({
    eventId: requestEventId, eventType: 'reply.delivery_reconciliation_requested',
    replyId, claimEpoch: 0, payload: request as unknown as Record<string, unknown>,
  })
  const receiptDigest = 'a'.repeat(64)
  const failureCode = 'provider-permanent-rejection'
  const observationMaterial = {
    schema_version: 'aun-delivery-unknown-reconciliation-observation/v1' as const,
    reconciliation_request_digest: request.request_digest,
    observed_outcome: options.observedOutcome,
    validated_receipt_digest: options.observedOutcome === 'validated_original_receipt' ? receiptDigest : null,
    permanent_failure_code: options.observedOutcome === 'permanent_failure' ? failureCode : null,
    zero_external_effect_attestation_digest: null,
    evidence_digest: '8'.repeat(64),
  }
  const observation: DeliveryUnknownReconciliationObservationV1 = {
    ...observationMaterial,
    observation_digest: reconciliationObservationDigest(observationMaterial),
  }
  const observationEventId = reconciliationObservationEventId(unknownEvent.event.event_id, observation.observation_digest)
  await log.append({
    eventId: observationEventId, eventType: 'reply.delivery_reconciliation_observed',
    replyId, claimEpoch: 0, payload: observation as unknown as Record<string, unknown>,
  })
  const terminal = options.observedOutcome === 'permanent_failure'
    ? {
        outcome: 'permanent_failure' as const,
        event_id: `reconciled-permanent:${options.suffix}`,
        payload: {
          reply_id: replyId, delivery_id: deliveryId, recipient_seat_id: 'spec',
          failure_code: failureCode, permanent: true, fanout_child_provenance_digest: null,
        },
      }
    : {
        outcome: 'delivered' as const,
        event_id: `reconciled-delivered:${options.suffix}`,
        payload: {
          reply_id: replyId, delivery_id: deliveryId, recipient_seat_id: 'spec', receipt_digest: receiptDigest,
          provider_request_digest: unknown.provider_request_digest,
          resolved_delivery_decision_digest: unknown.resolved_delivery_decision_digest,
          fanout_child_provenance_digest: null,
        },
      }
  return {
    log,
    input: {
      unknown_event_id: unknownEvent.event.event_id,
      reconciliation_request_event_id: requestEventId,
      reconciliation_observation_event_id: observationEventId,
      terminal,
    },
    outcomeEventId: `delivery-reconciliation-outcome:${sha256Utf8('aun-delivery-unknown-outcome/v1\n' + canonicalJson({ delivery_id: deliveryId, attempt_ordinal: 0 }))}`,
  }
}

describe('conclusive reconciliation terminal outcome CAS', () => {
  test('validated original receipt and permanent failure each atomically append one causal terminal', async () => {
    const delivered = await installTerminalSources(db, { suffix: 'delivered', observedOutcome: 'validated_original_receipt' })
    const deliveredResult = await delivered.log.commitReconciliationTerminalCAS(delivered.input)
    expect(deliveredResult.status).toBe('inserted')
    expect(deliveredResult.provider_invocations).toBe(0)
    expect(deliveredResult.terminal.event_type).toBe('reply.delivered')
    expect(deliveredResult.terminal.causation_id).toBe(deliveredResult.outcome.event_id)
    expect((await delivered.log.commitReconciliationTerminalCAS(structuredClone(delivered.input))).status).toBe('byte_identical_existing')

    const permanent = await installTerminalSources(db, { suffix: 'permanent', observedOutcome: 'permanent_failure' })
    const permanentResult = await permanent.log.commitReconciliationTerminalCAS(permanent.input)
    expect(permanentResult.status).toBe('inserted')
    expect(permanentResult.provider_invocations).toBe(0)
    expect(permanentResult.terminal.event_type).toBe('reply.failed')
    expect(permanentResult.terminal.causation_id).toBe(permanentResult.outcome.event_id)
    expect(await pendingDeliveries(db)).toHaveLength(0)
  })

  test('inconclusive observation consumes no outcome winner and every precommit kill rolls back both members', async () => {
    const inconclusive = await installTerminalSources(db, { suffix: 'not-found', observedOutcome: 'not_found' })
    await expect(inconclusive.log.commitReconciliationTerminalCAS(inconclusive.input))
      .rejects.toBeInstanceOf(ReconciliationTransitionCollisionError)
    expect(await inconclusive.log.getByEventId(inconclusive.outcomeEventId)).toBeNull()

    const killPoints = ['after_outcome_append', 'after_terminal_append', 'before_commit'] as const
    for (const [index, killPoint] of killPoints.entries()) {
      const isolated = new SqliteAdapter(join(dir, `terminal-kill-${index}.db`))
      await ensureEventLogSchema(isolated)
      const fixture = await installTerminalSources(isolated, { suffix: `kill-${index}`, observedOutcome: 'validated_original_receipt' })
      fixture.input.on_commit_point = point => { if (point === killPoint) throw new Error(`kill:${killPoint}`) }
      await expect(fixture.log.commitReconciliationTerminalCAS(fixture.input)).rejects.toThrow(`kill:${killPoint}`)
      expect(await fixture.log.getByEventId(fixture.outcomeEventId)).toBeNull()
      expect(await fixture.log.getByEventId(fixture.input.terminal.event_id)).toBeNull()
      await isolated.close()
    }
  })

  test('distinct unknown events and delivered/permanent contenders produce one outcome winner', async () => {
    const replyId = 'reply-race-terminal'
    const deliveryId = 'delivery-race-terminal'
    const delivered = await installTerminalSources(db, {
      suffix: 'race-delivered', observedOutcome: 'validated_original_receipt', replyId, deliveryId,
    })
    const permanent = await installTerminalSources(db, {
      suffix: 'race-permanent', observedOutcome: 'permanent_failure', replyId, deliveryId, appendEnqueued: false,
    })
    const settled = await Promise.allSettled([
      delivered.log.commitReconciliationTerminalCAS(delivered.input),
      permanent.log.commitReconciliationTerminalCAS(permanent.input),
    ])
    expect(settled.filter(item => item.status === 'fulfilled')).toHaveLength(1)
    expect(settled.filter(item => item.status === 'rejected')).toHaveLength(1)
    const outcomeCount = await db.queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM event_log WHERE event_id = $1`,
      [delivered.outcomeEventId],
    )
    const terminalCount = await db.queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM event_log WHERE reply_id = $1 AND event_type IN ('reply.delivered', 'reply.failed')`,
      [replyId],
    )
    expect(Number(outcomeCount?.n ?? 0)).toBe(1)
    expect(Number(terminalCount?.n ?? 0)).toBe(1)
  })
})
