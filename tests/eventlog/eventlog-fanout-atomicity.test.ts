import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import {
  EventLog,
  FanoutCollisionError,
  FanoutParentLinkMismatchError,
  bindingSnapshotDigest,
  buildFanoutRequest,
  buildFanoutProvenance,
  connectorCapabilityDigest,
  deliveryDigest,
  destinationRef,
  ensureEventLogSchema,
  fanoutChildIds,
  fanoutDigest,
  fanoutParentAggregate,
  loadedConnectorRegistrationDigest,
  opaqueAddressFingerprint,
  providerNonce,
  resolvedDeliveryDecisionDigest,
  type AppendFanoutAtomicInputV1,
  type ConnectorDeliveryCapabilityV1,
  type DeliveryDigestMaterialV1,
  type DeliveryUnitV1,
  type FanoutPlanV1,
  type FanoutRequestV1,
  type LoadedConnectorRegistrationV1,
} from '../../core/eventlog'

let dir: string
let db: SqliteAdapter

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'eventlog-fanout-'))
  db = new SqliteAdapter(join(dir, 'eventlog.db'))
  await ensureEventLogSchema(db)
})

afterEach(async () => {
  await db.close().catch(() => {})
  rmSync(dir, { recursive: true, force: true })
})

const CONNECTOR_ID = '11111111-1111-4111-8111-111111111111'
const REGISTRATION_ID = '22222222-2222-4222-8222-222222222222'
const BUILD_DIGEST = 'a'.repeat(64)
const FIXTURE_DIGEST = 'b'.repeat(64)

function capability(): ConnectorDeliveryCapabilityV1 {
  const material = {
    schema_version: 'aun-connector-delivery-capability/v1' as const,
    connector_instance_id: CONNECTOR_ID,
    connector_kind: 'fake',
    idempotency_mode: 'native' as const,
    receipt_mode: 'provider_ack' as const,
    dedupe_scope: 'connector_instance' as const,
    dedupe_window_seconds: 60,
    provider_nonce_max_bytes: 25,
    provider_nonce_charset: 'ascii_base64url',
    semantic_capabilities: ['post_message'] as Array<'post_message' | 'reply_context' | 'direct_attention'>,
    reconciliation_mode: 'provider_lookup' as const,
    guarantee: 'effectively_once' as const,
    typed_rate_limit_retry_budget: 1,
    ambiguous_outcome_retry_budget: 0 as const,
    adapter_contract_version: 'fake/v1',
    adapter_build_digest: BUILD_DIGEST,
    capability_fixture_set_digest: FIXTURE_DIGEST,
  }
  return { ...material, capability_digest: connectorCapabilityDigest(material) }
}

function registration(c: ConnectorDeliveryCapabilityV1): LoadedConnectorRegistrationV1 {
  const material = {
    schema_version: 'aun-loaded-connector-registration/v1' as const,
    registration_id: REGISTRATION_ID,
    connector_instance_id: CONNECTOR_ID,
    connector_kind: 'fake',
    loaded_adapter_instance_id: 'fake-loaded-1',
    adapter_contract_version: c.adapter_contract_version,
    adapter_build_digest: c.adapter_build_digest,
    canonical_capability_digest: c.capability_digest,
    fixture_manifest_version: '1.0.0',
    fixture_manifest_digest: c.capability_fixture_set_digest,
    build_test_attestation_ref: 'fixture://fake/1',
    build_test_attestation_digest: 'c'.repeat(64),
    loader_identity_digest: 'd'.repeat(64),
    registry_generation: 1,
    status: 'active' as const,
  }
  return { ...material, registration_digest: loadedConnectorRegistrationDigest(material) }
}

function fanoutFixture(recipients = ['kodama', 'spec']): AppendFanoutAtomicInputV1 {
  const requestMaterial = {
    schema_version: 'aun-fanout-request/v1' as const,
    fanout_id: 'fanout-1',
    sender_seat_id: 'arc',
    conversation_id: 'conversation-1',
    turn_id: 'turn-1',
    parent_reply_id: 'reply-parent-1',
    correlation_id: 'correlation-1',
    causation_id: 'cause-1',
    recipient_seat_ids: recipients,
    content: { media_type: 'text/plain' as const, text: 'fanout content' },
    authority_snapshot_digest: '1'.repeat(64),
    resolver_version: 'resolver/v1',
  }
  const request: FanoutRequestV1 = buildFanoutRequest(requestMaterial)
  const provenance = buildFanoutProvenance(`fanout-planned:${request.fanout_id}`, request)
  const c = capability()
  const loaded = registration(c)
  const children: AppendFanoutAtomicInputV1['children'] = []
  const planChildren: FanoutPlanV1['children'] = []

  for (const [index, recipient] of request.recipient_seat_ids.entries()) {
    const ids = fanoutChildIds(request.fanout_id, request.fanout_digest, recipient)
    const token = `opaque:${recipient}`
    const snapshot = {
      schema_version: 'aun-resolved-delivery-binding-snapshot/v1' as const,
      channel_binding_id: `33333333-3333-4333-8333-33333333333${index}`,
      channel_id: `channel-${recipient}`,
      connector_instance_id: CONNECTOR_ID,
      connector_kind: 'fake',
      provider: 'fake',
      provider_identity_fingerprint: 'e'.repeat(64),
      provider_channel_access_id: `access-${recipient}`,
      channel_access_generation_or_digest: 'generation-1',
      projection_identity_id: null,
      binding_role: 'outbound' as const,
      status: 'active' as const,
      priority: 100 - index,
      ordering_scope: 'channel' as const,
      policy_source: 'policy://fanout',
      routing_metadata_allowlist: {},
      opaque_address_fingerprint: opaqueAddressFingerprint(token),
      capability_digest: c.capability_digest,
      resolver_version: request.resolver_version,
    }
    const snapshotDigest = bindingSnapshotDigest(snapshot)
    const decisionMaterial = {
      schema_version: 'aun-resolved-delivery-decision/v1' as const,
      resolution_input_digest: `${index + 2}`.repeat(64),
      evaluated_candidate_set_digest: '4'.repeat(64),
      eligible_candidate_set_digest: '5'.repeat(64),
      selected_route_digest: '6'.repeat(64),
      policy_digest: '7'.repeat(64),
      resolver_version: request.resolver_version,
      selected_binding_snapshot_digest: snapshotDigest,
    }
    const decision = { ...decisionMaterial, resolved_delivery_decision_digest: resolvedDeliveryDecisionDigest(decisionMaterial) }
    const destination = {
      schema_version: 'aun-connector-address/v1' as const,
      connector_instance_id: CONNECTOR_ID,
      opaque_address_token: token,
      destination_ref: destinationRef(CONNECTOR_ID, token),
      resolved_binding_snapshot_digest: snapshotDigest,
      resolved_delivery_decision_digest: decision.resolved_delivery_decision_digest,
    }
    const material: DeliveryDigestMaterialV1 = {
      schema_version: 'aun-delivery-digest-material/v1',
      delivery_id: ids.delivery_id,
      sender_seat_id: request.sender_seat_id,
      recipient_seat_id: recipient,
      conversation_id: request.conversation_id,
      turn_id: request.turn_id,
      reply_id: ids.child_reply_id,
      correlation_id: request.correlation_id,
      causation_id: request.causation_id,
      content: request.content,
      destination_ref: destination.destination_ref,
      resolved_binding_snapshot_digest: snapshotDigest,
      capability_digest: c.capability_digest,
      required_semantic_capabilities: ['post_message'],
      required_receipt_mode: 'provider_ack',
      business_nonce: `business:${recipient}`,
      required_guarantee: 'effectively_once',
      fanout_child_provenance: provenance,
    }
    const digest = deliveryDigest(material)
    const unit: DeliveryUnitV1 = {
      ...material,
      schema_version: 'aun-delivery-unit/v1',
      destination,
      resolved_binding_snapshot: snapshot,
      resolved_delivery_decision: decision,
      connector_capability: c,
      capability_authority: {
        source: 'registered_loaded_adapter',
        connector_instance_id: CONNECTOR_ID,
        adapter_contract_version: c.adapter_contract_version,
        adapter_build_digest: c.adapter_build_digest,
        capability_digest: c.capability_digest,
        capability_fixture_set_digest: c.capability_fixture_set_digest,
        loaded_registration_digest: loaded.registration_digest,
        caller_supplied_capability_is_authority: false,
      },
      idempotency: {
        schema_version: 'aun-delivery-idempotency/v1',
        business_nonce: material.business_nonce,
        provider_nonce: providerNonce(material.business_nonce, digest),
        derivation_version: 'aun-provider-nonce/v1',
        delivery_digest: digest,
        required_guarantee: 'effectively_once',
      },
    }
    children.push({ delivery_unit: unit, loaded_registration: loaded })
    planChildren.push({
      recipient_seat_id: recipient,
      child_reply_id: ids.child_reply_id,
      delivery_id: ids.delivery_id,
      destination_ref: destination.destination_ref,
      resolved_binding_snapshot_digest: snapshotDigest,
      resolved_delivery_decision_digest: decision.resolved_delivery_decision_digest,
      fanout_child_provenance_digest: provenance.provenance_digest,
    })
  }
  return {
    request,
    plan: {
      schema_version: 'aun-fanout-plan/v1',
      fanout_id: request.fanout_id,
      fanout_digest: request.fanout_digest,
      parent_reply_id: request.parent_reply_id,
      authority_snapshot_digest: request.authority_snapshot_digest,
      resolver_version: request.resolver_version,
      children: planChildren,
    },
    children,
  }
}

describe('FanoutAtomicAppendPort', () => {
  test('TN-013A/C normalizes reordered recipients and rejects empty, duplicate, or malformed input', () => {
    const ordered = fanoutFixture(['kodama', 'spec'])
    const reordered = fanoutFixture(['spec', 'kodama'])
    expect(reordered.request).toEqual(ordered.request)
    expect(reordered.plan).toEqual(ordered.plan)
    expect(reordered.children).toEqual(ordered.children)

    expect(() => fanoutFixture([])).toThrow(/recipient set is empty/)
    expect(() => fanoutFixture(['spec', 'spec'])).toThrow(/duplicates/)
    expect(() => fanoutFixture([''])).toThrow(/non-empty strings/)
  })

  test('plan plus all ordered children commit once and replay byte-identically', async () => {
    const log = new EventLog(db)
    const input = fanoutFixture()
    const first = await log.appendFanoutAtomic(input)
    expect(first.status).toBe('inserted')
    expect(first.provider_invocations).toBe(0)
    expect(first.child_events).toHaveLength(2)
    expect(await log.count()).toBe(3)
    const replay = await log.appendFanoutAtomic(structuredClone(input))
    expect(replay.status).toBe('byte_identical_existing')
    expect(await log.count()).toBe(3)
  })

  test('throw at every plan/child boundary exposes zero partial members', async () => {
    const points = ['after_plan_append', 'after_child_append:0', 'after_child_append:1', 'before_commit']
    for (const [index, killAt] of points.entries()) {
      const isolated = new SqliteAdapter(join(dir, `kill-${index}.db`))
      await ensureEventLogSchema(isolated)
      const log = new EventLog(isolated)
      const input = fanoutFixture()
      input.on_commit_point = point => {
        const rendered = point.point === 'after_child_append' ? `${point.point}:${point.child_index}` : point.point
        if (rendered === killAt) throw new Error(`kill:${killAt}`)
      }
      await expect(log.appendFanoutAtomic(input)).rejects.toThrow(`kill:${killAt}`)
      expect(await log.count()).toBe(0)
      await isolated.close()
    }
  })

  test('partial pre-existing set and changed parent are FANOUT_COLLISION with zero repair writes', async () => {
    const log = new EventLog(db)
    const input = fanoutFixture()
    await log.append({
      eventId: `fanout-planned:${input.request.fanout_id}`,
      eventType: 'reply.fanout_planned', seatId: input.request.sender_seat_id,
      conversationId: input.request.conversation_id, causationId: input.request.causation_id,
      correlationId: input.request.correlation_id, turnId: input.request.turn_id,
      replyId: input.request.parent_reply_id, payload: input.plan as unknown as Record<string, unknown>,
    })
    await expect(log.appendFanoutAtomic(input)).rejects.toBeInstanceOf(FanoutCollisionError)
    expect(await log.count()).toBe(1)

    const isolated = new SqliteAdapter(join(dir, 'changed-parent.db'))
    await ensureEventLogSchema(isolated)
    const isolatedLog = new EventLog(isolated)
    const original = fanoutFixture()
    await isolatedLog.appendFanoutAtomic(original)
    const changed = fanoutFixture()
    const requestMaterial = { ...changed.request, parent_reply_id: 'reply-parent-other' } as any
    delete requestMaterial.fanout_digest
    changed.request = { ...requestMaterial, fanout_digest: fanoutDigest(requestMaterial) }
    await expect(isolatedLog.appendFanoutAtomic(changed)).rejects.toBeInstanceOf(FanoutCollisionError)
    expect(await isolatedLog.count()).toBe(3)
    await isolated.close()
  })

  test('TN-013D authority snapshot drift before atomic commit leaves zero plan and child events', async () => {
    const log = new EventLog(db)
    const input = fanoutFixture()
    const changedMaterial = {
      ...input.request,
      authority_snapshot_digest: 'f'.repeat(64),
    } as any
    delete changedMaterial.fanout_digest
    input.request = buildFanoutRequest(changedMaterial)

    await expect(log.appendFanoutAtomic(input)).rejects.toBeInstanceOf(FanoutCollisionError)
    expect(await log.count()).toBe(0)
  })
})

function deliveredPayload(input: AppendFanoutAtomicInputV1, childIndex: number) {
  const child = input.plan.children[childIndex]!
  const unit = input.children[childIndex]!.delivery_unit
  return {
    reply_id: child.child_reply_id,
    delivery_id: child.delivery_id,
    recipient_seat_id: child.recipient_seat_id,
    receipt_digest: '8'.repeat(64),
    provider_request_digest: '9'.repeat(64),
    resolved_delivery_decision_digest: unit.resolved_delivery_decision.resolved_delivery_decision_digest,
    fanout_child_provenance_digest: child.fanout_child_provenance_digest,
  }
}

describe('persisted fanout parent aggregate', () => {
  test('only all expected provenance-matched provider terminals deliver the parent', async () => {
    const log = new EventLog(db)
    const input = fanoutFixture()
    const committed = await log.appendFanoutAtomic(input)
    expect((await fanoutParentAggregate(db, committed.plan_event.event_id)).parent_delivered).toBe(false)
    for (let index = 0; index < input.plan.children.length; index += 1) {
      const child = input.plan.children[index]!
      await log.append({
        eventId: `delivered:${child.child_reply_id}`,
        eventType: 'reply.delivered', replyId: child.child_reply_id,
        claimEpoch: 0, payload: deliveredPayload(input, index),
      })
    }
    const aggregate = await fanoutParentAggregate(db, committed.plan_event.event_id)
    expect(aggregate.parent_delivered).toBe(true)
    expect(aggregate.validated_delivered_delivery_ids).toEqual(input.plan.children.map(child => child.delivery_id).sort())
  })

  test('wrong child provenance and same-fanout out-of-plan terminal fail closed', async () => {
    const input = fanoutFixture()
    const log = new EventLog(db)
    const committed = await log.appendFanoutAtomic(input)
    const first = input.plan.children[0]!
    const wrong = deliveredPayload(input, 0)
    wrong.fanout_child_provenance_digest = 'f'.repeat(64)
    await log.append({ eventId: 'wrong-terminal', eventType: 'reply.delivered', replyId: first.child_reply_id, payload: wrong })
    await expect(fanoutParentAggregate(db, committed.plan_event.event_id)).rejects.toBeInstanceOf(FanoutParentLinkMismatchError)

    const isolated = new SqliteAdapter(join(dir, 'foreign.db'))
    await ensureEventLogSchema(isolated)
    const isolatedLog = new EventLog(isolated)
    const isolatedCommitted = await isolatedLog.appendFanoutAtomic(input)
    const foreign = { ...deliveredPayload(input, 0), reply_id: 'foreign-reply', delivery_id: 'foreign-delivery', recipient_seat_id: 'foreign-seat' }
    await isolatedLog.append({ eventId: 'foreign-terminal', eventType: 'reply.delivered', replyId: foreign.reply_id, payload: foreign })
    await expect(fanoutParentAggregate(isolated, isolatedCommitted.plan_event.event_id)).rejects.toBeInstanceOf(FanoutParentLinkMismatchError)
    await isolated.close()
  })
})
