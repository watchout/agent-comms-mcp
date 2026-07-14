import { describe, expect, test } from 'bun:test'
import {
  assertCanonicalDeliveryDecisionCurrent,
  effectiveRouteCandidateDigest,
  resolveCanonicalDeliveryDecision,
  type CanonicalRouteResolutionMaterialV1,
  type EffectiveRouteCandidateV1,
} from '../core/outbound-projection'
import type { ResolvedDeliveryBindingSnapshotV1 } from '../core/eventlog/transport-contract'

const sha = (digit: string) => digit.repeat(64)

function candidate(overrides: Partial<EffectiveRouteCandidateV1> = {}): EffectiveRouteCandidateV1 {
  return {
    binding_id: '00000000-0000-4000-8000-000000000001',
    binding_role: 'outbound',
    binding_status: 'active',
    binding_priority: 20,
    connector_instance_id: '00000000-0000-4000-8000-000000000002',
    connector_status: 'active',
    adapter_build_digest: sha('1'),
    capability_digest: sha('2'),
    credential_id: 'credential-1',
    credential_status: 'active',
    credential_generation_digest: sha('3'),
    provider_channel_access_id: 'access-1',
    provider_channel_access_status: 'active',
    provider_channel_access_expires_at: '2026-07-14T00:00:00Z',
    provider_channel_access_generation_digest: sha('4'),
    provider_identity_id: 'identity-1',
    provider_identity_trust: 'trusted',
    provider_identity_fingerprint: sha('5'),
    projection_identity_id: null,
    projection_identity_trust: 'not_applicable',
    opaque_address_fingerprint: sha('6'),
    eligible: true,
    exclusion_reason: null,
    ...overrides,
  }
}

function snapshot(selected = candidate()): ResolvedDeliveryBindingSnapshotV1 {
  return {
    schema_version: 'aun-resolved-delivery-binding-snapshot/v1',
    channel_binding_id: selected.binding_id,
    channel_id: 'channel-1',
    connector_instance_id: selected.connector_instance_id,
    connector_kind: 'discord',
    provider: 'discord',
    provider_identity_fingerprint: selected.provider_identity_fingerprint,
    provider_channel_access_id: selected.provider_channel_access_id,
    channel_access_generation_or_digest: selected.provider_channel_access_generation_digest,
    projection_identity_id: selected.projection_identity_id,
    binding_role: selected.binding_role,
    status: 'active',
    priority: selected.binding_priority,
    ordering_scope: 'channel',
    policy_source: 'policy-1',
    routing_metadata_allowlist: { thread: null },
    opaque_address_fingerprint: selected.opaque_address_fingerprint,
    capability_digest: selected.capability_digest,
    resolver_version: 'resolver-1',
  }
}

function material(overrides: Partial<CanonicalRouteResolutionMaterialV1> = {}): CanonicalRouteResolutionMaterialV1 {
  const selected = candidate()
  return {
    resolution_input: {
      sender_seat_id: 'aun',
      recipient_seat_id: 'spec',
      conversation_id: 'conversation-1',
      turn_id: 'turn-1',
      required_semantic_capabilities: ['post_message'],
      required_receipt_mode: 'provider_ack',
      required_guarantee: 'effectively_once',
      authority_snapshot_digest: sha('7'),
    },
    evaluated_candidates: [selected],
    policy: {
      policy_source_digest: sha('8'),
      fallback_allowed: false,
      candidate_serialization_order: 'binding_priority_desc_then_binding_id_connector_id_access_id_asc',
      tie_behavior: 'reject_ambiguous',
    },
    resolver_version: 'resolver-1',
    selected_binding_snapshot: snapshot(selected),
    ...overrides,
  }
}

describe('transport-neutral canonical route decision', () => {
  test('reruns deterministically against the pinned authority snapshot', () => {
    const pinned = resolveCanonicalDeliveryDecision(material())
    expect(assertCanonicalDeliveryDecisionCurrent(pinned, material())).toEqual(pinned)
  })

  test('every routing-effective candidate field changes a digest or fails closed', () => {
    const baseline = candidate()
    const mutations: Array<[keyof EffectiveRouteCandidateV1, unknown]> = [
      ['binding_id', '00000000-0000-4000-8000-000000000009'],
      ['binding_role', 'projection'],
      ['binding_status', 'inactive'],
      ['binding_priority', 21],
      ['connector_instance_id', '00000000-0000-4000-8000-000000000009'],
      ['connector_status', 'inactive'],
      ['adapter_build_digest', sha('9')],
      ['capability_digest', sha('9')],
      ['credential_id', 'credential-2'],
      ['credential_status', 'revoked'],
      ['credential_generation_digest', sha('9')],
      ['provider_channel_access_id', 'access-2'],
      ['provider_channel_access_status', 'inactive'],
      ['provider_channel_access_expires_at', '2026-07-15T00:00:00Z'],
      ['provider_channel_access_generation_digest', sha('9')],
      ['provider_identity_id', 'identity-2'],
      ['provider_identity_trust', 'untrusted'],
      ['provider_identity_fingerprint', sha('9')],
      ['projection_identity_id', 'projection-1'],
      ['projection_identity_trust', 'untrusted'],
      ['opaque_address_fingerprint', sha('9')],
      ['eligible', false],
      ['exclusion_reason', 'policy_excluded'],
    ]
    const baselineDigest = effectiveRouteCandidateDigest(baseline)
    for (const [field, value] of mutations) {
      const changed = { ...baseline, [field]: value } as EffectiveRouteCandidateV1
      try {
        expect(effectiveRouteCandidateDigest(changed), field).not.toBe(baselineDigest)
      } catch (error) {
        expect(String(error), field).toMatch(/ROUTE_AUTHORITY_INVALID/)
      }
    }
  })

  test('insert, delete, higher priority, and tied candidates cannot preserve a decision', () => {
    const baseMaterial = material()
    const pinned = resolveCanonicalDeliveryDecision(baseMaterial)
    const lower = candidate({
      binding_id: '00000000-0000-4000-8000-000000000003',
      connector_instance_id: '00000000-0000-4000-8000-000000000004',
      binding_priority: 10,
      provider_channel_access_id: 'access-2',
    })
    expect(() => assertCanonicalDeliveryDecisionCurrent(pinned, {
      ...baseMaterial,
      evaluated_candidates: [baseMaterial.evaluated_candidates[0]!, lower],
    })).toThrow(/RESOLVER_DECISION_DRIFT/)
    expect(() => resolveCanonicalDeliveryDecision({ ...baseMaterial, evaluated_candidates: [] })).toThrow(/NO_ELIGIBLE_ROUTE/)

    const higher = candidate({
      binding_id: '00000000-0000-4000-8000-000000000005',
      connector_instance_id: '00000000-0000-4000-8000-000000000006',
      binding_priority: 30,
      provider_channel_access_id: 'access-3',
    })
    expect(() => resolveCanonicalDeliveryDecision({
      ...baseMaterial,
      evaluated_candidates: [baseMaterial.evaluated_candidates[0]!, higher],
    })).toThrow(/selected binding snapshot differs/)

    const tied = candidate({
      binding_id: '00000000-0000-4000-8000-000000000007',
      connector_instance_id: '00000000-0000-4000-8000-000000000008',
      provider_channel_access_id: 'access-4',
    })
    expect(() => resolveCanonicalDeliveryDecision({
      ...baseMaterial,
      evaluated_candidates: [baseMaterial.evaluated_candidates[0]!, tied],
    })).toThrow(/AMBIGUOUS_ROUTE/)
  })

  test('every resolution input plus policy, resolver, and selected snapshot drift is detected', () => {
    const baseMaterial = material()
    const pinned = resolveCanonicalDeliveryDecision(baseMaterial)
    const inputMutations = {
      sender_seat_id: 'arc',
      recipient_seat_id: 'qa',
      conversation_id: 'conversation-2',
      turn_id: 'turn-2',
      required_semantic_capabilities: ['direct_attention', 'post_message'],
      required_receipt_mode: 'durable_handoff' as const,
      required_guarantee: 'at_least_once' as const,
      authority_snapshot_digest: sha('9'),
    }
    for (const [field, value] of Object.entries(inputMutations)) {
      expect(() => assertCanonicalDeliveryDecisionCurrent(pinned, {
        ...baseMaterial,
        resolution_input: { ...baseMaterial.resolution_input, [field]: value },
      }), field).toThrow(/RESOLVER_DECISION_DRIFT/)
    }
    expect(() => assertCanonicalDeliveryDecisionCurrent(pinned, {
      ...baseMaterial,
      policy: { ...baseMaterial.policy, policy_source_digest: sha('9') },
    })).toThrow(/RESOLVER_DECISION_DRIFT/)
    expect(() => assertCanonicalDeliveryDecisionCurrent(pinned, {
      ...baseMaterial,
      resolver_version: 'resolver-2',
    })).toThrow(/selected binding snapshot differs/)
    expect(() => assertCanonicalDeliveryDecisionCurrent(pinned, {
      ...baseMaterial,
      selected_binding_snapshot: { ...baseMaterial.selected_binding_snapshot, routing_metadata_allowlist: { thread: 'thread-2' } },
    })).toThrow(/RESOLVER_DECISION_DRIFT/)
  })

  test('heartbeat, latency, last-seen, and updated-at telemetry are excluded', () => {
    const baseMaterial = material()
    const pinned = resolveCanonicalDeliveryDecision(baseMaterial)
    const withTelemetry = {
      ...baseMaterial.evaluated_candidates[0]!,
      updated_at: '2026-07-13T12:34:56Z',
      last_seen_at: '2026-07-13T12:34:56Z',
      heartbeat_epoch: 999,
      latency_ms: 9999,
    } as EffectiveRouteCandidateV1
    expect(assertCanonicalDeliveryDecisionCurrent(pinned, {
      ...baseMaterial,
      evaluated_candidates: [withTelemetry],
    })).toEqual(pinned)
  })
})
