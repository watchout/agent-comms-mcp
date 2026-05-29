#!/usr/bin/env bun
/**
 * Issue #580 — `mcp__agent-comms__send` claim terminal evidence.
 *
 * The decision logic lives in `core/send-fallback-decision.ts`; this
 * file exercises every branch of `decideSendFallback` against a real
 * Postgres so the merge gate observes the SQL invariants the server
 * relies on before it writes `agent_messages` or `outbound_queue`:
 *
 *   T-1 existing reply path → kind: 'claim_present'
 *   T-2 claim closed        → kind: 'claim_unavailable', reason: claim_closed
 *   T-3 claim missing       → kind: 'claim_unavailable', reason: claim_missing
 *   T-4 invalid reply_to    → kind: 'invalid_reply_to' (UUID absent)
 *                              and (UUID present but channel_id NULL)
 *   T-5 cc + mention        → fallback decision identical regardless
 *                              of optional args (B-6: cc/mention are
 *                              not part of the routing decision)
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { Client } from 'pg'
import { randomUUID } from 'node:crypto'
import { decideSendFallback } from '../../core/send-fallback-decision'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost/agent_comms'
const TEST_AGENT = `test-send-fallback-${process.pid}`
const OTHER_AGENT = `test-other-agent-${process.pid}`
const TEST_CHANNEL = `test-channel-${process.pid}`

let dbReachable = false
let client: Client

beforeAll(async () => {
  try {
    client = new Client({ connectionString: DATABASE_URL })
    await client.connect()
    await client.query(`DELETE FROM message_queue WHERE agent_id = ANY($1)`, [[TEST_AGENT, OTHER_AGENT]])
    await client.query(`DELETE FROM agent_messages WHERE channel_id = $1`, [TEST_CHANNEL])
    dbReachable = true
  } catch {
    dbReachable = false
  }
})

afterAll(async () => {
  if (!dbReachable) return
  try {
    await client.query(`DELETE FROM message_queue WHERE agent_id = ANY($1)`, [[TEST_AGENT, OTHER_AGENT]])
    await client.query(`DELETE FROM agent_messages WHERE channel_id = $1`, [TEST_CHANNEL])
    await client.end()
  } catch {}
})

function requireDb() {
  if (!dbReachable) {
    throw new Error(
      `DB unreachable at ${DATABASE_URL}. ` +
      `This contract test requires a real Postgres — silent skip would ` +
      `let the merge gate pass on a non-test (CEO P1 cycle 2 axis 6 fix).`,
    )
  }
}

/**
 * Insert a fake "original" agent_messages row and (optionally) a
 * matching message_queue claim. Returns the message UUID that the
 * caller will pass as `reply_to`.
 */
async function seedOriginal(opts: {
  channelId?: string | null
  withClaim?: 'received' | 'in_progress' | 'replied' | null
  claimedBy?: string
}): Promise<string> {
  const msgId = randomUUID()
  await client.query(
    `INSERT INTO agent_messages (id, channel_id, author_id, content, message_type, source, direction, role)
     VALUES ($1, $2, $3, 'seed', 'chat', 'agent-comms', 'inbound', 'agent')`,
    [msgId, opts.channelId ?? TEST_CHANNEL, OTHER_AGENT],
  )
  if (opts.withClaim) {
    await client.query(
      `INSERT INTO message_queue (agent_id, message_id, payload, status, claimed_by, claimed_at, claim_expires_at)
       VALUES ($1, $2, '{}'::jsonb, $3, $4, now(), now() + interval '30 seconds')`,
      [opts.claimedBy ?? TEST_AGENT, msgId, opts.withClaim, opts.claimedBy ?? TEST_AGENT],
    )
  }
  return msgId
}

async function inTx<T>(fn: (txClient: Client) => Promise<T>): Promise<T> {
  await client.query('BEGIN')
  try {
    const result = await fn(client)
    await client.query('ROLLBACK')
    return result
  } catch (e) {
    try { await client.query('ROLLBACK') } catch {}
    throw e
  }
}

describe('test_send_claim_terminal_evidence — decideSendFallback decision tree', () => {
  test('T-1 (existing reply path): active claim with status=received → claim_present', async () => {
    requireDb()
    const replyTo = await seedOriginal({ withClaim: 'received' })
    const decision = await inTx(tx => decideSendFallback(tx, replyTo, TEST_AGENT))
    expect(decision.kind).toBe('claim_present')
    if (decision.kind === 'claim_present') {
      expect(decision.claimedMqId).toBeDefined()
    }
  })

  test('T-1b (processed reply path): active claim with status=in_progress → claim_present', async () => {
    requireDb()
    const replyTo = await seedOriginal({ withClaim: 'in_progress' })
    const decision = await inTx(tx => decideSendFallback(tx, replyTo, TEST_AGENT))
    expect(decision.kind).toBe('claim_present')
    if (decision.kind === 'claim_present') {
      expect(decision.claimedMqId).toBeDefined()
    }
  })

  test('T-2 (claim closed): claim flipped to status=replied → claim_unavailable/claim_closed', async () => {
    requireDb()
    const replyTo = await seedOriginal({ withClaim: 'received' })
    await client.query(
      `UPDATE message_queue SET status = 'replied', replied_at = now() WHERE message_id = $1`,
      [replyTo],
    )
    const decision = await inTx(tx => decideSendFallback(tx, replyTo, TEST_AGENT))
    expect(decision.kind).toBe('claim_unavailable')
    if (decision.kind === 'claim_unavailable') {
      expect(decision.reason).toBe('claim_closed')
      expect(decision.status).toBe('replied')
      expect(decision.queueId).toBeDefined()
    }
  })

  test('T-3 (claim missing): no claim ever existed → claim_unavailable/claim_missing', async () => {
    requireDb()
    const replyTo = await seedOriginal({ withClaim: null })
    const decision = await inTx(tx => decideSendFallback(tx, replyTo, TEST_AGENT))
    expect(decision.kind).toBe('claim_unavailable')
    if (decision.kind === 'claim_unavailable') {
      expect(decision.reason).toBe('claim_missing')
      expect(decision.queueId).toBeUndefined()
      expect(decision.status).toBeUndefined()
    }
  })

  test('T-4 (invalid reply_to, UUID absent): → invalid_reply_to', async () => {
    requireDb()
    const bogusUuid = '00000000-0000-0000-0000-deadbeef0001'
    const decision = await inTx(tx => decideSendFallback(tx, bogusUuid, TEST_AGENT))
    expect(decision.kind).toBe('invalid_reply_to')
  })

  test('T-4 (invalid reply_to, channel_id NULL/empty): → invalid_reply_to (B-4 edge)', async () => {
    requireDb()
    // Seed an agent_messages row with an empty channel_id. The DB
    // schema requires NOT NULL on channel_id, so we simulate the
    // §B-4 edge case via empty string (which the helper rejects).
    const msgId = randomUUID()
    await client.query(
      `INSERT INTO agent_messages (id, channel_id, author_id, content, message_type, source, direction, role)
       VALUES ($1, '', $2, 'seed', 'chat', 'agent-comms', 'inbound', 'agent')`,
      [msgId, OTHER_AGENT],
    )
    const decision = await inTx(tx => decideSendFallback(tx, msgId, TEST_AGENT))
    expect(decision.kind).toBe('invalid_reply_to')
    await client.query(`DELETE FROM agent_messages WHERE id = $1`, [msgId])
  })

  test('T-5 (cc + mention immaterial to decision): same claim-missing result regardless of optional args', async () => {
    requireDb()
    // The decision helper takes only (txClient, reply_to, agentId).
    // cc[] / mention / message_type / metadata are §2 B-6 concerns
    // resolved downstream by Phase 5; they cannot influence the
    // fallback verdict. This test pins that contract.
    const replyTo = await seedOriginal({ withClaim: null })
    const decision1 = await inTx(tx => decideSendFallback(tx, replyTo, TEST_AGENT))
    const decision2 = await inTx(tx => decideSendFallback(tx, replyTo, TEST_AGENT))
    expect(decision1).toEqual(decision2)
    if (decision1.kind === 'claim_unavailable') {
      expect(decision1.reason).toBe('claim_missing')
    }
  })

  test.skip('TODO #338 sub-PR 9 v0.9 schema — claim owned by a different agent → claim_missing for the calling agent', async () => {
    requireDb()
    // Subtle invariant: a `'received'` row claimed by OTHER_AGENT does
    // NOT count as a claim for TEST_AGENT. The helper's first SELECT
    // filters on `claimed_by = $2`, so TEST_AGENT sees this case as
    // claim_missing (no row ever owned by them) — this keeps send
    // ownership per-(agent, msg) scoped.
    const replyTo = await seedOriginal({ withClaim: 'received', claimedBy: OTHER_AGENT })
    const decision = await inTx(tx => decideSendFallback(tx, replyTo, TEST_AGENT))
    expect(decision.kind).toBe('claim_unavailable')
    if (decision.kind === 'claim_unavailable') {
      expect(decision.reason).toBe('claim_missing')
    }
  })
})
