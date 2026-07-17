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

const CONNECTOR_ID = '33333333-3333-4333-8333-333333333333'
const REGISTRATION_ID = '44444444-4444-4444-8444-444444444444'
const BINDING_ID = '55555555-5555-4555-8555-555555555555'
const BUILD_DIGEST = 'a'.repeat(64)

export function makeDeliveryFixture(
  receiptMode: 'provider_ack' | 'durable_handoff' | 'none' = 'provider_ack',
  suffix = '001',
  connectorKind = 'fixture-mcp',
): { unit: DeliveryUnitV1; registration: LoadedConnectorRegistrationV1; authority: CapabilityAuthorityV1 } {
  const capabilityMaterial = {
    schema_version: 'aun-connector-delivery-capability/v1' as const,
    connector_instance_id: CONNECTOR_ID,
    connector_kind: connectorKind,
    idempotency_mode: 'native' as const,
    receipt_mode: receiptMode,
    dedupe_scope: 'connector_instance' as const,
    dedupe_window_seconds: null,
    provider_nonce_max_bytes: 64,
    provider_nonce_charset: 'base64url',
    semantic_capabilities: ['post_message'] as Array<'post_message'>,
    reconciliation_mode: receiptMode === 'none' ? 'none' as const : 'provider_lookup' as const,
    guarantee: 'effectively_once' as const,
    typed_rate_limit_retry_budget: 1,
    ambiguous_outcome_retry_budget: 0 as const,
    adapter_contract_version: `${connectorKind}/v1`,
    adapter_build_digest: BUILD_DIGEST,
    capability_fixture_set_digest: 'b'.repeat(64),
  }
  const capability: ConnectorDeliveryCapabilityV1 = {
    ...capabilityMaterial,
    capability_digest: connectorCapabilityDigest(capabilityMaterial),
  }
  const registrationMaterial = {
    schema_version: 'aun-loaded-connector-registration/v1' as const,
    registration_id: REGISTRATION_ID,
    connector_instance_id: CONNECTOR_ID,
    connector_kind: capability.connector_kind,
    loaded_adapter_instance_id: 'fixture-loaded-1',
    adapter_contract_version: capability.adapter_contract_version,
    adapter_build_digest: capability.adapter_build_digest,
    canonical_capability_digest: capability.capability_digest,
    fixture_manifest_version: '1.0.0',
    fixture_manifest_digest: capability.capability_fixture_set_digest,
    build_test_attestation_ref: 'fixture://aun-k3',
    build_test_attestation_digest: 'c'.repeat(64),
    loader_identity_digest: 'd'.repeat(64),
    registry_generation: 1,
    status: 'active' as const,
  }
  const registration: LoadedConnectorRegistrationV1 = {
    ...registrationMaterial,
    registration_digest: loadedConnectorRegistrationDigest(registrationMaterial),
  }
  const token = `opaque-${suffix}`
  const snapshot: ResolvedDeliveryBindingSnapshotV1 = {
    schema_version: 'aun-resolved-delivery-binding-snapshot/v1',
    channel_binding_id: BINDING_ID,
    channel_id: `channel-${suffix}`,
    connector_instance_id: CONNECTOR_ID,
    connector_kind: capability.connector_kind,
    provider: connectorKind,
    provider_identity_fingerprint: 'e'.repeat(64),
    provider_channel_access_id: `provider-channel-${suffix}`,
    channel_access_generation_or_digest: 'generation-1',
    projection_identity_id: 'projection-1',
    binding_role: 'outbound',
    status: 'active',
    priority: 100,
    ordering_scope: 'channel',
    policy_source: 'fixture://aun-k3',
    routing_metadata_allowlist: {},
    opaque_address_fingerprint: opaqueAddressFingerprint(token),
    capability_digest: capability.capability_digest,
    resolver_version: 'resolver/v1',
  }
  const snapshotDigest = bindingSnapshotDigest(snapshot)
  const decisionMaterial = {
    schema_version: 'aun-resolved-delivery-decision/v1' as const,
    resolution_input_digest: '1'.repeat(64),
    evaluated_candidate_set_digest: '2'.repeat(64),
    eligible_candidate_set_digest: '3'.repeat(64),
    selected_route_digest: '4'.repeat(64),
    policy_digest: '5'.repeat(64),
    resolver_version: snapshot.resolver_version,
    selected_binding_snapshot_digest: snapshotDigest,
  }
  const decision = { ...decisionMaterial, resolved_delivery_decision_digest: resolvedDeliveryDecisionDigest(decisionMaterial) }
  const material: DeliveryDigestMaterialV1 = {
    schema_version: 'aun-delivery-digest-material/v1',
    delivery_id: `delivery-${suffix}`,
    sender_seat_id: 'aun',
    recipient_seat_id: 'spec',
    conversation_id: `conversation-${suffix}`,
    turn_id: `turn-${suffix}`,
    reply_id: `reply-${suffix}`,
    correlation_id: `correlation-${suffix}`,
    causation_id: null,
    content: { media_type: 'text/plain', text: `hello-${suffix}` },
    destination_ref: destinationRef(CONNECTOR_ID, token),
    resolved_binding_snapshot_digest: snapshotDigest,
    capability_digest: capability.capability_digest,
    required_semantic_capabilities: ['post_message'],
    required_receipt_mode: receiptMode,
    business_nonce: `out:reply-${suffix}`,
    required_guarantee: 'effectively_once',
    fanout_child_provenance: null,
  }
  const digest = deliveryDigest(material)
  const authority: CapabilityAuthorityV1 = {
    source: 'registered_loaded_adapter',
    connector_instance_id: CONNECTOR_ID,
    adapter_contract_version: capability.adapter_contract_version,
    adapter_build_digest: capability.adapter_build_digest,
    capability_digest: capability.capability_digest,
    capability_fixture_set_digest: capability.capability_fixture_set_digest,
    loaded_registration_digest: registration.registration_digest,
    caller_supplied_capability_is_authority: false,
  }
  return {
    registration,
    authority,
    unit: {
      ...material,
      schema_version: 'aun-delivery-unit/v1',
      destination: {
        schema_version: 'aun-connector-address/v1',
        connector_instance_id: CONNECTOR_ID,
        opaque_address_token: token,
        destination_ref: material.destination_ref,
        resolved_binding_snapshot_digest: snapshotDigest,
        resolved_delivery_decision_digest: decision.resolved_delivery_decision_digest,
      },
      resolved_binding_snapshot: snapshot,
      resolved_delivery_decision: decision,
      connector_capability: capability,
      capability_authority: authority,
      idempotency: {
        schema_version: 'aun-delivery-idempotency/v1',
        business_nonce: material.business_nonce,
        provider_nonce: providerNonce(material.business_nonce, digest),
        derivation_version: 'aun-provider-nonce/v1',
        delivery_digest: digest,
        required_guarantee: material.required_guarantee,
      },
    },
  }
}

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
