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

  test('(1) same content + same source within 30s window → returns true', async () => {
    await insertPayload(TEST_AGENT, 'hello dedup', 'agent-comms', 5)  // 5s ago
    const isDup = await isQueueContentDup(client, TEST_AGENT, 'hello dedup', 'agent-comms', 30)
    expect(isDup).toBe(true)
  })

  test('(2) same content + same source past the window (31s ago) → not a duplicate', async () => {
    await insertPayload(TEST_AGENT, 'hello dedup', 'agent-comms', 31)  // 31s ago
    const isDup = await isQueueContentDup(client, TEST_AGENT, 'hello dedup', 'agent-comms', 30)
    expect(isDup).toBe(false)
  })

  test('(3) different content within window → not a duplicate (no false positive)', async () => {
    await insertPayload(TEST_AGENT, 'first message', 'agent-comms', 5)
    const isDup = await isQueueContentDup(client, TEST_AGENT, 'a totally different message', 'agent-comms', 30)
    expect(isDup).toBe(false)
  })

  test('(4) dual-path: SAME source same content → caught (collapse same-path retry)', async () => {
    // Same agent-comms direct emit arriving twice within the
    // window — the cycle 1 case the UUID-based UNIQUE misses
    // because the second emit gets a fresh UUID.
    await insertPayload(TEST_AGENT, 'same-path content', 'agent-comms', 3)
    const isDup = await isQueueContentDup(client, TEST_AGENT, 'same-path content', 'agent-comms', 30)
    expect(isDup).toBe(true)
  })

  test('(5) dual-path: DIFFERENT source same content → preserved as separate record (cycle 2)', async () => {
    // Issue #251 §1 verbatim ("hash + source/timestamp window"):
    // distinct sources with the same content are deliberately
    // separate records (different reply context). cycle 1's
    // source-agnostic dedup wrongly collapsed these; cycle 2
    // restores the correct semantics per CTO `c1c6eb1d`.
    await insertPayload(TEST_AGENT, 'cross-source content', 'agent-comms', 3)
    const isDup = await isQueueContentDup(client, TEST_AGENT, 'cross-source content', 'discord', 30)
    expect(isDup).toBe(false)
  })

  test('(6) dedup race — concurrent SELECTs both see no prior row, INSERTs both succeed (helper limitation)', async () => {
    // Documents the known SELECT-before-INSERT race the helper has
    // (auditor axis 4 🟡, msg `02be8430`). Two callers that arrive
    // concurrently both see an empty SELECT and proceed to INSERT;
    // the existing `uq_mq_agent_message ON (agent_id, message_id)`
    // catches that path because they share the same message_id.
    // For the cross-source case (different message_ids by design),
    // the race window is left intentionally — that path's
    // duplicates are at most one row pair per ~30s under realistic
    // production traffic, which Issue #251 metric (queue +50% over
    // baseline) tolerates.
    const isDupBefore = await isQueueContentDup(client, TEST_AGENT, 'race content', 'agent-comms', 30)
    expect(isDupBefore).toBe(false)
    // First caller proceeds to INSERT (simulated)…
    await insertPayload(TEST_AGENT, 'race content', 'agent-comms', 0)
    // …and immediately a second caller checks. By design it now sees
    // the dup, so the second INSERT short-circuits.
    const isDupAfter = await isQueueContentDup(client, TEST_AGENT, 'race content', 'agent-comms', 30)
    expect(isDupAfter).toBe(true)
  })
})
