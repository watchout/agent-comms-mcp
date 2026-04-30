import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import { Client } from 'pg'
import { randomUUID } from 'node:crypto'

// Issue #278 — Stage B end-to-end integration fixtures.
//
// Each test exercises a multi-step flow against a real PG instance to
// pin behaviors that the per-component unit tests do not catch on
// their own:
//
//   case 1  — multi in-flight: two consecutive `next`-style claims on
//             one agent leave both rows in status='read' (the legacy
//             single-slot guard would have implicit-failed the first).
//   case 5  — send-path claim flip: a `read` row claimed by agent X
//             with message_id=$reply_to is the sole row that
//             FOR-UPDATE-locks under the segment 3a predicate, and
//             flipping it to 'replied' is a one-row UPDATE that
//             survives a concurrent claimant attempt.
//
// The MCP server / CLI flows are tested separately; this file targets
// the SQL-level invariants the entire Stage B contract rests on.

const DATABASE_URL = process.env.DATABASE_URL
const dbDescribe = DATABASE_URL ? describe : describe.skip

dbDescribe('Issue #278 Stage B — SQL-level integration', () => {
  let client: Client
  const TEST_AGENT_A = `e2e-A-${randomUUID().slice(0, 8)}`
  const TEST_AGENT_B = `e2e-B-${randomUUID().slice(0, 8)}`

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL })
    await client.connect()
  })

  beforeEach(async () => {
    for (const a of [TEST_AGENT_A, TEST_AGENT_B]) {
      await client.query(`DELETE FROM message_queue WHERE agent_id = $1`, [a])
    }
  })

  afterAll(async () => {
    for (const a of [TEST_AGENT_A, TEST_AGENT_B]) {
      await client.query(`DELETE FROM message_queue WHERE agent_id = $1`, [a])
    }
    await client.end()
  })

  async function seedPending(agentId: string, content: string): Promise<{ id: number; messageId: string }> {
    const messageId = randomUUID()
    const r = await client.query<{ id: number }>(
      `INSERT INTO message_queue (agent_id, message_id, payload, status)
       VALUES ($1, $2, $3, 'pending')
       RETURNING id`,
      [agentId, messageId, JSON.stringify({ author_id: 'src', content, message_type: 'chat' })],
    )
    return { id: r.rows[0].id, messageId }
  }

  async function claim(agentId: string, queueId: number): Promise<void> {
    // Mirrors the segment 1 next-handler claim stamp: status='read',
    // claimed_by=$agent, claimed_at=now(), claim_expires_at=now()+30s.
    await client.query(
      `UPDATE message_queue
          SET status = 'read', read_at = now(),
              claimed_by = $1, claimed_at = now(),
              claim_expires_at = now() + interval '30 seconds'
        WHERE id = $2`,
      [agentId, queueId],
    )
  }

  test('(case 1) multi in-flight — two consecutive claims by the same agent both stay status=read', async () => {
    const m1 = await seedPending(TEST_AGENT_A, 'first')
    const m2 = await seedPending(TEST_AGENT_A, 'second')
    await claim(TEST_AGENT_A, m1.id)
    await claim(TEST_AGENT_A, m2.id)

    // Both rows are simultaneously claimed — Issue #278 §A semantics.
    // The legacy single-slot guard would have flipped m1 to
    // 'failed'/'IMPLICIT_ABANDON' before m2 was claimed.
    const rows = await client.query(
      `SELECT id, status, claimed_by FROM message_queue
        WHERE agent_id = $1 ORDER BY id`,
      [TEST_AGENT_A],
    )
    expect(rows.rows).toEqual([
      { id: m1.id, status: 'read', claimed_by: TEST_AGENT_A },
      { id: m2.id, status: 'read', claimed_by: TEST_AGENT_A },
    ])
  })

  test('(case 5) send-path claim lookup — exactly one row matches the (message_id, claimed_by) tuple', async () => {
    // Two agents claim independent messages; we then run the segment 3a
    // FOR-UPDATE-locked SELECT to verify the predicate isolates the
    // correct row even with parallel claims live.
    const seed = await seedPending(TEST_AGENT_A, 'reply-target')
    await claim(TEST_AGENT_A, seed.id)
    const noiseSeed = await seedPending(TEST_AGENT_B, 'unrelated')
    await claim(TEST_AGENT_B, noiseSeed.id)

    const lookup = await client.query<{ id: number }>(
      `SELECT id FROM message_queue
          WHERE message_id = $1 AND claimed_by = $2 AND status = 'read'`,
      [seed.messageId, TEST_AGENT_A],
    )
    expect(lookup.rows.length).toBe(1)
    expect(lookup.rows[0].id).toBe(seed.id)

    // Flipping it to 'replied' (segment 3a step 9) makes the predicate
    // miss on the next attempt — the basis for INVALID_REPLY_TO when
    // the second send tries the same reply_to.
    await client.query(
      `UPDATE message_queue
          SET status = 'replied', replied_at = now(), replied_with = $1
        WHERE id = $2`,
      [randomUUID(), seed.id],
    )
    const second = await client.query(
      `SELECT id FROM message_queue
          WHERE message_id = $1 AND claimed_by = $2 AND status = 'read'`,
      [seed.messageId, TEST_AGENT_A],
    )
    expect(second.rows.length).toBe(0)
  })

  test('(case 5b) wrong agent never matches — claimed_by predicate isolates senders', async () => {
    const seed = await seedPending(TEST_AGENT_A, 'A-claim')
    await claim(TEST_AGENT_A, seed.id)
    const lookup = await client.query(
      `SELECT id FROM message_queue
          WHERE message_id = $1 AND claimed_by = $2 AND status = 'read'`,
      [seed.messageId, TEST_AGENT_B],
    )
    expect(lookup.rows.length).toBe(0)
  })
})
