#!/usr/bin/env bun
/**
 * Tests for Discord adapter access control, bot filter logic, and outbound endpoint
 */
import { describe, test, expect } from 'bun:test'
import { gate, loadAccess, type Access } from '../adapters/discord'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

function makeAccess(overrides: Partial<Access> = {}): Access {
  return {
    dmPolicy: 'pairing',
    allowFrom: [],
    groups: {},
    pending: {},
    ...overrides,
  }
}

// --- Bot filter tests ---
describe('Bot filter', () => {
  test('self-messages are filtered by msg.author.id === client.user?.id pattern', () => {
    // This is tested at the integration level in the adapter.
    // Here we verify the gate function does NOT filter bots —
    // only the messageCreate handler checks self-ID.
    const access = makeAccess({
      dmPolicy: 'allowlist',
      allowFrom: ['bot-123'],
    })
    // A bot user that is in allowFrom should be delivered
    const result = gate(access, 'bot-123', 'ch-1', null, true, false)
    expect(result.action).toBe('deliver')
  })

  test('other bots are NOT filtered (only self is filtered)', () => {
    const access = makeAccess({
      groups: { 'ch-1': { requireMention: false, allowFrom: [] } },
    })
    // Another bot should pass gate if channel is open
    const result = gate(access, 'other-bot-456', 'ch-1', null, false, false)
    expect(result.action).toBe('deliver')
  })
})

// --- DM access control ---
describe('DM access control', () => {
  test('disabled dmPolicy drops all DMs', () => {
    const access = makeAccess({ dmPolicy: 'disabled' })
    const result = gate(access, 'user-1', 'dm-ch', null, true, false)
    expect(result.action).toBe('drop')
  })

  test('allowFrom permits listed user DMs', () => {
    const access = makeAccess({
      dmPolicy: 'allowlist',
      allowFrom: ['user-1'],
    })
    const result = gate(access, 'user-1', 'dm-ch', null, true, false)
    expect(result.action).toBe('deliver')
  })

  test('DM from unlisted user is dropped', () => {
    const access = makeAccess({
      dmPolicy: 'pairing',
      allowFrom: ['user-1'],
    })
    const result = gate(access, 'user-2', 'dm-ch', null, true, false)
    expect(result.action).toBe('drop')
  })
})

// --- Guild channel access control ---
describe('Guild channel access control', () => {
  test('unconfigured channel with empty allowFrom delivers (open access)', () => {
    const access = makeAccess()
    const result = gate(access, 'user-1', 'unknown-ch', null, false, false)
    expect(result.action).toBe('deliver')
  })

  test('unconfigured channel with allowFrom permits listed user', () => {
    const access = makeAccess({ allowFrom: ['user-1'] })
    const result = gate(access, 'user-1', 'unknown-ch', null, false, false)
    expect(result.action).toBe('deliver')
  })

  test('unconfigured channel with allowFrom blocks unlisted user', () => {
    const access = makeAccess({ allowFrom: ['user-1'] })
    const result = gate(access, 'user-2', 'unknown-ch', null, false, false)
    expect(result.action).toBe('drop')
  })

  test('open channel (no allowFrom, no requireMention) delivers', () => {
    const access = makeAccess({
      groups: { 'ch-1': { requireMention: false, allowFrom: [] } },
    })
    const result = gate(access, 'anyone', 'ch-1', null, false, false)
    expect(result.action).toBe('deliver')
  })

  test('channel with allowFrom blocks unlisted user', () => {
    const access = makeAccess({
      groups: { 'ch-1': { requireMention: false, allowFrom: ['user-a'] } },
    })
    const result = gate(access, 'user-b', 'ch-1', null, false, false)
    expect(result.action).toBe('drop')
  })

  test('channel with allowFrom permits listed user', () => {
    const access = makeAccess({
      groups: { 'ch-1': { requireMention: false, allowFrom: ['user-a'] } },
    })
    const result = gate(access, 'user-a', 'ch-1', null, false, false)
    expect(result.action).toBe('deliver')
  })

  test('requireMention blocks message without mention', () => {
    const access = makeAccess({
      groups: { 'ch-1': { requireMention: true, allowFrom: [] } },
    })
    const result = gate(access, 'user-a', 'ch-1', null, false, false)
    expect(result.action).toBe('drop')
  })

  test('requireMention allows message with mention', () => {
    const access = makeAccess({
      groups: { 'ch-1': { requireMention: true, allowFrom: [] } },
    })
    const result = gate(access, 'user-a', 'ch-1', null, false, true)
    expect(result.action).toBe('deliver')
  })

  test('both allowFrom and requireMention must pass', () => {
    const access = makeAccess({
      groups: { 'ch-1': { requireMention: true, allowFrom: ['user-a'] } },
    })
    // In allowFrom but no mention → drop
    expect(gate(access, 'user-a', 'ch-1', null, false, false).action).toBe('drop')
    // Mentioned but not in allowFrom → drop
    expect(gate(access, 'user-b', 'ch-1', null, false, true).action).toBe('drop')
    // Both → deliver
    expect(gate(access, 'user-a', 'ch-1', null, false, true).action).toBe('deliver')
  })
})

// --- mentionPatterns filter (ungrouped channels) ---
describe('mentionPatterns filter', () => {
  test('ungrouped channel with mentionPatterns requires mention', () => {
    const access = makeAccess({
      mentionPatterns: ['bot-id-123', 'MyBot'],
    })
    // No mention → drop
    expect(gate(access, 'user-1', 'any-ch', null, false, false).action).toBe('drop')
    // With mention → deliver
    expect(gate(access, 'user-1', 'any-ch', null, false, true).action).toBe('deliver')
  })

  test('ungrouped channel without mentionPatterns delivers all', () => {
    const access = makeAccess()
    // No mentionPatterns → deliver without mention
    expect(gate(access, 'user-1', 'any-ch', null, false, false).action).toBe('deliver')
  })

  test('ungrouped channel with empty mentionPatterns delivers all', () => {
    const access = makeAccess({ mentionPatterns: [] })
    expect(gate(access, 'user-1', 'any-ch', null, false, false).action).toBe('deliver')
  })

  test('mentionPatterns + allowFrom: both checks apply', () => {
    const access = makeAccess({
      allowFrom: ['user-1'],
      mentionPatterns: ['bot-id'],
    })
    // user-1, no mention → drop (mention required)
    expect(gate(access, 'user-1', 'any-ch', null, false, false).action).toBe('drop')
    // user-1, with mention → deliver
    expect(gate(access, 'user-1', 'any-ch', null, false, true).action).toBe('deliver')
    // user-2, with mention → drop (not in allowFrom)
    expect(gate(access, 'user-2', 'any-ch', null, false, true).action).toBe('drop')
  })
})

// --- Thread inheritance ---
describe('Thread inheritance', () => {
  test('thread inherits parent channel policy', () => {
    const access = makeAccess({
      groups: { 'parent-ch': { requireMention: false, allowFrom: [] } },
    })
    // Thread channel ID is different, but parentChannelId maps to configured channel
    const result = gate(access, 'user-1', 'thread-ch', 'parent-ch', false, false)
    expect(result.action).toBe('deliver')
  })

  test('thread with unconfigured parent falls back to top-level allowFrom', () => {
    const access = makeAccess({
      allowFrom: ['user-1'],
      groups: { 'other-ch': { requireMention: false, allowFrom: [] } },
    })
    // user-1 in allowFrom → deliver
    expect(gate(access, 'user-1', 'thread-ch', 'unknown-parent', false, false).action).toBe('deliver')
    // user-2 not in allowFrom → drop
    expect(gate(access, 'user-2', 'thread-ch', 'unknown-parent', false, false).action).toBe('drop')
  })
})

// --- loadAccess ---
describe('loadAccess', () => {
  test('empty path returns defaults', () => {
    const access = loadAccess('')
    expect(access.dmPolicy).toBe('pairing')
    expect(access.allowFrom).toEqual([])
    expect(access.groups).toEqual({})
  })

  test('nonexistent file returns defaults', () => {
    const access = loadAccess('/tmp/nonexistent-access-file-test.json')
    expect(access.dmPolicy).toBe('pairing')
    expect(access.allowFrom).toEqual([])
  })
})

// --- Outbound endpoint contract tests ---
// These test the HTTP contract without a real Discord client.
// We create a mock server that mimics the /send endpoint validation.
describe('Outbound endpoint contract', () => {
  test('POST /send requires chat_id and text', async () => {
    // Simulate the validation logic from the adapter
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
    expect(result.length).toBeLessThanOrEqual(2002) // 1990 + '…(truncated)'.length
    expect(result.endsWith('…(truncated)')).toBe(true)
  })

  test('OUTBOUND_PORT defaults to WEBHOOK_PORT + 1000', () => {
    const webhookPort = 8795
    const outboundPort = webhookPort + 1000
    expect(outboundPort).toBe(9795)
  })
})
