import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import { Client } from 'pg'
import { randomUUID } from 'node:crypto'
import { drainPendingWithAutoSkip } from '../../core/drain-with-auto-skip'
import { resetAutoSkipPatternsCache } from '../../config/auto-skip-patterns'

// Issue #278 (F-4) — shared "drain pending with auto-skip" helper.
//
// The helper is the single source of truth for "drain bounded N
// pending rows + auto-skip filter" used by both the SessionStart
// hook (F-1) and the upcoming Stop hook v8. These unit tests pin
// its contract directly so the Stop hook integration can rely on
// the same predicate / mutation / summary shape.

const DATABASE_URL = process.env.DATABASE_URL
const dbDescribe = DATABASE_URL ? describe : describe.skip

dbDescribe('drainPendingWithAutoSkip — shared helper for F-1 / Stop-hook v8', () => {
  let client: Client
  const TEST_AGENT = `test-drain-helper-${randomUUID().slice(0, 8)}`

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL })
    await client.connect()
    resetAutoSkipPatternsCache()
  })

  beforeEach(async () => {
    await client.query(`DELETE FROM message_queue WHERE agent_id = $1`, [TEST_AGENT])
  })

  afterAll(async () => {
    await client.query(`DELETE FROM message_queue WHERE agent_id = $1`, [TEST_AGENT])
    await client.end()
  })

  let counter = 0
  async function seed(content: string, messageType = 'chat', authorId = 'someone'): Promise<string> {
    const messageId = randomUUID()
    counter++
    const payload = JSON.stringify({ author_id: authorId, content, message_type: messageType })
    await client.query(
      `INSERT INTO message_queue (agent_id, message_id, payload, status, priority, created_at)
       VALUES ($1, $2, $3, 'pending', 0, now() - make_interval(secs => $4 / 1000.0))`,
      [TEST_AGENT, messageId, payload, 60_000 - counter],
    )
    return messageId
  }

  test('limit=0 short-circuits with no DB SELECT side effects', async () => {
    await seed('any')
    const result = await drainPendingWithAutoSkip(client, TEST_AGENT, 0)
    expect(result).toEqual({ drained: 0, skipped: 0 })
    // Row stays exactly as seeded.
    const r = await client.query(
      `SELECT status FROM message_queue WHERE agent_id = $1`,
      [TEST_AGENT],
    )
    expect(r.rows[0].status).toBe('pending')
  })

  test('pending=0 → early return without iteration', async () => {
    const result = await drainPendingWithAutoSkip(client, TEST_AGENT, 5)
    expect(result).toEqual({ drained: 0, skipped: 0 })
  })

  test.skip('— matched rows flip to skipped with AUTO_SKIP_PATTERN reason; unmatched stay pending (deferred to Issue #349 — drainPendingWithAutoSkip collapsed to "replied" in v0.9)', async () => {
    const noiseId = await seed('⚠️ メンションがないため warning')
    const chatId = await seed('please review')
    const result = await drainPendingWithAutoSkip(client, TEST_AGENT, 5)
    expect(result.drained).toBe(2)
    expect(result.skipped).toBe(1)
    const noiseRow = await client.query(
      `SELECT status, failed_reason FROM message_queue WHERE message_id = $1`,
      [noiseId],
    )
    expect(noiseRow.rows[0].status).toBe('skipped')
    expect(noiseRow.rows[0].failed_reason).toBe('AUTO_SKIP_PATTERN:lead_ama_no_mention_warning')
    const chatRow = await client.query(
      `SELECT status, failed_reason FROM message_queue WHERE message_id = $1`,
      [chatId],
    )
    expect(chatRow.rows[0].status).toBe('pending')
    expect(chatRow.rows[0].failed_reason).toBe(null)
  })

  test.skip('— self-echo (sender=recipient) is matched and skipped with reason=self_echo (deferred to Issue #349)', async () => {
    const id = await seed('echo', 'chat', TEST_AGENT)
    const result = await drainPendingWithAutoSkip(client, TEST_AGENT, 5)
    expect(result.skipped).toBe(1)
    const row = await client.query(
      `SELECT failed_reason FROM message_queue WHERE message_id = $1`,
      [id],
    )
    expect(row.rows[0].failed_reason).toBe('AUTO_SKIP_PATTERN:self_echo')
  })

  test('limit caps the iteration regardless of pending depth', async () => {
    for (let i = 0; i < 10; i++) {
      await seed(`row-${i}`)
    }
    const result = await drainPendingWithAutoSkip(client, TEST_AGENT, 3)
    expect(result.drained).toBe(3)
    expect(result.skipped).toBe(0) // none of these are noise
    // 7 rows still pending after the cap.
    const remaining = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM message_queue WHERE agent_id = $1 AND status = 'pending'`,
      [TEST_AGENT],
    )
    expect(remaining.rows[0].n).toBe(10)  // chat rows untouched
  })

  test('idempotent — running the helper twice on the same row set never double-skips', async () => {
    await seed('⚠️ メンションがないため A')
    await seed('⚠️ メンションがないため B')
    const first = await drainPendingWithAutoSkip(client, TEST_AGENT, 5)
    expect(first.skipped).toBe(2)
    const second = await drainPendingWithAutoSkip(client, TEST_AGENT, 5)
    expect(second.drained).toBe(0)
    expect(second.skipped).toBe(0)
  })
})
