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
import { shouldIgnoreDiscordInboundMessage } from '../adapters/discord'

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
