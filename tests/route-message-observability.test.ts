#!/usr/bin/env bun
/**
 * Issue #351 Phase A — mention drop observability.
 *
 * T1: routeMessage A1 (channel_non_member) → warn log + counter +1
 * T2: core routing ignores adapter external IDs
 * T3: resolveSendDestination B1 (caller not in mentions) → reject + log
 * T4: parseMentions malformed input → empty array, no throw
 * T5: happy-path regression — valid mention still enqueues, no drop log
 *
 * Usage: bun test tests/route-message-observability.test.ts
 */
import { describe, test, expect, beforeEach } from 'bun:test'
import {
  routeMessage,
  parseMentions,
  setObservabilityLogger,
  resetObservabilityCounters,
  getObservabilityCounters,
  type AgentInfo,
  type ChannelInfo,
} from '../core/route-message.ts'
import { resolveSendDestination, type DbAdapter } from '../core/route-message-db.ts'

type CapturedEvent = Record<string, unknown>

function captureLogger(): { events: CapturedEvent[]; reset: () => void } {
  const events: CapturedEvent[] = []
  setObservabilityLogger((e) => { events.push(e as unknown as CapturedEvent) })
  return { events, reset: () => { events.length = 0 } }
}

beforeEach(() => {
  resetObservabilityCounters()
})

describe('T1: routeMessage A1 — channel_non_member drop emits log + counter', () => {
  test('non-member recipient produces warn log and increments counter', () => {
    const { events } = captureLogger()

    const channel: ChannelInfo = { channelId: 'ch-1', members: ['agent-a'], type: 'channel' }
    const agents: AgentInfo[] = [
      { agentId: 'agent-a', agentType: 'dev', observerMode: false, discordId: null },
      { agentId: 'agent-b', agentType: 'dev', observerMode: false, discordId: null }, // not a member
    ]
    const msg = {
      authorAgentId: 'ceo',
      authorIsBot: false,
      content: '@agent-b hi',
      mentions: ['agent-b'],
      messageType: 'chat',
    }

    const result = routeMessage(msg, channel, agents, 'inbound')

    expect(result.dropTargets['agent-b']).toBe('NOT_A_MEMBER')
    expect(result.pushTargets).not.toContain('agent-b')

    const dropEvents = events.filter((e) => e.event === 'route_drop' && e.reason === 'channel_non_member')
    expect(dropEvents.length).toBe(1)
    expect(dropEvents[0].recipient_agent_id).toBe('agent-b')
    expect(dropEvents[0].channel_id).toBe('ch-1')
    expect(dropEvents[0].level).toBe('warn')

    const counters = getObservabilityCounters()
    expect(counters['route_message_drops_total|reason=channel_non_member']).toBe(1)
  })
})

describe('T2: core routing ignores adapter external IDs', () => {
  test('raw Discord IDs in msg.mentions never route to a bot in core', async () => {
    const { events } = captureLogger()

    const channel: ChannelInfo = { channelId: 'ch-1', members: ['agent-a', 'agent-b'], type: 'channel' }
    const agents: AgentInfo[] = [
      { agentId: 'agent-a', agentType: 'dev', observerMode: false, discordId: null },
      { agentId: 'agent-b', agentType: 'dev', observerMode: false, discordId: null }, // null discordId → A4
    ]
    const msg = {
      authorAgentId: 'ceo',
      authorIsBot: false,
      content: '<@1486351481871794207> hi',
      mentions: ['1486351481871794207'],
      messageType: 'chat',
    }

    const base = routeMessage(msg, channel, agents, 'inbound')
    expect(base.dropTargets['agent-b']).toBe('NOT_MENTIONED')
    expect(base.pushTargets).not.toContain('agent-b')

    const dropEvents = events.filter((e) => e.reason === 'mention_not_in_array' && e.recipient_agent_id === 'agent-b')
    expect(dropEvents.length).toBe(1)
  })

  test('explicit agent_id mention still routes without discord metadata', () => {
    const { events } = captureLogger()
    const channel: ChannelInfo = { channelId: 'ch-1', members: ['agent-a', 'agent-b'], type: 'channel' }
    const agents: AgentInfo[] = [
      { agentId: 'agent-a', agentType: 'dev', observerMode: false, discordId: null },
      { agentId: 'agent-b', agentType: 'dev', observerMode: false, discordId: null },
    ]
    const msg = {
      authorAgentId: 'ceo',
      authorIsBot: false,
      content: '@agent-b hi',
      mentions: ['agent-b'],
      messageType: 'chat',
    }

    const result = routeMessage(msg, channel, agents, 'inbound')
    expect(result.pushTargets).toContain('agent-b')
    expect(result.dropTargets['agent-b']).toBeUndefined()

    const dropEventsForB = events.filter((e) => e.event === 'route_drop' && e.recipient_agent_id === 'agent-b')
    expect(dropEventsForB.length).toBe(0)
  })
})

describe('T3: resolveSendDestination B1 — caller not in mentions → reject + structured log', () => {
  test('NOT_MENTIONED_IN_ORIGINAL emits send_reject event and increments counter', async () => {
    const { events } = captureLogger()

    const fakeDb: DbAdapter = {
      async query(sql: string) {
        if (sql.startsWith('SELECT author_id')) {
          return {
            rows: [{
              author_id: 'other-bot',
              content: 'hello world',
              message_type: 'chat',
              metadata: null,
              thread_id: null,
              channel_id: 'ch-1',
            }],
          }
        }
        if (sql.includes("SELECT agent_type FROM agents")) {
          return { rows: [{ agent_type: 'dev' }] } // not human
        }
        if (sql.includes("SELECT metadata->>'discord_id'")) {
          return { rows: [{ discord_id: null }] }
        }
        return { rows: [] }
      },
    }

    const out = await resolveSendDestination(fakeDb, 'agent-com-dev', 'msg-uuid-1')
    expect((out as { code: string }).code).toBe('NOT_MENTIONED_IN_ORIGINAL')

    const rejects = events.filter((e) => e.event === 'send_reject' && e.reason === 'not_mentioned_in_original')
    expect(rejects.length).toBe(1)
    expect(rejects[0].caller_agent_id).toBe('agent-com-dev')
    expect(rejects[0].original_author).toBe('other-bot')
    expect(rejects[0].original_id).toBe('msg-uuid-1')
    expect(rejects[0].has_parsed_mentions).toBe(false)
    expect(rejects[0].has_metadata_mentions).toBe(false)

    const counters = getObservabilityCounters()
    expect(counters['send_reject_total|reason=not_mentioned_in_original']).toBe(1)
  })

  test('input_mentions grants reply ACL for normalized Discord mention rows', async () => {
    const { events } = captureLogger()

    const fakeDb: DbAdapter = {
      async query(sql: string) {
        if (sql.startsWith('SELECT author_id')) {
          return {
            rows: [{
              author_id: 'auditor',
              content: '<@1491404979477676053> post-merge audit response',
              message_type: 'chat',
              metadata: null,
              thread_id: null,
              channel_id: 'ch-audit',
              input_mentions: ['codex-aun'],
            }],
          }
        }
        if (sql.includes("SELECT agent_type FROM agents")) {
          return { rows: [{ agent_type: 'dev' }] }
        }
        if (sql.includes("SELECT metadata->>'discord_id'")) {
          return { rows: [{ discord_id: '1491404979477676053' }] }
        }
        return { rows: [] }
      },
    }

    const out = await resolveSendDestination(fakeDb, 'codex-aun', 'msg-normalized-mention')
    expect(out).toEqual({ channelId: 'ch-audit', threadId: null })

    const rejects = events.filter((e) => e.event === 'send_reject' && e.reason === 'not_mentioned_in_original')
    expect(rejects.length).toBe(0)
    const counters = getObservabilityCounters()
    expect(counters['send_reject_total|reason=not_mentioned_in_original']).toBeUndefined()
  })
})

describe('T4: parseMentions defensive — malformed input never throws', () => {
  test('empty string returns []', () => {
    expect(parseMentions('')).toEqual([])
  })
  test('non-string input returns []', () => {
    expect(parseMentions(null as unknown as string)).toEqual([])
    expect(parseMentions(undefined as unknown as string)).toEqual([])
    expect(parseMentions(123 as unknown as string)).toEqual([])
  })
  test('bare <@> with no id returns []', () => {
    expect(parseMentions('<@>')).toEqual([])
  })
  test('numeric-only ID is excluded (Discord snowflake, not native agent)', () => {
    expect(parseMentions('hello @1486351481871794207 world')).toEqual([])
  })
  test('mixed valid and invalid mentions only keeps valid', () => {
    expect(parseMentions('@cto @1234567890 @lead-ama')).toEqual(['codex-cto', 'lead-ama'])
  })
})

describe('T5: happy-path regression — valid mention still enqueues, no drop log fires for recipient', () => {
  test('mentioned bot lands in pushTargets and emits no drop event for itself', () => {
    const { events } = captureLogger()

    const channel: ChannelInfo = { channelId: 'ch-1', members: ['agent-a', 'agent-b'], type: 'channel' }
    const agents: AgentInfo[] = [
      { agentId: 'agent-a', agentType: 'dev', observerMode: false, discordId: null },
      { agentId: 'agent-b', agentType: 'dev', observerMode: false, discordId: null },
    ]
    const msg = {
      authorAgentId: 'agent-a',
      authorIsBot: true,
      content: '@agent-b hello',
      mentions: ['agent-b'],
      messageType: 'chat',
    }

    const result = routeMessage(msg, channel, agents, 'inbound')

    expect(result.pushTargets).toEqual(['agent-b'])
    expect(result.dropTargets['agent-b']).toBeUndefined()

    const dropEventsForB = events.filter((e) => e.event === 'route_drop' && e.recipient_agent_id === 'agent-b')
    expect(dropEventsForB.length).toBe(0)
  })
})

describe('T6: human agents are dropped from pushTargets (no message_queue insert)', () => {
  test('recipient with agentType=human is dropped with HUMAN_AGENT_NO_QUEUE', () => {
    const { events } = captureLogger()

    const channel: ChannelInfo = { channelId: 'ch-1', members: ['agent-a', 'ceo'], type: 'channel' }
    const agents: AgentInfo[] = [
      { agentId: 'agent-a', agentType: 'dev', observerMode: false, discordId: null },
      { agentId: 'ceo', agentType: 'human', observerMode: false, discordId: '1227059781265653783' },
    ]
    const msg = {
      authorAgentId: 'agent-a',
      authorIsBot: true,
      content: 'thanks <@ceo>',
      mentions: ['ceo'],
      messageType: 'chat',
    }

    const result = routeMessage(msg, channel, agents, 'inbound')

    expect(result.pushTargets).not.toContain('ceo')
    expect(result.dropTargets['ceo']).toBe('HUMAN_AGENT_NO_QUEUE')

    const dropEvents = events.filter((e) => e.event === 'route_drop' && e.reason === 'human_agent_no_queue')
    expect(dropEvents.length).toBe(1)
    expect(dropEvents[0].recipient_agent_id).toBe('ceo')

    const counters = getObservabilityCounters()
    expect(counters['route_message_drops_total|reason=human_agent_no_queue']).toBe(1)
  })

  test('senderIsHuman + noMentions does not enqueue bots or humans', () => {
    captureLogger()

    const channel: ChannelInfo = { channelId: 'ch-1', members: ['agent-a', 'ceo'], type: 'channel' }
    const agents: AgentInfo[] = [
      { agentId: 'agent-a', agentType: 'dev', observerMode: false, discordId: null },
      { agentId: 'ceo', agentType: 'human', observerMode: false, discordId: '1227059781265653783' },
    ]
    const msg = {
      authorAgentId: 'ceo',
      authorIsBot: false,
      content: 'no mentions here',
      mentions: [],
      messageType: 'chat',
    }

    const result = routeMessage(msg, channel, agents, 'inbound')

    expect(result.pushTargets).toEqual([])
    expect(result.dropTargets['agent-a']).toBe('MISSING_MENTION_TARGET')
  })
})

describe('T7: missing-mention alert routing + @everyone broadcast', () => {
  test('no-mention with channel.primary → no enqueue, primary marked missing target', () => {
    const { events } = captureLogger()

    const channel: ChannelInfo = {
      channelId: 'ch-1',
      members: ['agent-a', 'agent-b', 'agent-c'],
      type: 'channel',
      primary: 'agent-a',
    }
    const agents: AgentInfo[] = [
      { agentId: 'agent-a', agentType: 'dev', observerMode: false, discordId: null },
      { agentId: 'agent-b', agentType: 'dev', observerMode: false, discordId: null },
      { agentId: 'agent-c', agentType: 'dev', observerMode: false, discordId: null },
    ]
    const msg = {
      authorAgentId: 'ceo',
      authorIsBot: false,
      content: 'hello fleet (no mention)',
      mentions: [],
      messageType: 'chat',
    }

    const result = routeMessage(msg, channel, agents, 'inbound')

    expect(result.pushTargets).toEqual([])
    expect(result.dropTargets['agent-a']).toBe('MISSING_MENTION_TARGET')
    expect(result.dropTargets['agent-b']).toBe('NOT_PRIMARY_NO_MENTION')
    expect(result.dropTargets['agent-c']).toBe('NOT_PRIMARY_NO_MENTION')

    const drops = events.filter((e) => e.event === 'route_drop' && e.reason === 'not_primary_no_mention')
    expect(drops.length).toBe(2)
    const missingDrops = events.filter((e) => e.event === 'route_drop' && e.reason === 'missing_mention_target')
    expect(missingDrops.length).toBe(1)
  })

  test('no-mention WITHOUT channel.primary → no enqueue, all bot members marked missing target', () => {
    captureLogger()

    const channel: ChannelInfo = {
      channelId: 'ch-1',
      members: ['agent-a', 'agent-b'],
      type: 'channel',
      // primary omitted
    }
    const agents: AgentInfo[] = [
      { agentId: 'agent-a', agentType: 'dev', observerMode: false, discordId: null },
      { agentId: 'agent-b', agentType: 'dev', observerMode: false, discordId: null },
    ]
    const msg = {
      authorAgentId: 'ceo',
      authorIsBot: false,
      content: 'legacy ceo bypass',
      mentions: [],
      messageType: 'chat',
    }

    const result = routeMessage(msg, channel, agents, 'inbound')
    expect(result.pushTargets).toEqual([])
    expect(result.dropTargets['agent-a']).toBe('MISSING_MENTION_TARGET')
    expect(result.dropTargets['agent-b']).toBe('MISSING_MENTION_TARGET')
  })

  test('@everyone fanout even when channel.primary is set', () => {
    captureLogger()

    const channel: ChannelInfo = {
      channelId: 'ch-1',
      members: ['agent-a', 'agent-b', 'agent-c'],
      type: 'channel',
      primary: 'agent-a',
    }
    const agents: AgentInfo[] = [
      { agentId: 'agent-a', agentType: 'dev', observerMode: false, discordId: null },
      { agentId: 'agent-b', agentType: 'dev', observerMode: false, discordId: null },
      { agentId: 'agent-c', agentType: 'dev', observerMode: false, discordId: null },
    ]
    const msg = {
      authorAgentId: 'ceo',
      authorIsBot: false,
      content: 'announce @everyone',
      mentions: ['everyone'],
      messageType: 'chat',
    }

    const result = routeMessage(msg, channel, agents, 'inbound')
    expect(result.pushTargets.sort()).toEqual(['agent-a', 'agent-b', 'agent-c'])
  })

  test('@all alias still works (regression)', () => {
    const channel: ChannelInfo = { channelId: 'ch-1', members: ['agent-a', 'agent-b'], type: 'channel', primary: 'agent-a' }
    const agents: AgentInfo[] = [
      { agentId: 'agent-a', agentType: 'dev', observerMode: false, discordId: null },
      { agentId: 'agent-b', agentType: 'dev', observerMode: false, discordId: null },
    ]
    const msg = { authorAgentId: 'ceo', authorIsBot: false, content: 'all hands @all', mentions: ['all'], messageType: 'chat' }
    const result = routeMessage(msg, channel, agents, 'inbound')
    expect(result.pushTargets.sort()).toEqual(['agent-a', 'agent-b'])
  })

  test('bot sender with no mentions and primary set → no enqueue', () => {
    const channel: ChannelInfo = { channelId: 'ch-1', members: ['agent-a', 'agent-b'], type: 'channel', primary: 'agent-a' }
    const agents: AgentInfo[] = [
      { agentId: 'agent-a', agentType: 'dev', observerMode: false, discordId: null },
      { agentId: 'agent-b', agentType: 'dev', observerMode: false, discordId: null },
    ]
    const msg = { authorAgentId: 'other-bot', authorIsBot: true, content: 'silent bot post', mentions: [], messageType: 'chat' }
    const result = routeMessage(msg, channel, agents, 'inbound')
    expect(result.pushTargets).toEqual([])
    expect(result.dropTargets['agent-a']).toBe('MISSING_MENTION_TARGET')
    expect(result.dropTargets['agent-b']).toBe('NOT_PRIMARY_NO_MENTION')
  })
})

describe('T8: #527 cycle 3 — Discord inbound parser passes @everyone / @here through to routing', () => {
  // Pure regression for the GROUP_KEYWORDS allowlist used by
  // extractDiscordMentions() in server.ts. We re-implement just the filter
  // (the rest of extractDiscordMentions is DB-bound) and assert that
  // 'everyone' and 'here' survive when they are not channel members. This
  // mirrors the production path: parseMentions() captures the literal,
  // GROUP_KEYWORDS.has() lets it through, routeMessage() then fanouts.
  test('GROUP_KEYWORDS lets @everyone and @here through the member filter', () => {
    const { GROUP_KEYWORDS } = require('../core/send-errors')
    const members = new Set(['agent-a'])
    const parsed = parseMentions('hello @everyone and @here and @agent-b')
    const filtered = parsed.filter((id: string) => members.has(id) || GROUP_KEYWORDS.has(id))
    expect(filtered).toContain('everyone')
    expect(filtered).toContain('here')
    // agent-b is not a member and not a group keyword → filtered out
    expect(filtered).not.toContain('agent-b')
  })

  test('end-to-end: @everyone survives parse → filter → routeMessage fanout overrides primary', () => {
    const { GROUP_KEYWORDS } = require('../core/send-errors')
    const channel: ChannelInfo = {
      channelId: 'ch-1',
      members: ['agent-a', 'agent-b'],
      type: 'channel',
      primary: 'agent-a',
    }
    const agents: AgentInfo[] = [
      { agentId: 'agent-a', agentType: 'dev', observerMode: false, discordId: null },
      { agentId: 'agent-b', agentType: 'dev', observerMode: false, discordId: null },
    ]
    const memberSet = new Set(channel.members)
    const content = 'announce @everyone'
    // Reproduce extractDiscordMentions:1291 filter (server.ts) — only the
    // native-mention slice is exercised here; the <@discord_id> slice is
    // DB-bound and out of scope for this pure regression.
    const mentions = parseMentions(content)
      .filter((id: string) => memberSet.has(id) || GROUP_KEYWORDS.has(id))
    expect(mentions).toContain('everyone')

    const result = routeMessage(
      { authorAgentId: 'ceo', authorIsBot: false, content, mentions, messageType: 'chat' },
      channel,
      agents,
      'inbound',
    )
    // primary-only would be ['agent-a']; broadcast must fan out to both
    expect(result.pushTargets.sort()).toEqual(['agent-a', 'agent-b'])
  })
})
