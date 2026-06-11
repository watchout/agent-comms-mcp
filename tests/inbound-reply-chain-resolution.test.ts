#!/usr/bin/env bun
/**
 * PR-β §4 frozen merge-gate fixtures (cycle 3 — auditor Pre-impl PASS 6/6,
 * dispatch msg `bc03a6a6`/`f4e1b06d`/`86b3b6e1`).
 *
 * Pins (case 6 deleted in cycle 3 — case 4/5 already pin the wire order
 * at runtime; the source-grep was redundant):
 *   - case 1   dedicated column hit → reply_to UUID 設定
 *   - case 1b  legacy row (column NULL + metadata.discord_message_id) →
 *              metadata fallback で reply_to UUID 設定 (cycle 3 §1.1 step 2)
 *   - case 1c  両 miss orphan → reply_to NULL + injected stderrSink で
 *              orphan log 観測 (cycle 3 §1.3)
 *   - case 1d  NEW both-hit coexistence → column row が必ず返却 +
 *              metadata query は物理的に発火しない (cycle 3 §1.1 priority)
 *   - case 2   replyToMessageId なし → reply_to undefined
 *   - case 3   orphan stderr (case 1c と独立 keep、両者 sink 経由)
 *   - case 4   handleInboundMessage with routeInbound spy → empty mentions
 *              + parent → spy が `[parent.author_id]` を受領
 *   - case 5   explicit mentions → spy が unchanged 受領
 *
 * §1.4 adapter symmetry: 本 PR は inbound adapter only。outbound adapter
 * への symmetric な変更は意図的に加えない (BLOCK 1/2/3 は inbound 固有、
 * 同 abstraction 層内 N instance ではないため)。
 *
 * §3 anti-patterns (cycle 3): priority-non-deterministic SQL / late-bound
 * global resolution / process-global stderr monkeypatch — 本 file は
 * test injection 経由で全て回避。
 */
import { describe, test, expect } from 'bun:test'
import {
  handleInboundMessage,
  setInboundReceiverDeps,
  type InboundReceiverDeps,
} from '../adapters/inbound-receiver'
import type { routeInbound as RouteInboundFn } from '../core/route-message'

interface SaveMessageCapture {
  channel_id: string
  author_id: string
  content: string
  message_type?: string
  reply_to?: string
  metadata?: Record<string, unknown>
  author_bot?: boolean
  input_mentions?: string[] | null
}

type ParentLookupMode =
  | { kind: 'column'; row: { id: string; author_id: string } }
  | { kind: 'metadata'; row: { id: string; author_id: string } }
  | { kind: 'both'; columnRow: { id: string; author_id: string }; metadataRow: { id: string; author_id: string } }
  | { kind: 'miss' }

interface QueryStats {
  columnQueries: number
  metadataQueries: number
}

function makeDeps(opts: {
  parentLookup?: ParentLookupMode
  registeredChannel?: boolean
  receiverIsMember?: boolean
  channelMembers?: string[]
  discordResolution?: Record<string, string>
  routeSpy?: RouteInboundFn
  stderrSink?: (chunk: string) => void
}): {
  deps: InboundReceiverDeps
  saved: SaveMessageCapture[]
  routeCalls: Array<{ mentions: string[] }>
  queryStats: QueryStats
} {
  const saved: SaveMessageCapture[] = []
  const routeCalls: Array<{ mentions: string[] }> = []
  const queryStats: QueryStats = { columnQueries: 0, metadataQueries: 0 }
  const channelId = 'core-channel-uuid'
  const receiverAgentId = 'receiver-bot'

  const coreDbAdapter = async () => ({
    async query(sql: string, params?: any[]): Promise<{ rows: any[] }> {
      const s = sql.toLowerCase()
      const firstParam = typeof params?.[0] === 'string' ? params[0] : ''
      // §1.1 cycle 3 — 2-step lookup. Each branch is counted separately
      // so case 1d can assert column priority is deterministic
      // (metadata query never fires when the column already hit).
      const isColumnLookup =
        s.includes('agent_messages') &&
        /\bdiscord_message_id\s*=\s*\$1/.test(s) &&
        !s.includes("metadata->>'discord_message_id'")
      const isMetadataLookup =
        s.includes('agent_messages') &&
        s.includes("metadata->>'discord_message_id'") &&
        !/\bdiscord_message_id\s*=\s*\$1/.test(s)

      if (isColumnLookup) {
        queryStats.columnQueries += 1
        const lookup = opts.parentLookup ?? { kind: 'miss' }
        if (lookup.kind === 'column') return { rows: [lookup.row as any] }
        if (lookup.kind === 'both') return { rows: [lookup.columnRow as any] }
        return { rows: [] }
      }
      if (isMetadataLookup) {
        queryStats.metadataQueries += 1
        const lookup = opts.parentLookup ?? { kind: 'miss' }
        if (lookup.kind === 'metadata') return { rows: [lookup.row as any] }
        // §1.1 priority: 'both' should never reach the metadata branch.
        // If a regression sends us here, return the metadata row so the
        // assertion in case 1d (`reply_to === 'column-uuid'`) flips
        // loudly to 'metadata-uuid' and the bug is caught.
        if (lookup.kind === 'both') return { rows: [lookup.metadataRow as any] }
        return { rows: [] }
      }
      if (s.includes('from agent_ui_bindings') && s.includes('ui_id = $1')) {
        const agentId = opts.discordResolution?.[firstParam]
        return agentId ? { rows: [{ agent_id: agentId, ui_id: firstParam } as any] } : { rows: [] }
      }
      if (s.includes('from agents') && s.includes("metadata->>'discord_id' = $1")) {
        const agentId = opts.discordResolution?.[firstParam]
        return agentId ? { rows: [{ agent_id: agentId } as any] } : { rows: [] }
      }
      if (s.includes('from channels')) {
        if (!opts.registeredChannel) return { rows: [] }
        const members = opts.channelMembers ?? (opts.receiverIsMember ? [receiverAgentId] : [])
        return { rows: [{ id: channelId, members, type: 'group', thread_id: null } as any] }
      }
      // §2.2 mock split — loadAgentInfo: WHERE agent_id = $1
      if (s.includes('from agents') && s.includes('where agent_id = $1')) {
        return {
          rows: [{ agent_id: firstParam || receiverAgentId, status: 'active', discord_id: null } as any],
        }
      }
      // §2.2 mock split — resolveAgentFromDiscordId: human author returns null
      if (
        s.includes('from agents') &&
        s.includes("metadata->>'discord_id'") &&
        !s.includes('where agent_id')
      ) {
        return { rows: [] }
      }
      if (s.includes('from agents')) {
        return { rows: [{ agent_id: receiverAgentId, status: 'active' } as any] }
      }
      return { rows: [] }
    },
  })

  const deps: InboundReceiverDeps = {
    agentId: receiverAgentId,
    authMode: 'off',
    databaseUrl: 'postgresql://test',
    receiverPipelineBots: new Set(),
    processedIds: new Map(),
    tryGetDb: async () => null,
    coreDbAdapter: coreDbAdapter as any,
    saveMessage: async (msg) => {
      saved.push(msg as SaveMessageCapture)
      return 'saved-msg-uuid'
    },
    validateIncomingAuth: () => ({ valid: true }),
    buildQuoteBlock: async () => null,
    updateActiveThread: async () => {},
    hashCode: (s: string) => s.length,
    mcpPush: undefined,
    routeInbound: opts.routeSpy
      ? ((msg, ctx, agents) => {
          routeCalls.push({ mentions: [...msg.mentions] })
          return opts.routeSpy!(msg, ctx, agents)
        })
      : undefined,
    stderrSink: opts.stderrSink,
  }

  return { deps, saved, routeCalls, queryStats }
}

const baseParams = {
  receiverAgentId: 'receiver-bot',
  externalChannelId: 'discord-ch-1',
  externalMessageId: 'discord-msg-100',
  authorExternalId: 'discord-user-99',
  authorName: 'Alice',
  authorIsBot: false,
  content: 'hello',
  attachments: undefined,
  timestamp: new Date('2026-05-01T00:00:00Z'),
  platform: 'discord',
  mentions: [] as string[],
}

function makeStderrBuffer(): { sink: (chunk: string) => void; chunks: string[] } {
  const chunks: string[] = []
  return { sink: (c: string) => chunks.push(c), chunks }
}

describe('PR-β cycle 3 — handleInboundMessage 2-step lookup + early capture + sink dep', () => {
  test('case 1 — dedicated column hit resolves to UUID (no metadata query)', async () => {
    const { deps, saved, queryStats } = makeDeps({
      parentLookup: { kind: 'column', row: { id: 'parent-uuid-123', author_id: 'origin-bot' } },
      registeredChannel: true,
      receiverIsMember: true,
    })
    setInboundReceiverDeps(deps)

    await handleInboundMessage({ ...baseParams, replyToMessageId: 'discord-parent-snowflake' })

    expect(saved.length).toBe(1)
    expect(saved[0].reply_to).toBe('parent-uuid-123')
    expect(queryStats.columnQueries).toBe(1)
    expect(queryStats.metadataQueries).toBe(0)
  })

  test('case 1b — legacy metadata-only row resolves via 2-step fallback', async () => {
    const { deps, saved, queryStats } = makeDeps({
      parentLookup: { kind: 'metadata', row: { id: 'legacy-uuid-456', author_id: 'legacy-bot' } },
      registeredChannel: true,
      receiverIsMember: true,
    })
    setInboundReceiverDeps(deps)

    await handleInboundMessage({ ...baseParams, replyToMessageId: 'discord-legacy-snowflake' })

    expect(saved.length).toBe(1)
    expect(saved[0].reply_to).toBe('legacy-uuid-456')
    expect(queryStats.columnQueries).toBe(1)
    expect(queryStats.metadataQueries).toBe(1)
  })

  test('case 1c — both lookups miss → reply_to absent + sink-captured orphan log', async () => {
    const buf = makeStderrBuffer()
    const { deps, saved, queryStats } = makeDeps({
      parentLookup: { kind: 'miss' },
      registeredChannel: true,
      receiverIsMember: true,
      stderrSink: buf.sink,
    })
    setInboundReceiverDeps(deps)

    await handleInboundMessage({
      ...baseParams,
      replyToMessageId: 'discord-orphan-double-miss',
    })

    expect(saved.length).toBe(1)
    expect(saved[0].reply_to).toBeUndefined()
    expect(queryStats.columnQueries).toBe(1)
    expect(queryStats.metadataQueries).toBe(1)
    const orphanLogged = buf.chunks.some(
      (c) => c.includes('reply_to orphan') && c.includes('discord-orphan-double-miss'),
    )
    expect(orphanLogged).toBe(true)
  })

  test('case 1d — both-hit coexistence: column row returned, metadata query never fires', async () => {
    const { deps, saved, queryStats } = makeDeps({
      parentLookup: {
        kind: 'both',
        columnRow: { id: 'column-uuid', author_id: 'column-bot' },
        metadataRow: { id: 'metadata-uuid', author_id: 'metadata-bot' },
      },
      registeredChannel: true,
      receiverIsMember: true,
    })
    setInboundReceiverDeps(deps)

    await handleInboundMessage({ ...baseParams, replyToMessageId: 'discord-both-hit' })

    expect(saved.length).toBe(1)
    expect(saved[0].reply_to).toBe('column-uuid')
    expect(queryStats.columnQueries).toBe(1)
    expect(queryStats.metadataQueries).toBe(0)
  })

  test('case 2 — no replyToMessageId → reply_to absent (no lookup runs)', async () => {
    const { deps, saved, queryStats } = makeDeps({
      parentLookup: { kind: 'miss' },
      registeredChannel: true,
      receiverIsMember: true,
    })
    setInboundReceiverDeps(deps)

    await handleInboundMessage({ ...baseParams })

    expect(saved.length).toBe(1)
    expect(saved[0].reply_to).toBeUndefined()
    expect(queryStats.columnQueries).toBe(0)
    expect(queryStats.metadataQueries).toBe(0)
  })

  test('case 3 — orphan replyToMessageId → reply_to absent + sink-captured orphan log', async () => {
    const buf = makeStderrBuffer()
    const { deps, saved } = makeDeps({
      parentLookup: { kind: 'miss' },
      registeredChannel: true,
      receiverIsMember: true,
      stderrSink: buf.sink,
    })
    setInboundReceiverDeps(deps)

    await handleInboundMessage({ ...baseParams, replyToMessageId: 'discord-orphan-snowflake' })

    expect(saved[0].reply_to).toBeUndefined()
    expect(buf.chunks.some((c) => c.includes('reply_to orphan'))).toBe(true)
  })

  test('case 4 — empty mentions + parent author → routeInbound spy receives [parent.author_id]', async () => {
    const spy: RouteInboundFn = (msg, ctx, _agents) => ({
      pushTargets: [ctx.members?.[0] ?? 'receiver-bot'],
      dropTargets: {},
      senderIsHuman: !msg.authorAgentId,
      noMentions: msg.mentions.length === 0,
    })
    const { deps, saved, routeCalls } = makeDeps({
      parentLookup: { kind: 'column', row: { id: 'parent-uuid', author_id: 'origin-bot' } },
      registeredChannel: true,
      receiverIsMember: true,
      routeSpy: spy,
    })
    setInboundReceiverDeps(deps)

    await handleInboundMessage({
      ...baseParams,
      replyToMessageId: 'discord-parent',
      mentions: [],
    })

    expect(routeCalls.length).toBe(1)
    expect(routeCalls[0].mentions).toEqual(['origin-bot'])
    expect(saved[0].author_bot).toBe(false)
    expect(saved[0].input_mentions).toEqual(['origin-bot'])
  })

  test('case 4b — empty mentions + Discord parent author → auto-fill is normalized to agent_id', async () => {
    const spy: RouteInboundFn = (msg, ctx, _agents) => ({
      pushTargets: [ctx.members?.[1] ?? 'arc'],
      dropTargets: {},
      senderIsHuman: !msg.authorAgentId,
      noMentions: msg.mentions.length === 0,
    })
    const { deps, saved, routeCalls } = makeDeps({
      parentLookup: { kind: 'column', row: { id: 'parent-uuid', author_id: '1488361927846658098' } },
      registeredChannel: true,
      channelMembers: ['receiver-bot', 'arc'],
      discordResolution: { '1488361927846658098': 'arc' },
      routeSpy: spy,
    })
    setInboundReceiverDeps(deps)

    await handleInboundMessage({
      ...baseParams,
      replyToMessageId: 'discord-parent',
      mentions: [],
    })

    expect(routeCalls.length).toBe(1)
    expect(routeCalls[0].mentions).toEqual(['arc'])
    expect(saved[0].input_mentions).toEqual(['arc'])
  })

  test('case 4c — raw Discord mentions are normalized before save and route', async () => {
    const spy: RouteInboundFn = (msg, ctx, _agents) => ({
      pushTargets: [ctx.members?.[1] ?? 'arc'],
      dropTargets: {},
      senderIsHuman: !msg.authorAgentId,
      noMentions: msg.mentions.length === 0,
    })
    const { deps, saved, routeCalls } = makeDeps({
      registeredChannel: true,
      channelMembers: ['receiver-bot', 'arc'],
      discordResolution: { '1488361927846658098': 'arc' },
      routeSpy: spy,
    })
    setInboundReceiverDeps(deps)

    await handleInboundMessage({
      ...baseParams,
      mentions: ['1488361927846658098'],
    })

    expect(routeCalls.length).toBe(1)
    expect(routeCalls[0].mentions).toEqual(['arc'])
    expect(saved[0].input_mentions).toEqual(['arc'])
  })

  test('case 5 — explicit mentions → routeInbound spy receives unchanged mentions', async () => {
    const spy: RouteInboundFn = (msg, ctx, _agents) => ({
      pushTargets: [ctx.members?.[0] ?? 'receiver-bot'],
      dropTargets: {},
      senderIsHuman: !msg.authorAgentId,
      noMentions: msg.mentions.length === 0,
    })
    const { deps, saved, routeCalls } = makeDeps({
      parentLookup: { kind: 'column', row: { id: 'parent-uuid', author_id: 'origin-bot' } },
      registeredChannel: true,
      receiverIsMember: true,
      routeSpy: spy,
    })
    setInboundReceiverDeps(deps)

    await handleInboundMessage({
      ...baseParams,
      replyToMessageId: 'discord-parent',
      mentions: ['some-bot'],
    })

    expect(routeCalls.length).toBe(1)
    expect(routeCalls[0].mentions).toEqual(['some-bot'])
    expect(saved[0].author_bot).toBe(false)
    expect(saved[0].input_mentions).toEqual(['some-bot'])
  })
})
