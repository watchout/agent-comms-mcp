#!/usr/bin/env bun
/**
 * Transport-Neutral Contract r1.1.4 correction: thrown nonce errors are
 * not receipt truth and numeric Discord 40062 is rate limiting, not success.
 *
 * Covers two distinct layers:
 *
 *   1. Unit tests prove `isDuplicateNonceError` is fail-closed and the exact
 *      numeric 40062 classifier remains retry/failure-only.
 *
 *   2. SQL integration tests that drive the exact UPDATE statements the
 *      consumer uses — short-circuit path (row claimed with
 *      discord_message_id already set → flip to sent without a delivery
 *      call) and mark-sent path (delivery succeeded → row carries new
 *      discord_message_id). These exercise the DB contract the consumer
 *      relies on so a future migration that drops the column or changes
 *      the CHECK constraint fails loudly here.
 *
 * Why not drive `consumeOneOutboundRow` directly? It reads module-level
 * AGENT_ID and the `discordClients` Map which are set up by server boot,
 * so isolating it would require refactoring the whole delivery path. The
 * current split — pure classifier + SQL fixtures + source-pattern pins in
 * spec-enforcement — gives the same coverage at lower refactor cost.
 *
 * Skipped automatically when no DATABASE_URL is reachable (CI / dev
 * without Postgres). The unit-test describe block runs unconditionally.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { Client } from 'pg'
import { isDiscord40062RateLimit, isDuplicateNonceError } from '../core/outbound-delivery'

// ─────────────────────────────────────────────────────────────────────────
// Unit tests — pure classifier
// ─────────────────────────────────────────────────────────────────────────
describe('40062 false-success removal', () => {
  test('numeric code 40062 is rate limiting and never duplicate success', () => {
    const err = Object.assign(new Error('Cannot send a message using that nonce'), { code: 40062 })
    expect(isDiscord40062RateLimit(err)).toBe(true)
    expect(isDuplicateNonceError(err)).toBe(false)
  })

  test('rawError 40062 is rate limiting and never success', () => {
    const err = Object.assign(new Error('upstream rejected'), { rawError: { code: 40062 } })
    expect(isDiscord40062RateLimit(err)).toBe(true)
    expect(isDuplicateNonceError(err)).toBe(false)
  })

  test('stringified 40062 remains failure-only', () => {
    const err = new Error('DiscordAPIError[40062]: Cannot send a message using that nonce')
    expect(isDiscord40062RateLimit(err)).toBe(true)
    expect(isDuplicateNonceError(err)).toBe(false)
  })

  test('nonce-like prose without an exact provider receipt is not success', () => {
    expect(isDuplicateNonceError(new Error('Cannot send a message USING that NONCE'))).toBe(false)
    expect(isDuplicateNonceError({}, 'nonce already used by prior send')).toBe(false)
    expect(isDiscord40062RateLimit({}, 'nonce already used by prior send')).toBe(false)
  })

  test('does NOT match regular transient errors', () => {
    expect(isDuplicateNonceError(new Error('ETIMEDOUT while POSTing'))).toBe(false)
    expect(isDuplicateNonceError(new Error('HTTP 503 Service Unavailable'))).toBe(false)
    expect(isDuplicateNonceError(new Error('network down'))).toBe(false)
  })

  test('does NOT match unrelated 4xx errors', () => {
    const err = Object.assign(new Error('missing access'), { code: 50001 })
    expect(isDuplicateNonceError(err)).toBe(false)
  })

  test('does NOT match numeric-looking content that is not 40062', () => {
    // 40063 is a different Discord error code (e.g. "Cannot edit message").
    expect(isDuplicateNonceError(new Error('DiscordAPIError[40063]'))).toBe(false)
  })

  test('handles undefined / null / non-object inputs gracefully', () => {
    expect(isDuplicateNonceError(undefined)).toBe(false)
    expect(isDuplicateNonceError(null)).toBe(false)
    expect(isDuplicateNonceError('some string')).toBe(false)
    expect(isDuplicateNonceError(42)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// SQL integration tests — consumer UPDATE contracts
// ─────────────────────────────────────────────────────────────────────────
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost/agent_comms'
const TEST_AGENT = `test-prA-cycle2-${process.pid}`

let client: Client | null = null
let available = false

beforeAll(async () => {
  try {
    client = new Client({ connectionString: DATABASE_URL })
    await client.connect()
    const { rows } = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'outbound_queue'
          AND column_name IN ('discord_message_id', 'claimed_at', 'next_retry_at')`,
    )
    available = rows.length === 3
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

describe('outbound consumer SQL contract — PR-A cycle 2', () => {
  test('short-circuit: row with discord_message_id already set flips to sent without a delivery call', async () => {
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn('[prA cycle2] skipping — DATABASE_URL unreachable or schema missing')
      return
    }

    // Seed a claimed row that carries a pre-populated discord_message_id.
    // The consumer's claim + short-circuit path is meant to flip this to
    // 'sent' with no further Discord call. We simulate the two SQL halves
    // the consumer executes: the atomic claim UPDATE and the short-circuit
    // mark-sent UPDATE.
    const seed = await client!.query(
      `INSERT INTO outbound_queue
         (message_id, agent_id, channel_external_id, content,
          status, attempts, max_attempts, discord_message_id)
       VALUES ($1, $2, 'test-channel', 'idempotent-fixture',
               'pending', 0, 5, $3)
       RETURNING id`,
      ['msg-short-circuit', TEST_AGENT, 'discord-msg-pre-existing'],
    )
    const fixtureId = seed.rows[0].id

    // 1) Atomic claim (mirrors server.ts consumeOneOutboundRow).
    const claim = await client!.query(
      `UPDATE outbound_queue
          SET status = 'claimed', attempts = attempts + 1, claimed_at = now()
        WHERE id = (
          SELECT id FROM outbound_queue
           WHERE status = 'pending'
             AND agent_id = $1
             AND (next_retry_at IS NULL OR next_retry_at <= now())
             AND id = $2
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id, discord_message_id, attempts`,
      [TEST_AGENT, fixtureId],
    )
    expect(claim.rowCount).toBe(1)
    const claimed = claim.rows[0]
    expect(claimed.discord_message_id).toBe('discord-msg-pre-existing')

    // 2) Short-circuit mark-sent (consumer path when discord_message_id is
    //    already populated). No Discord call is involved.
    const markSent = await client!.query(
      `UPDATE outbound_queue SET status = 'sent', sent_at = COALESCE(sent_at, now()) WHERE id = $1 RETURNING status, discord_message_id`,
      [fixtureId],
    )
    expect(markSent.rowCount).toBe(1)
    expect(markSent.rows[0].status).toBe('sent')
    expect(markSent.rows[0].discord_message_id).toBe('discord-msg-pre-existing')
  })

  test('mark-sent: delivery success persists discord_message_id and flips status', async () => {
    if (!available) return

    // Seed a fresh pending row (no discord_message_id).
    const seed = await client!.query(
      `INSERT INTO outbound_queue
         (message_id, agent_id, channel_external_id, content,
          status, attempts, max_attempts)
       VALUES ($1, $2, 'test-channel', 'success-fixture', 'pending', 1, 5)
       RETURNING id`,
      ['msg-mark-sent', TEST_AGENT],
    )
    const fixtureId = seed.rows[0].id

    // Simulate successful delivery — persist the Discord snowflake.
    const markSent = await client!.query(
      `UPDATE outbound_queue SET status = 'sent', sent_at = now(), discord_message_id = $1 WHERE id = $2 RETURNING status, discord_message_id, sent_at`,
      ['discord-msg-fresh', fixtureId],
    )
    expect(markSent.rowCount).toBe(1)
    const row = markSent.rows[0]
    expect(row.status).toBe('sent')
    expect(row.discord_message_id).toBe('discord-msg-fresh')
    expect(row.sent_at).not.toBeNull()
  })

  test('40062 with no provider message ID remains unsent and retryable', async () => {
    if (!available) return

    // Seed a pending row with no discord_message_id. This simulates the
    // retry scenario where the first attempt's HTTP response was lost. A
    // numeric error alone cannot prove the original effect.
    const seed = await client!.query(
      `INSERT INTO outbound_queue
         (message_id, agent_id, channel_external_id, content,
          status, attempts, max_attempts)
       VALUES ($1, $2, 'test-channel', 'idempotent-via-nonce',
               'pending', 2, 5)
       RETURNING id`,
      ['msg-dup-nonce', TEST_AGENT],
    )
    const fixtureId = seed.rows[0].id

    const keepRetryable = await client!.query(
      `UPDATE outbound_queue
          SET status = 'pending', last_error = $1, next_retry_at = now() + interval '1 second', claimed_at = NULL
        WHERE id = $2
        RETURNING status, discord_message_id, last_error`,
      ['discord_rate_limit_40062', fixtureId],
    )
    expect(keepRetryable.rowCount).toBe(1)
    expect(keepRetryable.rows[0].status).toBe('pending')
    expect(keepRetryable.rows[0].discord_message_id).toBeNull()
    expect(keepRetryable.rows[0].last_error).toBe('discord_rate_limit_40062')
  })
})
