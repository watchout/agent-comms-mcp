#!/usr/bin/env bun
/**
 * Bug 2 root fix — outbound writeback to agent_messages.discord_message_id.
 *
 * Dispatch refs:
 *   - CEO approval: msg c40b8dc9 (進めて)
 *   - lead-ama dispatch: msg 40829fa4
 *   - root cause investigation: msgs 9997112b…31cf031e
 *
 * Bug shape (pre-fix):
 *   1. server.ts INSERT path A (outbound, line 604) intentionally omits
 *      discord_message_id (the snowflake is unknown at agent_messages
 *      INSERT time — the row exists in DB before the consumer ever
 *      contacts Discord).
 *   2. outbound-consumer.ts mark-sent path wrote the returned snowflake
 *      ONLY to outbound_queue.discord_message_id, never back to
 *      agent_messages.
 *   3. When a human later replied to the bot's Discord message,
 *      adapters/inbound-receiver.ts:497-513 does a 2-step lookup on
 *      agent_messages.discord_message_id (column then metadata).
 *      Both missed → orphan branch → reply_to stored as NULL →
 *      core/reply-chain.ts CTE returned only the seed row.
 *
 * Fix: wrap the existing outbound_queue UPDATE and a new
 * agent_messages UPDATE in BEGIN / COMMIT, so the bot's row in
 * agent_messages carries the snowflake the moment the post lands.
 *
 * These four tests exercise the REAL outbound consumer
 * (`consumeOneOutboundRow`) with a mocked DiscordAdapter swapped into
 * `discordClients`. No fixture pre-populates
 * agent_messages.discord_message_id; every assertion follows from the
 * consumer running end-to-end against a real Postgres.
 *
 * Skipped automatically when DATABASE_URL is unreachable.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { Client } from 'pg'
import { randomUUID } from 'crypto'
import {
  consumeOneOutboundRow,
  setDbGetter,
} from '../../adapters/outbound-consumer'
import { discordClients } from '../../adapters/discord-client'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost/agent_comms'
const TEST_AGENT = `test-bug2-writeback-${process.pid}`
const TEST_CHANNEL_EXTERNAL = `test-bug2-channel-${process.pid}`

let client: Client | null = null
let available = false
let testChannelUuid: string | null = null

// ──────────────────────────────────────────────────────────────────────
// Mock DiscordAdapter — programmable per-test response.
// Mirrors the real adapter's shape: `sendAdapterMessage` returns
// `{ external_message_id }`. Tests set `mockResponse` (resolved id) or
// `mockError` (thrown error) before invoking consumeOneOutboundRow().
// ──────────────────────────────────────────────────────────────────────
let mockResponse: string | null = null
let mockError: unknown = null
let mockCallCount = 0

const mockAdapter: any = {
  async sendAdapterMessage(_params: any) {
    mockCallCount++
    if (mockError) throw mockError
    return { external_message_id: mockResponse }
  },
}

beforeAll(async () => {
  try {
    client = new Client({ connectionString: DATABASE_URL })
    await client.connect()
    const { rows } = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'agent_messages'
          AND column_name = 'discord_message_id'`,
    )
    available = rows.length === 1

    if (available) {
      // Reuse a real channel row to satisfy any FK on agent_messages.channel_id.
      // We pick the most recent registered channel; if none, create one.
      const ch = await client.query(
        `SELECT id FROM channels ORDER BY created_at DESC NULLS LAST LIMIT 1`,
      )
      if (ch.rows.length > 0) {
        testChannelUuid = ch.rows[0].id
      } else {
        const newChan = await client.query(
          `INSERT INTO channels (id, channel_name, created_at)
           VALUES ($1, $2, now())
           RETURNING id`,
          [randomUUID(), `bug2-test-channel-${process.pid}`],
        ).catch(() => null)
        testChannelUuid = newChan?.rows[0]?.id ?? null
      }

      await cleanFixtures()
    }
  } catch {
    available = false
  }

  // Inject the DB getter + agent id used by consumeOneOutboundRow.
  setDbGetter(async () => client as any, TEST_AGENT)
  // Inject the mock Discord adapter for this agent id.
  discordClients.set(TEST_AGENT, mockAdapter)
})

afterAll(async () => {
  if (client && available) {
    try {
      await cleanFixtures()
    } catch { /* ignore */ }
    try { await client.end() } catch { /* ignore */ }
  }
  discordClients.delete(TEST_AGENT)
})

beforeEach(() => {
  mockResponse = null
  mockError = null
  mockCallCount = 0
})

async function cleanFixtures(): Promise<void> {
  if (!client) return
  await client.query(`DELETE FROM outbound_queue WHERE agent_id = $1`, [TEST_AGENT])
  await client.query(
    `DELETE FROM agent_messages
       WHERE author_id IN ($1, 'human-replier-bug2')
          OR content LIKE 'bug2-fixture-%'
          OR discord_message_id LIKE 'bug2-snowflake-%'`,
    [TEST_AGENT],
  )
}

/** Insert a fresh outbound agent_messages row + its outbound_queue partner. */
async function seedOutboundPair(opts: { content: string; channelExternal?: string }) {
  if (!client || !testChannelUuid) throw new Error('test setup failed')
  const messageUuid = randomUUID()
  await client.query(
    `INSERT INTO agent_messages
       (id, channel_id, author_id, content, message_type, direction, source, role, created_at)
     VALUES ($1, $2, $3, $4, 'chat', 'outbound', 'agent-comms', 'agent', now())`,
    [messageUuid, testChannelUuid, TEST_AGENT, opts.content],
  )
  const q = await client.query(
    `INSERT INTO outbound_queue
       (message_id, agent_id, channel_external_id, content,
        status, attempts, max_attempts)
     VALUES ($1, $2, $3, $4, 'pending', 0, 5)
     RETURNING id`,
    [messageUuid, TEST_AGENT, opts.channelExternal ?? TEST_CHANNEL_EXTERNAL, opts.content],
  )
  return { messageUuid, queueId: q.rows[0].id as number | string }
}

describe('Bug 2 root fix — outbound writeback to agent_messages.discord_message_id', () => {
  test('(a) E2E: consumer success writes discord_message_id back to agent_messages', async () => {
    if (!available) {
      console.warn('[bug2 (a)] skipping — DATABASE_URL unreachable or schema missing')
      return
    }

    const snowflake = `bug2-snowflake-a-${Date.now()}`
    mockResponse = snowflake

    const { messageUuid, queueId } = await seedOutboundPair({ content: 'bug2-fixture-a' })
    await consumeOneOutboundRow()

    // Adapter was called exactly once.
    expect(mockCallCount).toBe(1)

    // outbound_queue row marked sent + carries the snowflake (existing
    // PR #168 contract).
    const oq = await client!.query(
      `SELECT status, discord_message_id FROM outbound_queue WHERE id = $1`,
      [queueId],
    )
    expect(oq.rows[0].status).toBe('sent')
    expect(oq.rows[0].discord_message_id).toBe(snowflake)

    // The bug-2 contract: agent_messages.discord_message_id MUST now
    // carry the same snowflake. Pre-fix this assertion fails (NULL).
    const am = await client!.query(
      `SELECT discord_message_id FROM agent_messages WHERE id = $1`,
      [messageUuid],
    )
    expect(am.rows.length).toBe(1)
    expect(am.rows[0].discord_message_id).toBe(snowflake)
  })

  test('(b) chain resolution: inbound reply finds parent + reply_chain CTE returns 2 rows', async () => {
    if (!available) return

    const snowflake = `bug2-snowflake-b-${Date.now()}`
    mockResponse = snowflake
    const { messageUuid: parentUuid } = await seedOutboundPair({ content: 'bug2-fixture-b-parent' })
    await consumeOneOutboundRow()

    // Step 1: simulate the lookup adapters/inbound-receiver.ts:497-501
    // performs when an inbound message arrives carrying
    // reply_to_discord_id = <returned_id>. Pre-fix this returns 0 rows
    // (the column was never populated). Post-fix it must return the
    // parent's UUID + author.
    const lookup = await client!.query(
      `SELECT id, author_id FROM agent_messages
        WHERE discord_message_id = $1
        LIMIT 1`,
      [snowflake],
    )
    expect(lookup.rows.length).toBe(1)
    expect(lookup.rows[0].id).toBe(parentUuid)
    expect(lookup.rows[0].author_id).toBe(TEST_AGENT)

    // Step 2: insert the child reply row with reply_to set to the
    // resolved parent UUID (this is what inbound-receiver does once
    // the lookup hits).
    const childUuid = randomUUID()
    await client!.query(
      `INSERT INTO agent_messages
         (id, channel_id, author_id, content, message_type, direction,
          source, role, reply_to, created_at)
       VALUES ($1, $2, 'human-replier-bug2', 'bug2-fixture-b-child',
               'chat', 'inbound', 'agent-comms', 'human', $3, now())`,
      [childUuid, testChannelUuid, parentUuid],
    )

    // Step 3: drive the same recursive CTE core/reply-chain.ts uses.
    // 2 rows = parent + child = chain successfully reconstructed.
    const chain = await client!.query(
      `WITH RECURSIVE chain(id, channel_id, author_id, content, reply_to, created_at, depth) AS (
         SELECT id, channel_id, author_id, content, reply_to, created_at, 0
         FROM agent_messages WHERE id = $1
         UNION ALL
         SELECT m.id, m.channel_id, m.author_id, m.content, m.reply_to, m.created_at, c.depth + 1
         FROM agent_messages m JOIN chain c ON m.id = c.reply_to
         WHERE c.depth + 1 < $2
       )
       SELECT id, reply_to, depth FROM chain ORDER BY created_at ASC`,
      [childUuid, 10],
    )
    expect(chain.rows.length).toBe(2)
    // Ordering by created_at ASC: parent first (older), child second.
    expect(chain.rows[0].id).toBe(parentUuid)
    expect(chain.rows[1].id).toBe(childUuid)
    expect(chain.rows[1].reply_to).toBe(parentUuid)
  })

  test('(c) idempotent: a no-op replay does not overwrite agent_messages.discord_message_id', async () => {
    if (!available) return

    const snowflake1 = `bug2-snowflake-c-${Date.now()}`
    mockResponse = snowflake1
    const { messageUuid, queueId } = await seedOutboundPair({ content: 'bug2-fixture-c' })
    await consumeOneOutboundRow()

    // First run — column populated.
    const am1 = await client!.query(
      `SELECT discord_message_id FROM agent_messages WHERE id = $1`,
      [messageUuid],
    )
    expect(am1.rows[0].discord_message_id).toBe(snowflake1)

    // Manually re-claim the same outbound row (consumer's claim path
    // would otherwise skip this row because it is now 'sent'). Reset
    // status to 'pending' and run the consumer again, but with a
    // DIFFERENT mock response. The agent_messages row already holds
    // snowflake1, and the WHERE … AND discord_message_id IS NULL guard
    // must keep it that way.
    await client!.query(
      `UPDATE outbound_queue
         SET status = 'pending', sent_at = NULL,
             discord_message_id = NULL
       WHERE id = $1`,
      [queueId],
    )
    const snowflake2 = `bug2-snowflake-c-RESET-${Date.now()}`
    mockResponse = snowflake2
    await consumeOneOutboundRow()

    const am2 = await client!.query(
      `SELECT discord_message_id FROM agent_messages WHERE id = $1`,
      [messageUuid],
    )
    // The original snowflake survives — idempotency clause did its job.
    expect(am2.rows[0].discord_message_id).toBe(snowflake1)
  })

  test('(d) transaction failure: UNIQUE violation rolls back, no half-write', async () => {
    if (!available) return

    // Pre-seed an UNRELATED agent_messages row holding the snowflake we
    // are about to "receive" from Discord. The outbound row's writeback
    // will collide with the partial unique index on
    // agent_messages.discord_message_id and the transaction must
    // ROLLBACK (both UPDATEs undone).
    const collidingSnowflake = `bug2-snowflake-d-${Date.now()}`
    const collidingUuid = randomUUID()
    await client!.query(
      `INSERT INTO agent_messages
         (id, channel_id, author_id, content, message_type, direction,
          source, role, discord_message_id, created_at)
       VALUES ($1, $2, 'unrelated-author', 'bug2-fixture-d-pre',
               'chat', 'inbound', 'agent-comms', 'agent', $3, now())`,
      [collidingUuid, testChannelUuid, collidingSnowflake],
    )

    mockResponse = collidingSnowflake
    const { messageUuid, queueId } = await seedOutboundPair({ content: 'bug2-fixture-d' })
    await consumeOneOutboundRow()

    // Post-rollback expectations:
    //   - outbound_queue row stays in a not-sent state. Because the
    //     atomic claim already flipped status to 'claimed' and the
    //     mark-sent UPDATE was rolled back, the row is left at
    //     'claimed' (orphan reclaim will return it to 'pending' after
    //     OUTBOUND_ORPHAN_TIMEOUT_SEC for retry).
    const oq = await client!.query(
      `SELECT status, discord_message_id, sent_at FROM outbound_queue WHERE id = $1`,
      [queueId],
    )
    expect(oq.rows[0].status).not.toBe('sent')
    expect(oq.rows[0].discord_message_id).toBeNull()
    expect(oq.rows[0].sent_at).toBeNull()

    //   - The original agent_messages row stays untouched: its
    //     discord_message_id is still NULL because the UPDATE was
    //     rolled back.
    const am = await client!.query(
      `SELECT discord_message_id FROM agent_messages WHERE id = $1`,
      [messageUuid],
    )
    expect(am.rows[0].discord_message_id).toBeNull()

    // Cleanup the colliding row so afterAll cleanup is straightforward.
    await client!.query(`DELETE FROM agent_messages WHERE id = $1`, [collidingUuid])
  })
})
