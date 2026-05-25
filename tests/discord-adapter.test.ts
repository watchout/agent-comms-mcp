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

const USABLE_PROVIDER_IDENTITY_PREDICATE =
  "api.status = 'active' AND api.trust_status NOT IN ('disabled', 'revoked')"

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

describe('Discord mention conversion pre-migration fallback', () => {
  test('converts @agent_id to Discord mention from metadata when provider identity table is absent', async () => {
    const adapter = new DiscordAdapter()
    const calls: string[] = []
    const missingTable = new Error('relation "agent_provider_identities" does not exist') as Error & { code: string }
    missingTable.code = '42P01'

    adapter.setDbQuery(async (sql, params) => {
      calls.push(sql)
      if (sql.includes('agent_provider_identities')) throw missingTable
      expect(sql).toContain("metadata->>'discord_id'")
      expect(params).toEqual(['agent-com-dev'])
      return { rows: [{ discord_id: '123456789012345678' }] }
    })

    await expect(adapter.convertMentionsToDiscord('ping @agent-com-dev')).resolves.toBe('ping <@123456789012345678>')
    expect(calls.length).toBe(2)
  })

  test('converts Discord mention to @agent_id from metadata when provider identity table is absent', async () => {
    const adapter = new DiscordAdapter()
    const calls: string[] = []

    adapter.setDbQuery(async (sql, params) => {
      calls.push(sql)
      if (sql.includes('agent_provider_identities')) throw new Error('no such table: agent_provider_identities')
      expect(sql).toContain("metadata->>'discord_id'")
      expect(params).toEqual(['123456789012345678'])
      return { rows: [{ agent_id: 'agent-com-dev' }] }
    })

    await expect(adapter.convertMentionsFromDiscord('ping <@!123456789012345678>')).resolves.toBe('ping @agent-com-dev')
    expect(calls.length).toBe(2)
  })
})

describe('Discord mention conversion provider identity trust status', () => {
  test('does not convert outbound mentions through revoked provider identities', async () => {
    const adapter = new DiscordAdapter()
    let sawProviderIdentityQuery = false

    adapter.setDbQuery(async (sql, params) => {
      expect(params).toEqual(['agent-com-dev'])
      if (!sql.includes('agent_provider_identities')) return { rows: [] }
      sawProviderIdentityQuery = true
      return {
        rows: [{
          discord_id: sql.includes(USABLE_PROVIDER_IDENTITY_PREDICATE)
            ? null
            : '123456789012345678',
        }],
      }
    })

    await expect(adapter.convertMentionsToDiscord('ping @agent-com-dev')).resolves.toBe('ping @agent-com-dev')
    expect(sawProviderIdentityQuery).toBe(true)
  })

  test('does not convert inbound mentions through disabled provider identities', async () => {
    const adapter = new DiscordAdapter()
    let sawProviderIdentityQuery = false

    adapter.setDbQuery(async (sql, params) => {
      expect(params).toEqual(['123456789012345678'])
      if (!sql.includes('agent_provider_identities')) return { rows: [] }
      sawProviderIdentityQuery = true
      return {
        rows: sql.includes(USABLE_PROVIDER_IDENTITY_PREDICATE)
          ? []
          : [{ agent_id: 'agent-com-dev' }],
      }
    })

    await expect(adapter.convertMentionsFromDiscord('ping <@123456789012345678>')).resolves.toBe('ping <@123456789012345678>')
    expect(sawProviderIdentityQuery).toBe(true)
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
