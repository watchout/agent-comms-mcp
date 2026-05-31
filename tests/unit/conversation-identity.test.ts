import { describe, expect, test } from 'bun:test'
import {
  buildConversationKey,
  conversationKeyHash,
  normalizeThreadScopeId,
  resolveConversationIdentity,
  serializeConversationKey,
} from '../../core/conversation-identity'

describe('conversation identity resolver', () => {
  test('builds a stable canonical key and hash', () => {
    const first = buildConversationKey({
      surface: ' mcp ',
      channel_id: ' 1487368919613444156 ',
      root_message_id: ' 7f2b0d2b-0000-4000-8000-000000000001 ',
    })
    const second = buildConversationKey({
      surface: 'mcp',
      channel_id: '1487368919613444156',
      thread_scope_id: '1487368919613444156',
      root_message_id: '7f2b0d2b-0000-4000-8000-000000000001',
      conversation_kind: 'request',
    })

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(first.key).toEqual(second.key)
    expect(first.key_hash).toBe(second.key_hash)
    expect(first.key_json).toBe(serializeConversationKey(first.key))
    expect(conversationKeyHash(first.key)).toBe(first.key_hash)
  })

  test('uses thread id before falling back to channel scope', () => {
    expect(normalizeThreadScopeId({ channel_id: 'channel-1' })).toBe('channel-1')
    expect(normalizeThreadScopeId({ channel_id: 'channel-1', thread_id: 'thread-1' })).toBe('thread-1')
    expect(
      normalizeThreadScopeId({
        channel_id: 'channel-1',
        thread_id: 'thread-1',
        thread_scope_id: 'explicit-scope',
      }),
    ).toBe('explicit-scope')
  })

  test('rejects rootless and ambiguous root keys', () => {
    expect(buildConversationKey({
      surface: 'mcp',
      channel_id: 'channel-1',
    })).toEqual({ ok: false, error: 'CONVERSATION_ROOT_REQUIRED' })

    expect(buildConversationKey({
      surface: 'mcp',
      channel_id: 'channel-1',
      root_message_id: 'message-1',
      root_request_id: 'request-1',
    })).toEqual({ ok: false, error: 'CONVERSATION_ROOT_AMBIGUOUS' })
  })

  test('rejects unsupported conversation kinds', () => {
    expect(buildConversationKey({
      surface: 'mcp',
      channel_id: 'channel-1',
      root_message_id: 'message-1',
      conversation_kind: 'latest-channel-message',
    })).toEqual({ ok: false, error: 'INVALID_CONVERSATION_KIND' })
  })

  test('continues an explicit reply conversation without creating a new key', () => {
    const result = resolveConversationIdentity({
      surface: 'mcp',
      channel_id: 'channel-1',
      reply_to_conversation_id: 'conversation-existing',
    })

    expect(result).toEqual({
      ok: true,
      action: 'continue',
      conversation_id: 'conversation-existing',
      reason: 'reply_to',
    })
  })

  test('continues a known provider parent conversation', () => {
    const result = resolveConversationIdentity({
      surface: 'discord',
      channel_id: 'channel-1',
      provider_parent_conversation_id: 'conversation-provider-parent',
      provider_parent_reference: 'discord-message-1',
    })

    expect(result).toEqual({
      ok: true,
      action: 'continue',
      conversation_id: 'conversation-provider-parent',
      reason: 'provider_parent',
    })
  })

  test('isolates an unknown provider parent instead of attaching to the latest channel conversation', () => {
    const result = resolveConversationIdentity({
      surface: 'discord',
      channel_id: 'channel-1',
      thread_id: 'discord-thread-1',
      root_message_id: 'message-orphan',
      provider_parent_reference: 'deleted-or-invisible-message',
      orphan_policy: 'isolate',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.action).toBe('create')
    expect(result.reason).toBe('orphan_isolated')
    expect(result.key).toMatchObject({
      channel_id: 'channel-1',
      thread_scope_id: 'discord-thread-1',
      root_message_id: 'message-orphan',
      conversation_kind: 'request',
    })
    expect('root_request_id' in result.key).toBe(false)
    expect('parent_conversation_id' in result.key).toBe(false)
  })

  test('can reject an unresolved provider parent when the orphan policy requires it', () => {
    expect(resolveConversationIdentity({
      surface: 'discord',
      channel_id: 'channel-1',
      root_message_id: 'message-orphan',
      provider_parent_reference: 'discord-message-404',
      orphan_policy: 'reject',
    })).toEqual({
      ok: false,
      error: 'ORPHAN_PARENT_UNRESOLVED',
      detail: 'discord-message-404',
    })
  })

  test('requires child conversations to carry an explicit parent audit link', () => {
    expect(buildConversationKey({
      surface: 'mcp',
      channel_id: 'channel-1',
      root_request_id: 'fanout-child-1',
      conversation_kind: 'fanout_child',
    })).toEqual({ ok: false, error: 'FANOUT_PARENT_REQUIRED' })

    const result = resolveConversationIdentity({
      surface: 'mcp',
      channel_id: 'channel-1',
      root_request_id: 'fanout-child-1',
      parent_conversation_id: 'parent-conversation',
      conversation_kind: 'fanout_child',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.action).toBe('create')
    expect(result.reason).toBe('child_request')
    expect(result.key.parent_conversation_id).toBe('parent-conversation')
  })

  test('rejects parent conversation ids on non-child roots', () => {
    expect(buildConversationKey({
      surface: 'mcp',
      channel_id: 'channel-1',
      root_message_id: 'message-1',
      parent_conversation_id: 'parent-conversation',
      conversation_kind: 'audit',
    })).toEqual({ ok: false, error: 'PARENT_FOR_NON_CHILD_UNSUPPORTED' })
  })

  test('fails closed when reply and provider parent evidence disagree', () => {
    expect(resolveConversationIdentity({
      surface: 'discord',
      channel_id: 'channel-1',
      reply_to_conversation_id: 'conversation-a',
      provider_parent_conversation_id: 'conversation-b',
    })).toEqual({ ok: false, error: 'CONVERSATION_PARENT_AMBIGUOUS' })
  })
})
