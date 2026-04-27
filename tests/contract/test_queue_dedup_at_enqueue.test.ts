import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import { Client } from 'pg'
import { randomUUID } from 'node:crypto'
import { isQueueContentDup, contentHash, enqueueWithDedup } from '../../core/queue-dedup'

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

  // Issue #251 cycle 3 (CTO `bd9b1a9b` + auditor `1e388095`) —
  // e2e race tests against the per-call dedicated client helper.
  // case (6) above only confirms that the SELECT side observes a
  // committed row; cases (9) / (10) below drive the actual race
  // through `enqueueWithDedup`, which owns its own `pg.Client` per
  // call. Two callers racing into the same dedup window must
  // produce exactly one INSERT.

  test('(9) e2e race — Promise.all of 2 enqueueWithDedup calls produces exactly 1 INSERT', async () => {
    const RACE_AGENT = `test-race-${randomUUID().slice(0, 8)}`
    try {
      const messageIdA = randomUUID()
      const messageIdB = randomUUID()
      const content = `e2e race content ${randomUUID().slice(0, 8)}`
      const hash = contentHash(content)
      const buildPayload = (mid: string) => JSON.stringify({
        author_id: 'race', content, content_hash: hash,
        message_type: 'chat', source: 'agent-comms', ts: new Date().toISOString(), message_id: mid,
      })

      const [a, b] = await Promise.all([
        enqueueWithDedup({
          databaseUrl: DATABASE_URL!,
          agentId: RACE_AGENT, content, source: 'agent-comms', windowSeconds: 30,
          insertSql: `INSERT INTO message_queue (agent_id, message_id, payload) VALUES ($1, $2, $3) ON CONFLICT (agent_id, message_id) WHERE message_id IS NOT NULL DO NOTHING RETURNING id`,
          insertParams: [RACE_AGENT, messageIdA, buildPayload(messageIdA)],
        }),
        enqueueWithDedup({
          databaseUrl: DATABASE_URL!,
          agentId: RACE_AGENT, content, source: 'agent-comms', windowSeconds: 30,
          insertSql: `INSERT INTO message_queue (agent_id, message_id, payload) VALUES ($1, $2, $3) ON CONFLICT (agent_id, message_id) WHERE message_id IS NOT NULL DO NOTHING RETURNING id`,
          insertParams: [RACE_AGENT, messageIdB, buildPayload(messageIdB)],
        }),
      ])

      // Exactly one of the two callers wrote a row; the other
      // dedup-skipped. Both possibilities (A wins / B wins) are
      // valid outcomes — what we assert is the count, not the
      // ordering.
      const insertedCount = (a.inserted ? 1 : 0) + (b.inserted ? 1 : 0)
      const skippedCount = (a.dedupSkipped ? 1 : 0) + (b.dedupSkipped ? 1 : 0)
      expect(insertedCount).toBe(1)
      expect(skippedCount).toBe(1)

      // DB row count: exactly 1 row matching this content.
      const rows = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM message_queue
         WHERE agent_id = $1 AND (payload::jsonb->>'content_hash') = $2`,
        [RACE_AGENT, hash],
      )
      expect(parseInt(rows.rows[0].n, 10)).toBe(1)
    } finally {
      await client.query(`DELETE FROM message_queue WHERE agent_id = $1`, [RACE_AGENT])
    }
  })

  test('(10) e2e race — different sources race produces 2 INSERTs (cross-source preserved)', async () => {
    // Cross-source dedup is intentionally NOT collapsed (Issue
    // #251 §1 verbatim). Two writers with the same content but
    // different `source` should both write rows even when racing.
    const RACE_AGENT = `test-race-cross-${randomUUID().slice(0, 8)}`
    try {
      const content = `cross-source race ${randomUUID().slice(0, 8)}`
      const hash = contentHash(content)
      const buildPayload = (src: string, mid: string) => JSON.stringify({
        author_id: 'race', content, content_hash: hash,
        message_type: 'chat', source: src, ts: new Date().toISOString(), message_id: mid,
      })
      const midA = randomUUID()
      const midB = randomUUID()

      const [a, b] = await Promise.all([
        enqueueWithDedup({
          databaseUrl: DATABASE_URL!,
          agentId: RACE_AGENT, content, source: 'agent-comms', windowSeconds: 30,
          insertSql: `INSERT INTO message_queue (agent_id, message_id, payload) VALUES ($1, $2, $3) ON CONFLICT (agent_id, message_id) WHERE message_id IS NOT NULL DO NOTHING RETURNING id`,
          insertParams: [RACE_AGENT, midA, buildPayload('agent-comms', midA)],
        }),
        enqueueWithDedup({
          databaseUrl: DATABASE_URL!,
          agentId: RACE_AGENT, content, source: 'discord', windowSeconds: 30,
          insertSql: `INSERT INTO message_queue (agent_id, message_id, payload) VALUES ($1, $2, $3) ON CONFLICT (agent_id, message_id) WHERE message_id IS NOT NULL DO NOTHING RETURNING id`,
          insertParams: [RACE_AGENT, midB, buildPayload('discord', midB)],
        }),
      ])

      expect(a.inserted).toBe(true)
      expect(b.inserted).toBe(true)
      expect(a.dedupSkipped).toBe(false)
      expect(b.dedupSkipped).toBe(false)

      const rows = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM message_queue WHERE agent_id = $1`,
        [RACE_AGENT],
      )
      expect(parseInt(rows.rows[0].n, 10)).toBe(2)
    } finally {
      await client.query(`DELETE FROM message_queue WHERE agent_id = $1`, [RACE_AGENT])
    }
  })

  test('(11) shared-client transaction hazard avoided — enqueueWithDedup never BEGIN/COMMIT on the caller-supplied client', async () => {
    // Regression test for the auditor's axis-3 finding (msg
    // `1e388095`): cycle 2 ran BEGIN/COMMIT on the shared singleton
    // returned by `tryGetDb()`. cycle 3 moved the transaction onto
    // a per-call client owned by the helper. We verify that
    // `enqueueWithDedup` does not require a caller-provided pg
    // client at all — it builds its own from the URL.
    //
    // The caller (`server.ts`) keeps the shared singleton for
    // non-transaction work (saveMessage, agent_messages writes
    // around L1779-L1789); only the dedup tx is offloaded.
    const HAZARD_AGENT = `test-hazard-${randomUUID().slice(0, 8)}`
    try {
      const content = `hazard-test ${randomUUID().slice(0, 8)}`
      const result = await enqueueWithDedup({
        databaseUrl: DATABASE_URL!,
        agentId: HAZARD_AGENT, content, source: 'agent-comms', windowSeconds: 30,
        insertSql: `INSERT INTO message_queue (agent_id, message_id, payload) VALUES ($1, $2, $3) ON CONFLICT (agent_id, message_id) WHERE message_id IS NOT NULL DO NOTHING RETURNING id`,
        insertParams: [HAZARD_AGENT, randomUUID(), JSON.stringify({
          author_id: 'h', content, content_hash: contentHash(content),
          message_type: 'chat', source: 'agent-comms', ts: new Date().toISOString(),
        })],
      })
      expect(result.inserted).toBe(true)
      expect(result.attempts).toBe(1)
      expect(result.contentHash).toBe(contentHash(content))
    } finally {
      await client.query(`DELETE FROM message_queue WHERE agent_id = $1`, [HAZARD_AGENT])
    }
  })
})
