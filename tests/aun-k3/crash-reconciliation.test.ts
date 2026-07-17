import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import { PgAdapter } from '../../core/db/pg-adapter'
import {
  EventLog,
  canonicalJson,
  commitValidatedDeliveryTruth,
  dispatchV2OutboxOnce,
  ensureEventLogSchema,
  pendingDeliveries,
  reconciliationObservationDigest,
  reconciliationObservationEventId,
  reconciliationRequestDigest,
  reconcileUnknownDeliveryOnce,
  reserveProviderNonce,
  recoverDispatcherClaims,
  sha256Utf8,
  startProviderInvocation,
  storedEventConflictMaterial,
  type DeliveryUnknownReconciliationObservationV1,
  type DeliveryUnknownReconciliationRequestV1,
  type ReplyDeliveryUnknownPayloadV1,
} from '../../core/eventlog'
import { FakeV2Adapter, appendUnit, makeDeliveryFixture } from './delivery-truth.test'

const PG_EVENT_LOG_DDL = `
  CREATE TABLE event_log (
    seq BIGSERIAL PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, event_type TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), seat_id TEXT, seat_instance_id TEXT,
    conversation_id TEXT, causation_id TEXT, correlation_id TEXT, turn_id TEXT, reply_id TEXT,
    claim_epoch INTEGER, payload JSONB NOT NULL DEFAULT '{}'::jsonb
  );
  CREATE UNIQUE INDEX uq_el_delivery_claim ON event_log(reply_id, claim_epoch) WHERE event_type='reply.delivery_claimed';
  CREATE UNIQUE INDEX uq_el_reply_delivered ON event_log(reply_id) WHERE event_type='reply.delivered';
  CREATE INDEX idx_el_type_reply ON event_log(event_type, reply_id);
`

const pgEnabled = () => process.env.AUN_K3_DB_SCOPE === 'isolated_disposable_fixture'

async function pgFixture() {
  const url = process.env.AUN_K3_TEST_DATABASE_URL
  if (!url) throw new Error('AUN_K3_TEST_DATABASE_URL is required')
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''))
  if (!name.startsWith('aun_k3_fixture_')) throw new Error(`unsafe K3 fixture database ${name}`)
  const schema = `k3_crash_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 8)}`
  const db = new PgAdapter(url)
  await db.execute(`CREATE SCHEMA "${schema}"`)
  await db.execute(`SET search_path TO "${schema}", public`)
  await db.execute(PG_EVENT_LOG_DDL)
  return { db, async cleanup() { await db.execute(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await db.close() } }
}

async function withDb<T>(run: (db: SqliteAdapter) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'aun-k3-crash-'))
  const db = new SqliteAdapter(join(dir, 'eventlog.db'))
  await ensureEventLogSchema(db)
  try { return await run(db) } finally {
    await db.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('K3 crash boundaries and reconciliation', () => {
  test('TC007 crash/preflight failure before claim leaves delivery pending with zero effect', async () => withDb(async db => {
    const fixture = makeDeliveryFixture('provider_ack', 'before-claim')
    const adapter = new FakeV2Adapter('provider_ack')
    await appendUnit(db, fixture)
    const result = await dispatchV2OutboxOnce(db, adapter, {
      dispatcherId: 'dispatcher', dispatcherInstanceId: 'old',
      targetConnectorInstanceId: '99999999-9999-4999-8999-999999999999',
      loadRegistration: () => fixture.registration,
    })
    expect(result.rejectedAuthority).toEqual([fixture.unit.reply_id])
    expect(adapter.calls).toBe(0)
    expect((await pendingDeliveries(db)).map(row => row.reply_id)).toEqual([fixture.unit.reply_id])
  }))

  test('TC008 stale claim before invocation-start is released to a new epoch without duplication', async () => withDb(async db => {
    const fixture = makeDeliveryFixture('provider_ack', 'claim-before-start')
    const adapter = new FakeV2Adapter('provider_ack')
    await appendUnit(db, fixture)
    await new EventLog(db).append({
      eventId: 'crashed-claim', eventType: 'reply.delivery_claimed',
      seatId: 'dispatcher', seatInstanceId: 'old', conversationId: fixture.unit.conversation_id,
      turnId: fixture.unit.turn_id, replyId: fixture.unit.reply_id, claimEpoch: 0,
    })
    expect((await recoverDispatcherClaims(db, { dispatcherId: 'dispatcher', activeInstanceId: 'new' })).map(row => row.reply_id)).toEqual([fixture.unit.reply_id])
    const result = await dispatchV2OutboxOnce(db, adapter, {
      dispatcherId: 'dispatcher', dispatcherInstanceId: 'new',
      targetConnectorInstanceId: fixture.unit.destination.connector_instance_id,
      loadRegistration: () => fixture.registration,
    })
    expect(result.delivered).toEqual([fixture.unit.reply_id])
    expect(adapter.calls).toBe(1)
  }))

  test('TC009 started attempt without receipt recovers to unknown and is never resent', async () => withDb(async db => {
    const fixture = makeDeliveryFixture('provider_ack', 'start-before-receipt')
    const adapter = new FakeV2Adapter('provider_ack')
    await appendUnit(db, fixture)
    await new EventLog(db).append({
      eventId: 'started-crashed-claim', eventType: 'reply.delivery_claimed',
      seatId: 'dispatcher', seatInstanceId: 'old', conversationId: fixture.unit.conversation_id,
      turnId: fixture.unit.turn_id, replyId: fixture.unit.reply_id, claimEpoch: 0,
    })
    const prepared = adapter.prepare(fixture.unit, fixture.registration)
    await startProviderInvocation(db, {
      delivery_id: fixture.unit.delivery_id, reply_id: fixture.unit.reply_id,
      recipient_seat_id: fixture.unit.recipient_seat_id, attempt_ordinal: 0,
      provider_nonce: fixture.unit.idempotency.provider_nonce,
      delivery_digest: fixture.unit.idempotency.delivery_digest,
      provider_request_digest: prepared.request.provider_request_digest,
    })
    expect(await recoverDispatcherClaims(db, { dispatcherId: 'dispatcher', activeInstanceId: 'new' })).toHaveLength(0)
    expect(await pendingDeliveries(db)).toHaveLength(0)
    const result = await dispatchV2OutboxOnce(db, adapter, {
      dispatcherId: 'dispatcher', dispatcherInstanceId: 'new',
      targetConnectorInstanceId: fixture.unit.destination.connector_instance_id,
      loadRegistration: () => fixture.registration,
    })
    expect(result.providerInvocations).toBe(0)
    expect(adapter.calls).toBe(0)
  }))

  test('TC010 validated post-crash receipt resolves unknown through one existing CAS terminal', async () => withDb(async db => {
    const log = new EventLog(db)
    const replyId = 'reply-reconcile'
    const deliveryId = 'delivery-reconcile'
    const unknown: ReplyDeliveryUnknownPayloadV1 = {
      reply_id: replyId, delivery_id: deliveryId, recipient_seat_id: 'spec', attempt_ordinal: 0,
      connector_instance_id: '33333333-3333-4333-8333-333333333333',
      resolved_binding_snapshot_digest: '2'.repeat(64), resolved_delivery_decision_digest: '3'.repeat(64),
      delivery_digest: '4'.repeat(64), provider_request_digest: '5'.repeat(64),
      business_nonce: 'business-reconcile', provider_nonce: 'provider-reconcile',
      capability_digest: '6'.repeat(64), invocation_started_event_id: 'provider-started-reconcile',
      reconciliation_mode: 'provider_lookup', fanout_child_provenance_digest: null,
    }
    const unknownEvent = await log.append({
      eventId: 'delivery-unknown-reconcile', eventType: 'reply.delivery_unknown',
      conversationId: 'conversation-reconcile', turnId: 'turn-reconcile', replyId, claimEpoch: 0,
      payload: unknown as unknown as Record<string, unknown>,
    })
    const requestMaterial = {
      schema_version: 'aun-delivery-unknown-reconciliation-request/v1' as const,
      reconciliation_id: 'reconciliation-1', delivery_unknown_event_id: unknownEvent.event.event_id,
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
    const request: DeliveryUnknownReconciliationRequestV1 = { ...requestMaterial, request_digest: reconciliationRequestDigest(requestMaterial) }
    await log.append({
      eventId: 'reconciliation-requested-1', eventType: 'reply.delivery_reconciliation_requested',
      replyId, claimEpoch: 0, payload: request as unknown as Record<string, unknown>,
    })
    const observationMaterial = {
      schema_version: 'aun-delivery-unknown-reconciliation-observation/v1' as const,
      reconciliation_request_digest: request.request_digest,
      observed_outcome: 'validated_original_receipt' as const,
      validated_receipt_digest: 'a'.repeat(64), permanent_failure_code: null,
      zero_external_effect_attestation_digest: null, evidence_digest: '8'.repeat(64),
    }
    const observation: DeliveryUnknownReconciliationObservationV1 = {
      ...observationMaterial, observation_digest: reconciliationObservationDigest(observationMaterial),
    }
    const observationEventId = reconciliationObservationEventId(unknownEvent.event.event_id, observation.observation_digest)
    await log.append({
      eventId: observationEventId, eventType: 'reply.delivery_reconciliation_observed',
      replyId, claimEpoch: 0, payload: observation as unknown as Record<string, unknown>,
    })
    const input = {
      unknown_event_id: unknownEvent.event.event_id,
      reconciliation_request_event_id: 'reconciliation-requested-1',
      reconciliation_observation_event_id: observationEventId,
      terminal: {
        outcome: 'delivered' as const, event_id: 'reconciled-delivered-1',
        payload: {
          reply_id: replyId, delivery_id: deliveryId, recipient_seat_id: 'spec',
          receipt_digest: observation.validated_receipt_digest!, provider_request_digest: unknown.provider_request_digest,
          resolved_delivery_decision_digest: unknown.resolved_delivery_decision_digest,
          fanout_child_provenance_digest: null,
        },
      },
    }
    expect((await reconcileUnknownDeliveryOnce(db, input)).status).toBe('inserted')
    expect((await reconcileUnknownDeliveryOnce(db, structuredClone(input))).status).toBe('byte_identical_existing')
    expect(Number((await db.queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM event_log WHERE event_type='reply.delivered' AND reply_id=$1", [replyId]))?.n)).toBe(1)
  }))
})

describe.if(pgEnabled())('K3 PostgreSQL crash commit boundary', () => {
  test('TC010-PG crash after validated receipt rolls back, then one exact terminal commits', async () => {
    const pg = await pgFixture()
    try {
      const fixture = makeDeliveryFixture('provider_ack', 'pg-crash-receipt')
      const adapter = new FakeV2Adapter('provider_ack')
      await appendUnit(pg.db, fixture)
      const prepared = adapter.prepare(fixture.unit, fixture.registration)
      await reserveProviderNonce(pg.db, {
        key: {
          connector_instance_id: fixture.unit.destination.connector_instance_id,
          concrete_dedupe_scope_identity: prepared.concrete_dedupe_scope_identity,
          provider_nonce: fixture.unit.idempotency.provider_nonce,
        },
        value: {
          business_nonce: fixture.unit.business_nonce,
          delivery_digest: fixture.unit.idempotency.delivery_digest,
          adapter_build_digest: fixture.unit.capability_authority.adapter_build_digest,
        },
      })
      const claim = await new EventLog(pg.db).append({
        eventId: 'pg-crash-claim', eventType: 'reply.delivery_claimed', seatId: 'dispatcher',
        seatInstanceId: 'dispatcher-old', conversationId: fixture.unit.conversation_id,
        turnId: fixture.unit.turn_id, replyId: fixture.unit.reply_id, claimEpoch: 0,
      })
      const invocation = {
        delivery_id: fixture.unit.delivery_id, reply_id: fixture.unit.reply_id,
        recipient_seat_id: fixture.unit.recipient_seat_id, attempt_ordinal: 0,
        provider_nonce: fixture.unit.idempotency.provider_nonce,
        delivery_digest: fixture.unit.idempotency.delivery_digest,
        provider_request_digest: prepared.request.provider_request_digest,
      }
      const started = await startProviderInvocation(pg.db, invocation)
      const attempted = await adapter.sendPrepared(prepared, fixture.unit, fixture.registration)
      const context = {
        dispatcherId: 'dispatcher', dispatcherInstanceId: 'dispatcher-old',
        conversationId: fixture.unit.conversation_id, correlationId: fixture.unit.correlation_id,
        turnId: fixture.unit.turn_id, claimEventId: claim.event.event_id, claimEpoch: 0,
        invocationStart: invocation, invocationStartedEventId: started.eventId,
      }
      await expect(commitValidatedDeliveryTruth(pg.db, fixture.unit, fixture.registration, attempted, {
        ...context, onCommitPoint: point => { if (point === 'before_terminal_append') throw new Error('kill:after-receipt') },
      })).rejects.toThrow('kill:after-receipt')
      expect(Number((await pg.db.queryOne<{ n: string }>("SELECT COUNT(*) AS n FROM event_log WHERE event_type='reply.delivered'"))?.n ?? 0)).toBe(0)
      await commitValidatedDeliveryTruth(pg.db, fixture.unit, fixture.registration, attempted, context)
      expect(Number((await pg.db.queryOne<{ n: string }>("SELECT COUNT(*) AS n FROM event_log WHERE event_type='reply.delivered'"))?.n ?? 0)).toBe(1)
    } finally { await pg.cleanup() }
  })
})
