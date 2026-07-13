import { describe, expect, test } from 'bun:test'
import { DiscordTransportAdapter } from '../../adapters/eventlog/discord-transport'
import type { StrictDiscordProviderPort } from '../../adapters/types'
import {
  CONTRACT_DOMAINS,
  discordProviderRequestDigest,
  discordProviderResponseDigest,
  digestCanonical,
  type CapabilityAuthorityV1,
  type DiscordProviderAckV1,
  type DiscordProviderRequestV1,
  type FrozenProviderRequestEnvelopeV1,
} from '../../core/eventlog/transport-contract'

const CONNECTOR_ID = '11111111-1111-4111-8111-111111111111'
const BUILD_DIGEST = 'a'.repeat(64)

const authority: CapabilityAuthorityV1 = {
  source: 'registered_loaded_adapter',
  connector_instance_id: CONNECTOR_ID,
  adapter_contract_version: 'discord/v1',
  adapter_build_digest: BUILD_DIGEST,
  capability_digest: 'b'.repeat(64),
  capability_fixture_set_digest: 'c'.repeat(64),
  loaded_registration_digest: 'd'.repeat(64),
  caller_supplied_capability_is_authority: false,
}

function request(content = 'exact content'): DiscordProviderRequestV1 {
  const material = {
    schema_version: 'aun-discord-provider-request/v1' as const,
    connector_instance_id: CONNECTOR_ID,
    adapter_build_digest: BUILD_DIGEST,
    channel_id: 'channel-1',
    thread_id: 'thread-1',
    message_reference: { message_id: 'message-0', channel_id: 'thread-1', guild_id: 'guild-1', fail_if_not_exists: true },
    final_content_utf8: content,
    allowed_mentions: { parse: ['roles', 'users'] as Array<'everyone' | 'roles' | 'users'>, roles: ['role-1'], users: ['user-1'], replied_user: false },
    direct_attention_targets: ['user-1'],
    provider_nonce: 'a1_abcdefghijklmnopqrstuv',
    enforce_nonce: true as const,
    projection_identity_id: 'projection-1',
    expected_mention_everyone: false,
    expected_mentioned_user_ids: ['user-1'],
    expected_mentioned_role_ids: ['role-1'],
  }
  return { ...material, provider_request_digest: discordProviderRequestDigest(material) }
}

function envelope(value: DiscordProviderRequestV1): FrozenProviderRequestEnvelopeV1 {
  return {
    schema_version: 'aun-frozen-provider-request-envelope/v1',
    connector_kind: 'discord',
    connector_instance_id: CONNECTOR_ID,
    adapter_contract_version: authority.adapter_contract_version,
    adapter_build_digest: BUILD_DIGEST,
    provider_request_schema_version: value.schema_version,
    provider_request_digest: value.provider_request_digest,
    provider_request_payload: value as unknown as Record<string, unknown>,
  }
}

function ack(value: DiscordProviderRequestV1): DiscordProviderAckV1 {
  const material = {
    schema_version: 'aun-discord-provider-ack/v1' as const,
    provider_request_digest: value.provider_request_digest,
    actual_provider_request_digest: value.provider_request_digest,
    message_id: 'message-1',
    channel_id: value.channel_id,
    thread_id: value.thread_id,
    nonce: value.provider_nonce,
    author_id: value.projection_identity_id,
    message_reference: value.message_reference,
    actual_content_utf8: value.final_content_utf8,
    mention_everyone: value.expected_mention_everyone,
    mentioned_user_ids: value.expected_mentioned_user_ids,
    mentioned_role_ids: value.expected_mentioned_role_ids,
  }
  return { ...material, provider_response_digest: discordProviderResponseDigest(material) }
}

describe('strict direct Discord transport adapter', () => {
  test('passes one immutable exact request and returns a fully bound acknowledgement envelope', async () => {
    const calls: DiscordProviderRequestV1[] = []
    const provider: StrictDiscordProviderPort = {
      async sendFrozenProviderRequest(value) {
        calls.push(value)
        expect(Object.isFrozen(value)).toBe(true)
        expect(Object.isFrozen(value.allowed_mentions)).toBe(true)
        return ack(value)
      },
    }
    const adapter = new DiscordTransportAdapter({ capability_authority: authority, provider })
    const req = request()
    const result = await adapter.send(envelope(req))
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual(req)
    expect(result.provider_request_digest).toBe(req.provider_request_digest)
    expect(result.provider_ack_digest).toBe(digestCanonical(CONTRACT_DOMAINS.discordAck, result.provider_ack_payload))
  })

  test('does not truncate, find latest messages, change reply target, or mutate mentions', async () => {
    const longContent = '界'.repeat(2500)
    let observed: DiscordProviderRequestV1 | null = null
    const provider: StrictDiscordProviderPort = {
      async sendFrozenProviderRequest(value) {
        observed = value
        return ack(value)
      },
    }
    const req = request(longContent)
    await new DiscordTransportAdapter({ capability_authority: authority, provider }).send(envelope(req))
    expect(observed?.final_content_utf8).toBe(longContent)
    expect(observed?.message_reference).toEqual(req.message_reference)
    expect(observed?.allowed_mentions).toEqual(req.allowed_mentions)
  })

  test('authority or strict envelope mismatch blocks before provider invocation', async () => {
    let calls = 0
    const provider: StrictDiscordProviderPort = {
      async sendFrozenProviderRequest(value) { calls += 1; return ack(value) },
    }
    const req = request()
    const bad: any = envelope(req)
    bad.adapter_build_digest = 'f'.repeat(64)
    await expect(new DiscordTransportAdapter({ capability_authority: authority, provider }).send(bad)).rejects.toThrow(/CAPABILITY_UNPROVEN/)
    expect(calls).toBe(0)
    const extra: any = envelope(req)
    extra.fallback_channel = 'other'
    await expect(new DiscordTransportAdapter({ capability_authority: authority, provider }).send(extra)).rejects.toThrow(/extra=\[fallback_channel\]/)
    expect(calls).toBe(0)
  })

  test('provider-effect mismatch emits no validated acknowledgement envelope', async () => {
    const provider: StrictDiscordProviderPort = {
      async sendFrozenProviderRequest(value) {
        const wrong = { ...ack(value), actual_content_utf8: 'mutated by provider' }
        wrong.provider_response_digest = discordProviderResponseDigest(wrong)
        return wrong
      },
    }
    await expect(new DiscordTransportAdapter({ capability_authority: authority, provider }).send(envelope(request())))
      .rejects.toThrow(/PROVIDER_EFFECT_MISMATCH/)
  })
})
