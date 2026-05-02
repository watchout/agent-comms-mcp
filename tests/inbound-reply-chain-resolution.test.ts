#!/usr/bin/env bun
/**
 * PR-β §4 frozen merge-gate fixtures (cycle 2 — auditor Pre-impl PASS 6/6,
 * dispatch msg `5c825a43`/`d1cb676a`/`549a269c`/`1c8477c7`).
 *
 * Pins:
 *   - case 1:    dedicated column hit → reply_to UUID 設定
 *   - case 1b:   legacy row (column NULL + metadata.discord_message_id) →
 *                metadata fallback で reply_to UUID 設定 (PR-β cycle 2 §1.1)
 *   - case 1c:   両 miss orphan → reply_to NULL + stderr "reply_to orphan"
 *   - case 2:    replyToMessageId なし → reply_to undefined
 *   - case 3:    orphan stderr (case 1c と独立 keep)
 *   - case 4:    handleInboundMessage with routeInbound spy (deps.routeInbound) →
 *                empty mentions + parent → spy が `[parent.author_id]` を受領
 *   - case 5:    explicit mentions → spy が unchanged を受領
 *   - case 6:    source-grep — autoFill < routeInbound 順 + docstring honest
 *
 * §2.4 honesty: case 6 は routeInbound surface (spy で behavioral assertion)
 * のみ pin する。saveMessage mock は persistence layer の "真" の挙動ではなく
 * payload capture の thin double であり、persistence semantics の検証は本 PR
 * の scope 外 (別 PR test infra 強化候補)。
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
}

type ParentLookupMode =
  | { kind: 'column'; row: { id: string; author_id: string } }
  | { kind: 'metadata'; row: { id: string; author_id: string } }
  | { kind: 'miss' }

function makeDeps(opts: {
  parentLookup?: ParentLookupMode
  registeredChannel?: boolean
  receiverIsMember?: boolean
  routeSpy?: RouteInboundFn
}): {
  deps: InboundReceiverDeps
  saved: SaveMessageCapture[]
  routeCalls: Array<{ mentions: string[] }>
} {
  const saved: SaveMessageCapture[] = []
  const routeCalls: Array<{ mentions: string[] }> = []
  const channelId = 'core-channel-uuid'
  const receiverAgentId = 'receiver-bot'

  // PR-β cycle 2 §2.2 mock split: each query branch reflects the real
  // SQL the production code issues, so the test catches contract drift
  // (e.g. mock matched the wrong SELECT).
  const coreDbAdapter = async () => ({
    async query(sql: string, params?: any[]): Promise<{ rows: any[] }> {
      const s = sql.toLowerCase()

      // §1.1 dual-lookup: column = $1 OR metadata->>'discord_message_id' = $1
      if (s.includes('agent_messages') && s.includes('discord_message_id')) {
        const lookup = opts.parentLookup ?? { kind: 'miss' }
        const sqlHasColumn = /\bdiscord_message_id\s*=\s*\$1/.test(s)
        const sqlHasMetadata = s.includes("metadata->>'discord_message_id'")
        // Branch by what the lookup mode SAYS the data shape is.
        if (lookup.kind === 'column' && sqlHasColumn) {
          return { rows: [lookup.row as any] }
        }
        if (lookup.kind === 'metadata' && sqlHasMetadata && !sqlHasColumn) {
          // legacy-only: should never see this without dual-lookup OR clause.
          return { rows: [lookup.row as any] }
        }
        if (lookup.kind === 'metadata' && sqlHasMetadata && sqlHasColumn) {
          // dual-lookup OR clause — column miss falls through to metadata hit.
          return { rows: [lookup.row as any] }
        }
        return { rows: [] }
      }
      if (s.includes('from channels')) {
        if (!opts.registeredChannel) return { rows: [] }
        const members = opts.receiverIsMember ? [receiverAgentId] : []
        return { rows: [{ id: channelId, members, type: 'group', thread_id: null } as any] }
      }
      // §2.2 mock split — loadAgentInfo: WHERE agent_id = $1
      if (
        s.includes('from agents') &&
        s.includes('where agent_id') &&
        !s.includes("metadata->>'discord_id'")
      ) {
        return {
          rows: [{ agent_id: receiverAgentId, status: 'active', discord_id: null } as any],
        }
      }
      // §2.2 mock split — loadAgentInfo (combined select reads discord_id):
      if (
        s.includes('from agents') &&
        s.includes('where agent_id = $1')
      ) {
        return {
          rows: [{ agent_id: receiverAgentId, status: 'active', discord_id: null } as any],
        }
      }
      // §2.2 mock split — resolveAgentFromDiscordId: human author returns null.
      if (
        s.includes('from agents') &&
        s.includes("metadata->>'discord_id'") &&
        !s.includes('where agent_id')
      ) {
        return { rows: [] }
      }
      // §2.2 mock split — fallback agents lookup (loadAgentInfo legacy).
      if (s.includes('from agents')) {
        return { rows: [{ agent_id: receiverAgentId, status: 'active' } as any] }
      }
      void params
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
    bus: undefined,
    mcpPush: undefined,
    routeInbound: opts.routeSpy
      ? ((msg, ctx, agents) => {
          routeCalls.push({ mentions: [...msg.mentions] })
          return opts.routeSpy!(msg, ctx, agents)
        })
      : undefined,
  }

  return { deps, saved, routeCalls }
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

function captureStderr<T>(fn: () => Promise<T>): Promise<{ result: T; chunks: string[] }> {
  const chunks: string[] = []
  const orig = process.stderr.write.bind(process.stderr)
  ;(process.stderr.write as any) = (chunk: any) => {
    chunks.push(String(chunk))
    return true
  }
  return fn()
    .then((result) => ({ result, chunks }))
    .finally(() => {
      process.stderr.write = orig as any
    })
}

describe('PR-β cycle 2 — handleInboundMessage reply_to + mentions auto-fill', () => {
  // case 1: dedicated column hit → reply_to UUID 設定 (既存維持)
  test('case 1 — dedicated column hit resolves to UUID', async () => {
    const { deps, saved } = makeDeps({
      parentLookup: { kind: 'column', row: { id: 'parent-uuid-123', author_id: 'origin-bot' } },
      registeredChannel: true,
      receiverIsMember: true,
    })
    setInboundReceiverDeps(deps)

    await handleInboundMessage({ ...baseParams, replyToMessageId: 'discord-parent-snowflake' })

    expect(saved.length).toBe(1)
    expect(saved[0].reply_to).toBe('parent-uuid-123')
  })

  // case 1b NEW: legacy row (column NULL + metadata.discord_message_id 有) → metadata fallback
  test('case 1b — legacy metadata-only row resolves via metadata fallback', async () => {
    const { deps, saved } = makeDeps({
      parentLookup: { kind: 'metadata', row: { id: 'legacy-uuid-456', author_id: 'legacy-bot' } },
      registeredChannel: true,
      receiverIsMember: true,
    })
    setInboundReceiverDeps(deps)

    await handleInboundMessage({ ...baseParams, replyToMessageId: 'discord-legacy-snowflake' })

    expect(saved.length).toBe(1)
    expect(saved[0].reply_to).toBe('legacy-uuid-456')
  })

  // case 1c NEW: 両 miss → reply_to undefined + stderr "reply_to orphan"
  test('case 1c — both lookups miss → reply_to absent + orphan stderr', async () => {
    const { deps, saved } = makeDeps({
      parentLookup: { kind: 'miss' },
      registeredChannel: true,
      receiverIsMember: true,
    })
    setInboundReceiverDeps(deps)

    const { chunks } = await captureStderr(() =>
      handleInboundMessage({
        ...baseParams,
        replyToMessageId: 'discord-orphan-double-miss',
      }),
    )

    expect(saved.length).toBe(1)
    expect(saved[0].reply_to).toBeUndefined()
    const orphanLogged = chunks.some(
      (c) => c.includes('reply_to orphan') && c.includes('discord-orphan-double-miss'),
    )
    expect(orphanLogged).toBe(true)
  })

  // case 2: no replyToMessageId → reply_to absent (既存維持)
  test('case 2 — no replyToMessageId → reply_to absent', async () => {
    const { deps, saved } = makeDeps({
      parentLookup: { kind: 'miss' },
      registeredChannel: true,
      receiverIsMember: true,
    })
    setInboundReceiverDeps(deps)

    await handleInboundMessage({ ...baseParams })

    expect(saved.length).toBe(1)
    expect(saved[0].reply_to).toBeUndefined()
  })

  // case 3: orphan stderr (case 1c と独立 keep、cycle 1 case 3 と等価)
  test('case 3 — orphan replyToMessageId → reply_to absent + stderr orphan log', async () => {
    const { deps, saved } = makeDeps({
      parentLookup: { kind: 'miss' },
      registeredChannel: true,
      receiverIsMember: true,
    })
    setInboundReceiverDeps(deps)

    const { chunks } = await captureStderr(() =>
      handleInboundMessage({ ...baseParams, replyToMessageId: 'discord-orphan-snowflake' }),
    )

    expect(saved[0].reply_to).toBeUndefined()
    expect(chunks.some((c) => c.includes('reply_to orphan'))).toBe(true)
  })

  // case 4 REBUILT: routeInbound spy (deps injection) で auto-filled mentions 受領
  test('case 4 — empty mentions + parent author → routeInbound spy receives [parent.author_id]', async () => {
    const spy: RouteInboundFn = (msg, ctx, _agents) => ({
      pushTargets: [ctx.members?.[0] ?? 'receiver-bot'],
      dropTargets: {},
      senderIsHuman: !msg.authorAgentId,
      noMentions: msg.mentions.length === 0,
    })
    const { deps, routeCalls } = makeDeps({
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
  })

  // case 5 REBUILT: explicit mentions → spy が unchanged 受領
  test('case 5 — explicit mentions → routeInbound spy receives unchanged mentions', async () => {
    const spy: RouteInboundFn = (msg, ctx, _agents) => ({
      pushTargets: [ctx.members?.[0] ?? 'receiver-bot'],
      dropTargets: {},
      senderIsHuman: !msg.authorAgentId,
      noMentions: msg.mentions.length === 0,
    })
    const { deps, routeCalls } = makeDeps({
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
  })

  // case 6 REWRITE: source-grep — autoFill < routeInbound surface のみ pin
  test('case 6 — handleInboundMessage source wires applyMentionsAutoFill before routeInbound (surface contract only)', async () => {
    const src = (await import('node:fs')).readFileSync(
      new URL('../adapters/inbound-receiver.ts', import.meta.url),
      'utf-8',
    )
    const fnIdx = src.indexOf('export async function handleInboundMessage(')
    expect(fnIdx).toBeGreaterThan(-1)
    const body = src.slice(fnIdx)
    const autoFillIdx = body.indexOf('applyMentionsAutoFill')
    const routeIdx = body.indexOf('routeInbound)(')
    expect(autoFillIdx).toBeGreaterThan(-1)
    expect(routeIdx).toBeGreaterThan(autoFillIdx)
    // §2.4 honesty pin: this case asserts the WIRING surface only —
    // persistence-layer semantics (saveMessage true behavior) are NOT
    // claimed by this test.
  })
})
