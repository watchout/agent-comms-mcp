import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import { Client } from 'pg'
import { randomUUID } from 'node:crypto'
import { notifySenderOfDeliveryStatus } from '../../core/sender-feedback'
import { notifySenderAndObserve, getSenderFeedbackCounter, _resetSenderFeedbackCounter } from '../../core/sender-feedback-emit'

// Issue #251 (b) — system_info busy notification is skipped at the
// sender-feedback source.
//
// `notifySenderOfDeliveryStatus` historically inserted a payload row
// directly into `message_queue` with `message_id = NULL` whenever the
// target was `busy` (out-of-band "⏳ target busy, N queued"). Those
// rows wake the sender bot just to display a status message and add
// no actionable content; observed (2026-04-27) 447 such rows over 7d
// (240 failed / 189 skipped / 14 pending / 3 replied / 1 read).
//
// Cycle 1 of Issue #251 short-circuits the busy branch: the function
// returns `{ emitted: 'system_info', reason: 'queue-skip' }` without
// any DB write. The `disconnected` branch still INSERTs the
// `system_error` row — that remains an actionable signal (delivery
// deferred until session recovery) and is out of scope for this fix.

const DATABASE_URL = process.env.DATABASE_URL
const dbDescribe = DATABASE_URL ? describe : describe.skip

dbDescribe('test_queue_system_info_filter — busy / system_info path no longer enqueues', () => {
  let client: Client
  const SENDER = `test-sysinfo-sender-${randomUUID().slice(0, 8)}`
  const BUSY_TARGET = `test-sysinfo-busy-${randomUUID().slice(0, 8)}`
  const OFFLINE_TARGET = `test-sysinfo-off-${randomUUID().slice(0, 8)}`

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL })
    await client.connect()
    // Register the test agents so the SELECT FROM agents in
    // sender-feedback finds them.
    for (const [id, status] of [[SENDER, 'idle'], [BUSY_TARGET, 'busy'], [OFFLINE_TARGET, 'disconnected']] as const) {
      await client.query(
        `INSERT INTO agents (agent_id, display_name, agent_type, runtime, status)
         VALUES ($1, $1, 'dev', 'claude-code', $2)
         ON CONFLICT (agent_id) DO UPDATE SET status = EXCLUDED.status`,
        [id, status],
      )
    }
  })

  beforeEach(async () => {
    await client.query(`DELETE FROM message_queue WHERE agent_id = $1`, [SENDER])
  })

  afterAll(async () => {
    await client.query(`DELETE FROM message_queue WHERE agent_id = $1`, [SENDER])
    for (const id of [SENDER, BUSY_TARGET, OFFLINE_TARGET]) {
      await client.query(`DELETE FROM agents WHERE agent_id = $1`, [id])
    }
    await client.end()
  })

  test('(1) busy target → emitted="system_info" reason="queue-skip", message_queue row count = 0', async () => {
    const result = await notifySenderOfDeliveryStatus(client, {
      senderId: SENDER, targetId: BUSY_TARGET, messageId: null,
    })
    expect(result.emitted).toBe('system_info')
    expect(result.reason).toBe('queue-skip')
    const rows = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM message_queue WHERE agent_id = $1`,
      [SENDER],
    )
    expect(parseInt(rows.rows[0].n, 10)).toBe(0)
  })

  test('(2) disconnected target → system_error row IS still inserted (regression check)', async () => {
    const result = await notifySenderOfDeliveryStatus(client, {
      senderId: SENDER, targetId: OFFLINE_TARGET, messageId: null,
    })
    expect(result.emitted).toBe('system_error')
    const rows = await client.query<{ n: string; pl: string }>(
      `SELECT count(*)::text AS n, max(payload::text) AS pl FROM message_queue WHERE agent_id = $1`,
      [SENDER],
    )
    expect(parseInt(rows.rows[0].n, 10)).toBe(1)
    expect(rows.rows[0].pl).toContain('system_error')
  })

  test('(3) idle target → no row, no emit (regression check, pre-existing behaviour)', async () => {
    const result = await notifySenderOfDeliveryStatus(client, {
      senderId: SENDER, targetId: SENDER /* self → 'self' short-circuit, but exercising the path */, messageId: null,
    })
    // Self targeting returns early — confirm nothing leaks into the queue.
    expect(result.emitted).toBe(null)
    const rows = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM message_queue WHERE agent_id = $1`,
      [SENDER],
    )
    expect(parseInt(rows.rows[0].n, 10)).toBe(0)
  })

  // Issue #251 cycle 2 axis 3 (CTO `c1c6eb1d`) — caller-side
  // `emitted` consumption via `notifySenderAndObserve` wrapper.
  // cycle 1 left the busy signal silently dropped; cycle 2 bumps a
  // process-local counter + emits a stderr line so the signal is
  // observable without re-introducing queue noise.
  test('(4) wrapper bumps systemInfo counter + emits stderr on busy target', async () => {
    _resetSenderFeedbackCounter()
    const result = await notifySenderAndObserve(client, {
      senderId: SENDER, targetId: BUSY_TARGET, messageId: null,
    })
    expect(result.emitted).toBe('system_info')
    expect(result.reason).toBe('queue-skip')
    const counter = getSenderFeedbackCounter()
    expect(counter.systemInfo).toBe(1)
    expect(counter.systemError).toBe(0)
    // queue still untouched (cycle 1 invariant preserved)
    const rows = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM message_queue WHERE agent_id = $1`,
      [SENDER],
    )
    expect(parseInt(rows.rows[0].n, 10)).toBe(0)
  })

  test('(5) wrapper bumps systemError counter on disconnected target (and queue row stays)', async () => {
    _resetSenderFeedbackCounter()
    const result = await notifySenderAndObserve(client, {
      senderId: SENDER, targetId: OFFLINE_TARGET, messageId: null,
    })
    expect(result.emitted).toBe('system_error')
    expect(getSenderFeedbackCounter().systemError).toBe(1)
    expect(getSenderFeedbackCounter().systemInfo).toBe(0)
    const rows = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM message_queue WHERE agent_id = $1`,
      [SENDER],
    )
    expect(parseInt(rows.rows[0].n, 10)).toBe(1)
  })
})
