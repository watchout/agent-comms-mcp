#!/usr/bin/env bun
/**
 * Tests for inbound mentions filter (PR#62 — §3.15 step 4, updated for §5.1 pure routeInbound)
 *
 * Verifies:
 * 1. extractDiscordMentions helper
 * 2. routeInbound() pure function — mentions filter logic
 * 3. handleInboundMessage() wrapper — DB + routing + push
 * 4. Bypass conditions (emergency only, CEO follows mentions)
 * 5. All callsites pass mentions
 * 6. §2.2 Pattern A: human warning (no mentions)
 *
 * Usage: bun test tests/inbound-mentions-filter.test.ts
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { routeMessage } from '../core/route-message'
import { authorizeDiscordInboundSender } from '../adapters/discord'
import type { DbAdapter } from '../core/route-message-db'

const PROJECT_ROOT = join(dirname(new URL(import.meta.url).pathname), '..')
// FEAT-005: handleInboundMessage + sendHumanWarning moved to
// adapters/inbound-receiver.ts; outbound consumer to adapters/
// outbound-consumer.ts. Concat so mentions-filter structural pins
// still fire at the new home.
const SERVER_SOURCE =
  readFileSync(join(PROJECT_ROOT, 'server.ts'), 'utf-8')
  + '\n'
  + readFileSync(join(PROJECT_ROOT, 'adapters/inbound-receiver.ts'), 'utf-8')
  + '\n'
  + readFileSync(join(PROJECT_ROOT, 'adapters/outbound-consumer.ts'), 'utf-8')
// PR-A: routeInbound + helpers extracted to core/route-message{,-db}.ts
const CORE_PURE_SOURCE = readFileSync(join(PROJECT_ROOT, 'core/route-message.ts'), 'utf-8')
const CORE_DB_SOURCE = readFileSync(join(PROJECT_ROOT, 'core/route-message-db.ts'), 'utf-8')
const DISCORD_SOURCE = readFileSync(join(PROJECT_ROOT, 'adapters/discord.ts'), 'utf-8')

describe('Inbound Mentions Filter — extractDiscordMentions', () => {
  test('extractDiscordMentions function exists with rawDiscordUserIds param', () => {
    expect(SERVER_SOURCE).toContain('async function extractDiscordMentions(content: string, rawDiscordUserIds?: string[], externalChannelId?: string)')
  })

  test('parses Discord <@id> mentions', () => {
    expect(SERVER_SOURCE).toContain('/<@!?(\\d+)>/g')
  })

  test('resolves Discord IDs to agent_ids only through channel members', () => {
    const fnIdx = SERVER_SOURCE.indexOf('async function extractDiscordMentions')
    const fnBody = SERVER_SOURCE.slice(fnIdx, fnIdx + 1800)
    expect(fnBody).toContain('resolveInboundChannel(db, externalChannelId)')
    expect(fnBody).toContain('resolveAgentFromDiscordIdInMembers(db, discordId, [...memberSet])')
    expect(fnBody).not.toContain('resolveAgentFromDiscordId(db, discordId)')
  })

  test('also parses @agent_id native mentions', () => {
    const fnIdx = SERVER_SOURCE.indexOf('async function extractDiscordMentions')
    const fnBody = SERVER_SOURCE.slice(fnIdx, fnIdx + 3000)
    expect(fnBody).toContain('parseNativeAgentMentions(content, aliasMap)')
  })

  test('deduplicates mentions', () => {
    const fnIdx = SERVER_SOURCE.indexOf('async function extractDiscordMentions')
    const fnBody = SERVER_SOURCE.slice(fnIdx, fnIdx + 3000)
    expect(fnBody).toContain('new Set(')
  })

  // Phase C Step 1 PR-A (A): regression pin for bug 1895/1896.
  // Discord.js msg.mentions.users auto-includes the reply target; accepting
  // those verbatim leaks the reply target into agent mentions and causes
  // cross-bot message_queue INSERTs. The function must filter rawDiscordUserIds
  // to those that actually appear as <@...> in the content text.
  test('filters rawDiscordUserIds to IDs present in content (excludes reply auto-mention)', () => {
    const fnIdx = SERVER_SOURCE.indexOf('async function extractDiscordMentions')
    const fnBody = SERVER_SOURCE.slice(fnIdx, fnIdx + 3000)
    expect(fnBody).toContain('contentIdSet')
    expect(fnBody).toMatch(/if\s*\(!contentIdSet\.has\(discordId\)\)\s*continue/)
  })
})

describe('routeInbound — Pure function (§5.1)', () => {
  // PR-A: extracted to core/route-message.ts
  // PR-B: renamed to `routeMessage` with a `sourceType` discriminator (§C2).
  // `routeInbound` is kept as a backwards-compat alias that forwards to
  // `routeMessage({sourceType: 'inbound'})`.
  test('routeInbound alias still exists and routeMessage is the pure implementation', () => {
    expect(CORE_PURE_SOURCE).toContain('export function routeInbound(')
    expect(CORE_PURE_SOURCE).toContain('export function routeMessage(')
    expect(CORE_PURE_SOURCE).not.toContain('export async function routeMessage(')
    // The alias body is a one-line forwarder
    const aliasIdx = CORE_PURE_SOURCE.indexOf('export function routeInbound(')
    expect(CORE_PURE_SOURCE.slice(aliasIdx, aliasIdx + 400)).toContain("routeMessage(msg, channel, agents, 'inbound')")
  })

  test('routeMessage takes msg, channel, agents, sourceType params', () => {
    const fnIdx = CORE_PURE_SOURCE.indexOf('export function routeMessage(')
    const fnSig = CORE_PURE_SOURCE.slice(fnIdx, fnIdx + 500)
    expect(fnSig).toContain('msg:')
    expect(fnSig).toContain('channel: ChannelInfo')
    expect(fnSig).toContain('agents: AgentInfo[]')
    expect(fnSig).toContain('sourceType: RouteSourceType')
  })

  test('routeMessage returns RouteResult with pushTargets and dropTargets', () => {
    expect(CORE_PURE_SOURCE).toContain('pushTargets: string[]')
    expect(CORE_PURE_SOURCE).toContain('dropTargets: Record<string, string>')
    expect(CORE_PURE_SOURCE).toContain('senderIsHuman: boolean')
    expect(CORE_PURE_SOURCE).toContain('noMentions: boolean')
    // PR-B §C2: senderViolation is set for send-tool / cli callers whose own
    // agentId is not a channel member
    expect(CORE_PURE_SOURCE).toContain('senderViolation?: string')
  })

  test('mentions filter checks individual and group mentions', () => {
    const fnIdx = CORE_PURE_SOURCE.indexOf('export function routeMessage(')
    const fnBody = CORE_PURE_SOURCE.slice(fnIdx, fnIdx + 8000)
    expect(fnBody).toContain("msg.mentions.includes(agent.agentId)")
    expect(fnBody).toContain("msg.mentions.includes('all')")
    expect(fnBody).toContain("msg.mentions.includes('dev')")
    expect(fnBody).toContain("msg.mentions.includes('org')")
  })

  test('NOT_MENTIONED is set in dropTargets', () => {
    const fnIdx = CORE_PURE_SOURCE.indexOf('export function routeMessage(')
    const fnBody = CORE_PURE_SOURCE.slice(fnIdx, fnIdx + 8000)
    expect(fnBody).toContain("'NOT_MENTIONED'")
  })

  test('DM bypass: DM messages always push', () => {
    const fnIdx = CORE_PURE_SOURCE.indexOf('export function routeMessage(')
    const fnBody = CORE_PURE_SOURCE.slice(fnIdx, fnIdx + 5000)
    expect(fnBody).toContain('isDm')
  })

  test('emergency bypass + no-mention missing-target alert routing', () => {
    const fnIdx = CORE_PURE_SOURCE.indexOf('export function routeMessage(')
    const fnBody = CORE_PURE_SOURCE.slice(fnIdx, fnIdx + 5000)
    expect(fnBody).toContain('isEmergency')
    expect(fnBody).not.toContain('isCeo')
    // CEO directive 2026-05-27 — missing mention targets alert instead of
    // falling back to channel.primary or legacy human fanout.
    expect(fnBody).toContain('if (noMentions)')
    expect(fnBody).toContain('channel.primary')
    expect(fnBody).toContain('MISSING_MENTION_TARGET')
    expect(fnBody).toContain('NOT_PRIMARY_NO_MENTION')
    // Behavioural cover: T7.a-e in tests/route-message-observability.test.ts
    // and case 4 below for the missing-target path.
  })

  test('observer mode agents are dropped', () => {
    const fnIdx = CORE_PURE_SOURCE.indexOf('export function routeMessage(')
    const fnBody = CORE_PURE_SOURCE.slice(fnIdx, fnIdx + 5000)
    expect(fnBody).toContain('agent.observerMode')
    expect(fnBody).toContain("'OBSERVER_MODE'")
  })

  test('routeMessage rejects unresolved/non-member senders for every source and human native inbound', () => {
    const fnIdx = CORE_PURE_SOURCE.indexOf('export function routeMessage(')
    const fnBody = CORE_PURE_SOURCE.slice(fnIdx, fnIdx + 5000)
    expect(fnBody).not.toContain("sourceType !== 'inbound'")
    expect(fnBody).toContain('SENDER_ID_UNRESOLVED')
    expect(fnBody).toContain("SENDER_NOT_A_MEMBER")
    expect(fnBody).toContain("sourceType === 'inbound'")
    expect(fnBody).toContain('SENDER_HUMAN_NOT_ALLOWED')
  })
})

// CEO directive 2026-05-27 — no-mention human posts alert instead of routing.
describe('routeMessage — Issue #278 §B CEO bypass behavior', () => {
  const channel = {
    channelId: 'agent-com',
    type: 'channel',
    members: ['ceo', 'cto', 'agent-com-dev', 'lead-ama'],
  } as const
  const agents = [
    { agentId: 'ceo', agentType: 'human', observerMode: false, discordId: '1227059781265653783' },
    { agentId: 'cto', agentType: 'org', observerMode: false, discordId: null },
    { agentId: 'agent-com-dev', agentType: 'dev', observerMode: false, discordId: null },
    { agentId: 'lead-ama', agentType: 'org', observerMode: false, discordId: null },
  ] as const

  test('case 4 — DB human sender is rejected before recipient routing', () => {
    const result = routeMessage(
      {
        authorAgentId: 'ceo',
        authorIsBot: false,
        content: 'Stage B どうなってる？',
        mentions: [],
        messageType: 'chat',
      },
      channel as any,
      agents as any,
      'inbound',
    )
    expect(result.pushTargets).toEqual([])
    expect(result.dropTargets).toEqual({})
    expect(result.senderViolation).toBe('SENDER_HUMAN_NOT_ALLOWED')
    expect(result.noMentions).toBe(true)
    expect(result.senderIsHuman).toBe(true)
  })

  test('observer-mode bots keep observer drop when no mention is present', () => {
    const agentsWithObserver = [
      ...agents.slice(0, 3),
      { ...agents[3], observerMode: true },
    ]
    const result = routeMessage(
      {
        authorAgentId: 'agent-com-dev',
        authorIsBot: true,
        content: 'broadcast',
        mentions: [],
        messageType: 'chat',
      },
      channel as any,
      agentsWithObserver as any,
      'inbound',
    )
    expect(result.pushTargets).toEqual([])
    expect(result.dropTargets['ceo']).toBe('HUMAN_AGENT_NO_QUEUE')
    expect(result.dropTargets['cto']).toBe('NOT_MENTIONED')
    expect(result.dropTargets['lead-ama']).toBe('OBSERVER_MODE')
  })

  test('bot author + no mentions still drops as not mentioned without a primary', () => {
    // Bot chatter without explicit mentions does not fan out and does not
    // trigger the human warning path.
    const result = routeMessage(
      {
        authorAgentId: 'lead-ama',
        authorIsBot: true,
        content: 'broadcast',
        mentions: [],
        messageType: 'chat',
      },
      channel as any,
      agents as any,
      'inbound',
    )
    expect(result.pushTargets).toEqual([])
    expect(result.dropTargets['cto']).toBe('NOT_MENTIONED')
    expect(result.dropTargets['agent-com-dev']).toBe('NOT_MENTIONED')
    expect(result.dropTargets['lead-ama']).toBeUndefined() // self-skip, no entry
  })

  test('human author + explicit mentions is still rejected at native inbound boundary', () => {
    const result = routeMessage(
      {
        authorAgentId: 'ceo',
        authorIsBot: false,
        content: 'cto only',
        mentions: ['cto'],
        messageType: 'chat',
      },
      channel as any,
      agents as any,
      'inbound',
    )
    expect(result.pushTargets).toEqual([])
    expect(result.dropTargets).toEqual({})
    expect(result.senderViolation).toBe('SENDER_HUMAN_NOT_ALLOWED')
  })
})

describe('handleInboundMessage — Full flow wrapper', () => {
  test('handleInboundMessage is async and wraps routeInbound', () => {
    expect(SERVER_SOURCE).toContain('async function handleInboundMessage(')
  })

  test('native Discord sender authorization happens before callbacks and queue-capable flow', () => {
    const fnIdx = DISCORD_SOURCE.indexOf('private async handleInbound(msg: Message)')
    const fnBody = DISCORD_SOURCE.slice(fnIdx, fnIdx + 7000)
    const authIdx = fnBody.indexOf('authorizeDiscordInboundSender(')
    expect(authIdx).toBeGreaterThan(-1)
    expect(authIdx).toBeLessThan(fnBody.indexOf('startTypingInternal('))
    expect(authIdx).toBeLessThan(fnBody.indexOf('this.messageCallback(unified)'))
    expect(authIdx).toBeLessThan(fnBody.indexOf('this.adapterMessageCallback(inbound)'))
  })

  test('last_received_context abolished (reply_to required, §4.2)', () => {
    // updateLastReceivedContext should no longer exist
    expect(SERVER_SOURCE).not.toContain('async function updateLastReceivedContext')
    expect(SERVER_SOURCE).not.toContain('async function getLastReceivedContext')
  })

  test('returns humanWarning flag for Pattern A', () => {
    const fnIdx = SERVER_SOURCE.indexOf('async function handleInboundMessage(')
    // Window widened for PR-β (Issue #230): handleInboundMessage now
    // resolves replyToMessageId → UUID before the routing decision, so the
    // body grew past the original 5000-char window.
    const fnBody = SERVER_SOURCE.slice(fnIdx, fnIdx + 12000)
    expect(fnBody).toContain('humanWarning:')
    expect(fnBody).toContain('result.senderIsHuman && result.noMentions')
  })
})

describe('Discord native inbound — DB channels.members sender boundary', () => {
  function authDb(
    bindingAgentIds: string[],
    memberIds = ['agent-a', 'ceo'],
    agentTypes: Record<string, string> = { 'agent-a': 'dev', ceo: 'human' },
  ): DbAdapter {
    return {
      async query(sql: string, params: unknown[] = []) {
        if (sql.includes('SELECT id, members, type FROM channels')) {
          return { rows: [{ id: 'ch-1', members: memberIds, type: 'channel' }] }
        }
        if (sql.includes('FROM agent_ui_bindings')) {
          return {
            rows: bindingAgentIds.map((agentId) => ({
              agent_id: agentId,
              ui_id: String(params[0]),
              status: 'active',
              surface_role: 'primary',
            })),
          }
        }
        if (sql.includes("metadata->>'discord_id' = $1")) {
          return { rows: bindingAgentIds.map((agent_id) => ({ agent_id })) }
        }
        if (sql.includes('SELECT agent_type FROM agents')) {
          const agentType = agentTypes[String(params[0])]
          return { rows: agentType ? [{ agent_type: agentType }] : [] }
        }
        return { rows: [] }
      },
    }
  }

  test('allows exactly one non-human member identity', async () => {
    expect(await authorizeDiscordInboundSender(authDb(['agent-a']), 'ch-1', 'discord-a')).toEqual({
      ok: true,
      agentId: 'agent-a',
      channelId: 'ch-1',
    })
  })

  test('fails closed for absent DB, unmapped/nonmember, ambiguous, and human senders', async () => {
    expect(await authorizeDiscordInboundSender(null, 'ch-1', 'discord-a')).toEqual({ ok: false, code: 'DB_UNAVAILABLE' })
    expect(await authorizeDiscordInboundSender(authDb([]), 'ch-1', 'discord-a')).toEqual({ ok: false, code: 'SENDER_NOT_A_MEMBER' })
    expect(await authorizeDiscordInboundSender(authDb(['outside'], ['agent-a']), 'ch-1', 'discord-a')).toEqual({ ok: false, code: 'SENDER_NOT_A_MEMBER' })
    expect(await authorizeDiscordInboundSender(authDb(['agent-a', 'agent-b'], ['agent-a', 'agent-b'], { 'agent-a': 'dev', 'agent-b': 'dev' }), 'ch-1', 'discord-a')).toEqual({ ok: false, code: 'SENDER_ID_UNRESOLVED' })
    expect(await authorizeDiscordInboundSender(authDb(['ceo']), 'ch-1', 'discord-ceo')).toEqual({ ok: false, code: 'SENDER_HUMAN_NOT_ALLOWED' })
  })
})

describe('§2.2 Pattern A — Human warning', () => {
  test('sendHumanWarning function exists', () => {
    expect(SERVER_SOURCE).toContain('async function sendHumanWarning(')
  })

  test('warning includes mentions guidance', () => {
    expect(SERVER_SOURCE).toContain('メンション先がありません')
    expect(SERVER_SOURCE).toContain('@all')
  })

  test('cross-process dedup via pg_try_advisory_lock', () => {
    const fnIdx = SERVER_SOURCE.indexOf('async function sendHumanWarning(')
    const fnBody = SERVER_SOURCE.slice(fnIdx, fnIdx + 2000)
    expect(fnBody).toContain('pg_try_advisory_lock')
  })

  test('unified flow caller sends human warning (Phase C I5)', () => {
    // Phase C I5: single shared startup onMessage handler calls handleInboundMessage
    // AND sendHumanWarning. §2.2 Pattern A human warning remains functional.
    const sharedStartup = SERVER_SOURCE.indexOf('// --- 2. Shared startup (unconditional) ---')
    const sharedSection = SERVER_SOURCE.slice(sharedStartup)
    expect(sharedSection).toContain('result.humanWarning')
    expect(sharedSection).toContain('sendHumanWarning')
  })
})

describe('Inbound Mentions Filter — callsite updates (Phase C I5: unified)', () => {
  test('Discord adapter connects and uses handleInboundMessage', () => {
    expect(SERVER_SOURCE).toContain('Discord adapter connected (inbound + outbound)')
    expect(SERVER_SOURCE).toContain('extractDiscordMentions(content, msg.mentionUserIds, msg.channel)')
  })

  test('per-bot client does NOT bind onMessage (outbound-only)', () => {
    expect(SERVER_SOURCE).not.toContain('botDiscord.onMessage')
  })

  test('shared Discord onMessage calls handleInboundMessage (Phase C I5: single callsite)', () => {
    // Phase C I5: unified flow — single shared Discord adapter
    // calls handleInboundMessage for full inbound routing.
    const sharedStartup = SERVER_SOURCE.indexOf('// --- 2. Shared startup (unconditional) ---')
    const sharedSection = SERVER_SOURCE.slice(sharedStartup)
    const sharedIdx = sharedSection.indexOf('discord.onMessage((msg)')
    expect(sharedIdx).toBeGreaterThan(-1)
    const handlerBody = sharedSection.slice(sharedIdx, sharedIdx + 3000)
    expect(handlerBody).toContain('handleInboundMessage({')
  })

  test('all callsites use handleInboundMessage (not old routeInbound)', () => {
    // routeInbound should NOT be called with { receiverAgentId: ... } directly
    // Only handleInboundMessage should be called from message handlers
    const callsites = SERVER_SOURCE.match(/routeInbound\(\{/g)
    expect(callsites).toBeNull()  // No direct calls to routeInbound with object literal
  })
})
