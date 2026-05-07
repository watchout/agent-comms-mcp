#!/usr/bin/env bun
/**
 * CEO P0 wave 2 blocker — inbound-receiver fanout fix.
 *
 * spec ↔ instruction: lead-ama dispatch notify ids `ce26c127`/`cb32bf49`/
 * `129c7410` (cycle 1 base) + `4196edff`/`3cc295e7` (cycle 2 補強).
 *
 * Pre-fix: handleInboundMessage looked at `pushTargets.includes(receiverAgentId)`
 * and only INSERTed for the daemon's own AGENT_ID. A Discord message
 * mentioning bots B and C, received by daemon A, would commit at most
 * one row (A's, if A was also mentioned) — B and C never received a
 * queue row. CEO P0 because wave 2 SIGUSR1 cutover depends on the
 * fanout working for every member of a multi-bot channel.
 *
 * Test fixtures (merge gate, per dispatch §4):
 *   T-1 single-bot regression: mention=A → only A queue row.
 *   T-2 fanout: mention=B + cc=C in members [A,B,C] → B + C queue rows.
 *   T-3 NOT_A_MEMBER drop: mention=B but B is not in channel members → no B row.
 *   T-4 bus.signal fans out to every committed receiver.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { Client } from 'pg'
import { randomUUID } from 'node:crypto'
import { handleInboundMessage, setInboundReceiverDeps } from '../adapters/inbound-receiver'
import { createMessageBus } from '../core/message-bus'
import { createDbAdapter, toLegacy } from '../core/db'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost/agent_comms'
const SUFFIX = `fanout-${process.pid}`
const AGENT_A = `test-${SUFFIX}-a`
const AGENT_B = `test-${SUFFIX}-b`
const AGENT_C = `test-${SUFFIX}-c`
const TEST_CHANNEL = `test-channel-${SUFFIX}`

let dbReachable = false
let client: Client

beforeAll(async () => {
  try {
    client = new Client({ connectionString: DATABASE_URL })
    await client.connect()
    // Seed agents.
    for (const id of [AGENT_A, AGENT_B, AGENT_C]) {
      await client.query(
        `INSERT INTO agents (agent_id, display_name, agent_type, runtime, status, metadata)
         VALUES ($1, $1, 'dev', 'test', 'online', $2)
         ON CONFLICT (agent_id) DO UPDATE SET status='online'`,
        [id, JSON.stringify({ discord_id: `discord-${id}` })],
      )
    }
    // Cycle 2 Finding 2 — register the channel up-front so
    // `resolveInboundChannel` succeeds before each test's
    // `handleInboundMessage` call. Per-test seedChannel() still tweaks
    // the members array (T-3 narrows it), but the row is guaranteed to
    // exist by the time the receiver looks it up.
    await client.query(
      `INSERT INTO channels (id, org_id, type, members)
       VALUES ($1, 'default', 'channel', $2)
       ON CONFLICT (id) DO UPDATE SET members = EXCLUDED.members`,
      [TEST_CHANNEL, [AGENT_A, AGENT_B, AGENT_C]],
    )
    dbReachable = true
  } catch {
    dbReachable = false
  }
})

afterAll(async () => {
  if (!dbReachable) return
  try {
    await client.query(`DELETE FROM message_queue WHERE agent_id = ANY($1)`, [[AGENT_A, AGENT_B, AGENT_C]])
    await client.query(`DELETE FROM agent_messages WHERE channel_id = $1`, [TEST_CHANNEL])
    await client.query(`DELETE FROM channels WHERE id = $1`, [TEST_CHANNEL])
    await client.query(`DELETE FROM agents WHERE agent_id = ANY($1)`, [[AGENT_A, AGENT_B, AGENT_C]])
    await client.end()
  } catch {}
})

function requireDb() {
  if (!dbReachable) {
    throw new Error(
      `DB unreachable at ${DATABASE_URL}. Inbound fanout test requires Postgres.`,
    )
  }
}

async function seedChannel(members: string[]) {
  await client.query(
    `INSERT INTO channels (id, org_id, type, members)
     VALUES ($1, 'default', 'channel', $2)
     ON CONFLICT (id) DO UPDATE SET members = EXCLUDED.members`,
    [TEST_CHANNEL, members],
  )
}

async function clearQueues() {
  await client.query(`DELETE FROM message_queue WHERE agent_id = ANY($1)`, [[AGENT_A, AGENT_B, AGENT_C]])
  await client.query(`DELETE FROM agent_messages WHERE channel_id = $1`, [TEST_CHANNEL])
}

function setupDeps(busSignals: string[]) {
  // Wire handleInboundMessage with a recording stderr + a stub bus that
  // captures every signal target. saveMessage delegates to the real
  // agent_messages INSERT path so reply_to / metadata behave normally.
  const dbAdapter = createDbAdapter(DATABASE_URL)
  setInboundReceiverDeps({
    agentId: AGENT_A,
    authMode: 'open',
    databaseUrl: DATABASE_URL,
    receiverPipelineBots: new Set<string>(),
    processedIds: new Set<string>(),
    tryGetDb: async () => client,
    coreDbAdapter: async () => toLegacy(dbAdapter),
    saveMessage: async (msg: any) => {
      const id = randomUUID()
      await client.query(
        `INSERT INTO agent_messages (id, channel_id, author_id, content, message_type, source, direction, role, metadata)
         VALUES ($1, $2, $3, $4, $5, 'discord', 'inbound', 'user', $6)`,
        [id, msg.channel_id, msg.author_id, msg.content, msg.message_type ?? 'chat', JSON.stringify(msg.metadata ?? {})],
      )
      return id
    },
    validateIncomingAuth: () => ({ ok: true as const }),
    buildQuoteBlock: () => null,
    updateActiveThread: async () => {},
    hashCode: (s: string) => s,
    bus: {
      async signal(name: string) { busSignals.push(name) },
      close: async () => {},
    } as any,
    mcpPush: async () => {},
  })
}

describe('test_inbound_multi_bot_fanout — CEO P0 wave 2 blocker', () => {
  beforeEach(async () => {
    requireDb()
    await clearQueues()
  })

  test('T-1 single-bot mention → only target queue row (regression)', async () => {
    await seedChannel([AGENT_A, AGENT_B, AGENT_C])
    const busSignals: string[] = []
    setupDeps(busSignals)
    const r = await handleInboundMessage({
      receiverAgentId: AGENT_A,
      externalChannelId: TEST_CHANNEL,
      externalMessageId: `ext-t1-${randomUUID()}`,
      authorExternalId: 'human-tester',
      authorName: 'Tester',
      authorIsBot: false,
      content: `<@${AGENT_A}> hello`,
      timestamp: new Date(),
      platform: 'discord',
      mentions: [AGENT_A],
    })
    expect(r.delivered).toBe(true)
    const counts = await client.query<{ agent_id: string; n: number }>(
      `SELECT agent_id, COUNT(*)::int AS n FROM message_queue WHERE agent_id = ANY($1) GROUP BY agent_id`,
      [[AGENT_A, AGENT_B, AGENT_C]],
    )
    const map = Object.fromEntries(counts.rows.map(r => [r.agent_id, r.n]))
    expect(map[AGENT_A]).toBe(1)
    expect(map[AGENT_B] ?? 0).toBe(0)
    expect(map[AGENT_C] ?? 0).toBe(0)
    expect(busSignals).toContain(`bot_${AGENT_A}`)
  })

  test('T-2 fanout: mention=B + cc=C → B + C each get a queue row (core)', async () => {
    await seedChannel([AGENT_A, AGENT_B, AGENT_C])
    const busSignals: string[] = []
    setupDeps(busSignals)
    const r = await handleInboundMessage({
      receiverAgentId: AGENT_A,
      externalChannelId: TEST_CHANNEL,
      externalMessageId: `ext-t2-${randomUUID()}`,
      authorExternalId: 'human-tester',
      authorName: 'Tester',
      authorIsBot: false,
      // cc body suffix gets parsed by the receiver as additional mentions.
      content: `<@${AGENT_B}> hello\n[CC: <@${AGENT_C}>]`,
      timestamp: new Date(),
      platform: 'discord',
      mentions: [AGENT_B, AGENT_C],
    })
    expect(r.delivered).toBe(true)
    const counts = await client.query<{ agent_id: string; n: number }>(
      `SELECT agent_id, COUNT(*)::int AS n FROM message_queue WHERE agent_id = ANY($1) GROUP BY agent_id`,
      [[AGENT_A, AGENT_B, AGENT_C]],
    )
    const map = Object.fromEntries(counts.rows.map(r => [r.agent_id, r.n]))
    expect(map[AGENT_B]).toBe(1)
    expect(map[AGENT_C]).toBe(1)
    expect(map[AGENT_A] ?? 0).toBe(0)
  })

  test('T-3 NOT_A_MEMBER drop: mention=B but B not in channel → no B row', async () => {
    // Channel only has A and C; B is mentioned but not a member.
    await seedChannel([AGENT_A, AGENT_C])
    const busSignals: string[] = []
    setupDeps(busSignals)
    const r = await handleInboundMessage({
      receiverAgentId: AGENT_A,
      externalChannelId: TEST_CHANNEL,
      externalMessageId: `ext-t3-${randomUUID()}`,
      authorExternalId: 'human-tester',
      authorName: 'Tester',
      authorIsBot: false,
      content: `<@${AGENT_B}> hello`,
      timestamp: new Date(),
      platform: 'discord',
      mentions: [AGENT_B],
    })
    // delivered may be false (no in-channel pushTarget) — the invariant
    // we're pinning is "B does NOT get a row".
    const counts = await client.query<{ agent_id: string; n: number }>(
      `SELECT agent_id, COUNT(*)::int AS n FROM message_queue WHERE agent_id = ANY($1) GROUP BY agent_id`,
      [[AGENT_A, AGENT_B, AGENT_C]],
    )
    const map = Object.fromEntries(counts.rows.map(r => [r.agent_id, r.n]))
    expect(map[AGENT_B] ?? 0).toBe(0)
  })

  test('T-4 bus.signal fans out to every committed receiver', async () => {
    await seedChannel([AGENT_A, AGENT_B, AGENT_C])
    const busSignals: string[] = []
    setupDeps(busSignals)
    const r = await handleInboundMessage({
      receiverAgentId: AGENT_A,
      externalChannelId: TEST_CHANNEL,
      externalMessageId: `ext-t4-${randomUUID()}`,
      authorExternalId: 'human-tester',
      authorName: 'Tester',
      authorIsBot: false,
      content: `<@${AGENT_B}> <@${AGENT_C}> hello`,
      timestamp: new Date(),
      platform: 'discord',
      mentions: [AGENT_B, AGENT_C],
    })
    expect(r.delivered).toBe(true)
    expect(busSignals).toContain(`bot_${AGENT_B}`)
    expect(busSignals).toContain(`bot_${AGENT_C}`)
  })
})
