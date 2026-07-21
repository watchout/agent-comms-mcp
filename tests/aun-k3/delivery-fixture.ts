import {
  bindingSnapshotDigest,
  connectorCapabilityDigest,
  deliveryDigest,
  destinationRef,
  loadedConnectorRegistrationDigest,
  opaqueAddressFingerprint,
  providerNonce,
  resolvedDeliveryDecisionDigest,
  type CapabilityAuthorityV1,
  type ConnectorDeliveryCapabilityV1,
  type DeliveryDigestMaterialV1,
  type DeliveryUnitV1,
  type LoadedConnectorRegistrationV1,
  type ResolvedDeliveryBindingSnapshotV1,
} from '../../core/eventlog'

const CONNECTOR_ID = '33333333-3333-4333-8333-333333333333'
const REGISTRATION_ID = '44444444-4444-4444-8444-444444444444'
const BINDING_ID = '55555555-5555-4555-8555-555555555555'
const BUILD_DIGEST = 'a'.repeat(64)

export function makeDeliveryFixture(
  receiptMode: 'provider_ack' | 'durable_handoff' | 'none' = 'provider_ack',
  suffix = '001',
  connectorKind = 'fixture-mcp',
  replyId = `reply-${suffix}`,
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
    reply_id: replyId,
    correlation_id: `correlation-${suffix}`,
    causation_id: null,
    content: { media_type: 'text/plain', text: `hello-${suffix}` },
    destination_ref: destinationRef(CONNECTOR_ID, token),
    resolved_binding_snapshot_digest: snapshotDigest,
    capability_digest: capability.capability_digest,
    required_semantic_capabilities: ['post_message'],
    required_receipt_mode: receiptMode,
    business_nonce: `out:${replyId}`,
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
