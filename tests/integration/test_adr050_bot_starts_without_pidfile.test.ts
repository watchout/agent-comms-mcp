/**
 * ADR-050 fixture (6b) — agent-comms inbound persistence path succeeds
 * without any /tmp/agent-com-*.pid file present (post-UnixSignalBus removal).
 *
 * Real handler invocation: drives `persistInboundDelivery()` against a real
 * Postgres `DATABASE_URL`. This is the "real handler" the dispatch instruction
 * calls for — it is the function the inbound receiver invokes after route
 * resolution to commit Step 7b (UPDATE) + 7d (INSERT) atomically. Pre-ADR-050
 * the receiver also called `bus.signal()` immediately after this commit; this
 * test verifies that:
 *
 *   - `persistInboundDelivery` commits a real `message_queue` row,
 *   - no PID file is created or required at any point,
 *   - the row reaches the queue in `pending` status (wake-daemon's input).
 *
 * Skipped without `DATABASE_URL` (per dispatch fixture spec). Uses a unique
 * probe agent_id so it does not contaminate live fleet traffic.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { existsSync, readdirSync } from 'node:fs'
import { Client } from 'pg'
import { randomUUID } from 'node:crypto'
import { persistInboundDelivery } from '../../core/inbound-delivery'

const HAS_DB = !!process.env.DATABASE_URL

describe.skipIf(!HAS_DB)('ADR-050 §6b — bot inbound persistence works without PID file', () => {
  const probeAgent = `adr050-${randomUUID().slice(0, 8)}`
  let pg: Client

  beforeAll(async () => {
    pg = new Client({ connectionString: process.env.DATABASE_URL! })
    await pg.connect()
    // Register the probe agent (online) so any FK / status check resolves.
    await pg.query(
      `INSERT INTO agents (agent_id, display_name, status, agent_type, runtime)
         VALUES ($1, $1, 'online', 'agent', 'bun')
         ON CONFLICT (agent_id) DO UPDATE SET status = 'online'`,
      [probeAgent],
    )
  })

  afterAll(async () => {
    if (pg) {
      await pg.query(`DELETE FROM message_queue WHERE agent_id = $1`, [probeAgent]).catch(() => {})
      await pg
        .query(`DELETE FROM agent_messages WHERE author_id = $1`, [`adr050-author-${probeAgent}`])
        .catch(() => {})
      await pg.query(`DELETE FROM agents WHERE agent_id = $1`, [probeAgent]).catch(() => {})
      await pg.end()
    }
  })

  test('persistInboundDelivery commits with no PID file present', async () => {
    // PID files MUST NOT exist for this probe before invocation.
    const pidPath = `/tmp/agent-com-${probeAgent}.pid`
    expect(existsSync(pidPath)).toBe(false)

    // Insert an agent_messages row (Step 7a equivalent) so 7b's UPDATE has a
    // target.
    const messageId = randomUUID()
    await pg.query(
      `INSERT INTO agent_messages (id, author_id, content, message_type, source, direction, role)
         VALUES ($1, $2, $3, 'chat', 'agent-comms', 'in', 'user')`,
      [messageId, `adr050-author-${probeAgent}`, 'adr-050 smoke'],
    )

    const payload = JSON.stringify({
      author_id: `adr050-author-${probeAgent}`,
      content: 'adr-050 smoke',
      message_id: messageId,
      message_type: 'chat',
      source: 'agent-comms',
      ts: new Date().toISOString(),
    })

    // Real handler invocation (no PID file required, no in-process bus).
    const result = await persistInboundDelivery(process.env.DATABASE_URL!, {
      receiverAgentId: probeAgent,
      messageId,
      mqPayloadJson: payload,
    })

    expect(result.committed).toBe(true)
    expect(result.duplicateDedup).toBe(false)

    // Still no PID file after commit (post-ADR-050 invariant).
    expect(existsSync(pidPath)).toBe(false)

    // The row reached message_queue in pending status — wake-daemon's input.
    const q = await pg.query(
      `SELECT count(*)::int AS n
         FROM message_queue
        WHERE agent_id = $1 AND message_id = $2 AND status = 'pending'`,
      [probeAgent, messageId],
    )
    expect(q.rows[0].n).toBe(1)
  })

  test('no /tmp/agent-com-*.pid files left lying around for the probe', () => {
    const stragglers = readdirSync('/tmp')
      .filter((f) => f.startsWith(`agent-com-${probeAgent}`) && f.endsWith('.pid'))
    expect(stragglers).toEqual([])
  })
})
