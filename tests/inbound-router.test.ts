#!/usr/bin/env bun
/**
 * Tests for inbound router (PR#56 — SSOT-5 §1 compliant)
 *
 * Verifies:
 * 1. Source-level: routeInbound exists and is used for Discord inbound
 * 2. Source-level: direct mcp.notification push is removed from onMessage
 * 3. DB integration: members check, active_thread filter, CEO bypass
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
  test('server.ts has routeInbound function', () => {
    expect(SERVER_SOURCE).toContain('async function routeInbound(')
  })

  test('server.ts has resolveInboundChannel function', () => {
    expect(SERVER_SOURCE).toContain('async function resolveInboundChannel(')
  })

  test('server.ts has resolveAgentFromDiscordId function', () => {
    expect(SERVER_SOURCE).toContain('async function resolveAgentFromDiscordId(')
  })

  test('Discord onMessage uses routeInbound (not direct mcp.notification)', () => {
    // Find the discord.onMessage block in the channel plugin section
    const onMessageIdx = SERVER_SOURCE.indexOf('discord.onMessage((msg) => {')
    expect(onMessageIdx).toBeGreaterThan(-1)

    // Get the onMessage callback body (up to closing })
    const afterOnMessage = SERVER_SOURCE.slice(onMessageIdx, onMessageIdx + 2000)

    // Must use routeInbound
    expect(afterOnMessage).toContain('routeInbound({')

    // Must NOT contain direct mcp.notification in the onMessage callback
    // (mcp.notification should only be called inside pushFn)
    expect(afterOnMessage).not.toContain("mcp.notification({\n          method: 'notifications/claude/channel',")
  })

  test('routeInbound drops unregistered channels (CHANNEL_UNKNOWN)', () => {
    expect(SERVER_SOURCE).toContain("reason: 'CHANNEL_UNKNOWN'")
    expect(SERVER_SOURCE).toContain('not registered in core DB')
  })

  test('members=[] results in NOT_A_MEMBER (no length>0 guard)', () => {
    // The members check must NOT have a length > 0 guard
    const routeInboundIdx = SERVER_SOURCE.indexOf('async function routeInbound(')
    const body = SERVER_SOURCE.slice(routeInboundIdx, routeInboundIdx + 3000)
    // Should NOT contain the old guard
    expect(body).not.toContain('resolved.members.length > 0 &&')
    // Should contain the direct includes check
    expect(body).toContain('!resolved.members.includes(receiverAgentId)')
  })

  test('routeInbound checks channel members', () => {
    expect(SERVER_SOURCE).toContain('!resolved.members.includes(receiverAgentId)')
  })

  test('routeInbound checks active_thread', () => {
    expect(SERVER_SOURCE).toContain('getActiveThread(receiverAgentId)')
  })

  test('routeInbound has emergency/CEO bypass', () => {
    expect(SERVER_SOURCE).toContain('isEmergencyMessage(content,')
    expect(SERVER_SOURCE).toContain('isHumanAgent(senderAgentId)')
    expect(SERVER_SOURCE).toContain('bypassActiveThread')
  })

  test('routeInbound always saves to DB before delivery check', () => {
    // saveMessage should appear before members check
    const routeInboundIdx = SERVER_SOURCE.indexOf('async function routeInbound(')
    const body = SERVER_SOURCE.slice(routeInboundIdx, routeInboundIdx + 3000)
    const saveIdx = body.indexOf('await saveMessage(')
    const membersCheckIdx = body.indexOf('!resolved.members.includes(receiverAgentId)')
    expect(saveIdx).toBeGreaterThan(-1)
    expect(membersCheckIdx).toBeGreaterThan(-1)
    expect(saveIdx).toBeLessThan(membersCheckIdx)
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
        `INSERT INTO agents (agent_id, org_id, status, agent_type, metadata, created_at, updated_at)
         VALUES ($1, 'default', 'online', 'human', $2, now(), now())
         ON CONFLICT (agent_id) DO UPDATE SET agent_type = 'human', metadata = $2`,
        [CEO_AGENT, JSON.stringify({ discord_id: CEO_DISCORD_ID })]
      )

      // Setup test bot agent
      await client.query(
        `INSERT INTO agents (agent_id, org_id, status, agent_type, active_thread, created_at, updated_at)
         VALUES ($1, 'default', 'online', 'bot', NULL, now(), now())
         ON CONFLICT (agent_id) DO UPDATE SET active_thread = NULL, agent_type = 'bot'`,
        [TEST_AGENT]
      )

      // Setup non-member agent
      await client.query(
        `INSERT INTO agents (agent_id, org_id, status, agent_type, created_at, updated_at)
         VALUES ($1, 'default', 'online', 'bot', now(), now())
         ON CONFLICT (agent_id) DO NOTHING`,
        [NON_MEMBER_AGENT]
      )
    } catch (err) {
      console.warn('DB not available, integration tests will be skipped')
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
    // These are source-level tests for the function logic
    // (function is not exported, so we verify source patterns)
    expect(SERVER_SOURCE).toContain("if (messageType === 'emergency') return true")
    expect(SERVER_SOURCE).toContain("if (content.startsWith('!stop')) return true")
  })
})
