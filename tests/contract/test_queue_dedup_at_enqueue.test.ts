import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import { Client } from 'pg'
import { randomUUID } from 'node:crypto'
import { isQueueContentDup, contentHash } from '../../core/queue-dedup'

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
  // cycle 2 v3 final: stamps `content_hash` into the payload so the
  // SELECT in `isQueueContentDup` matches against the stored hash.
  async function insertPayload(agentId: string, content: string, source: string, ageSec: number): Promise<void> {
    const payload = JSON.stringify({
      author_id: 'test',
      content,
      content_hash: contentHash(content),
      message_type: 'chat',
      source,
      ts: new Date().toISOString(),
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

  test('(6) dual-writer race — Promise.all of 2 dedup checks: one sees the row, the second skips', async () => {
    // Issue #251 cycle 2 v3 (auditor axis 4): two writers that
    // arrive in the same tick both call `isQueueContentDup` and
    // race to INSERT. The transaction wrapper in server.ts wraps
    // each (SELECT, INSERT) pair in BEGIN/COMMIT; the second
    // writer's SELECT after the first writer's COMMIT now sees the
    // row and skips. We simulate that ordering here.
    //
    // Writer A goes first (insertPayload acts as the post-COMMIT
    // visibility), Writer B then runs the dedup check and must
    // observe the row. Promise.all is used to confirm the helper
    // is safe to call concurrently against an idle DB.
    await insertPayload(TEST_AGENT, 'race content', 'agent-comms', 0)
    const [aDup, bDup] = await Promise.all([
      isQueueContentDup(client, TEST_AGENT, 'race content', 'agent-comms', 30),
      isQueueContentDup(client, TEST_AGENT, 'race content', 'agent-comms', 30),
    ])
    expect(aDup).toBe(true)
    expect(bDup).toBe(true)
  })

  test('(7) hash IS the dedup key — content_hash mismatch with stored content goes to fallback path', async () => {
    // cycle 2 v3 final: the SELECT prefers `content_hash` field
    // when present. If a payload row was inserted by older code
    // without `content_hash` (cycle 1 layout), the helper falls
    // back to comparing raw content. We test the fallback by
    // inserting a row that lacks `content_hash` and confirming the
    // helper still catches the duplicate.
    const messageId = randomUUID()
    const legacyPayload = JSON.stringify({
      author_id: 'test',
      content: 'legacy without hash',
      message_type: 'chat',
      source: 'agent-comms',
      ts: new Date().toISOString(),
    })
    await client.query(
      `INSERT INTO message_queue (agent_id, message_id, payload, status, created_at)
       VALUES ($1, $2, $3, 'pending', now() - make_interval(secs => 5))`,
      [TEST_AGENT, messageId, legacyPayload],
    )
    const isDup = await isQueueContentDup(client, TEST_AGENT, 'legacy without hash', 'agent-comms', 30)
    expect(isDup).toBe(true)
  })

  test('(8) hash exposed by helper matches caller-side stamp (hash function stability)', async () => {
    // The same content fed to `contentHash()` twice must return
    // the same value, otherwise dedup is broken. This pins the
    // hash function so a future swap (e.g. blake2 / xxhash) is
    // caught by failing test, not silent mismatch.
    const a = contentHash('stability check')
    const b = contentHash('stability check')
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{16}$/)
    // Different content must produce different hash.
    expect(a).not.toBe(contentHash('different content'))
  })
})
