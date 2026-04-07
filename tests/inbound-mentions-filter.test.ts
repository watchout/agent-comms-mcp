#!/usr/bin/env bun
/**
 * Tests for inbound mentions filter (PR#62 — §3.15 step 4)
 *
 * Verifies:
 * 1. extractDiscordMentions helper
 * 2. routeInbound() mentions filter
 * 3. Bypass conditions (CEO, emergency, reply)
 * 4. All callsites pass mentions
 *
 * Usage: bun test tests/inbound-mentions-filter.test.ts
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

const PROJECT_ROOT = join(dirname(new URL(import.meta.url).pathname), '..')
const SERVER_SOURCE = readFileSync(join(PROJECT_ROOT, 'server.ts'), 'utf-8')

describe('Inbound Mentions Filter — extractDiscordMentions', () => {
  test('extractDiscordMentions function exists with rawDiscordUserIds param', () => {
    expect(SERVER_SOURCE).toContain('async function extractDiscordMentions(content: string, rawDiscordUserIds?: string[])')
  })

  test('parses Discord <@id> mentions', () => {
    expect(SERVER_SOURCE).toContain('/<@!?(\\d+)>/g')
  })

  test('resolves Discord IDs to agent_ids via resolveAgentFromDiscordId', () => {
    const fnIdx = SERVER_SOURCE.indexOf('async function extractDiscordMentions')
    const fnBody = SERVER_SOURCE.slice(fnIdx, fnIdx + 800)
    expect(fnBody).toContain('resolveAgentFromDiscordId(discordId)')
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

describe('Inbound Mentions Filter — routeInbound step 4', () => {
  test('routeInbound accepts mentions parameter', () => {
    const fnIdx = SERVER_SOURCE.indexOf('async function routeInbound(')
    const fnSig = SERVER_SOURCE.slice(fnIdx, fnIdx + 600)
    expect(fnSig).toContain('mentions?: string[]')
  })

  test('routeInbound accepts replyToMessageId parameter', () => {
    const fnIdx = SERVER_SOURCE.indexOf('async function routeInbound(')
    const fnSig = SERVER_SOURCE.slice(fnIdx, fnIdx + 600)
    expect(fnSig).toContain('replyToMessageId?: string')
  })

  test('mentions filter checks individual and group mentions', () => {
    expect(SERVER_SOURCE).toContain("mentions?.includes(receiverAgentId)")
    expect(SERVER_SOURCE).toContain("mentions?.includes('all')")
    expect(SERVER_SOURCE).toContain("mentions?.includes('dev')")
    expect(SERVER_SOURCE).toContain("mentions?.includes('org')")
  })

  test('NOT_MENTIONED reason is returned when not mentioned', () => {
    expect(SERVER_SOURCE).toContain("reason: 'NOT_MENTIONED'")
  })

  test('DM bypass: DM messages always push', () => {
    const routeIdx = SERVER_SOURCE.indexOf('Mentions filter')
    const filterBody = SERVER_SOURCE.slice(routeIdx, routeIdx + 800)
    expect(filterBody).toContain('isDm')
  })

  test('CEO/emergency bypass: human/emergency always push', () => {
    const routeIdx = SERVER_SOURCE.indexOf('Mentions filter')
    const filterBody = SERVER_SOURCE.slice(routeIdx, routeIdx + 800)
    expect(filterBody).toContain('!isEmergency')
    expect(filterBody).toContain('!isCeo')
  })

  test('mentions filter runs before last_received_context update', () => {
    const routeIdx = SERVER_SOURCE.indexOf('async function routeInbound(')
    const routeBody = SERVER_SOURCE.slice(routeIdx, routeIdx + 5000)
    const mentionsIdx = routeBody.indexOf("reason: 'NOT_MENTIONED'")
    const contextIdx = routeBody.indexOf('updateLastReceivedContext')
    expect(mentionsIdx).toBeGreaterThan(-1)
    expect(contextIdx).toBeGreaterThan(-1)
    expect(mentionsIdx).toBeLessThan(contextIdx)
  })
})

describe('Inbound Mentions Filter — callsite updates', () => {
  test('stdio/channel plugin Discord adapter removed (Phase 3c — daemon only)', () => {
    // Discord connections removed from bot-side server.ts — daemon manages all Discord
    expect(SERVER_SOURCE).toContain('Discord connections are daemon-only (Phase 3c)')
  })

  test('daemon per-bot client passes mentions to routeInbound', () => {
    const daemonBlock = SERVER_SOURCE.indexOf("if (TRANSPORT_MODE === 'daemon')")
    const daemonSection = SERVER_SOURCE.slice(daemonBlock, daemonBlock + 15000)
    // Find per-bot onMessage (botDiscord.onMessage)
    const perBotIdx = daemonSection.indexOf('botDiscord.onMessage')
    expect(perBotIdx).toBeGreaterThan(-1)
    const perBotBody = daemonSection.slice(perBotIdx, perBotIdx + 2000)
    expect(perBotBody).toContain('extractDiscordMentions')
    expect(perBotBody).toContain('mentions: resolvedMentions')
  })

  test('daemon shared client passes mentions to routeInbound', () => {
    const daemonBlock = SERVER_SOURCE.indexOf("if (TRANSPORT_MODE === 'daemon')")
    const daemonSection = SERVER_SOURCE.slice(daemonBlock, daemonBlock + 15000)
    // Find shared onMessage (discord.onMessage in daemon)
    const sharedIdx = daemonSection.indexOf('discord.onMessage((msg) => {')
    expect(sharedIdx).toBeGreaterThan(-1)
    const sharedBody = daemonSection.slice(sharedIdx, sharedIdx + 3000)
    expect(sharedBody).toContain('extractDiscordMentions')
    expect(sharedBody).toContain('mentions: resolvedMentions')
  })
})
