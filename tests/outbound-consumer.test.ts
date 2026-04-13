#!/usr/bin/env bun
/**
 * S2-A (FEAT-005) §4.5 — orphan reclaim behavioural test.
 *
 * Seeds a fixture row with status='processing' + claimed_at older than
 * OUTBOUND_ORPHAN_TIMEOUT_SEC, runs the exact reclaim SQL that
 * server.ts::reclaimOrphanOutboundRows executes, and verifies:
 *   - status flips back to 'pending'
 *   - last_error = 'orphan_reclaim'
 *   - claimed_at is cleared (NULL)
 *   - next_retry_at is scheduled with the backoff formula, NOT now()
 *     (plan §3.5 — thundering-herd prevention after crashed consumers)
 *
 * The function is not exported from server.ts (module-level AGENT_ID), so
 * the test executes the canonical SQL directly. The S2-A spec-enforcement
 * test s2a-daemon-owns-outbound.test.ts #5 pins the SQL shape at source
 * level, keeping the two paths in sync.
 *
 * Skipped automatically when no DATABASE_URL is reachable (CI / dev
 * without Postgres).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { Client } from 'pg'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost/agent_comms'
const TEST_AGENT = `test-s2a-orphan-${process.pid}`
// Phase C Step 1 PR-A cycle 2 S1: default raised 300 → 600 so the orphan
// reclaim window is strictly larger than Discord's ~5-minute enforceNonce
// dedup window. Keep in sync with server.ts::reclaimOrphanOutboundRows.
const TIMEOUT_SEC = 600 // matches OUTBOUND_ORPHAN_TIMEOUT_SEC default

let client: Client | null = null
let available = false

beforeAll(async () => {
  try {
    client = new Client({ connectionString: DATABASE_URL })
    await client.connect()
    // Make sure the schema is current (claimed_at / next_retry_at exist).
    const { rows } = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'outbound_queue'
          AND column_name IN ('claimed_at', 'next_retry_at')`,
    )
    available = rows.length === 2
    // Clean up any leftover fixture from a previous aborted run.
    await client.query(`DELETE FROM outbound_queue WHERE agent_id = $1`, [TEST_AGENT])
  } catch {
    available = false
  }
})

afterAll(async () => {
  if (client) {
    try {
      await client.query(`DELETE FROM outbound_queue WHERE agent_id = $1`, [TEST_AGENT])
      await client.end()
    } catch {
      // ignore
    }
  }
})

describe('S2-A §4.5 — orphan reclaim returns processing rows to pending', () => {
  test('reclaim flips status, records orphan_reclaim, and schedules backoff next_retry_at', async () => {
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn('[s2a §4.5] skipping — DATABASE_URL unreachable or schema missing')
      return
    }

    const attempts = 3 // delay(3) = 2^2 = 4s + jitter(<500ms), well inside the tolerance
    const claimedAtOffsetSec = TIMEOUT_SEC + 60 // 6 min past the 5 min threshold

    // Seed: processing row older than the orphan threshold.
    const seed = await client!.query(
      `INSERT INTO outbound_queue
         (message_id, agent_id, channel_external_id, content,
          status, attempts, max_attempts, claimed_at)
       VALUES ($1, $2, 'test-channel', 'fixture',
               'processing', $3, 5, now() - ($4::int || ' seconds')::interval)
       RETURNING id`,
      ['test-message-id', TEST_AGENT, attempts, claimedAtOffsetSec],
    )
    const fixtureId = seed.rows[0].id

    // Record the clock before the reclaim so we can bound next_retry_at.
    const before = await client!.query(`SELECT now() AS t`)
    const beforeT = new Date(before.rows[0].t).getTime()

    // Run the exact SQL reclaimOrphanOutboundRows uses (server.ts).
    const res = await client!.query(
      `UPDATE outbound_queue
          SET status = 'pending',
              last_error = 'orphan_reclaim',
              claimed_at = NULL,
              next_retry_at = now()
                            + LEAST(
                                interval '30 seconds',
                                (power(2, greatest(attempts - 1, 0)))::int * interval '1 second'
                              )
                            + ((random() * 500)::int || ' milliseconds')::interval
        WHERE status = 'processing'
          AND agent_id = $1
          AND claimed_at < now() - ($2::int || ' seconds')::interval
        RETURNING id, attempts`,
      [TEST_AGENT, TIMEOUT_SEC],
    )
    expect(res.rowCount).toBe(1)
    expect(res.rows[0].id).toBe(fixtureId)

    // Verify the row shape post-reclaim.
    const { rows } = await client!.query(
      `SELECT status, last_error, claimed_at, next_retry_at, attempts
         FROM outbound_queue WHERE id = $1`,
      [fixtureId],
    )
    expect(rows.length).toBe(1)
    const row = rows[0]
    expect(row.status).toBe('pending')
    expect(row.last_error).toBe('orphan_reclaim')
    expect(row.claimed_at).toBeNull()
    expect(row.next_retry_at).not.toBeNull()

    // Backoff formula: min(30s, 2^(attempts-1)s) + jitter(0..500ms).
    // For attempts=3 that is 4s..4.5s past `before`.
    const scheduled = new Date(row.next_retry_at).getTime()
    const deltaMs = scheduled - beforeT
    expect(deltaMs).toBeGreaterThanOrEqual(4_000 - 50) // small tolerance for clock skew
    expect(deltaMs).toBeLessThanOrEqual(4_500 + 1_500) // + query RTT margin
  })

  test('reclaim does not touch processing rows younger than the orphan threshold', async () => {
    if (!available) return

    // Seed a "fresh" processing row (claimed_at = now() - 60s, well below
    // the 600s threshold). The reclaim UPDATE must leave it untouched.
    const seed = await client!.query(
      `INSERT INTO outbound_queue
         (message_id, agent_id, channel_external_id, content,
          status, attempts, max_attempts, claimed_at)
       VALUES ($1, $2, 'test-channel', 'fixture-young',
               'processing', 1, 5, now() - interval '60 seconds')
       RETURNING id`,
      ['test-young-message-id', TEST_AGENT],
    )
    const fixtureId = seed.rows[0].id

    const res = await client!.query(
      `UPDATE outbound_queue
          SET status = 'pending',
              last_error = 'orphan_reclaim',
              claimed_at = NULL
        WHERE status = 'processing'
          AND agent_id = $1
          AND claimed_at < now() - ($2::int || ' seconds')::interval
          AND id = $3
        RETURNING id`,
      [TEST_AGENT, TIMEOUT_SEC, fixtureId],
    )
    expect(res.rowCount).toBe(0)

    const { rows } = await client!.query(
      `SELECT status FROM outbound_queue WHERE id = $1`,
      [fixtureId],
    )
    expect(rows[0].status).toBe('processing')
  })
})
