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
// FEAT-005 (adapter rewrite): Discord client lifecycle moved to
// adapters/discord-client.ts. Concatenate so existing substring
// assertions still pin the same invariants at their new home.
const SERVER_SOURCE =
  readFileSync(join(PROJECT_ROOT, 'server.ts'), 'utf-8')
  + '\n'
  + readFileSync(join(PROJECT_ROOT, 'adapters/discord-client.ts'), 'utf-8')

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

  test('getDiscordClient helper returns per-bot client or null (no shared fallback, FEAT-005)', () => {
    // FEAT-005 (2026-04-14): the shared-fallback `?? discord` branch
    // was removed because it caused identity misattribution when the
    // outbound claim SQL raced (2026-04-12 incident). getDiscordClient
    // now returns null for unknown botIds and logs via console.error so
    // callers must handle the miss explicitly.
    expect(SERVER_SOURCE).toMatch(/function\s+getDiscordClient\s*\([^)]*\)\s*:\s*DiscordAdapter\s*\|\s*null/)
    expect(SERVER_SOURCE).not.toContain('discordClients.get(botId) ?? discord')
  })

  test.skip('send tool uses getDiscordClient for per-bot sending (obsolete call site)', () => {
    // Historical pin: the send-tool used to route through
    // `getDiscordClient(agentId).sendAdapterMessage(...)`. Phase 3
    // (Issue #129) moved the send path to outbound_queue INSERT; the
    // consumer now resolves the Discord client via
    // `discordClients.get(AGENT_ID)` (no fallback, FEAT-005 CP-2).
    // Skipped until the test is rewritten to pin the new path.
    expect(SERVER_SOURCE).toContain('getDiscordClient(agentId).sendAdapterMessage(')
  })

  test('multi-bot SSE creates per-bot Discord client on SSE connect', () => {
    // Phase C I5: multi-bot SSE server (conditional) creates per-bot clients
    const multiBotBlock = SERVER_SOURCE.indexOf('if (MULTI_BOT_MODE)')
    const multiBotSection = SERVER_SOURCE.slice(multiBotBlock, multiBotBlock + 15000)
    expect(multiBotSection).toContain('resolveDiscordToken(botId)')
    expect(multiBotSection).toContain('connectBotDiscord(botId,')
    expect(multiBotSection).toContain('discordClients.set(botId, botDiscord)')
  })

  test('multi-bot SSE cleans up per-bot Discord on SSE disconnect', () => {
    const multiBotBlock = SERVER_SOURCE.indexOf('if (MULTI_BOT_MODE)')
    const multiBotSection = SERVER_SOURCE.slice(multiBotBlock, multiBotBlock + 15000)
    expect(multiBotSection).toContain("per-bot Discord disconnected for ${botId}")
    expect(multiBotSection).toContain('discordClients.delete(botId)')
  })

  test('multi-bot SSE cleans up per-bot Discord on reconnect', () => {
    const multiBotBlock = SERVER_SOURCE.indexOf('if (MULTI_BOT_MODE)')
    const multiBotSection = SERVER_SOURCE.slice(multiBotBlock, multiBotBlock + 15000)
    expect(multiBotSection).toContain('oldClient.disconnect()')
  })

  test('shutdown cleans up all per-bot Discord clients', () => {
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
describe('Phase 3c — Shared Client Routing (Phase C I5: unified)', () => {
  test('shared startup skips bots with per-bot clients', () => {
    expect(SERVER_SOURCE).toContain('discordClients.has(botId)) continue')
  })

  test('per-bot client does NOT register an onMessage handler (outbound-only)', () => {
    expect(SERVER_SOURCE).not.toContain('botDiscord.onMessage((msg)')
  })

  test('shared discord instance exists', () => {
    // The global discord instance should still exist
    expect(SERVER_SOURCE).toContain("const discord = new DiscordAdapter()")
  })
})
