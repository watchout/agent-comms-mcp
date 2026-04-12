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

const PROJECT_ROOT = join(dirname(new URL(import.meta.url).pathname), '..')
const SERVER_SOURCE = readFileSync(join(PROJECT_ROOT, 'server.ts'), 'utf-8')
// PR-A: routeInbound + helpers extracted to core/route-message{,-db}.ts
const CORE_PURE_SOURCE = readFileSync(join(PROJECT_ROOT, 'core/route-message.ts'), 'utf-8')
const CORE_DB_SOURCE = readFileSync(join(PROJECT_ROOT, 'core/route-message-db.ts'), 'utf-8')

describe('Inbound Mentions Filter — extractDiscordMentions', () => {
  test('extractDiscordMentions function exists with rawDiscordUserIds param', () => {
    expect(SERVER_SOURCE).toContain('async function extractDiscordMentions(content: string, rawDiscordUserIds?: string[])')
  })

  test('parses Discord <@id> mentions', () => {
    expect(SERVER_SOURCE).toContain('/<@!?(\\d+)>/g')
  })

  test('resolves Discord IDs to agent_ids via resolveAgentFromDiscordId', () => {
    const fnIdx = SERVER_SOURCE.indexOf('async function extractDiscordMentions')
    const fnBody = SERVER_SOURCE.slice(fnIdx, fnIdx + 1000)
    // PR-A: resolveAgentFromDiscordId now takes (db, discordId) — extracted to core/
    expect(fnBody).toContain('resolveAgentFromDiscordId(db, discordId)')
  })

  test('also parses @agent_id native mentions', () => {
    const fnIdx = SERVER_SOURCE.indexOf('async function extractDiscordMentions')
    const fnBody = SERVER_SOURCE.slice(fnIdx, fnIdx + 1200)
    expect(fnBody).toContain('parseMentions(content)')
  })

  test('deduplicates mentions', () => {
    const fnIdx = SERVER_SOURCE.indexOf('async function extractDiscordMentions')
    const fnBody = SERVER_SOURCE.slice(fnIdx, fnIdx + 1200)
    expect(fnBody).toContain('new Set(')
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
    const fnBody = CORE_PURE_SOURCE.slice(fnIdx, fnIdx + 3500)
    expect(fnBody).toContain("msg.mentions.includes(agent.agentId)")
    expect(fnBody).toContain("msg.mentions.includes('all')")
    expect(fnBody).toContain("msg.mentions.includes('dev')")
    expect(fnBody).toContain("msg.mentions.includes('org')")
  })

  test('NOT_MENTIONED is set in dropTargets', () => {
    const fnIdx = CORE_PURE_SOURCE.indexOf('export function routeMessage(')
    const fnBody = CORE_PURE_SOURCE.slice(fnIdx, fnIdx + 3500)
    expect(fnBody).toContain("'NOT_MENTIONED'")
  })

  test('DM bypass: DM messages always push', () => {
    const fnIdx = CORE_PURE_SOURCE.indexOf('export function routeMessage(')
    const fnBody = CORE_PURE_SOURCE.slice(fnIdx, fnIdx + 3500)
    expect(fnBody).toContain('isDm')
  })

  test('emergency bypass only (no CEO bypass)', () => {
    const fnIdx = CORE_PURE_SOURCE.indexOf('export function routeMessage(')
    const fnBody = CORE_PURE_SOURCE.slice(fnIdx, fnIdx + 3500)
    expect(fnBody).toContain('isEmergency')
    expect(fnBody).not.toContain('isCeo')
    // senderIsHuman exists in RouteResult but is NOT used as a bypass condition in the filter logic
    expect(fnBody).not.toContain('if (senderIsHuman)')  // not used as bypass condition
  })

  test('observer mode agents are dropped', () => {
    const fnIdx = CORE_PURE_SOURCE.indexOf('export function routeMessage(')
    const fnBody = CORE_PURE_SOURCE.slice(fnIdx, fnIdx + 3500)
    expect(fnBody).toContain('agent.observerMode')
    expect(fnBody).toContain("'OBSERVER_MODE'")
  })

  // PR-B §C2: sender-side guard for send-tool / cli callers
  test('routeMessage rejects non-member senders for send-tool / cli sourceType', () => {
    const fnIdx = CORE_PURE_SOURCE.indexOf('export function routeMessage(')
    const fnBody = CORE_PURE_SOURCE.slice(fnIdx, fnIdx + 3500)
    expect(fnBody).toContain("sourceType !== 'inbound'")
    expect(fnBody).toContain("SENDER_NOT_A_MEMBER")
  })
})

describe('handleInboundMessage — Full flow wrapper', () => {
  test('handleInboundMessage is async and wraps routeInbound', () => {
    expect(SERVER_SOURCE).toContain('async function handleInboundMessage(')
  })

  test('DB save happens before routing', () => {
    const fnIdx = SERVER_SOURCE.indexOf('async function handleInboundMessage(')
    const fnBody = SERVER_SOURCE.slice(fnIdx, fnIdx + 5000)
    const dbSaveIdx = fnBody.indexOf('saveMessage(')
    const routeIdx = fnBody.indexOf('routeInbound(')
    expect(dbSaveIdx).toBeGreaterThan(-1)
    expect(routeIdx).toBeGreaterThan(-1)
    expect(dbSaveIdx).toBeLessThan(routeIdx)
  })

  test('last_received_context abolished (reply_to required, §4.2)', () => {
    // updateLastReceivedContext should no longer exist
    expect(SERVER_SOURCE).not.toContain('async function updateLastReceivedContext')
    expect(SERVER_SOURCE).not.toContain('async function getLastReceivedContext')
  })

  test('returns humanWarning flag for Pattern A', () => {
    const fnIdx = SERVER_SOURCE.indexOf('async function handleInboundMessage(')
    const fnBody = SERVER_SOURCE.slice(fnIdx, fnIdx + 5000)
    expect(fnBody).toContain('humanWarning:')
    expect(fnBody).toContain('result.senderIsHuman && result.noMentions')
  })
})

describe('§2.2 Pattern A — Human warning', () => {
  test('sendHumanWarning function exists', () => {
    expect(SERVER_SOURCE).toContain('async function sendHumanWarning(')
  })

  test('warning includes mentions guidance', () => {
    expect(SERVER_SOURCE).toContain('メンションがないためbotには通知されていません')
    expect(SERVER_SOURCE).toContain('@all')
  })

  test('cross-process dedup via pg_try_advisory_lock', () => {
    const fnIdx = SERVER_SOURCE.indexOf('async function sendHumanWarning(')
    const fnBody = SERVER_SOURCE.slice(fnIdx, fnIdx + 2000)
    expect(fnBody).toContain('pg_try_advisory_lock')
  })

  test('stdio mode caller sends human warning', () => {
    // In the stdio onMessage handler, check for humanWarning
    const stdioBlock = SERVER_SOURCE.indexOf("TRANSPORT_MODE !== 'daemon'")
    const stdioSection = SERVER_SOURCE.slice(stdioBlock, stdioBlock + 3000)
    expect(stdioSection).toContain('result.humanWarning')
    expect(stdioSection).toContain('sendHumanWarning')
  })

  test('daemon mode does NOT invoke inbound human warning (ADR-041 S2-B: daemon outbound-only)', () => {
    const daemonBlock = SERVER_SOURCE.indexOf("if (TRANSPORT_MODE === 'daemon' || IS_RECEIVER_MODE)")
    const daemonSection = SERVER_SOURCE.slice(daemonBlock, daemonBlock + 15000)
    expect(daemonSection).not.toContain('humanWarningSent')
  })
})

describe('Inbound Mentions Filter — callsite updates', () => {
  test('stdio/channel plugin Discord adapter connects and uses handleInboundMessage', () => {
    expect(SERVER_SOURCE).toContain('Discord adapter connected (channel plugin mode)')
    expect(SERVER_SOURCE).toContain('extractDiscordMentions(content, msg.mentionUserIds)')
  })

  test('daemon per-bot client does NOT bind onMessage (ADR-041 S2-B: outbound-only)', () => {
    const daemonBlock = SERVER_SOURCE.indexOf("if (TRANSPORT_MODE === 'daemon' || IS_RECEIVER_MODE)")
    const daemonSection = SERVER_SOURCE.slice(daemonBlock, daemonBlock + 15000)
    expect(daemonSection).not.toContain('botDiscord.onMessage')
  })

  test('daemon shared client does NOT bind onMessage (ADR-041 S2-B: stdio is sole inbound)', () => {
    const daemonBlock = SERVER_SOURCE.indexOf("if (TRANSPORT_MODE === 'daemon' || IS_RECEIVER_MODE)")
    const daemonSection = SERVER_SOURCE.slice(daemonBlock, daemonBlock + 15000)
    expect(daemonSection).not.toContain('discord.onMessage((msg) => {')
  })

  test('all callsites use handleInboundMessage (not old routeInbound)', () => {
    // routeInbound should NOT be called with { receiverAgentId: ... } directly
    // Only handleInboundMessage should be called from message handlers
    const callsites = SERVER_SOURCE.match(/routeInbound\(\{/g)
    expect(callsites).toBeNull()  // No direct calls to routeInbound with object literal
  })
})
