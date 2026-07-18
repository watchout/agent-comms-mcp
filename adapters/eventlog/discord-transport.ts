/** Strict direct Discord adapter for Transport-Neutral Contract r1.1.4. */

import type { StrictDiscordProviderPort } from '../types'
import {
  CONTRACT_DOMAINS,
  canonicalJson,
  decodeDiscordProviderAck,
  discordProviderRequestDigest,
  digestCanonical,
  providerDedupeScopeDigest,
  sha256Utf8,
  transportReceiptDigest,
  validateDeliveryUnit,
  validateDiscordAckEnvelope,
  validateDiscordFrozenRequestEnvelope,
  validateDiscordProviderAck,
  type CapabilityAuthorityV1,
  type ConnectorProviderAckEnvelopeV1,
  type FrozenProviderRequestEnvelopeV1,
  type DeliveryUnitV1,
  type DiscordProviderRequestV1,
  type LoadedConnectorRegistrationV1,
  type ProviderAckTransportReceiptV1,
} from '../../core/eventlog/transport-contract'
import type {
  V2DeliveryAttemptResult,
  V2DeliveryPreparedAttempt,
  V2DeliveryTransportAdapter,
} from '../../core/eventlog/delivery'

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return value
}

export interface DiscordTransportAdapterOptionsV1 {
  capability_authority: CapabilityAuthorityV1
  provider: StrictDiscordProviderPort
}

/**
 * ConnectorAdapterPort implementation. Input is only the frozen envelope;
 * DeliveryUnitV1, routing, lookup, truncation, and fallback are deliberately
 * absent from this surface.
 */
export class DiscordTransportAdapter {
  constructor(private readonly options: DiscordTransportAdapterOptionsV1) {}

  async send(value: unknown): Promise<ConnectorProviderAckEnvelopeV1> {
    const { envelope, request } = validateDiscordFrozenRequestEnvelope(
      value,
      this.options.capability_authority,
    )
    // Re-encode before handing data to the provider so getters/prototypes and
    // caller mutation cannot change the effect after digest validation.
    const frozenRequest = deepFreeze(JSON.parse(canonicalJson(request)))
    const ack = decodeDiscordProviderAck(
      await this.options.provider.sendFrozenProviderRequest(frozenRequest),
    )
    validateDiscordProviderAck(frozenRequest, ack)
    const ackEnvelope: ConnectorProviderAckEnvelopeV1 = {
      schema_version: 'aun-connector-provider-ack-envelope/v1',
      connector_kind: 'discord',
      connector_instance_id: envelope.connector_instance_id,
      adapter_contract_version: envelope.adapter_contract_version,
      adapter_build_digest: envelope.adapter_build_digest,
      provider_ack_schema_version: 'aun-discord-provider-ack/v1',
      provider_request_digest: envelope.provider_request_digest,
      provider_ack_digest: digestCanonical(CONTRACT_DOMAINS.discordAck, ack),
      provider_ack_payload: ack as unknown as Record<string, unknown>,
    }
    validateDiscordAckEnvelope(ackEnvelope, envelope)
    return ackEnvelope
  }
}

export function isDiscordFrozenEnvelope(
  value: unknown,
): value is FrozenProviderRequestEnvelopeV1 {
  return typeof value === 'object' && value !== null &&
    (value as Record<string, unknown>).schema_version === 'aun-frozen-provider-request-envelope/v1' &&
    (value as Record<string, unknown>).connector_kind === 'discord'
}

function nullableRoutingString(unit: DeliveryUnitV1, key: string): string | null {
  const value = unit.resolved_binding_snapshot.routing_metadata_allowlist[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Deterministically freeze the only Discord request that K3 may send. */
export function buildDiscordProviderRequestEnvelope(
  unit: DeliveryUnitV1,
  loadedRegistration: LoadedConnectorRegistrationV1,
): FrozenProviderRequestEnvelopeV1 {
  validateDeliveryUnit(unit, loadedRegistration)
  if (unit.connector_capability.connector_kind !== 'discord') throw new Error('Discord adapter received a non-Discord delivery unit')
  const projectionIdentity = unit.resolved_binding_snapshot.projection_identity_id
  if (!projectionIdentity) throw new Error('Discord delivery requires a frozen projection identity')
  const requestMaterial = {
    schema_version: 'aun-discord-provider-request/v1' as const,
    connector_instance_id: unit.destination.connector_instance_id,
    adapter_build_digest: unit.capability_authority.adapter_build_digest,
    channel_id: unit.resolved_binding_snapshot.provider_channel_access_id,
    thread_id: nullableRoutingString(unit, 'thread_id'),
    message_reference: null,
    final_content_utf8: unit.content.text,
    allowed_mentions: { parse: [] as Array<'everyone' | 'roles' | 'users'>, roles: [], users: [], replied_user: false },
    direct_attention_targets: [],
    provider_nonce: unit.idempotency.provider_nonce,
    enforce_nonce: true as const,
    projection_identity_id: projectionIdentity,
    expected_mention_everyone: false,
    expected_mentioned_user_ids: [],
    expected_mentioned_role_ids: [],
  }
  const request: DiscordProviderRequestV1 = {
    ...requestMaterial,
    provider_request_digest: discordProviderRequestDigest(requestMaterial),
  }
  return {
    schema_version: 'aun-frozen-provider-request-envelope/v1',
    connector_kind: 'discord',
    connector_instance_id: unit.destination.connector_instance_id,
    adapter_contract_version: unit.capability_authority.adapter_contract_version,
    adapter_build_digest: unit.capability_authority.adapter_build_digest,
    provider_request_schema_version: request.schema_version,
    provider_request_digest: request.provider_request_digest,
    provider_request_payload: request as unknown as Record<string, unknown>,
  }
}

/** Validate the exact provider effect and turn it into connector-neutral truth. */
export function validateDiscordProviderAckResult(
  unit: DeliveryUnitV1,
  loadedRegistration: LoadedConnectorRegistrationV1,
  request: FrozenProviderRequestEnvelopeV1,
  ackEnvelope: ConnectorProviderAckEnvelopeV1,
  options: { acknowledgedAt: string; receiptId: string },
): ProviderAckTransportReceiptV1 {
  validateDeliveryUnit(unit, loadedRegistration)
  validateDiscordFrozenRequestEnvelope(request, unit.capability_authority)
  validateDiscordAckEnvelope(ackEnvelope, request)
  const material: Omit<ProviderAckTransportReceiptV1, 'receipt_digest'> = {
    schema_version: 'aun-provider-ack-transport-receipt/v1',
    delivery_id: unit.delivery_id,
    reply_id: unit.reply_id,
    recipient_seat_id: unit.recipient_seat_id,
    connector_instance_id: unit.destination.connector_instance_id,
    channel_binding_id: unit.resolved_binding_snapshot.channel_binding_id,
    destination_ref: unit.destination_ref,
    resolved_binding_snapshot_digest: unit.resolved_binding_snapshot_digest,
    capability_digest: unit.capability_digest,
    opaque_address_fingerprint: unit.resolved_binding_snapshot.opaque_address_fingerprint,
    business_nonce: unit.business_nonce,
    provider_nonce: unit.idempotency.provider_nonce,
    delivery_digest: unit.idempotency.delivery_digest,
    resolved_delivery_decision_digest: unit.resolved_delivery_decision.resolved_delivery_decision_digest,
    provider_request_digest: request.provider_request_digest,
    receipt_mode: 'provider_ack',
    receipt_id: options.receiptId,
    provider_ack: ackEnvelope,
    acknowledged_at: options.acknowledgedAt,
    proof_tier: 'provider_acknowledged',
  }
  return { ...material, receipt_digest: transportReceiptDigest(material) }
}

function discordDedupeIdentity(unit: DeliveryUnitV1, request: FrozenProviderRequestEnvelopeV1): string {
  const scope = unit.connector_capability.dedupe_scope
  if (scope === 'same_author') {
    return providerDedupeScopeDigest({
      connector_instance_id: unit.destination.connector_instance_id,
      dedupe_scope: scope,
      provider_author_identity_id: unit.resolved_binding_snapshot.projection_identity_id,
      provider_author_identity_fingerprint: unit.resolved_binding_snapshot.provider_identity_fingerprint,
      channel_scope_ref: null,
      thread_scope_ref: null,
    })
  }
  if (scope === 'thread') {
    const requestPayload = request.provider_request_payload as unknown as DiscordProviderRequestV1
    if (!requestPayload.thread_id) throw new Error('thread dedupe requires a frozen thread identity')
    return providerDedupeScopeDigest({
      connector_instance_id: unit.destination.connector_instance_id,
      dedupe_scope: scope,
      provider_author_identity_id: null,
      provider_author_identity_fingerprint: null,
      channel_scope_ref: unit.destination_ref,
      thread_scope_ref: sha256Utf8(`aun-discord-thread-scope/v1\n${requestPayload.thread_id}`),
    })
  }
  if (scope === 'channel') {
    return providerDedupeScopeDigest({
      connector_instance_id: unit.destination.connector_instance_id,
      dedupe_scope: scope,
      provider_author_identity_id: null,
      provider_author_identity_fingerprint: null,
      channel_scope_ref: unit.destination_ref,
      thread_scope_ref: null,
    })
  }
  return providerDedupeScopeDigest({
    connector_instance_id: unit.destination.connector_instance_id,
    dedupe_scope: 'connector_instance',
    provider_author_identity_id: null,
    provider_author_identity_fingerprint: null,
    channel_scope_ref: null,
    thread_scope_ref: null,
  })
}

export interface DiscordV2DeliveryTransportAdapterOptionsV1 extends DiscordTransportAdapterOptionsV1 {
  now?: () => string
  receiptId?: (unit: DeliveryUnitV1) => string
}

/** K3 adapter: fake/provider injection only; it owns no token or network setup. */
export class DiscordV2DeliveryTransportAdapter implements V2DeliveryTransportAdapter {
  private readonly direct: DiscordTransportAdapter

  constructor(private readonly options: DiscordV2DeliveryTransportAdapterOptionsV1) {
    this.direct = new DiscordTransportAdapter(options)
  }

  prepare(unit: DeliveryUnitV1, registration: LoadedConnectorRegistrationV1): V2DeliveryPreparedAttempt {
    const request = buildDiscordProviderRequestEnvelope(unit, registration)
    return { request, concrete_dedupe_scope_identity: discordDedupeIdentity(unit, request) }
  }

  async sendPrepared(
    prepared: V2DeliveryPreparedAttempt,
    unit: DeliveryUnitV1,
    registration: LoadedConnectorRegistrationV1,
  ): Promise<V2DeliveryAttemptResult> {
    try {
      const ack = await this.direct.send(prepared.request)
      return {
        outcome: 'provider_ack',
        request: prepared.request,
        receipt: validateDiscordProviderAckResult(unit, registration, prepared.request, ack, {
          acknowledgedAt: this.options.now?.() ?? new Date().toISOString(),
          receiptId: this.options.receiptId?.(unit) ?? `discord-receipt:${unit.delivery_id}`,
        }),
      }
    } catch (error) {
      const code = Number((error as { code?: unknown })?.code)
      return {
        outcome: 'delivery_unknown',
        request: prepared.request,
        failure_code: code === 40062 ? 'DISCORD_NONCE_CONFLICT_40062' : 'DISCORD_PROVIDER_OUTCOME_UNKNOWN',
      }
    }
  }
}
