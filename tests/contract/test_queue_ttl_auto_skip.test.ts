import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import { Client } from 'pg'
import { randomUUID } from 'node:crypto'
import { sweepExpiredPending } from '../../core/queue-ttl'

// Issue #251 (c) — auto-skip pending rows older than the TTL.
//
// Pending rows that linger past 24h are almost always stale (recipient
// offline, sender retried, conversation moved on). Observed
// (2026-04-27 psql query): 43 of 200 pending rows were over 24h old,
// the oldest from 2026-04-24. `sweepExpiredPending` runs a single
// UPDATE that flips qualifying rows to `status='skipped'` /
// `failed_reason='ttl_24h'` and is invoked on a 5-minute timer from
// `server.ts` (see startQueueTtlSweeper).
//
// Tests assert the boundary (24h+ skipped, 24h- preserved), the
// terminal-state guard (already-replied rows are not touched), and
// the `failed_reason` value (consumers may grep for it).

const DATABASE_URL = process.env.DATABASE_URL
const dbDescribe = DATABASE_URL ? describe : describe.skip

dbDescribe('test_queue_ttl_auto_skip — sweepExpiredPending flips stale pending → skipped', () => {
  let client: Client
  const TEST_AGENT = `test-ttl-${randomUUID().slice(0, 8)}`

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL })
    await client.connect()
  })

  beforeEach(async () => {
    await client.query(`DELETE FROM message_queue WHERE agent_id = $1`, [TEST_AGENT])
  })

  afterAll(async () => {
    await client.query(`DELETE FROM message_queue WHERE agent_id = $1`, [TEST_AGENT])
    await client.end()
  })

  // Helper — insert a row aged `ageSec` seconds back. We work in
  // seconds (integer) because make_interval(hours => $1) requires an
  // int parameter and the boundary cases want sub-second precision.
  async function insertAged(status: string, ageSec: number): Promise<string> {
    const messageId = randomUUID()
    const payload = JSON.stringify({ author_id: 'test', content: `aged-${ageSec}s`, message_type: 'chat', source: 'agent-comms', ts: new Date().toISOString() })
    await client.query(
      `INSERT INTO message_queue (agent_id, message_id, payload, status, created_at)
       VALUES ($1, $2, $3, $4, now() - make_interval(secs => $5))`,
      [TEST_AGENT, messageId, payload, status, ageSec],
    )
    return messageId
  }
  const HOUR = 3600

  async function rowOf(messageId: string): Promise<{ status: string; failed_reason: string | null }> {
    const r = await client.query<{ status: string; failed_reason: string | null }>(
      `SELECT status, failed_reason FROM message_queue WHERE message_id = $1`,
      [messageId],
    )
    return r.rows[0]
  }

  test('(1) pending row 24h + 1s old → flipped to skipped with failed_reason="ttl_24h"', async () => {
    const id = await insertAged('pending', 24 * HOUR + 5)  // 24h + 5s
    const updated = await sweepExpiredPending(client, { ttlHours: 24 })
    expect(updated).toBeGreaterThanOrEqual(1)
    const row = await rowOf(id)
    expect(row.status).toBe('skipped')
    expect(row.failed_reason).toBe('ttl_24h')
  })

  test('(2) pending row 23h 59m old → unchanged (under the cutoff)', async () => {
    const id = await insertAged('pending', 24 * HOUR - 60)  // 23h 59m
    await sweepExpiredPending(client, { ttlHours: 24 })
    const row = await rowOf(id)
    expect(row.status).toBe('pending')
    expect(row.failed_reason).toBe(null)
  })

  test('(3) already-replied row 30h old → unchanged (terminal state guard)', async () => {
    const id = await insertAged('replied', 30 * HOUR)
    await sweepExpiredPending(client, { ttlHours: 24 })
    const row = await rowOf(id)
    expect(row.status).toBe('replied')
  })

  test('(4) idempotent — re-running the sweep on the same data is a no-op', async () => {
    await insertAged('pending', 25 * HOUR)
    const first = await sweepExpiredPending(client, { ttlHours: 24 })
    const second = await sweepExpiredPending(client, { ttlHours: 24 })
    expect(first).toBeGreaterThanOrEqual(1)
    expect(second).toBe(0)
  })

  test('(5) custom failed_reason override is honoured', async () => {
    const id = await insertAged('pending', 25 * HOUR)
    await sweepExpiredPending(client, { ttlHours: 24, reason: 'custom_ttl' })
    const row = await rowOf(id)
    expect(row.failed_reason).toBe('custom_ttl')
  })
})
