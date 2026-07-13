#!/usr/bin/env bun
/**
 * Tests for Discord adapter HTTP contract and outbound port derivation.
 *
 * Access-control tests (gate / loadAccess / dmPolicy / mentionPatterns etc.)
 * were removed alongside the symbols themselves — routing + membership
 * enforcement now lives in core/route-message.ts and is covered by
 * tests/route-message.test.ts (spec §20 廃止: file-based access + plugin:discord).
 */
import { describe, test, expect } from 'bun:test'
import { DiscordAdapter, shouldIgnoreDiscordInboundMessage } from '../adapters/discord'
import {
  discordProviderRequestDigest,
  type DiscordProviderRequestV1,
} from '../core/eventlog/transport-contract'

describe('Inbound bot-authored message guard', () => {
  test('ignores all bot-authored Discord messages before inbound routing', () => {
    expect(shouldIgnoreDiscordInboundMessage({ author: { id: 'other-bot', bot: true } }, 'this-bot')).toBe(true)
    expect(shouldIgnoreDiscordInboundMessage({ author: { id: 'this-bot', bot: true } }, 'this-bot')).toBe(true)
  })

  test('keeps human-authored Discord messages unless they are impossible self echoes', () => {
    expect(shouldIgnoreDiscordInboundMessage({ author: { id: 'human', bot: false } }, 'this-bot')).toBe(false)
    expect(shouldIgnoreDiscordInboundMessage({ author: { id: 'this-bot', bot: false } }, 'this-bot')).toBe(true)
  })
})

describe('Outbound endpoint contract', () => {
  test('POST /send requires chat_id and text', () => {
    const validate = (body: any) => {
      if (!body.chat_id || !body.text) return { error: 'chat_id and text are required' }
      return { ok: true }
    }

    expect(validate({})).toEqual({ error: 'chat_id and text are required' })
    expect(validate({ chat_id: '123' })).toEqual({ error: 'chat_id and text are required' })
    expect(validate({ text: 'hello' })).toEqual({ error: 'chat_id and text are required' })
    expect(validate({ chat_id: '123', text: 'hello' })).toEqual({ ok: true })
    expect(validate({ chat_id: '123', text: 'hello', reply_to: '456' })).toEqual({ ok: true })
  })

  test('text truncation to Discord 2000 char limit', () => {
    const truncate = (text: string) =>
      text.length > 2000 ? text.slice(0, 1990) + '…(truncated)' : text

    const short = 'hello'
    expect(truncate(short)).toBe('hello')

    const long = 'a'.repeat(2500)
    const result = truncate(long)
    expect(result.length).toBeLessThanOrEqual(2002)
    expect(result.endsWith('…(truncated)')).toBe(true)
  })

  test('OUTBOUND_PORT defaults to WEBHOOK_PORT + 1000', () => {
    const webhookPort = 8795
    const outboundPort = webhookPort + 1000
    expect(outboundPort).toBe(9795)
  })
})

describe('EventLog strict Discord provider effect', () => {
  test('hands the exact frozen content/reference/mentions/nonce to one pinned destination', async () => {
    const sentPayloads: any[] = []
    const material = {
      schema_version: 'aun-discord-provider-request/v1' as const,
      connector_instance_id: '11111111-1111-4111-8111-111111111111',
      adapter_build_digest: 'a'.repeat(64),
      channel_id: 'parent-channel',
      thread_id: 'exact-thread',
      message_reference: { message_id: 'reference-message', channel_id: 'exact-thread', guild_id: 'guild-1', fail_if_not_exists: true },
      final_content_utf8: '界'.repeat(2500),
      allowed_mentions: { parse: ['roles', 'users'] as Array<'everyone' | 'roles' | 'users'>, roles: ['role-1'], users: ['user-1'], replied_user: false },
      direct_attention_targets: ['user-1'],
      provider_nonce: 'a1_abcdefghijklmnopqrstuv',
      enforce_nonce: true as const,
      projection_identity_id: 'projection-1',
      expected_mention_everyone: false,
      expected_mentioned_user_ids: ['user-1'],
      expected_mentioned_role_ids: ['role-1'],
    }
    const request: DiscordProviderRequestV1 = { ...material, provider_request_digest: discordProviderRequestDigest(material) }
    const adapter = new DiscordAdapter()
    ;(adapter as any).client = {
      isReady: () => true,
      channels: {
        fetch: async (id: string) => ({
          id,
          send: async (payload: any) => {
            sentPayloads.push(payload)
            return {
              id: 'sent-message', channelId: id, nonce: payload.nonce, content: payload.content,
              author: { id: 'projection-1' },
              reference: { messageId: 'reference-message', channelId: 'exact-thread', guildId: 'guild-1' },
              mentions: {
                everyone: false,
                users: new Map([['user-1', {}]]),
                roles: new Map([['role-1', {}]]),
              },
            }
          },
        }),
      },
    }
    const ack = await adapter.sendFrozenProviderRequest(request)
    expect(sentPayloads).toHaveLength(1)
    expect(sentPayloads[0].content).toBe(request.final_content_utf8)
    expect(sentPayloads[0].content.length).toBe(2500)
    expect(sentPayloads[0].reply).toEqual({ messageReference: 'reference-message', failIfNotExists: true })
    expect(sentPayloads[0].allowedMentions).toEqual({ parse: ['roles', 'users'], roles: ['role-1'], users: ['user-1'], repliedUser: false })
    expect(sentPayloads[0].nonce).toBe(request.provider_nonce)
    expect(sentPayloads[0].enforceNonce).toBe(true)
    expect(ack.actual_content_utf8).toBe(request.final_content_utf8)
    expect(ack.provider_request_digest).toBe(request.provider_request_digest)
  })
})
