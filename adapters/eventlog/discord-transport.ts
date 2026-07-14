/** Strict direct Discord adapter for Transport-Neutral Contract r1.1.4. */

import type { StrictDiscordProviderPort } from '../types'
import {
  CONTRACT_DOMAINS,
  canonicalJson,
  decodeDiscordProviderAck,
  digestCanonical,
  validateDiscordAckEnvelope,
  validateDiscordFrozenRequestEnvelope,
  validateDiscordProviderAck,
  type CapabilityAuthorityV1,
  type ConnectorProviderAckEnvelopeV1,
  type FrozenProviderRequestEnvelopeV1,
} from '../../core/eventlog/transport-contract'

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
