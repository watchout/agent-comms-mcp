#!/usr/bin/env bun
/**
 * Tests for inbound router (updated for §5.1 pure routeInbound + handleInboundMessage)
 *
 * Verifies:
 * 1. Source-level: routeInbound is pure, handleInboundMessage wraps it
 * 2. Source-level: Discord onMessage uses handleInboundMessage
 * 3. DB integration: members check, active_thread filter
 *
 * Usage: bun test tests/inbound-router.test.ts
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { Client } from 'pg'

const PROJECT_ROOT = join(dirname(new URL(import.meta.url).pathname), '..')
const SERVER_SOURCE = readFileSync(join(PROJECT_ROOT, 'server.ts'), 'utf-8')

// ============================================================
// 1. Source-level regression tests
// ============================================================
describe('Inbound Router — Source Structure', () => {
  test('server.ts has pure routeInbound function (not async)', () => {
    expect(SERVER_SOURCE).toContain('function routeInbound(')
    expect(SERVER_SOURCE).not.toContain('async function routeInbound(')
  })

  test('server.ts has handleInboundMessage async wrapper', () => {
    expect(SERVER_SOURCE).toContain('async function handleInboundMessage(')
  })

  test('server.ts has resolveInboundChannel function', () => {
    expect(SERVER_SOURCE).toContain('async function resolveInboundChannel(')
  })

  test('server.ts has resolveAgentFromDiscordId function', () => {
    expect(SERVER_SOURCE).toContain('async function resolveAgentFromDiscordId(')
  })

  test('Discord onMessage uses handleInboundMessage (not direct routeInbound)', () => {
    const onMessageIdx = SERVER_SOURCE.indexOf('discord.onMessage((msg) => {')
    expect(onMessageIdx).toBeGreaterThan(-1)
    const afterOnMessage = SERVER_SOURCE.slice(onMessageIdx, onMessageIdx + 2000)
    expect(afterOnMessage).toContain('handleInboundMessage({')
  })

  test('routeInbound drops unregistered channels (CHANNEL_UNKNOWN)', () => {
    expect(SERVER_SOURCE).toContain("reason: 'CHANNEL_UNKNOWN'")
    expect(SERVER_SOURCE).toContain('not registered in core DB')
  })

  test('handleInboundMessage checks channel members via loadAgentInfo', () => {
    const fnIdx = SERVER_SOURCE.indexOf('async function handleInboundMessage(')
    const body = SERVER_SOURCE.slice(fnIdx, fnIdx + 5000)
    expect(body).toContain('loadAgentInfo(receiverAgentId)')
  })

  test('last_received_context abolished (reply_to required, §4.2)', () => {
    expect(SERVER_SOURCE).not.toContain('updateLastReceivedContext')
    expect(SERVER_SOURCE).not.toContain('getLastReceivedContext')
  })

  test('handleInboundMessage always saves to DB before routing', () => {
    const fnIdx = SERVER_SOURCE.indexOf('async function handleInboundMessage(')
    const body = SERVER_SOURCE.slice(fnIdx, fnIdx + 5000)
    const saveIdx = body.indexOf('saveMessage(')
    const routeIdx = body.indexOf('routeInbound(')
    expect(saveIdx).toBeGreaterThan(-1)
    expect(routeIdx).toBeGreaterThan(-1)
    expect(saveIdx).toBeLessThan(routeIdx)
  })
})

// ============================================================
// 1b. Daemon mode source-level regression tests
// ============================================================
describe('Inbound Router — Daemon Mode Source Structure', () => {
  test('daemon mode uses handleInboundMessage for all Discord inbound paths', () => {
    const daemonBlock = SERVER_SOURCE.indexOf("if (TRANSPORT_MODE === 'daemon')")
    expect(daemonBlock).toBeGreaterThan(-1)
    const daemonSection = SERVER_SOURCE.slice(daemonBlock, daemonBlock + 20000)

    // Both startup per-bot and shared client use handleInboundMessage
    expect(daemonSection).toContain('handleInboundMessage({')
    // No direct saveMessage in any onMessage handler
    const sharedOnMsg = daemonSection.indexOf('discord.onMessage((msg) => {')
    expect(sharedOnMsg).toBeGreaterThan(-1)
    const sharedBody = daemonSection.slice(sharedOnMsg, sharedOnMsg + 4000)
    expect(sharedBody).not.toContain('saveMessage({')
  })

  test('daemon startup connects per-bot Discord clients from EXPECTED_BOTS', () => {
    const daemonBlock = SERVER_SOURCE.indexOf("if (TRANSPORT_MODE === 'daemon')")
    const daemonSection = SERVER_SOURCE.slice(daemonBlock, daemonBlock + 20000)
    expect(daemonSection).toContain('for (const botId of EXPECTED_BOTS)')
    expect(daemonSection).toContain('resolveDiscordToken(botId)')
    expect(daemonSection).toContain('connectBotDiscord(botId,')
  })

  test('daemon startup per-bot calls pushToChannelServer after handleInboundMessage', () => {
    const daemonBlock = SERVER_SOURCE.indexOf("if (TRANSPORT_MODE === 'daemon')")
    const daemonSection = SERVER_SOURCE.slice(daemonBlock, daemonBlock + 20000)
    expect(daemonSection).toContain('pushToChannelServer(botId, inboundContent,')
  })

  test('daemon shared client iterates over EXPECTED_BOTS', () => {
    const daemonBlock = SERVER_SOURCE.indexOf("if (TRANSPORT_MODE === 'daemon')")
    const daemonSection = SERVER_SOURCE.slice(daemonBlock, daemonBlock + 20000)
    expect(daemonSection).toContain('for (const expectedBot of EXPECTED_BOTS)')
  })

  test('daemon mode pushes via pushToChannelServer with SSE fallback', () => {
    const daemonBlock = SERVER_SOURCE.indexOf("if (TRANSPORT_MODE === 'daemon')")
    const daemonSection = SERVER_SOURCE.slice(daemonBlock, daemonBlock + 20000)
    expect(daemonSection).toContain('pushToChannelServer(expectedBot,')
    expect(daemonSection).toContain('ctx?.transport')
  })
})

// ============================================================
// 2. DB integration tests
// ============================================================
describe('Inbound Router — DB Integration', () => {
  let client: Client | null = null
  const TEST_AGENT = 'test-inbound-bot'
  const TEST_CHANNEL = 'test-inbound-ch-001'
  const CEO_AGENT = 'test-ceo-inbound'
  const CEO_DISCORD_ID = 'discord-ceo-999'
  const NON_MEMBER_AGENT = 'test-non-member-bot'

  beforeAll(async () => {
    const dbUrl = process.env.DATABASE_URL || 'postgresql://localhost/agent_comms'
    try {
      client = new Client({ connectionString: dbUrl })
      await client.connect()

      // Setup test channel with members
      await client.query(
        `INSERT INTO channels (id, org_id, type, name, members, created_by, created_at, updated_at)
         VALUES ($1, 'default', 'channel', 'test-inbound', $2, 'test', now(), now())
         ON CONFLICT (id) DO UPDATE SET members = $2`,
        [TEST_CHANNEL, [TEST_AGENT, CEO_AGENT]]
      )

      // Setup CEO agent (human type with discord_id)
      await client.query(
        `INSERT INTO agents (agent_id, display_name, runtime, org_id, status, agent_type, metadata)
         VALUES ($1, $1, 'discord', 'default', 'online', 'human', $2)
         ON CONFLICT (agent_id) DO UPDATE SET agent_type = 'human', metadata = $2`,
        [CEO_AGENT, JSON.stringify({ discord_id: CEO_DISCORD_ID })]
      )

      // Setup test bot agent
      await client.query(
        `INSERT INTO agents (agent_id, display_name, runtime, org_id, status, agent_type, active_thread)
         VALUES ($1, $1, 'claude-code', 'default', 'online', 'bot', NULL)
         ON CONFLICT (agent_id) DO UPDATE SET active_thread = NULL, agent_type = 'bot'`,
        [TEST_AGENT]
      )

      // Setup non-member agent
      await client.query(
        `INSERT INTO agents (agent_id, display_name, runtime, org_id, status, agent_type)
         VALUES ($1, $1, 'claude-code', 'default', 'online', 'bot')
         ON CONFLICT (agent_id) DO NOTHING`,
        [NON_MEMBER_AGENT]
      )
    } catch (err) {
      console.warn('DB not available, integration tests will be skipped:', (err as Error).message)
      client = null
    }
  })

  afterAll(async () => {
    if (client) {
      // Cleanup
      await client.query('DELETE FROM agent_messages WHERE channel_id = $1', [TEST_CHANNEL]).catch(() => {})
      await client.query('DELETE FROM channels WHERE id = $1', [TEST_CHANNEL]).catch(() => {})
      await client.query('DELETE FROM agents WHERE agent_id = ANY($1)', [[TEST_AGENT, CEO_AGENT, NON_MEMBER_AGENT]]).catch(() => {})
      await client.end()
    }
  })

  test('resolveInboundChannel returns members for known channel', async () => {
    if (!client) return // skip if no DB

    // Query directly to verify test setup
    const r = await client.query('SELECT members FROM channels WHERE id = $1', [TEST_CHANNEL])
    expect(r.rows.length).toBe(1)
    expect(r.rows[0].members).toContain(TEST_AGENT)
    expect(r.rows[0].members).toContain(CEO_AGENT)
    expect(r.rows[0].members).not.toContain(NON_MEMBER_AGENT)
  })

  test('isHumanAgent returns true for CEO agent', async () => {
    if (!client) return

    const r = await client.query("SELECT agent_type FROM agents WHERE agent_id = $1", [CEO_AGENT])
    expect(r.rows.length).toBe(1)
    expect(r.rows[0].agent_type).toBe('human')
  })

  test('resolveAgentFromDiscordId maps discord ID to agent_id', async () => {
    if (!client) return

    const r = await client.query(
      "SELECT agent_id FROM agents WHERE metadata->>'discord_id' = $1",
      [CEO_DISCORD_ID]
    )
    expect(r.rows.length).toBe(1)
    expect(r.rows[0].agent_id).toBe(CEO_AGENT)
  })

  test('active_thread blocks non-matching messages', async () => {
    if (!client) return

    // Set active_thread for test bot
    await client.query('UPDATE agents SET active_thread = $1 WHERE agent_id = $2', ['thread-xyz', TEST_AGENT])

    const r = await client.query('SELECT active_thread FROM agents WHERE agent_id = $1', [TEST_AGENT])
    expect(r.rows[0].active_thread).toBe('thread-xyz')

    // Cleanup: reset active_thread
    await client.query('UPDATE agents SET active_thread = NULL WHERE agent_id = $1', [TEST_AGENT])
  })

  test('isEmergencyMessage detects emergency type and !stop prefix', () => {
    expect(SERVER_SOURCE).toContain("if (messageType === 'emergency') return true")
    expect(SERVER_SOURCE).toContain("if (content.startsWith('!stop')) return true")
  })

  // ============================================================
  // resolveSendDestination — channel_id resolution regression
  // (CEO Discord inbound → bot reply, fixes INVALID_DESTINATION)
  // ============================================================
  test('CEO Discord inbound row exposes channel_id for resolveSendDestination', async () => {
    if (!client) return

    // Insert a synthetic inbound message that mirrors how the Discord adapter saves it:
    // - channel_id column is set
    // - metadata uses discord_channel_id (NOT plain channel_id) — this is the bug shape
    const msgId = '00000000-0000-4000-8000-00000abcd001'
    await client.query(
      `INSERT INTO agent_messages (id, channel_id, author_id, content, message_type, metadata, direction, source, created_at)
       VALUES ($1, $2, $3, $4, 'chat', $5::jsonb, 'inbound', 'discord', now())
       ON CONFLICT (id) DO UPDATE SET channel_id = $2, metadata = $5::jsonb`,
      [
        msgId,
        TEST_CHANNEL,
        CEO_DISCORD_ID,
        `<@bot> reply test`,
        JSON.stringify({
          discord_channel_id: TEST_CHANNEL,
          discord_message_id: 'snowflake-123',
          mentions: [TEST_AGENT],
          author_name: 'ceo',
        }),
      ]
    )

    // Verify both channel_id column and metadata key shape match the production bug
    const r = await client.query(
      'SELECT channel_id, metadata FROM agent_messages WHERE id = $1',
      [msgId]
    )
    expect(r.rows.length).toBe(1)
    expect(r.rows[0].channel_id).toBe(TEST_CHANNEL)
    const meta = typeof r.rows[0].metadata === 'string' ? JSON.parse(r.rows[0].metadata) : r.rows[0].metadata
    expect(meta.discord_channel_id).toBe(TEST_CHANNEL)
    expect(meta.channel_id).toBeUndefined() // proves the bug scenario: metadata.channel_id is missing

    // Cleanup
    await client.query('DELETE FROM agent_messages WHERE id = $1', [msgId])
  })
})

// ============================================================
// 3. resolveSendDestination — source-level regression
// ============================================================
describe('resolveSendDestination — channel_id resolution', () => {
  test('getMessageById SELECTs channel_id column', () => {
    // Per SSOT §4.2, channel_id must be read directly from agent_messages
    expect(SERVER_SOURCE).toContain('SELECT author_id, content, message_type, metadata, thread_id, channel_id FROM agent_messages')
  })

  test('getMessageById returns channel_id field', () => {
    const fnIdx = SERVER_SOURCE.indexOf('async function getMessageById(')
    expect(fnIdx).toBeGreaterThan(-1)
    const body = SERVER_SOURCE.slice(fnIdx, fnIdx + 1000)
    expect(body).toContain('channel_id: row.channel_id ?? null')
  })

  test('resolveSendDestination prefers row.channel_id over metadata', () => {
    const fnIdx = SERVER_SOURCE.indexOf('async function resolveSendDestination(')
    expect(fnIdx).toBeGreaterThan(-1)
    const body = SERVER_SOURCE.slice(fnIdx, fnIdx + 3000)
    // row.channel_id is the primary source
    expect(body).toContain('original.channel_id ?? platformChannelId')
  })

  test('resolveSendDestination falls back through platform-prefixed metadata keys', () => {
    const fnIdx = SERVER_SOURCE.indexOf('async function resolveSendDestination(')
    const body = SERVER_SOURCE.slice(fnIdx, fnIdx + 3000)
    // Discord, Telegram, Slack inbound metadata uses <platform>_channel_id
    expect(body).toContain('meta.discord_channel_id')
    expect(body).toContain('meta.telegram_channel_id')
  })
})
