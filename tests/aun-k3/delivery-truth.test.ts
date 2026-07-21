import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import type { DbAdapter } from '../../core/db/adapter'
import {
  CONTRACT_DOMAINS,
  EventLog,
  bindingSnapshotDigest,
  connectorCapabilityDigest,
  deliveryDigest,
  destinationRef,
  digestCanonical,
  dispatchV2OutboxOnce,
  ensureEventLogSchema,
  loadedConnectorRegistrationDigest,
  opaqueAddressFingerprint,
  providerNonce,
  resolvedDeliveryDecisionDigest,
  transportReceiptDigest,
  durableHandoffReceiptDigest,
  deliveryTruthView,
  type CapabilityAuthorityV1,
  type ConnectorDeliveryCapabilityV1,
  type DeliveryDigestMaterialV1,
  type DeliveryUnitV1,
  type DurableHandoffTransportReceiptV1,
  type FrozenProviderRequestEnvelopeV1,
  type LoadedConnectorRegistrationV1,
  type ProviderAckTransportReceiptV1,
  type ResolvedDeliveryBindingSnapshotV1,
  type V2DeliveryAttemptResult,
  type V2DeliveryPreparedAttempt,
  type V2DeliveryTransportAdapter,
} from '../../core/eventlog'
import { makeDeliveryFixture } from './delivery-fixture'
export { makeDeliveryFixture } from './delivery-fixture'

const CONNECTOR_ID = '33333333-3333-4333-8333-333333333333'

export class FakeV2Adapter implements V2DeliveryTransportAdapter {
  calls = 0
  constructor(readonly scripted: 'provider_ack' | 'durable_handoff' | 'delivery_unknown') {}

  prepare(unit: DeliveryUnitV1, _registration?: LoadedConnectorRegistrationV1): V2DeliveryPreparedAttempt {
    const payload = { schema_version: 'fixture-mcp-provider-request/v1', content: unit.content.text, nonce: unit.idempotency.provider_nonce }
    const request: FrozenProviderRequestEnvelopeV1 = {
      schema_version: 'aun-frozen-provider-request-envelope/v1',
      connector_kind: unit.connector_capability.connector_kind,
      connector_instance_id: unit.destination.connector_instance_id,
      adapter_contract_version: unit.capability_authority.adapter_contract_version,
      adapter_build_digest: unit.capability_authority.adapter_build_digest,
      provider_request_schema_version: payload.schema_version,
      provider_request_digest: digestCanonical('fixture-mcp-provider-request/v1\n', payload),
      provider_request_payload: payload,
    }
    return { request, concrete_dedupe_scope_identity: 'f'.repeat(64) }
  }

  async sendPrepared(
    prepared: V2DeliveryPreparedAttempt,
    unit: DeliveryUnitV1,
    _registration?: LoadedConnectorRegistrationV1,
  ): Promise<V2DeliveryAttemptResult> {
    this.calls += 1
    if (this.scripted === 'delivery_unknown') return { outcome: 'delivery_unknown', request: prepared.request, failure_code: 'NO_RECEIPT' }
    if (this.scripted === 'durable_handoff') {
      const material: Omit<DurableHandoffTransportReceiptV1, 'receipt_digest'> = {
        schema_version: 'aun-durable-handoff-transport-receipt/v1', delivery_id: unit.delivery_id,
        reply_id: unit.reply_id, recipient_seat_id: unit.recipient_seat_id,
        connector_instance_id: unit.destination.connector_instance_id,
        channel_binding_id: unit.resolved_binding_snapshot.channel_binding_id,
        destination_ref: unit.destination_ref, resolved_binding_snapshot_digest: unit.resolved_binding_snapshot_digest,
        resolved_delivery_decision_digest: unit.resolved_delivery_decision.resolved_delivery_decision_digest,
        capability_digest: unit.capability_digest,
        opaque_address_fingerprint: unit.resolved_binding_snapshot.opaque_address_fingerprint,
        business_nonce: unit.business_nonce, provider_nonce: unit.idempotency.provider_nonce,
        delivery_digest: unit.idempotency.delivery_digest, receipt_mode: 'durable_handoff',
        receipt_id: `handoff-${unit.delivery_id}`, durable_placement_digest: '8'.repeat(64),
        acknowledged_at: '2026-07-17T00:00:00Z', proof_tier: 'durable_handoff',
      }
      return { outcome: 'durable_handoff', receipt: { ...material, receipt_digest: durableHandoffReceiptDigest(material) } }
    }
    const ackPayload = { schema_version: 'fixture-mcp-provider-ack/v1', receipt_id: `ack-${unit.delivery_id}` }
    const ackEnvelope = {
      schema_version: 'aun-connector-provider-ack-envelope/v1' as const,
      connector_kind: unit.connector_capability.connector_kind,
      connector_instance_id: unit.destination.connector_instance_id,
      adapter_contract_version: unit.capability_authority.adapter_contract_version,
      adapter_build_digest: unit.capability_authority.adapter_build_digest,
      provider_ack_schema_version: ackPayload.schema_version,
      provider_request_digest: prepared.request.provider_request_digest,
      provider_ack_digest: digestCanonical('fixture-mcp-provider-ack/v1\n', ackPayload),
      provider_ack_payload: ackPayload,
    }
    const material: Omit<ProviderAckTransportReceiptV1, 'receipt_digest'> = {
      schema_version: 'aun-provider-ack-transport-receipt/v1', delivery_id: unit.delivery_id,
      reply_id: unit.reply_id, recipient_seat_id: unit.recipient_seat_id,
      connector_instance_id: unit.destination.connector_instance_id,
      channel_binding_id: unit.resolved_binding_snapshot.channel_binding_id,
      destination_ref: unit.destination_ref, resolved_binding_snapshot_digest: unit.resolved_binding_snapshot_digest,
      capability_digest: unit.capability_digest,
      opaque_address_fingerprint: unit.resolved_binding_snapshot.opaque_address_fingerprint,
      business_nonce: unit.business_nonce, provider_nonce: unit.idempotency.provider_nonce,
      delivery_digest: unit.idempotency.delivery_digest,
      resolved_delivery_decision_digest: unit.resolved_delivery_decision.resolved_delivery_decision_digest,
      provider_request_digest: prepared.request.provider_request_digest, receipt_mode: 'provider_ack',
      receipt_id: `receipt-${unit.delivery_id}`, provider_ack: ackEnvelope,
      acknowledged_at: '2026-07-17T00:00:00Z', proof_tier: 'provider_acknowledged',
    }
    return { outcome: 'provider_ack', request: prepared.request, receipt: { ...material, receipt_digest: transportReceiptDigest(material) } }
  }
}

export async function appendUnit(db: DbAdapter, fixture: ReturnType<typeof makeDeliveryFixture>): Promise<void> {
  await new EventLog(db).append({
    eventId: `enqueued:${fixture.unit.reply_id}`,
    eventType: 'reply.enqueued',
    seatId: fixture.unit.sender_seat_id,
    conversationId: fixture.unit.conversation_id,
    correlationId: fixture.unit.correlation_id,
    turnId: fixture.unit.turn_id,
    replyId: fixture.unit.reply_id,
    payload: fixture.unit as unknown as Record<string, unknown>,
  })
}

let dir: string
let db: SqliteAdapter
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aun-k3-truth-'))
  db = new SqliteAdapter(join(dir, 'eventlog.db'))
  await ensureEventLogSchema(db)
})
afterEach(async () => {
  await db.close()
  rmSync(dir, { recursive: true, force: true })
})

async function dispatch(fixture: ReturnType<typeof makeDeliveryFixture>, adapter: FakeV2Adapter) {
  await appendUnit(db, fixture)
  return dispatchV2OutboxOnce(db, adapter, {
    dispatcherId: 'aun-k3-dispatcher', dispatcherInstanceId: 'dispatcher-1',
    targetConnectorInstanceId: CONNECTOR_ID,
    loadRegistration: () => fixture.registration,
  })
}

describe('K3 validated delivery truth', () => {
  test('TC001 provider acknowledgement commits one delivered truth and one effect', async () => {
    const fixture = makeDeliveryFixture('provider_ack')
    const adapter = new FakeV2Adapter('provider_ack')
    const result = await dispatch(fixture, adapter)
    expect(result.delivered).toEqual([fixture.unit.reply_id])
    expect(result.providerInvocations).toBe(1)
    expect(adapter.calls).toBe(1)
    expect((await deliveryTruthView(db))[0]?.state).toBe('delivered')
    expect(Number((await db.queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM event_log WHERE event_type='reply.delivered'"))?.n)).toBe(1)
  })

  test('TC002 durable placement is handoff truth, never provider-delivered truth', async () => {
    const fixture = makeDeliveryFixture('durable_handoff')
    const result = await dispatch(fixture, new FakeV2Adapter('durable_handoff'))
    expect(result.delivered).toEqual([])
    expect((await deliveryTruthView(db))[0]?.state).toBe('handoff_accepted')
    expect(Number((await db.queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM event_log WHERE event_type='reply.delivered'"))?.n)).toBe(0)
  })

  test('TC003 absent receipt becomes unknown and is excluded from ordinary retry', async () => {
    const fixture = makeDeliveryFixture('none')
    const adapter = new FakeV2Adapter('delivery_unknown')
    const first = await dispatch(fixture, adapter)
    const second = await dispatchV2OutboxOnce(db, adapter, {
      dispatcherId: 'aun-k3-dispatcher', dispatcherInstanceId: 'dispatcher-2',
      targetConnectorInstanceId: CONNECTOR_ID, loadRegistration: () => fixture.registration,
    })
    expect(first.deliveryUnknown).toEqual([fixture.unit.reply_id])
    expect(second.providerInvocations).toBe(0)
    expect(adapter.calls).toBe(1)
    expect((await deliveryTruthView(db))[0]?.state).toBe('delivery_unknown')
  })
})
