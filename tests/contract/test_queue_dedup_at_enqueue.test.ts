import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import { Client } from 'pg'
import { randomUUID } from 'node:crypto'
import { isQueueContentDup } from '../../core/queue-dedup'

// Issue #251 (a) — content-level dedup at enqueue.
//
// Reproduces the dual-path duplicate observed in production
// (2026-04-27 psql query, 9+ pairs in agent-com-dev pending alone):
// the same content arrives via the Discord adapter inbound path AND
// via direct send, each generating a fresh UUID, so the existing
// `uq_mq_agent_message ON (agent_id, message_id)` UNIQUE constraint
// doesn't catch it. `isQueueContentDup` checks the stored payload's
// `content` field within a configurable time window (default 30s,
// per lead-ama dispatch v2 anchor) and returns true when a duplicate
// is already queued, so the second-arriving path can short-circuit
// the INSERT.
//
// Usage (local):
//   DATABASE_URL=postgresql://yuji@localhost/agent_comms \
//     bun test tests/contract/test_queue_dedup_at_enqueue.test.ts

const DATABASE_URL = process.env.DATABASE_URL
const dbDescribe = DATABASE_URL ? describe : describe.skip

dbDescribe('test_queue_dedup_at_enqueue — content-level dedup catches dual-path duplicates', () => {
  let client: Client
  const TEST_AGENT = `test-dedup-${randomUUID().slice(0, 8)}`

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL })
    await client.connect()
  })

  beforeEach(async () => {
    // Wipe any leftover rows from a prior run / failed test.
    await client.query(`DELETE FROM message_queue WHERE agent_id = $1`, [TEST_AGENT])
  })

  afterAll(async () => {
    await client.query(`DELETE FROM message_queue WHERE agent_id = $1`, [TEST_AGENT])
    await client.end()
  })

  // Helper: insert a payload row with a chosen `created_at` so we can
  // exercise window boundaries deterministically without sleeping.
  async function insertPayload(agentId: string, content: string, source: string, ageSec: number): Promise<void> {
    const payload = JSON.stringify({
      author_id: 'test', content, message_type: 'chat', source, ts: new Date().toISOString(),
    })
    const messageId = randomUUID()
    await client.query(
      `INSERT INTO message_queue (agent_id, message_id, payload, status, created_at)
       VALUES ($1, $2, $3, 'pending', now() - make_interval(secs => $4))`,
      [agentId, messageId, payload, ageSec],
    )
  }

  test('(1) same content within 30s window → isQueueContentDup returns true', async () => {
    await insertPayload(TEST_AGENT, 'hello dedup', 'agent-comms', 5)  // 5s ago
    const isDup = await isQueueContentDup(client, TEST_AGENT, 'hello dedup', 30)
    expect(isDup).toBe(true)
  })

  test('(2) same content but past the window (31s ago, window=30s) → not a duplicate', async () => {
    await insertPayload(TEST_AGENT, 'hello dedup', 'agent-comms', 31)  // 31s ago
    const isDup = await isQueueContentDup(client, TEST_AGENT, 'hello dedup', 30)
    expect(isDup).toBe(false)
  })

  test('(3) different content within window → not a duplicate (no false positive)', async () => {
    await insertPayload(TEST_AGENT, 'first message', 'agent-comms', 5)
    const isDup = await isQueueContentDup(client, TEST_AGENT, 'a totally different message', 30)
    expect(isDup).toBe(false)
  })

  test('(4) dual-path duplicate (different source, same content) is caught', async () => {
    // Path A: agent-comms direct send arrives first.
    await insertPayload(TEST_AGENT, 'dual-path content', 'agent-comms', 3)
    // Path B: Discord adapter delivers the same content ~3s later.
    // The dedup is source-agnostic on purpose — exactly this case is
    // what the existing UUID-based UNIQUE misses.
    const isDup = await isQueueContentDup(client, TEST_AGENT, 'dual-path content', 30)
    expect(isDup).toBe(true)
  })
})
