/**
 * Postgres regression coverage for targeted receive (`aun receive --queue-id`
 * and `aun next --queue-id`, which share the receiveTargeted claim path).
 *
 * The sibling SQLite contract file (test_aun_targeted_receive.test.ts) cannot
 * catch Postgres planner errors: the SQLite adapter strips locking clauses, so
 * the bare-FOR-UPDATE-with-LEFT-JOIN bug ('FOR UPDATE cannot be applied to the
 * nullable side of an outer join') shipped invisible to CI and broke every
 * real-Postgres targeted receive, including the state-daemon queue-work
 * scheduler runPending path (observed live: codex-cto claiming queue 118779,
 * 2026-06-12). This file executes the real claim SQL against Postgres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Client } from 'pg'
import { receiveTargeted } from '../../bin/aun/receive'
import { cleanAll, makeAgentId, openClient, seedAgent, seedQueueRow } from './state-daemon/seed'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost/agent_comms'

function pgEnv(agentId: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    AGENT_ID: agentId,
    AGENT_COM_EXPECTED_AGENT_ID: agentId,
    DATABASE_URL,
    AGENT_COM_PG_NOTIFY: 'false',
    ...extra,
  }
}

describe('targeted receive against real Postgres (lock shape regression)', () => {
  let pg: Client

  beforeAll(async () => {
    pg = await openClient()
  })

  afterAll(async () => {
    if (pg) {
      await cleanAll(pg)
      await pg.end()
    }
  })

  beforeEach(async () => {
    await cleanAll(pg)
  })

  test('receive --queue-id claims a pending row (FOR UPDATE OF mq plans on PG)', async () => {
    const agent = makeAgentId('pg-claim')
    await seedAgent(pg, {
      agent_id: agent,
      runtime: 'TUI',
      status: 'idle',
      last_seen_at: new Date(),
      tmux_session: `${agent}-session`,
    })
    const queueId = await seedQueueRow(pg, { agent_id: agent, status: 'pending' })

    const r = await receiveTargeted({
      agentId: agent,
      queueId: String(queueId),
      env: pgEnv(agent),
    })

    // With the bare FOR UPDATE this failed before claiming:
    // 'Error [TARGETED_RECEIVE_FAILED]: FOR UPDATE cannot be applied to the
    // nullable side of an outer join'
    expect(r.stderr).not.toContain('nullable side of an outer join')
    expect(r.ok).toBe(true)
    expect(r.summary?.claimed).toMatchObject({
      queue_id: String(queueId),
      claimed_by: agent,
    })
    expect(Number.isFinite(Date.parse(r.summary?.claimed?.claimed_at ?? ''))).toBe(true)
    expect(Number.isFinite(Date.parse(r.summary?.claimed?.claim_expires_at ?? ''))).toBe(true)

    const row = await pg.query(
      `SELECT status, claimed_by, claimed_at::text AS claimed_at,
              claim_expires_at::text AS claim_expires_at
         FROM message_queue WHERE id = $1`,
      [queueId],
    )
    expect(row.rows[0].status).toBe('received')
    expect(row.rows[0].claimed_by).toBe(agent)
    expect(row.rows[0].claimed_at).toBe(r.summary?.claimed?.claimed_at)
    expect(row.rows[0].claim_expires_at).toBe(r.summary?.claimed?.claim_expires_at)
  })

  test('claim persists receive_claim.source evidence on PG when configured', async () => {
    const agent = makeAgentId('pg-claim-source')
    await seedAgent(pg, {
      agent_id: agent,
      runtime: 'TUI',
      status: 'idle',
      last_seen_at: new Date(),
      tmux_session: `${agent}-session`,
    })
    const queueId = await seedQueueRow(pg, { agent_id: agent, status: 'pending' })

    const r = await receiveTargeted({
      agentId: agent,
      queueId: String(queueId),
      env: pgEnv(agent, { AUN_RECEIVE_CLAIM_SOURCE: 'state-daemon-queue-work-scheduler' }),
    })
    expect(r.ok).toBe(true)

    const row = await pg.query(
      `SELECT payload FROM message_queue WHERE id = $1`,
      [queueId],
    )
    const payload = JSON.parse(row.rows[0].payload)
    expect(payload.receive_claim).toMatchObject({
      mode: 'targeted-receive',
      source: 'state-daemon-queue-work-scheduler',
      agent_id: agent,
      queue_id: String(queueId),
    })
  })

  test('non-pending target fails closed on PG without touching the row', async () => {
    const agent = makeAgentId('pg-nonpending')
    await seedAgent(pg, {
      agent_id: agent,
      runtime: 'TUI',
      status: 'idle',
      last_seen_at: new Date(),
      tmux_session: `${agent}-session`,
    })
    const queueId = await seedQueueRow(pg, {
      agent_id: agent,
      status: 'replied',
    })

    const r = await receiveTargeted({
      agentId: agent,
      queueId: String(queueId),
      env: pgEnv(agent),
    })
    expect(r.ok).toBe(false)

    const row = await pg.query(
      `SELECT status FROM message_queue WHERE id = $1`,
      [queueId],
    )
    expect(row.rows[0].status).toBe('replied')
  })
})
