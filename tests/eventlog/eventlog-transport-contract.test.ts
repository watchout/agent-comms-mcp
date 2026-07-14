import { describe, expect, test } from 'bun:test'
import {
  CONTRACT_DOMAINS,
  LOADED_CONNECTOR_REGISTRATION_EVENT_ID_VECTOR,
  REOPENED_PAYLOAD_VECTOR_CANONICAL_JSON,
  REOPENED_PAYLOAD_VECTOR_DIGEST,
  RETRY_BUDGET_AUTHORITY_VECTOR_CANONICAL_JSON,
  RETRY_BUDGET_AUTHORITY_VECTOR_DIGEST,
  attestationDigest,
  bindingSnapshotDigest,
  canonicalJson,
  connectorCapabilityDigest,
  decodeConnectorProviderAckEnvelope,
  decodeFrozenProviderRequestEnvelope,
  decodeLoadedConnectorRegistration,
  decodeTransportReceipt,
  decodeDiscordProviderAck,
  decodeEvidenceRecord,
  decodeProducerRegistration,
  decodeReconciliationObservation,
  decodeRetryBudgetAuthority,
  deliveryDigest,
  durableHandoffReceiptDigest,
  destinationRef,
  discordProviderRequestDigest,
  discordProviderResponseDigest,
  digestCanonical,
  loadedConnectorRegistrationDigest,
  loadedConnectorRegistrationEventId,
  opaqueAddressFingerprint,
  producerRegistrationDigest,
  providerNonce,
  providerDedupeScopeDigest,
  reconciliationObservationDigest,
  reconciliationRequestDigest,
  resolvedDeliveryDecisionDigest,
  sha256Utf8,
  transportReceiptDigest,
  validateDeliveryUnit,
  validateDiscordAckEnvelope,
  validateDiscordFrozenRequestEnvelope,
  validateDiscordProviderAck,
  validateTransportReceiptForDelivery,
  zeroEffectEvidenceDigest,
  type CapabilityAuthorityV1,
  type ConnectorDeliveryCapabilityV1,
  type DeliveryDigestMaterialV1,
  type DeliveryUnitV1,
  type DurableHandoffTransportReceiptV1,
  type DiscordProviderAckV1,
  type DiscordProviderRequestV1,
  type FrozenProviderRequestEnvelopeV1,
  type LoadedConnectorRegistrationV1,
  type ProviderAckTransportReceiptV1,
  type ResolvedDeliveryBindingSnapshotV1,
  type ResolvedDeliveryDecisionV1,
  type RetryBudgetAuthorityV1,
  type ZeroEffectProducerRegistrationV1,
} from '../../core/eventlog/transport-contract'

const CONNECTOR_ID = '11111111-1111-4111-8111-111111111111'
const BINDING_ID = '22222222-2222-4222-8222-222222222222'
const REGISTRATION_ID = '33333333-3333-4333-8333-333333333333'
const BUILD_DIGEST = 'a'.repeat(64)
const FIXTURE_DIGEST = 'b'.repeat(64)

function capability(receiptMode: 'provider_ack' | 'durable_handoff' | 'none' = 'provider_ack'): ConnectorDeliveryCapabilityV1 {
  const material = {
    schema_version: 'aun-connector-delivery-capability/v1' as const,
    connector_instance_id: CONNECTOR_ID,
    connector_kind: 'discord',
    idempotency_mode: 'native' as const,
    receipt_mode: receiptMode,
    dedupe_scope: 'same_author' as const,
    dedupe_window_seconds: null,
    provider_nonce_max_bytes: 25,
    provider_nonce_charset: 'ascii_base64url',
    semantic_capabilities: ['direct_attention', 'post_message', 'reply_context'] as Array<'post_message' | 'reply_context' | 'direct_attention'>,
    reconciliation_mode: 'none' as const,
    guarantee: 'effectively_once' as const,
    typed_rate_limit_retry_budget: 1,
    ambiguous_outcome_retry_budget: 0 as const,
    adapter_contract_version: 'discord-transport/v1',
    adapter_build_digest: BUILD_DIGEST,
    capability_fixture_set_digest: FIXTURE_DIGEST,
  }
  return { ...material, capability_digest: connectorCapabilityDigest(material) }
}

function loadedRegistration(c: ConnectorDeliveryCapabilityV1): LoadedConnectorRegistrationV1 {
  const material = {
    schema_version: 'aun-loaded-connector-registration/v1' as const,
    registration_id: REGISTRATION_ID,
    connector_instance_id: CONNECTOR_ID,
    connector_kind: 'discord',
    loaded_adapter_instance_id: 'discord-loaded-1',
    adapter_contract_version: c.adapter_contract_version,
    adapter_build_digest: c.adapter_build_digest,
    canonical_capability_digest: c.capability_digest,
    fixture_manifest_version: '1.0.0',
    fixture_manifest_digest: c.capability_fixture_set_digest,
    build_test_attestation_ref: 'fixture://discord/1',
    build_test_attestation_digest: 'c'.repeat(64),
    loader_identity_digest: 'd'.repeat(64),
    registry_generation: 1,
    status: 'active' as const,
  }
  return { ...material, registration_digest: loadedConnectorRegistrationDigest(material) }
}

function deliveryFixture(receiptMode: 'provider_ack' | 'durable_handoff' | 'none' = 'provider_ack'): { unit: DeliveryUnitV1; registration: LoadedConnectorRegistrationV1; authority: CapabilityAuthorityV1 } {
  const c = capability(receiptMode)
  const registration = loadedRegistration(c)
  const token = 'opaque-discord-channel-1'
  const snapshot: ResolvedDeliveryBindingSnapshotV1 = {
    schema_version: 'aun-resolved-delivery-binding-snapshot/v1',
    channel_binding_id: BINDING_ID,
    channel_id: 'channel-1',
    connector_instance_id: CONNECTOR_ID,
    connector_kind: 'discord',
    provider: 'discord',
    provider_identity_fingerprint: 'e'.repeat(64),
    provider_channel_access_id: 'access-1',
    channel_access_generation_or_digest: 'access-generation-1',
    projection_identity_id: 'projection-1',
    binding_role: 'outbound',
    status: 'active',
    priority: 100,
    ordering_scope: 'channel',
    policy_source: 'policy://transport-neutral',
    routing_metadata_allowlist: {},
    opaque_address_fingerprint: opaqueAddressFingerprint(token),
    capability_digest: c.capability_digest,
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
  const decision: ResolvedDeliveryDecisionV1 = {
    ...decisionMaterial,
    resolved_delivery_decision_digest: resolvedDeliveryDecisionDigest(decisionMaterial),
  }
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
    delivery_id: 'delivery-001',
    sender_seat_id: 'arc',
    recipient_seat_id: 'spec',
    conversation_id: 'conv-001',
    turn_id: 'turn-001',
    reply_id: 'reply-001',
    correlation_id: 'corr-001',
    causation_id: null,
    content: { media_type: 'text/plain', text: 'hello' },
    destination_ref: destination.destination_ref,
    resolved_binding_snapshot_digest: snapshotDigest,
    capability_digest: c.capability_digest,
    required_semantic_capabilities: ['post_message'],
    required_receipt_mode: receiptMode,
    business_nonce: 'out:reply-001',
    required_guarantee: 'effectively_once',
    fanout_child_provenance: null,
  }
  const digest = deliveryDigest(material)
  const authority: CapabilityAuthorityV1 = {
    source: 'registered_loaded_adapter',
    connector_instance_id: CONNECTOR_ID,
    adapter_contract_version: c.adapter_contract_version,
    adapter_build_digest: c.adapter_build_digest,
    capability_digest: c.capability_digest,
    capability_fixture_set_digest: c.capability_fixture_set_digest,
    loaded_registration_digest: registration.registration_digest,
    caller_supplied_capability_is_authority: false,
  }
  const unit: DeliveryUnitV1 = {
    ...material,
    schema_version: 'aun-delivery-unit/v1',
    destination,
    resolved_binding_snapshot: snapshot,
    resolved_delivery_decision: decision,
    connector_capability: c,
    capability_authority: authority,
    idempotency: {
      schema_version: 'aun-delivery-idempotency/v1',
      business_nonce: material.business_nonce,
      provider_nonce: providerNonce(material.business_nonce, digest),
      derivation_version: 'aun-provider-nonce/v1',
      delivery_digest: digest,
      required_guarantee: material.required_guarantee,
    },
  }
  return { unit, registration, authority }
}

function discordRequest(unit: DeliveryUnitV1): DiscordProviderRequestV1 {
  const material = {
    schema_version: 'aun-discord-provider-request/v1' as const,
    connector_instance_id: CONNECTOR_ID,
    adapter_build_digest: BUILD_DIGEST,
    channel_id: 'provider-channel-1',
    thread_id: null,
    message_reference: null,
    final_content_utf8: unit.content.text,
    allowed_mentions: { parse: ['roles', 'users'] as Array<'everyone' | 'roles' | 'users'>, roles: [], users: ['user-1'], replied_user: false },
    direct_attention_targets: ['user-1'],
    provider_nonce: unit.idempotency.provider_nonce,
    enforce_nonce: true as const,
    projection_identity_id: 'projection-1',
    expected_mention_everyone: false,
    expected_mentioned_user_ids: ['user-1'],
    expected_mentioned_role_ids: [],
  }
  return { ...material, provider_request_digest: discordProviderRequestDigest(material) }
}

function discordAck(request: DiscordProviderRequestV1): DiscordProviderAckV1 {
  const material = {
    schema_version: 'aun-discord-provider-ack/v1' as const,
    provider_request_digest: request.provider_request_digest,
    actual_provider_request_digest: request.provider_request_digest,
    message_id: 'provider-message-1',
    channel_id: request.channel_id,
    thread_id: request.thread_id,
    nonce: request.provider_nonce,
    author_id: request.projection_identity_id,
    message_reference: request.message_reference,
    actual_content_utf8: request.final_content_utf8,
    mention_everyone: request.expected_mention_everyone,
    mentioned_user_ids: request.expected_mentioned_user_ids,
    mentioned_role_ids: request.expected_mentioned_role_ids,
  }
  return { ...material, provider_response_digest: discordProviderResponseDigest(material) }
}

describe('Transport-Neutral Contract r1.1.4 literal vectors', () => {
  test('loaded-registration event identity reproduces 41/82/123 bytes and exact digest', () => {
    const vector = LOADED_CONNECTOR_REGISTRATION_EVENT_ID_VECTOR
    const key = canonicalJson({ registration_id: vector.registration_id, registry_generation: vector.registry_generation })
    expect(Buffer.byteLength(CONTRACT_DOMAINS.loadedRegistrationKey)).toBe(41)
    expect(Buffer.byteLength(key)).toBe(82)
    expect(Buffer.byteLength(CONTRACT_DOMAINS.loadedRegistrationKey + key)).toBe(123)
    expect(sha256Utf8(CONTRACT_DOMAINS.loadedRegistrationKey + key)).toBe(vector.sha256)
    expect(loadedConnectorRegistrationEventId(vector.registration_id, vector.registry_generation)).toBe(vector.event_id)
  })

  test('request, observation, authority, and reopened payload vectors are byte exact', () => {
    const request = {
      schema_version: 'aun-delivery-unknown-reconciliation-request/v1' as const,
      reconciliation_id: 'recon-001', delivery_unknown_event_id: 'delivery-unknown:evt-001', delivery_unknown_event_digest: '1'.repeat(64),
      reply_id: 'reply-001', delivery_id: 'delivery-001', recipient_seat_id: 'spec', attempt_ordinal: 0,
      connector_instance_id: CONNECTOR_ID, resolved_binding_snapshot_digest: '2'.repeat(64), resolved_delivery_decision_digest: '3'.repeat(64),
      delivery_digest: '4'.repeat(64), provider_request_digest: '5'.repeat(64), business_nonce: 'business-001', provider_nonce: 'provider-001',
      capability_digest: '6'.repeat(64), reconciliation_mode: 'provider_lookup' as const, reconciler_registration_digest: '7'.repeat(64),
    }
    const requestDigest = reconciliationRequestDigest(request)
    expect(Buffer.byteLength(CONTRACT_DOMAINS.reconciliationRequest + canonicalJson(request))).toBe(1136)
    expect(requestDigest).toBe('fd910d0635103dac95e6278a82cf5fee68d25a3ceb63907eabd2677499d2240a')
    const observation = {
      schema_version: 'aun-delivery-unknown-reconciliation-observation/v1' as const,
      reconciliation_request_digest: requestDigest,
      observed_outcome: 'not_found' as const,
      validated_receipt_digest: null,
      permanent_failure_code: null,
      zero_external_effect_attestation_digest: null,
      evidence_digest: '8'.repeat(64),
    }
    expect(Buffer.byteLength(CONTRACT_DOMAINS.reconciliationObservation + canonicalJson(observation))).toBe(446)
    expect(reconciliationObservationDigest(observation)).toBe('2c5b765c6d73a4855889ee76d9ced137c83673a48c4a7c3f75a0ef1323c89877')
    expect(Buffer.byteLength(CONTRACT_DOMAINS.retryBudgetAuthority + RETRY_BUDGET_AUTHORITY_VECTOR_CANONICAL_JSON)).toBe(519)
    expect(sha256Utf8(CONTRACT_DOMAINS.retryBudgetAuthority + RETRY_BUDGET_AUTHORITY_VECTOR_CANONICAL_JSON)).toBe(RETRY_BUDGET_AUTHORITY_VECTOR_DIGEST)
    expect(Buffer.byteLength(REOPENED_PAYLOAD_VECTOR_CANONICAL_JSON)).toBe(1117)
    expect(sha256Utf8(REOPENED_PAYLOAD_VECTOR_CANONICAL_JSON)).toBe(REOPENED_PAYLOAD_VECTOR_DIGEST)
  })

  test('equal opaque addresses remain isolated by connector namespace', () => {
    const otherConnector = '99999999-9999-4999-8999-999999999999'
    expect(destinationRef(CONNECTOR_ID, 'same-opaque-address'))
      .not.toBe(destinationRef(otherConnector, 'same-opaque-address'))
  })

  test('TN-014 provider nonce golden vector is deterministic and exactly 25 ASCII bytes', () => {
    const digest = 'd75129e1333b12b69619eb2545d8cfdfe5334e773239e36e936fbef75cca84d6'
    const nonce = providerNonce('out:reply-001', digest)
    expect(nonce).toBe('a1_o-ZH85mRR1qQuZcQUEwHST')
    expect(Buffer.byteLength(nonce, 'ascii')).toBe(25)
    expect(nonce).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})

describe('strict decoders and authority recomputation', () => {
  test('delivery validation requires exact persisted loaded registration', () => {
    const { unit, registration } = deliveryFixture()
    expect(() => validateDeliveryUnit(unit, registration)).not.toThrow()
    const changed = { ...registration, status: 'revoked' as const }
    changed.registration_digest = loadedConnectorRegistrationDigest(changed)
    expect(() => validateDeliveryUnit(unit, changed)).toThrow(/LOADED_REGISTRATION_UNPROVEN/)
    const callerMinted = structuredClone(unit)
    callerMinted.capability_authority.loaded_registration_digest = 'f'.repeat(64)
    expect(() => validateDeliveryUnit(callerMinted, registration)).toThrow(/LOADED_REGISTRATION_UNPROVEN/)

    const wrongSnapshotKind = structuredClone(unit)
    wrongSnapshotKind.resolved_binding_snapshot.connector_kind = 'mcp'
    const snapshotDigest = bindingSnapshotDigest(wrongSnapshotKind.resolved_binding_snapshot)
    wrongSnapshotKind.resolved_binding_snapshot_digest = snapshotDigest
    wrongSnapshotKind.destination.resolved_binding_snapshot_digest = snapshotDigest
    const decisionMaterial = { ...wrongSnapshotKind.resolved_delivery_decision } as any
    delete decisionMaterial.resolved_delivery_decision_digest
    decisionMaterial.selected_binding_snapshot_digest = snapshotDigest
    wrongSnapshotKind.resolved_delivery_decision = {
      ...decisionMaterial,
      resolved_delivery_decision_digest: resolvedDeliveryDecisionDigest(decisionMaterial),
    }
    wrongSnapshotKind.destination.resolved_delivery_decision_digest = wrongSnapshotKind.resolved_delivery_decision.resolved_delivery_decision_digest
    expect(() => validateDeliveryUnit(wrongSnapshotKind, registration)).toThrow(/binding snapshot authority/)
  })

  test('loaded registration requires a strict semantic-version fixture manifest', () => {
    const { registration } = deliveryFixture()
    const invalid = { ...registration, fixture_manifest_version: 'latest' }
    invalid.registration_digest = loadedConnectorRegistrationDigest(invalid)
    expect(() => decodeLoadedConnectorRegistration(invalid)).toThrow(/must be semver/)

    const fullSemver = { ...registration, fixture_manifest_version: '1.2.3-alpha.1+build.5' }
    fullSemver.registration_digest = loadedConnectorRegistrationDigest(fullSemver)
    expect(decodeLoadedConnectorRegistration(fullSemver)).toEqual(fullSemver)
  })

  test('unknown observation enum remains rejected even with a recomputed digest', () => {
    const body: any = {
      schema_version: 'aun-delivery-unknown-reconciliation-observation/v1', reconciliation_request_digest: '1'.repeat(64),
      observed_outcome: 'invented_success', validated_receipt_digest: null, permanent_failure_code: null,
      zero_external_effect_attestation_digest: null, evidence_digest: '2'.repeat(64),
    }
    body.observation_digest = reconciliationObservationDigest(body)
    expect(() => decodeReconciliationObservation(body)).toThrow(/unknown observed_outcome/)
  })

  test('registration status, interval, and producer/evidence mapping fail closed', () => {
    const base: Omit<ZeroEffectProducerRegistrationV1, 'registration_digest'> = {
      schema_version: 'aun-zero-effect-producer-registration/v1', registration_id: '44444444-4444-4444-8444-444444444444',
      producer_instance_id: 'producer-1', producer_kind: 'invocation_guard', connector_instance_id: CONNECTOR_ID,
      capability_digest: '1'.repeat(64), authorized_evidence_kinds: ['typed_pre_invocation_failure'], verifier_contract_version: 'v1',
      producer_build_digest: '2'.repeat(64), build_test_attestation_digest: '3'.repeat(64), registry_generation: 1,
      valid_from: '2026-07-13T00:00:00Z', expires_at: '2026-07-13T01:00:00Z', status: 'active',
    }
    const valid = { ...base, registration_digest: producerRegistrationDigest(base) }
    expect(() => decodeProducerRegistration(valid)).not.toThrow()
    const invented: any = { ...valid, status: 'paused' }
    invented.registration_digest = digestCanonical(CONTRACT_DOMAINS.producerRegistration, Object.fromEntries(Object.entries(invented).filter(([key]) => key !== 'registration_digest')))
    expect(() => decodeProducerRegistration(invented)).toThrow(/invalid producer registration status/)
    const invalidInterval: any = { ...valid, expires_at: valid.valid_from }
    invalidInterval.registration_digest = digestCanonical(CONTRACT_DOMAINS.producerRegistration, Object.fromEntries(Object.entries(invalidInterval).filter(([key]) => key !== 'registration_digest')))
    expect(() => decodeProducerRegistration(invalidInterval)).toThrow(/interval/)
    const wrongPair: any = { ...valid, authorized_evidence_kinds: ['verified_lookup_no_effect'] }
    wrongPair.registration_digest = digestCanonical(CONTRACT_DOMAINS.producerRegistration, Object.fromEntries(Object.entries(wrongPair).filter(([key]) => key !== 'registration_digest')))
    expect(() => decodeProducerRegistration(wrongPair)).toThrow(/exact singleton/)
    const objectMasqueradingAsArray: any = {
      ...valid,
      authorized_evidence_kinds: { 0: 'typed_pre_invocation_failure', length: 1 },
    }
    objectMasqueradingAsArray.registration_digest = producerRegistrationDigest(objectMasqueradingAsArray)
    expect(() => decodeProducerRegistration(objectMasqueradingAsArray)).toThrow(/must be an array/)
  })

  test('numeric nonce and invented pre-invocation failure code are rejected after digest recompute', () => {
    const body: any = {
      delivery_id: 'delivery-1', attempt_ordinal: 0, provider_request_digest: '1'.repeat(64), provider_nonce: 123,
      nonce_reservation_event_id: 'reservation-1', invocation_started_event_id: null, failure_code: 'invented_failure',
    }
    const record: any = {
      schema_version: 'aun-zero-external-effect-evidence/v1', evidence_kind: 'typed_pre_invocation_failure', evidence_body: body,
      evidence_digest: zeroEffectEvidenceDigest('typed_pre_invocation_failure', body),
    }
    expect(() => decodeEvidenceRecord(record)).toThrow(/provider_nonce/)
    body.provider_nonce = 'nonce-1'
    record.evidence_digest = zeroEffectEvidenceDigest('typed_pre_invocation_failure', body)
    expect(() => decodeEvidenceRecord(record)).toThrow(/failure_code/)
  })

  test('retired budget generation alias and noncontiguous values are rejected', () => {
    const material = JSON.parse(RETRY_BUDGET_AUTHORITY_VECTOR_CANONICAL_JSON) as Omit<RetryBudgetAuthorityV1, 'authority_digest'>
    const valid = { ...material, authority_digest: RETRY_BUDGET_AUTHORITY_VECTOR_DIGEST }
    expect(() => decodeRetryBudgetAuthority(valid)).not.toThrow()
    const retired: any = { ...valid, generation: 1 }
    retired.authority_digest = digestCanonical(CONTRACT_DOMAINS.retryBudgetAuthority, Object.fromEntries(Object.entries(retired).filter(([key]) => key !== 'authority_digest')))
    expect(() => decodeRetryBudgetAuthority(retired)).toThrow(/extra=\[generation\]/)
  })

  test('dedupe scope authority rejects unknown enums, extras, and invalid nullability', () => {
    const valid = {
      connector_instance_id: CONNECTOR_ID, dedupe_scope: 'same_author' as const,
      provider_author_identity_id: 'provider-author-1', provider_author_identity_fingerprint: '1'.repeat(64),
      channel_scope_ref: null, thread_scope_ref: null,
    }
    expect(providerDedupeScopeDigest(valid)).toMatch(/^[0-9a-f]{64}$/)
    expect(() => providerDedupeScopeDigest({ ...valid, dedupe_scope: 'invented' as any })).toThrow(/unknown dedupe_scope/)
    expect(() => providerDedupeScopeDigest({ ...valid, latency_ms: 1 } as any)).toThrow(/extra=\[latency_ms\]/)
    expect(() => providerDedupeScopeDigest({ ...valid, provider_author_identity_id: null })).toThrow(/provider_author_identity_id/)
    expect(() => providerDedupeScopeDigest({
      ...valid,
      dedupe_scope: 'channel',
      provider_author_identity_id: null,
      provider_author_identity_fingerprint: null,
      channel_scope_ref: 'not-a-sha',
    })).toThrow(/channel_scope_ref must be lowercase sha256/)
  })
})

describe('strict frozen Discord request and acknowledgement envelopes', () => {
  test('exact request/ack subtype round trip passes and wrong effect fails', () => {
    const { unit, authority } = deliveryFixture()
    const request = discordRequest(unit)
    const requestEnvelope: FrozenProviderRequestEnvelopeV1 = {
      schema_version: 'aun-frozen-provider-request-envelope/v1', connector_kind: 'discord', connector_instance_id: CONNECTOR_ID,
      adapter_contract_version: authority.adapter_contract_version, adapter_build_digest: authority.adapter_build_digest,
      provider_request_schema_version: request.schema_version, provider_request_digest: request.provider_request_digest,
      provider_request_payload: request as unknown as Record<string, unknown>,
    }
    expect(validateDiscordFrozenRequestEnvelope(requestEnvelope, authority).request).toEqual(request)
    const ack = discordAck(request)
    expect(() => validateDiscordProviderAck(request, ack)).not.toThrow()
    const ackEnvelope = {
      schema_version: 'aun-connector-provider-ack-envelope/v1', connector_kind: 'discord', connector_instance_id: CONNECTOR_ID,
      adapter_contract_version: authority.adapter_contract_version, adapter_build_digest: authority.adapter_build_digest,
      provider_ack_schema_version: ack.schema_version, provider_request_digest: request.provider_request_digest,
      provider_ack_digest: digestCanonical(CONTRACT_DOMAINS.discordAck, ack),
      provider_ack_payload: ack,
    }
    expect(validateDiscordAckEnvelope(ackEnvelope, requestEnvelope).ack).toEqual(ack)
    const wrong = { ...ack, actual_content_utf8: 'mutated' }
    wrong.provider_response_digest = discordProviderResponseDigest(wrong)
    expect(() => validateDiscordProviderAck(request, wrong)).toThrow(/PROVIDER_EFFECT_MISMATCH/)
  })

  test('wrong schema and unknown extra ACK fields fail even with recomputed response digest', () => {
    const { unit } = deliveryFixture()
    const request = discordRequest(unit)
    const wrongSchema: any = { ...discordAck(request), schema_version: 'aun-discord-provider-ack/v2' }
    wrongSchema.provider_response_digest = discordProviderResponseDigest(wrongSchema)
    expect(() => decodeDiscordProviderAck(wrongSchema)).toThrow(/wrong Discord ack schema/)
    const extra: any = { ...discordAck(request), guessed_delivered: true }
    extra.provider_response_digest = discordProviderResponseDigest(extra)
    expect(() => decodeDiscordProviderAck(extra)).toThrow(/extra=\[guessed_delivered\]/)
    expect(() => decodeConnectorProviderAckEnvelope({ provider_ack_schema_version: 'aun-discord-provider-ack/v1' })).toThrow(/field mismatch/)
  })

  test('fake MCP subtypes use the same connector-neutral envelope without becoming Discord', () => {
    const connectorId = '99999999-9999-4999-8999-999999999999'
    const requestPayload = { schema_version: 'fixture-mcp-provider-request/v1', final_content_utf8: 'hello' }
    const requestDigest = digestCanonical('fixture-mcp-provider-request/v1\n', requestPayload)
    const requestEnvelope: FrozenProviderRequestEnvelopeV1 = {
      schema_version: 'aun-frozen-provider-request-envelope/v1', connector_kind: 'mcp',
      connector_instance_id: connectorId, adapter_contract_version: 'fixture-mcp/v1',
      adapter_build_digest: '9'.repeat(64), provider_request_schema_version: requestPayload.schema_version,
      provider_request_digest: requestDigest, provider_request_payload: requestPayload,
    }
    expect(decodeFrozenProviderRequestEnvelope(requestEnvelope)).toEqual(requestEnvelope)
    const ackPayload = { schema_version: 'fixture-mcp-provider-ack/v1', receipt_id: 'mcp-receipt-1' }
    const ackEnvelope = {
      schema_version: 'aun-connector-provider-ack-envelope/v1', connector_kind: 'mcp',
      connector_instance_id: connectorId, adapter_contract_version: 'fixture-mcp/v1',
      adapter_build_digest: '9'.repeat(64), provider_ack_schema_version: ackPayload.schema_version,
      provider_request_digest: requestDigest,
      provider_ack_digest: digestCanonical('fixture-mcp-provider-ack/v1\n', ackPayload),
      provider_ack_payload: ackPayload,
    }
    expect(decodeConnectorProviderAckEnvelope(ackEnvelope)).toEqual(ackEnvelope)
    expect(() => validateDiscordFrozenRequestEnvelope(requestEnvelope, {
      source: 'registered_loaded_adapter', connector_instance_id: connectorId,
      adapter_contract_version: 'fixture-mcp/v1', adapter_build_digest: '9'.repeat(64),
      capability_digest: '8'.repeat(64), capability_fixture_set_digest: '7'.repeat(64),
      loaded_registration_digest: '6'.repeat(64), caller_supplied_capability_is_authority: false,
    })).toThrow(/CAPABILITY_UNPROVEN/)
  })
})

describe('connector-neutral transport receipt truth', () => {
  test('provider acknowledgement receipt binds the complete frozen delivery authority', () => {
    const { unit, registration, authority } = deliveryFixture()
    const request = discordRequest(unit)
    const requestEnvelope: FrozenProviderRequestEnvelopeV1 = {
      schema_version: 'aun-frozen-provider-request-envelope/v1', connector_kind: 'discord',
      connector_instance_id: CONNECTOR_ID, adapter_contract_version: authority.adapter_contract_version,
      adapter_build_digest: authority.adapter_build_digest, provider_request_schema_version: request.schema_version,
      provider_request_digest: request.provider_request_digest,
      provider_request_payload: request as unknown as Record<string, unknown>,
    }
    const ack = discordAck(request)
    const ackEnvelope = {
      schema_version: 'aun-connector-provider-ack-envelope/v1' as const, connector_kind: 'discord',
      connector_instance_id: CONNECTOR_ID, adapter_contract_version: authority.adapter_contract_version,
      adapter_build_digest: authority.adapter_build_digest, provider_ack_schema_version: ack.schema_version,
      provider_request_digest: request.provider_request_digest,
      provider_ack_digest: digestCanonical(CONTRACT_DOMAINS.discordAck, ack),
      provider_ack_payload: ack as unknown as Record<string, unknown>,
    }
    validateDiscordAckEnvelope(ackEnvelope, requestEnvelope)
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
      provider_request_digest: request.provider_request_digest, receipt_mode: 'provider_ack',
      receipt_id: 'receipt-provider-1', provider_ack: ackEnvelope,
      acknowledged_at: '2026-07-13T00:00:00Z', proof_tier: 'provider_acknowledged',
    }
    const receipt: ProviderAckTransportReceiptV1 = { ...material, receipt_digest: transportReceiptDigest(material) }
    expect(validateTransportReceiptForDelivery(receipt, unit, registration)).toEqual(receipt)
    expect(decodeTransportReceipt(receipt)).toEqual(receipt)

    const changed = { ...receipt, destination_ref: '9'.repeat(64) }
    changed.receipt_digest = transportReceiptDigest(changed)
    expect(() => validateTransportReceiptForDelivery(changed, unit, registration)).toThrow(/receipt differs/)
  })

  test('durable handoff is strict placement truth and receipt_mode none admits no receipt', () => {
    const durable = deliveryFixture('durable_handoff')
    const durableMaterial: Omit<DurableHandoffTransportReceiptV1, 'receipt_digest'> = {
      schema_version: 'aun-durable-handoff-transport-receipt/v1', delivery_id: durable.unit.delivery_id,
      reply_id: durable.unit.reply_id, recipient_seat_id: durable.unit.recipient_seat_id,
      connector_instance_id: durable.unit.destination.connector_instance_id,
      channel_binding_id: durable.unit.resolved_binding_snapshot.channel_binding_id,
      destination_ref: durable.unit.destination_ref,
      resolved_binding_snapshot_digest: durable.unit.resolved_binding_snapshot_digest,
      resolved_delivery_decision_digest: durable.unit.resolved_delivery_decision.resolved_delivery_decision_digest,
      capability_digest: durable.unit.capability_digest,
      opaque_address_fingerprint: durable.unit.resolved_binding_snapshot.opaque_address_fingerprint,
      business_nonce: durable.unit.business_nonce, provider_nonce: durable.unit.idempotency.provider_nonce,
      delivery_digest: durable.unit.idempotency.delivery_digest, receipt_mode: 'durable_handoff',
      receipt_id: 'handoff-receipt-1', durable_placement_digest: '9'.repeat(64),
      acknowledged_at: '2026-07-13T00:00:00Z', proof_tier: 'durable_handoff',
    }
    const receipt: DurableHandoffTransportReceiptV1 = {
      ...durableMaterial,
      receipt_digest: durableHandoffReceiptDigest(durableMaterial),
    }
    expect(validateTransportReceiptForDelivery(receipt, durable.unit, durable.registration)).toEqual(receipt)

    const none = deliveryFixture('none')
    const noneMaterial = {
      ...durableMaterial,
      delivery_id: none.unit.delivery_id,
      reply_id: none.unit.reply_id,
      recipient_seat_id: none.unit.recipient_seat_id,
      connector_instance_id: none.unit.destination.connector_instance_id,
      channel_binding_id: none.unit.resolved_binding_snapshot.channel_binding_id,
      destination_ref: none.unit.destination_ref,
      resolved_binding_snapshot_digest: none.unit.resolved_binding_snapshot_digest,
      resolved_delivery_decision_digest: none.unit.resolved_delivery_decision.resolved_delivery_decision_digest,
      capability_digest: none.unit.capability_digest,
      opaque_address_fingerprint: none.unit.resolved_binding_snapshot.opaque_address_fingerprint,
      business_nonce: none.unit.business_nonce,
      provider_nonce: none.unit.idempotency.provider_nonce,
      delivery_digest: none.unit.idempotency.delivery_digest,
    }
    const noneReceipt = { ...noneMaterial, receipt_digest: durableHandoffReceiptDigest(noneMaterial) }
    expect(() => validateTransportReceiptForDelivery(noneReceipt, none.unit, none.registration)).toThrow(/receipt mode differs/)
    expect(() => decodeTransportReceipt({ ...receipt, guessed_delivered: true })).toThrow(/extra=\[guessed_delivered\]/)
  })
})
