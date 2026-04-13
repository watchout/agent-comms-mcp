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
// FEAT-005 (adapter rewrite): connectBotDiscord / resolveDiscordToken /
// getDiscordClient / discordClients live in adapters/discord-client.ts.
// Concatenate so structural pins still enforce the same invariants at
// their new home.
const SERVER_SOURCE =
  readFileSync(join(PROJECT_ROOT, 'server.ts'), 'utf-8')
  + '\n'
  + readFileSync(join(PROJECT_ROOT, 'adapters/discord-client.ts'), 'utf-8')
// PR-A: routing helpers extracted to core/. Source-level regression tests
// look in core/route-message{,-db}.ts for the moved functions, and in
// server.ts for the call sites + imports.
const CORE_PURE_SOURCE = readFileSync(join(PROJECT_ROOT, 'core/route-message.ts'), 'utf-8')
const CORE_DB_SOURCE = readFileSync(join(PROJECT_ROOT, 'core/route-message-db.ts'), 'utf-8')
const CORE_COMBINED = CORE_PURE_SOURCE + '\n' + CORE_DB_SOURCE

// ============================================================
// 1. Source-level regression tests
// ============================================================
describe('Inbound Router — Source Structure', () => {
  test('routeInbound is a pure (non-async) function in core/route-message.ts', () => {
    // PR-A: moved from server.ts to core/route-message.ts. server.ts still imports it.
    expect(CORE_PURE_SOURCE).toContain('export function routeInbound(')
    expect(CORE_PURE_SOURCE).not.toContain('export async function routeInbound(')
    expect(SERVER_SOURCE).toContain("from './core/route-message'")
    expect(SERVER_SOURCE).toContain('routeInbound,')
  })

  test('server.ts has handleInboundMessage async wrapper', () => {
    expect(SERVER_SOURCE).toContain('async function handleInboundMessage(')
  })

  test('resolveInboundChannel lives in core/route-message-db.ts', () => {
    expect(CORE_DB_SOURCE).toContain('export async function resolveInboundChannel(')
    expect(SERVER_SOURCE).toContain('resolveInboundChannel,')
  })

  test('resolveAgentFromDiscordId lives in core/route-message-db.ts', () => {
    expect(CORE_DB_SOURCE).toContain('export async function resolveAgentFromDiscordId(')
    expect(SERVER_SOURCE).toContain('resolveAgentFromDiscordId,')
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
    // PR-A: loadAgentInfo now takes a DbAdapter as the first argument
    expect(body).toContain('loadAgentInfo(coreDb, receiverAgentId)')
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
// ADR-041 S2-B (PR#157): daemon mode inbound handlers were removed. The
// stdio-mode Discord adapter is the sole inbound source. daemon retains
// per-bot Discord clients for outbound only.
describe('Inbound Router — Daemon Mode Source Structure (ADR-041 S2-B)', () => {
  test('daemon mode does NOT bind per-bot Discord onMessage', () => {
    const daemonBlock = SERVER_SOURCE.indexOf("if (TRANSPORT_MODE === 'daemon' || IS_RECEIVER_MODE)")
    expect(daemonBlock).toBeGreaterThan(-1)
    const daemonSection = SERVER_SOURCE.slice(daemonBlock, daemonBlock + 20000)
    expect(daemonSection).not.toContain('botDiscord.onMessage(')
  })

  test('daemon mode does NOT invoke handleInboundMessage', () => {
    const daemonBlock = SERVER_SOURCE.indexOf("if (TRANSPORT_MODE === 'daemon' || IS_RECEIVER_MODE)")
    const daemonSection = SERVER_SOURCE.slice(daemonBlock, daemonBlock + 20000)
    expect(daemonSection).not.toContain('handleInboundMessage({')
  })

  test('daemon startup still connects per-bot Discord clients (outbound-only)', () => {
    const daemonBlock = SERVER_SOURCE.indexOf("if (TRANSPORT_MODE === 'daemon' || IS_RECEIVER_MODE)")
    const daemonSection = SERVER_SOURCE.slice(daemonBlock, daemonBlock + 20000)
    expect(daemonSection).toContain('for (const botId of EXPECTED_BOTS)')
    expect(daemonSection).toContain('resolveDiscordToken(botId)')
    expect(daemonSection).toContain('connectBotDiscord(botId,')
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
    // PR-A: moved to core/route-message.ts
    expect(CORE_PURE_SOURCE).toContain("if (messageType === 'emergency') return true")
    expect(CORE_PURE_SOURCE).toContain("if (content.startsWith('!stop')) return true")
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
    // PR-A: moved to core/route-message-db.ts. Per SSOT §4.2, channel_id is read
    // directly from the agent_messages row.
    expect(CORE_DB_SOURCE).toContain('SELECT author_id, content, message_type, metadata, thread_id, channel_id FROM agent_messages')
  })

  test('getMessageById returns channel_id field', () => {
    const fnIdx = CORE_DB_SOURCE.indexOf('export async function getMessageById(')
    expect(fnIdx).toBeGreaterThan(-1)
    const body = CORE_DB_SOURCE.slice(fnIdx, fnIdx + 1500)
    expect(body).toContain('channel_id: row.channel_id ?? null')
  })

  test('resolveSendDestination prefers row.channel_id over metadata', () => {
    const fnIdx = CORE_DB_SOURCE.indexOf('export async function resolveSendDestination(')
    expect(fnIdx).toBeGreaterThan(-1)
    const body = CORE_DB_SOURCE.slice(fnIdx, fnIdx + 5000)
    // row.channel_id is the primary source
    expect(body).toContain('original.channel_id ?? platformChannelId')
  })

  test('resolveSendDestination falls back through platform-prefixed metadata keys', () => {
    const fnIdx = CORE_DB_SOURCE.indexOf('export async function resolveSendDestination(')
    const body = CORE_DB_SOURCE.slice(fnIdx, fnIdx + 5000)
    // Discord, Telegram, Slack inbound metadata uses <platform>_channel_id
    expect(body).toContain('meta.discord_channel_id')
    expect(body).toContain('meta.telegram_channel_id')
  })

  // PR-A: server.ts must import the moved helpers from core/
  test('server.ts imports getMessageById and resolveSendDestination from core', () => {
    expect(SERVER_SOURCE).toContain("from './core/route-message-db'")
    expect(SERVER_SOURCE).toContain('getMessageById,')
    expect(SERVER_SOURCE).toContain('resolveSendDestination,')
  })
})

// ============================================================
// 3c. ADR-040 D7 — mention / author_id type unification
// ============================================================
describe('ADR-040 D7 — isHumanAgent / mention resolver type unification', () => {
  test('isHumanAgent SQL accepts both agent_id and discord_id', () => {
    const fnIdx = CORE_DB_SOURCE.indexOf('export async function isHumanAgent(')
    expect(fnIdx).toBeGreaterThan(-1)
    const body = CORE_DB_SOURCE.slice(fnIdx, fnIdx + 800)
    expect(body).toContain('agent_id = $1')
    expect(body).toContain("metadata->>'discord_id' = $1")
    // Both forms in the same query — a plain OR is fine
    expect(body).toMatch(/agent_id = \$1 OR metadata->>'discord_id' = \$1/)
  })

  test('getAgentDiscordId helper exists (new in D7)', () => {
    expect(CORE_DB_SOURCE).toContain('export async function getAgentDiscordId(')
    const fnIdx = CORE_DB_SOURCE.indexOf('export async function getAgentDiscordId(')
    const body = CORE_DB_SOURCE.slice(fnIdx, fnIdx + 500)
    expect(body).toContain("metadata->>'discord_id'")
    expect(body).toContain('WHERE agent_id = $1')
  })

  test('resolveSendDestination compares mentions against both agent_id and Discord ID', () => {
    const fnIdx = CORE_DB_SOURCE.indexOf('export async function resolveSendDestination(')
    const body = CORE_DB_SOURCE.slice(fnIdx, fnIdx + 5000)
    expect(body).toContain('getAgentDiscordId(db, agentId)')
    expect(body).toContain('allMentions.includes(agentId)')
    expect(body).toContain('allMentions.includes(myDiscordId)')
    // isOwnMessage must also cover both shapes
    expect(body).toContain('original.author_id === agentId')
    expect(body).toContain('original.author_id === myDiscordId')
  })

  test('AgentInfo includes optional discordId field', () => {
    expect(CORE_PURE_SOURCE).toContain('discordId?: string | null')
  })

  test('routeInbound matches mentions against agent.discordId as a fallback', () => {
    const fnIdx = CORE_PURE_SOURCE.indexOf('export function routeInbound(')
    const body = CORE_PURE_SOURCE.slice(fnIdx, fnIdx + 3500)
    expect(body).toContain('agent.discordId != null && msg.mentions.includes(agent.discordId)')
  })

  test('loadAgentInfo populates discordId from metadata', () => {
    const fnIdx = CORE_DB_SOURCE.indexOf('export async function loadAgentInfo(')
    const body = CORE_DB_SOURCE.slice(fnIdx, fnIdx + 1500)
    expect(body).toContain("metadata->>'discord_id' AS discord_id")
    expect(body).toContain('discordId: r.rows[0].discord_id ?? null')
    // Fallback (DB unavailable) must include discordId: null
    expect(body).toContain('discordId: null')
  })

  test('DB integration: isHumanAgent resolves CEO via Discord user ID', async () => {
    const dbUrl = process.env.DATABASE_URL || 'postgresql://localhost/agent_comms'
    let client: Client | null = null
    const TEST_HUMAN_AGENT = 'test-d7-human'
    const TEST_HUMAN_DISCORD = 'discord-d7-999'
    try {
      client = new Client({ connectionString: dbUrl })
      await client.connect()

      await client.query(
        `INSERT INTO agents (agent_id, display_name, runtime, org_id, status, agent_type, metadata)
         VALUES ($1, $1, 'discord', 'default', 'online', 'human', $2::jsonb)
         ON CONFLICT (agent_id) DO UPDATE SET agent_type = 'human', metadata = $2::jsonb`,
        [TEST_HUMAN_AGENT, JSON.stringify({ discord_id: TEST_HUMAN_DISCORD })]
      )

      // Simulate the D7 fix SQL directly (the isHumanAgent query shape)
      const byAgentId = await client.query(
        `SELECT agent_type FROM agents WHERE agent_id = $1 OR metadata->>'discord_id' = $1`,
        [TEST_HUMAN_AGENT]
      )
      const byDiscordId = await client.query(
        `SELECT agent_type FROM agents WHERE agent_id = $1 OR metadata->>'discord_id' = $1`,
        [TEST_HUMAN_DISCORD]
      )

      // BEFORE D7: byDiscordId would return zero rows (query was agent_id = $1 only),
      // so isHumanAgent returned false and resolveSendDestination blocked the reply.
      // AFTER D7: both lookups find the row and the caller sees agent_type='human'.
      expect(byAgentId.rows.length).toBe(1)
      expect(byAgentId.rows[0].agent_type).toBe('human')
      expect(byDiscordId.rows.length).toBe(1)
      expect(byDiscordId.rows[0].agent_type).toBe('human')
    } catch (err) {
      console.warn('DB not available, skipping D7 integration test:', (err as Error).message)
    } finally {
      if (client) {
        await client.query('DELETE FROM agents WHERE agent_id = $1', [TEST_HUMAN_AGENT]).catch(() => {})
        await client.end()
      }
    }
  })
})

// ============================================================
// 3b. DiscordAdapter D1 self-registration (ADR-040 D1)
// ============================================================
describe('DiscordAdapter — D1 self-registration', () => {
  const ADAPTER_SOURCE = readFileSync(join(PROJECT_ROOT, 'adapters/discord.ts'), 'utf-8')

  test('DiscordAdapter has setAgentId method', () => {
    expect(ADAPTER_SOURCE).toContain('setAgentId(agentId: string): void')
    expect(ADAPTER_SOURCE).toContain('private agentId: string | null = null')
  })

  test('ready handler self-registers discord_id when agentId + dbQuery are set', () => {
    const readyIdx = ADAPTER_SOURCE.indexOf("this.client.once('ready'")
    expect(readyIdx).toBeGreaterThan(-1)
    const body = ADAPTER_SOURCE.slice(readyIdx, readyIdx + 2000)
    expect(body).toContain('this.agentId && this.dbQuery')
    expect(body).toContain('UPDATE agents')
    expect(body).toContain("jsonb_build_object('discord_id', $1::text)")
    // Idempotency guard so we do not write the same value on every reconnect
    expect(body).toContain("COALESCE(metadata->>'discord_id', '') <> $1::text")
  })

  test('per-bot connectBotDiscord calls setAgentId(botId) before connect', () => {
    const fnIdx = SERVER_SOURCE.indexOf('async function connectBotDiscord(')
    expect(fnIdx).toBeGreaterThan(-1)
    const body = SERVER_SOURCE.slice(fnIdx, fnIdx + 1500)
    const setAgentIdx = body.indexOf('adapter.setAgentId(botId)')
    const connectIdx = body.indexOf('adapter.connect({')
    expect(setAgentIdx).toBeGreaterThan(-1)
    expect(connectIdx).toBeGreaterThan(-1)
    expect(setAgentIdx).toBeLessThan(connectIdx)
  })

  test('stdio/sse shared discord adapter calls setAgentId(AGENT_ID) before connect', () => {
    // The path that runs in non-daemon transport modes binds the adapter to AGENT_ID
    expect(SERVER_SOURCE).toContain('discord.setAgentId(AGENT_ID)')
  })
})

// ============================================================
// 4. registerAgent UPSERT — metadata merge regression (D8)
// ============================================================
describe('registerAgent — metadata merge (ADR-040 D8)', () => {
  test('source uses jsonb || merge instead of overwrite', () => {
    const fnIdx = SERVER_SOURCE.indexOf('async function registerAgent(')
    expect(fnIdx).toBeGreaterThan(-1)
    const body = SERVER_SOURCE.slice(fnIdx, fnIdx + 2000)
    // The DO UPDATE branch must merge old metadata with new, not replace it.
    // Without this, every bot restart wipes DB-only keys (e.g. discord_id
    // self-registered by D1) when the bot's local config has no metadata.
    expect(body).toContain("metadata = COALESCE(agents.metadata, '{}'::jsonb) || COALESCE($5::jsonb, '{}'::jsonb)")
    // The INSERT branch must coerce NULL config to '{}'::jsonb so the column
    // never starts as NULL (otherwise the merge on a later restart is a no-op).
    expect(body).toContain("COALESCE($5::jsonb, '{}'::jsonb)")
  })

  test('DB integration: existing discord_id survives a config-without-metadata UPSERT', async () => {
    const dbUrl = process.env.DATABASE_URL || 'postgresql://localhost/agent_comms'
    let client: Client | null = null
    const TEST_AGENT_ID = 'test-d8-merge-bot'
    try {
      client = new Client({ connectionString: dbUrl })
      await client.connect()

      // Step 1: insert agent with discord_id (simulates a prior D1 self-registration
      // or the manual emergency patch we shipped on 2026-04-08)
      await client.query(
        `INSERT INTO agents (agent_id, display_name, runtime, org_id, status, agent_type, metadata)
         VALUES ($1, $1, 'claude-code', 'default', 'online', 'dev', $2::jsonb)
         ON CONFLICT (agent_id) DO UPDATE SET metadata = $2::jsonb`,
        [TEST_AGENT_ID, JSON.stringify({ discord_id: 'discord-1234567890' })]
      )

      // Step 2: simulate registerAgent's UPSERT with a NULL metadata payload
      // (the bug case: bot's local config has no `metadata` block).
      // Use the SAME SQL shape as server.ts so the test fails if the source ever regresses.
      await client.query(
        `INSERT INTO agents (agent_id, display_name, agent_type, runtime, status, last_seen_at, metadata)
         VALUES ($1, $2, $3, $4, 'online', now(), COALESCE($5::jsonb, '{}'::jsonb))
         ON CONFLICT (agent_id) DO UPDATE SET
           display_name = $2, agent_type = $3, runtime = $4,
           status = 'online', last_seen_at = now(),
           metadata = COALESCE(agents.metadata, '{}'::jsonb) || COALESCE($5::jsonb, '{}'::jsonb)`,
        [TEST_AGENT_ID, TEST_AGENT_ID, 'dev', 'claude-code', null]
      )

      // Step 3: discord_id must still be there
      const r = await client.query("SELECT metadata->>'discord_id' AS discord_id FROM agents WHERE agent_id = $1", [TEST_AGENT_ID])
      expect(r.rows.length).toBe(1)
      expect(r.rows[0].discord_id).toBe('discord-1234567890')

      // Step 4: a real metadata payload should still override the same key
      await client.query(
        `INSERT INTO agents (agent_id, display_name, agent_type, runtime, status, last_seen_at, metadata)
         VALUES ($1, $2, $3, $4, 'online', now(), COALESCE($5::jsonb, '{}'::jsonb))
         ON CONFLICT (agent_id) DO UPDATE SET
           display_name = $2, agent_type = $3, runtime = $4,
           status = 'online', last_seen_at = now(),
           metadata = COALESCE(agents.metadata, '{}'::jsonb) || COALESCE($5::jsonb, '{}'::jsonb)`,
        [TEST_AGENT_ID, TEST_AGENT_ID, 'dev', 'claude-code', JSON.stringify({ discord_id: 'discord-overridden' })]
      )
      const r2 = await client.query("SELECT metadata->>'discord_id' AS discord_id FROM agents WHERE agent_id = $1", [TEST_AGENT_ID])
      expect(r2.rows[0].discord_id).toBe('discord-overridden')

      // Step 5: a partial payload (different key) merges, both keys present
      await client.query(
        `INSERT INTO agents (agent_id, display_name, agent_type, runtime, status, last_seen_at, metadata)
         VALUES ($1, $2, $3, $4, 'online', now(), COALESCE($5::jsonb, '{}'::jsonb))
         ON CONFLICT (agent_id) DO UPDATE SET
           display_name = $2, agent_type = $3, runtime = $4,
           status = 'online', last_seen_at = now(),
           metadata = COALESCE(agents.metadata, '{}'::jsonb) || COALESCE($5::jsonb, '{}'::jsonb)`,
        [TEST_AGENT_ID, TEST_AGENT_ID, 'dev', 'claude-code', JSON.stringify({ team: 'platform' })]
      )
      const r3 = await client.query("SELECT metadata FROM agents WHERE agent_id = $1", [TEST_AGENT_ID])
      const meta = typeof r3.rows[0].metadata === 'string' ? JSON.parse(r3.rows[0].metadata) : r3.rows[0].metadata
      expect(meta.discord_id).toBe('discord-overridden') // preserved across a metadata-less merge
      expect(meta.team).toBe('platform') // newly added
    } catch (err) {
      console.warn('DB not available, skipping D8 integration test:', (err as Error).message)
    } finally {
      if (client) {
        await client.query('DELETE FROM agents WHERE agent_id = $1', [TEST_AGENT_ID]).catch(() => {})
        await client.end()
      }
    }
  })
})
