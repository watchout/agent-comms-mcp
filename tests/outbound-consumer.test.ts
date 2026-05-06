#!/usr/bin/env bun
/**
 * S2-A (FEAT-005) §4.5 — orphan reclaim behavioural test.
 *
 * Seeds a fixture row with status='claimed' + claimed_at older than
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
               'claimed', $3, 5, now() - ($4::int || ' seconds')::interval)
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
        WHERE status = 'claimed'
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
               'claimed', 1, 5, now() - interval '60 seconds')
       RETURNING id`,
      ['test-young-message-id', TEST_AGENT],
    )
    const fixtureId = seed.rows[0].id

    const res = await client!.query(
      `UPDATE outbound_queue
          SET status = 'pending',
              last_error = 'orphan_reclaim',
              claimed_at = NULL
        WHERE status = 'claimed'
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
    expect(rows[0].status).toBe('claimed')
  })
})

// ---------------------------------------------------------------------------
// §2 B-1 / B-2 (lead-ama dispatch msg 63ac0391) — 2-stage split + exhausted reclaim
// ---------------------------------------------------------------------------
//
// T-1: stage 2 (agent_messages back-fill) failure must NOT prevent stage 1
//      (outbound_queue mark-sent). Verifies the root-cause fix for the
//      2026-05-06 retry-loop incident — when stage 2 throws, stage 1 is
//      already committed (no enclosing transaction), so the row stays
//      'sent' and orphan reclaim cannot re-post it.
// T-2: orphan reclaim with attempts >= max_attempts must mark the row
//      'failed' with last_error='exhausted_via_orphan_reclaim', not
//      return it to 'pending' — closes the adversarial loop where an
//      exhausted row could be reclaimed indefinitely.

import { setDbGetter, consumeOneOutboundRow, reclaimOrphanOutboundRows } from '../adapters/outbound-consumer'
import { discordClients } from '../adapters/discord-client'
import { randomUUID } from 'node:crypto'

const HARD_AGENT_T1 = `test-2stage-t1-${process.pid}`
const HARD_AGENT_T2 = `test-2stage-t2-${process.pid}`

async function cleanupHardFixtures(c: Client): Promise<void> {
  await c.query(`DELETE FROM outbound_queue WHERE agent_id IN ($1, $2)`, [HARD_AGENT_T1, HARD_AGENT_T2]).catch(() => {})
  await c.query(`DELETE FROM agent_messages WHERE author_id IN ($1, $2)`, [HARD_AGENT_T1, HARD_AGENT_T2]).catch(() => {})
  await c.query(`DELETE FROM agents WHERE agent_id IN ($1, $2)`, [HARD_AGENT_T1, HARD_AGENT_T2]).catch(() => {})
}

// Hard merge gate (lead-ama dispatch §4 frozen, cycle 2 BLOCK-2 fix):
// T-1〜T-5 must FAIL — not skip — when DATABASE_URL is unreachable, so
// CI surfaces missing-infra as a real signal instead of silent green.
// The §4.5 reclaim tests above retain skip-on-no-DB (NOT in scope).
function requireHardDb(): void {
  if (!available) {
    throw new Error(
      'DATABASE_URL must be reachable for hard merge gate (T-1〜T-5). ' +
      'Run with a live Postgres connection (e.g. via .env or env var) ' +
      'before invoking outbound-consumer.test.ts.',
    )
  }
}

describe('§2 B-1 — outbound 2-stage split (T-1: stage 2 failure leaves row sent)', () => {
  test('stage 2 UNIQUE violation does NOT roll back stage 1; stderr emits 6-field log', async () => {
    requireHardDb()

    await cleanupHardFixtures(client!)

    // Register the test agent so any FK / status check resolves. Using
    // ON CONFLICT here keeps the test idempotent across re-runs.
    await client!.query(
      `INSERT INTO agents (agent_id, display_name, status, agent_type, runtime)
         VALUES ($1, $1, 'online', 'agent', 'bun')
         ON CONFLICT (agent_id) DO UPDATE SET status = 'online'`,
      [HARD_AGENT_T1],
    )

    // Pre-seed two agent_messages rows. Row A holds the discord_message_id
    // we will later try to assign to row B. Row B is the one the consumer
    // should back-fill — the assignment will violate
    // uq_agent_messages_discord_id and force stage 2 to throw.
    const conflictDiscordId = `conflict-${randomUUID()}`
    const rowAId = randomUUID()
    const rowBId = randomUUID()
    await client!.query(
      `INSERT INTO agent_messages (id, channel_id, author_id, content, message_type, source, direction, role, discord_message_id)
         VALUES ($1, 'test-channel', $2, 'fixture A — already holds the conflict id', 'chat', 'agent-comms', 'in', 'user', $3),
                ($4, 'test-channel', $2, 'fixture B — consumer will try to back-fill', 'chat', 'agent-comms', 'out', 'assistant', NULL)`,
      [rowAId, HARD_AGENT_T1, conflictDiscordId, rowBId],
    )

    // Seed the outbound row pointing at row B. The Discord send is mocked
    // via a fake client below to return `conflictDiscordId`, which will
    // collide with row A and throw on the agent_messages UPDATE.
    const outboundSeed = await client!.query(
      `INSERT INTO outbound_queue
         (message_id, agent_id, channel_external_id, content,
          status, attempts, max_attempts, claimed_at)
       VALUES ($1, $2, 'test-channel', 'stage 2 force-throw fixture',
               'pending', 0, 5, NULL)
       RETURNING id`,
      [rowBId, HARD_AGENT_T1],
    )
    const outboundRowId = outboundSeed.rows[0].id

    // Wire the consumer to the test DB + register a fake Discord client.
    // The fake send returns the conflicting id so stage 2 will UNIQUE-violate.
    setDbGetter(async () => client! as any, HARD_AGENT_T1)
    discordClients.set(HARD_AGENT_T1, {
      // Minimal surface — outbound-consumer.ts uses sendAdapterMessage
      // and expects an `external_message_id` field on the result.
      sendAdapterMessage: async () => ({ external_message_id: conflictDiscordId }),
    } as any)

    // Capture stderr while running the consumer.
    const stderrChunks: string[] = []
    const originalWrite = process.stderr.write.bind(process.stderr)
    ;(process.stderr.write as any) = (chunk: any) => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : String(chunk))
      return true
    }

    try {
      await consumeOneOutboundRow()
    } finally {
      ;(process.stderr.write as any) = originalWrite
      discordClients.delete(HARD_AGENT_T1)
    }

    // Verify outbound_queue row is 'sent' (stage 1 committed).
    const { rows } = await client!.query(
      `SELECT status, sent_at, discord_message_id FROM outbound_queue WHERE id = $1`,
      [outboundRowId],
    )
    expect(rows.length).toBe(1)
    expect(rows[0].status).toBe('sent')
    expect(rows[0].sent_at).not.toBeNull()
    expect(rows[0].discord_message_id).toBe(conflictDiscordId)

    // Verify stderr emitted the stage 2 failure log with all 6 forensic
    // tokens (cycle 2 spec amendment msg 706324a9): id / message_id /
    // typeof / discord_message_id / code / err.message — must all be
    // present on a single log line, in any order.
    const log = stderrChunks.join('')
    expect(log).toContain('stage 2 agent_messages back-fill failed')
    expect(log).toMatch(new RegExp(`id=${outboundRowId}\\b`))
    expect(log).toMatch(new RegExp(`message_id=${rowBId}`))
    expect(log).toContain('typeof=')
    expect(log).toContain('discord_message_id=')
    expect(log).toContain('code=')
    expect(log).toContain('err.message=')

    await cleanupHardFixtures(client!)
  })
})

describe('§2 B-2 — orphan reclaim attempts cap (T-2: exhausted rows go to failed)', () => {
  test('claimed row with attempts=max_attempts and stale claimed_at transitions to failed', async () => {
    requireHardDb()

    await cleanupHardFixtures(client!)
    await client!.query(
      `INSERT INTO agents (agent_id, display_name, status, agent_type, runtime)
         VALUES ($1, $1, 'online', 'agent', 'bun')
         ON CONFLICT (agent_id) DO UPDATE SET status = 'online'`,
      [HARD_AGENT_T2],
    )

    // Seed: claimed row with attempts=5, max_attempts=5, claimed_at 11 min ago
    // (well past OUTBOUND_ORPHAN_TIMEOUT_SEC default 600s).
    const seed = await client!.query(
      `INSERT INTO outbound_queue
         (message_id, agent_id, channel_external_id, content,
          status, attempts, max_attempts, claimed_at)
       VALUES ($1, $2, 'test-channel', 'fixture-exhausted',
               'claimed', 5, 5, now() - interval '11 minutes')
       RETURNING id`,
      [randomUUID(), HARD_AGENT_T2],
    )
    const fixtureId = seed.rows[0].id

    setDbGetter(async () => client! as any, HARD_AGENT_T2)

    await reclaimOrphanOutboundRows()

    const { rows } = await client!.query(
      `SELECT status, last_error FROM outbound_queue WHERE id = $1`,
      [fixtureId],
    )
    expect(rows.length).toBe(1)
    expect(rows[0].status).toBe('failed')
    expect(rows[0].last_error).toBe('exhausted_via_orphan_reclaim')

    await cleanupHardFixtures(client!)
  })

  test('claimed row with attempts<max_attempts still returns to pending', async () => {
    requireHardDb()

    await cleanupHardFixtures(client!)
    await client!.query(
      `INSERT INTO agents (agent_id, display_name, status, agent_type, runtime)
         VALUES ($1, $1, 'online', 'agent', 'bun')
         ON CONFLICT (agent_id) DO UPDATE SET status = 'online'`,
      [HARD_AGENT_T2],
    )

    const seed = await client!.query(
      `INSERT INTO outbound_queue
         (message_id, agent_id, channel_external_id, content,
          status, attempts, max_attempts, claimed_at)
       VALUES ($1, $2, 'test-channel', 'fixture-not-yet-exhausted',
               'claimed', 3, 5, now() - interval '11 minutes')
       RETURNING id`,
      [randomUUID(), HARD_AGENT_T2],
    )
    const fixtureId = seed.rows[0].id

    setDbGetter(async () => client! as any, HARD_AGENT_T2)

    await reclaimOrphanOutboundRows()

    const { rows } = await client!.query(
      `SELECT status, last_error FROM outbound_queue WHERE id = $1`,
      [fixtureId],
    )
    expect(rows[0].status).toBe('pending')
    expect(rows[0].last_error).toBe('orphan_reclaim')

    await cleanupHardFixtures(client!)
  })
})
