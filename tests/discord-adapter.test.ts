#!/usr/bin/env bun
/**
 * Tests for Discord adapter access control and bot filter logic
 */
import { describe, test, expect } from 'bun:test'
import { gate, loadAccess, type Access } from '../scripts/discord-adapter'

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
  test('message in unconfigured channel is dropped', () => {
    const access = makeAccess()
    const result = gate(access, 'user-1', 'unknown-ch', null, false, false)
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

  test('thread with unconfigured parent is dropped', () => {
    const access = makeAccess({
      groups: { 'other-ch': { requireMention: false, allowFrom: [] } },
    })
    const result = gate(access, 'user-1', 'thread-ch', 'unknown-parent', false, false)
    expect(result.action).toBe('drop')
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
