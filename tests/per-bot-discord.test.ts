#!/usr/bin/env bun
/**
 * Tests for Phase 3c: Per-Bot Discord Client (PR#59)
 *
 * Verifies:
 * 1. resolveDiscordToken() logic (per-bot, fallback, invalid)
 * 2. discordClients Map lifecycle (connect, disconnect, reconnect)
 * 3. Staggered connect + backoff
 * 4. Per-bot client used for send tool Discord forwarding
 * 5. Shared client skips bots with per-bot clients
 *
 * Usage: bun test tests/per-bot-discord.test.ts
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

const PROJECT_ROOT = join(dirname(new URL(import.meta.url).pathname), '..')
const SERVER_SOURCE = readFileSync(join(PROJECT_ROOT, 'server.ts'), 'utf-8')

// ============================================================
// 1. resolveDiscordToken() source structure
// ============================================================
describe('Phase 3c — resolveDiscordToken()', () => {
  test('resolveDiscordToken function exists', () => {
    expect(SERVER_SOURCE).toContain('async function resolveDiscordToken(botId: string)')
  })

  test('checks per-bot env var with uppercase + underscore conversion', () => {
    expect(SERVER_SOURCE).toContain("botId.toUpperCase().replace(/-/g, '_')")
    expect(SERVER_SOURCE).toContain('DISCORD_TOKEN_')
  })

  test('validates token via Discord REST API', () => {
    expect(SERVER_SOURCE).toContain('https://discord.com/api/v10/users/@me')
    expect(SERVER_SOURCE).toContain("Authorization: `Bot ${perBotToken}`")
  })

  test('returns source indicator (per-bot or fallback)', () => {
    expect(SERVER_SOURCE).toContain("source: 'per-bot'")
    expect(SERVER_SOURCE).toContain("source: 'fallback'")
  })

  test('falls back to shared DISCORD_BOT_TOKEN', () => {
    expect(SERVER_SOURCE).toContain('DISCORD_BOT_TOKEN')
    expect(SERVER_SOURCE).toContain('fallback to shared DISCORD_BOT_TOKEN')
  })

  test('returns null when no token available', () => {
    expect(SERVER_SOURCE).toContain('no token available')
  })
})

// ============================================================
// 2. Per-Bot Discord Client lifecycle
// ============================================================
describe('Phase 3c — Per-Bot Discord Client', () => {
  test('discordClients Map exists', () => {
    expect(SERVER_SOURCE).toContain('const discordClients = new Map<string, DiscordAdapter>()')
  })

  test('getDiscordClient helper uses per-bot or falls back to shared', () => {
    expect(SERVER_SOURCE).toContain('function getDiscordClient(botId: string): DiscordAdapter')
    expect(SERVER_SOURCE).toContain('discordClients.get(botId) ?? discord')
  })

  test('send tool uses getDiscordClient for per-bot sending', () => {
    expect(SERVER_SOURCE).toContain('getDiscordClient(agentId).sendAdapterMessage(')
  })

  test('daemon mode creates per-bot Discord client on SSE connect', () => {
    const daemonBlock = SERVER_SOURCE.indexOf("if (TRANSPORT_MODE === 'daemon')")
    const daemonSection = SERVER_SOURCE.slice(daemonBlock, daemonBlock + 15000)
    expect(daemonSection).toContain('resolveDiscordToken(botId)')
    expect(daemonSection).toContain('connectBotDiscord(botId,')
    expect(daemonSection).toContain('discordClients.set(botId, botDiscord)')
  })

  test('daemon mode cleans up per-bot Discord on SSE disconnect', () => {
    const daemonBlock = SERVER_SOURCE.indexOf("if (TRANSPORT_MODE === 'daemon')")
    const daemonSection = SERVER_SOURCE.slice(daemonBlock, daemonBlock + 15000)
    expect(daemonSection).toContain("per-bot Discord disconnected for ${botId}")
    expect(daemonSection).toContain('discordClients.delete(botId)')
  })

  test('daemon mode cleans up per-bot Discord on reconnect', () => {
    const daemonBlock = SERVER_SOURCE.indexOf("if (TRANSPORT_MODE === 'daemon')")
    const daemonSection = SERVER_SOURCE.slice(daemonBlock, daemonBlock + 15000)
    expect(daemonSection).toContain('oldClient.disconnect()')
  })

  test('daemon shutdown cleans up all per-bot Discord clients', () => {
    expect(SERVER_SOURCE).toContain('discordClients.clear()')
  })
})

// ============================================================
// 3. Staggered Connect + Backoff
// ============================================================
describe('Phase 3c — Staggered Connect + Backoff', () => {
  test('connectBotDiscord function exists with retry logic', () => {
    expect(SERVER_SOURCE).toContain('async function connectBotDiscord(botId: string, token: string)')
  })

  test('exponential backoff with max delay', () => {
    expect(SERVER_SOURCE).toContain('DISCORD_BACKOFF_MAX_MS')
    expect(SERVER_SOURCE).toContain('delay = Math.min(delay * 2, DISCORD_BACKOFF_MAX_MS)')
  })

  test('5 retry attempts with alert on failure', () => {
    expect(SERVER_SOURCE).toContain('attempt <= 5')
    expect(SERVER_SOURCE).toContain('ALERT — per-bot Discord connect failed')
  })

  test('staggered connect delay between bots', () => {
    expect(SERVER_SOURCE).toContain('STAGGERED_CONNECT_DELAY_MS')
    expect(SERVER_SOURCE).toContain('staggered connect')
  })
})

// ============================================================
// 4. Shared client skips per-bot bots
// ============================================================
describe('Phase 3c — Shared Client Routing', () => {
  test('shared Discord onMessage skips bots with per-bot clients', () => {
    const daemonBlock = SERVER_SOURCE.indexOf("if (TRANSPORT_MODE === 'daemon')")
    const daemonSection = SERVER_SOURCE.slice(daemonBlock, daemonBlock + 15000)
    expect(daemonSection).toContain('discordClients.has(botId)) continue')
  })

  test('per-bot client registers its own onMessage handler', () => {
    const daemonBlock = SERVER_SOURCE.indexOf("if (TRANSPORT_MODE === 'daemon')")
    const daemonSection = SERVER_SOURCE.slice(daemonBlock, daemonBlock + 15000)
    expect(daemonSection).toContain('botDiscord.onMessage((msg)')
  })

  test('shared discord instance is preserved for stdio/sse modes', () => {
    // The global discord instance should still exist
    expect(SERVER_SOURCE).toContain("const discord = new DiscordAdapter()")
  })
})
