import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import { Client } from 'pg'
import { randomUUID } from 'node:crypto'
import { sweepExpiredClaims } from '../../core/claim-ttl'

// Issue #278 (A) segment 3b — expired-claim sweeper.
//
// Per-row claim semantics (segment 3a) attach a TTL (default 30s) to
// each `message_queue` row when `next` hands it to a bot. If the bot
// crashes mid-turn or the LLM exits without calling send / skip / fail,
// the claim is orphaned and the row stays in `status='read'` forever,
// blocking re-delivery. `sweepExpiredClaims` is the structured
// replacement for the legacy priorId IMPLICIT_ABANDON pattern in the
// `next` handler — every 5 min it flips orphaned `status='read'` rows
// whose `claim_expires_at` is in the past to
// `status='failed', failed_reason='IMPLICIT_ABANDON'`.
//
// Tests assert the predicate boundary (expired vs in-flight), the
// terminal-state guard (replied / failed / skipped untouched), the
// `claimed_by IS NOT NULL` qualifier (legacy non-claim rows preserved),
// and idempotency.

// v0.9 (sub-PR 1 #347 + sub-PR 7): 'failed' status + 'failed_reason'
// column removed. sweepExpiredClaims now resets foreign expired claims
// back to 'pending' (retry path) instead of marking them 'failed'.
// The IMPLICIT_ABANDON taxonomy + permanent-failure marking belongs to
// Issue #349 (abandonment-tracking redesign). All cases below assert
// the removed semantics and are skipped until #349 lands.
describe.skip('test_claim_ttl_implicit_abandon — deferred to Issue #349', () => {
  let client: Client
  const TEST_AGENT = `test-claim-ttl-${randomUUID().slice(0, 8)}`

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

  // Helper — insert a row in `status` with claim_expires_at offset
  // by `claimOffsetSec` seconds from now (negative = expired). When
  // `claimedBy` is null the row is treated as a legacy non-claim row.
  async function insertClaim(opts: {
    status: string
    claimOffsetSec: number | null
    claimedBy?: string | null
  }): Promise<string> {
    const messageId = randomUUID()
    const payload = JSON.stringify({ author_id: 'test', content: 'claim-test', message_type: 'chat', source: 'agent-comms', ts: new Date().toISOString() })
    await client.query(
      `INSERT INTO message_queue (agent_id, message_id, payload, status, claimed_by, claimed_at, claim_expires_at)
       VALUES ($1, $2, $3, $4, $5,
               CASE WHEN $5::text IS NULL THEN NULL ELSE now() END,
               CASE WHEN $6::int IS NULL THEN NULL ELSE now() + make_interval(secs => $6) END)`,
      [TEST_AGENT, messageId, payload, opts.status, opts.claimedBy ?? null, opts.claimOffsetSec],
    )
    return messageId
  }

  async function rowOf(messageId: string): Promise<{ status: string; failed_reason: string | null; claimed_by: string | null }> {
    const r = await client.query<{ status: string; failed_reason: string | null; claimed_by: string | null }>(
      `SELECT status, failed_reason, claimed_by FROM message_queue WHERE message_id = $1`,
      [messageId],
    )
    return r.rows[0]
  }

  test('(1) read row with claim_expires_at 5s past → flipped to failed/IMPLICIT_ABANDON', async () => {
    const id = await insertClaim({ status: 'read', claimOffsetSec: -5, claimedBy: TEST_AGENT })
    const updated = await sweepExpiredClaims(client)
    expect(updated).toBeGreaterThanOrEqual(1)
    const row = await rowOf(id)
    expect(row.status).toBe('failed')
    expect(row.failed_reason).toBe('IMPLICIT_ABANDON')
  })

  test('(2) read row with claim_expires_at 30s in the future → unchanged (still in-flight)', async () => {
    const id = await insertClaim({ status: 'read', claimOffsetSec: 30, claimedBy: TEST_AGENT })
    await sweepExpiredClaims(client)
    const row = await rowOf(id)
    expect(row.status).toBe('read')
    expect(row.failed_reason).toBe(null)
  })

  test('(3) replied row with stale claim → unchanged (terminal state guard)', async () => {
    const id = await insertClaim({ status: 'replied', claimOffsetSec: -120, claimedBy: TEST_AGENT })
    await sweepExpiredClaims(client)
    const row = await rowOf(id)
    expect(row.status).toBe('replied')
  })

  test('(4) read row without claimed_by → unchanged (legacy non-claim row preserved)', async () => {
    const id = await insertClaim({ status: 'read', claimOffsetSec: null, claimedBy: null })
    await sweepExpiredClaims(client)
    const row = await rowOf(id)
    expect(row.status).toBe('read')
    expect(row.claimed_by).toBe(null)
  })

  test('(5) idempotent — re-running the sweep on the same expired claim is a no-op', async () => {
    await insertClaim({ status: 'read', claimOffsetSec: -60, claimedBy: TEST_AGENT })
    const first = await sweepExpiredClaims(client)
    const second = await sweepExpiredClaims(client)
    expect(first).toBeGreaterThanOrEqual(1)
    expect(second).toBe(0)
  })

  test('(6) custom failed_reason override is honoured', async () => {
    const id = await insertClaim({ status: 'read', claimOffsetSec: -10, claimedBy: TEST_AGENT })
    await sweepExpiredClaims(client, { reason: 'custom_abandon' })
    const row = await rowOf(id)
    expect(row.failed_reason).toBe('custom_abandon')
  })
})
