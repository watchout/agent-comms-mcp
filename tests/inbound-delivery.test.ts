#!/usr/bin/env bun
/**
 * Tests for core/inbound-delivery.ts — atomic Step 7b + 7d persistence
 * (Issue #177). Pins transactional invariants called out in SSOT §7.3.1.
 *
 * Five scenarios (two unit-only + three that also exercise a real DB):
 *
 *   1. Happy path — BEGIN / UPDATE / INSERT / COMMIT sequence,
 *      `committed: true`, `duplicateDedup: false`.
 *   2. 7b (UPDATE) failure — ROLLBACK fires, `committed: false`,
 *      error surfaced, no 7d query observed.
 *   3. 7d (INSERT) failure — ROLLBACK fires, `committed: false`,
 *      error surfaced.
 *   4. Retry idempotency — second call with same (agent_id, message_id)
 *      returns `committed: true, duplicateDedup: true` because
 *      `ON CONFLICT DO NOTHING` leaves `rowCount = 0`.
 *   5. DB integration (round-trip) — real INSERT into a probe
 *      `agent_messages` row, persistInboundDelivery() commit, then
 *      `fetchNewMessages()` sees the row (before: empty, after: 1).
 *      Proves the "inbox-ghost" (metadata.to NULL → inbox empty) no
 *      longer occurs on the success path.
 *
 * DB integration tests run only if `DATABASE_URL` is set; they use a
 * unique probe agent id to avoid contamination with live fleet traffic.
 *
 * Usage: DATABASE_URL=postgresql://localhost/agent_comms bun test tests/inbound-delivery.test.ts
 */
import { describe, test, expect } from 'bun:test'
import { Client } from 'pg'
import {
  persistInboundDelivery,
  persistInboundDeliveryOnClient,
  type InboundDeliveryClient,
} from '../core/inbound-delivery'
import { fetchNewMessages } from '../core/inbox-cursor'

// ----- Mock client helper --------------------------------------------------

type Call = { sql: string; params?: any[] }
type Behavior = {
  throwAt?: number
  insertRowCount?: number
  /**
   * Row count returned by the UPDATE. Defaults to 1 (matched exactly one
   * row). Set to 0 to simulate a stale `messageId` — the helper must
   * ROLLBACK and never run the INSERT. BLOCKER 2 (Cycle 2).
   */
  updateRowCount?: number
}

function mockClient(behavior: Behavior = {}): {
  client: InboundDeliveryClient
  calls: Call[]
} {
  const calls: Call[] = []
  let n = 0
  const client: InboundDeliveryClient = {
    async query(sql: string, params?: any[]) {
      n++
      calls.push({ sql, params })
      if (behavior.throwAt === n) {
        throw new Error(`mock failure at call ${n}: ${sql.slice(0, 40)}`)
      }
      const stmt = sql.trim()
      if (/^UPDATE agent_messages/.test(stmt)) {
        return { rows: [], rowCount: behavior.updateRowCount ?? 1 }
      }
      if (/^INSERT INTO message_queue/.test(stmt)) {
        return { rows: [], rowCount: behavior.insertRowCount ?? 1 }
      }
      return { rows: [], rowCount: 0 }
    },
  }
  return { client, calls }
}

// ----- 1. Happy path -------------------------------------------------------

describe('persistInboundDelivery — happy path', () => {
  test('runs BEGIN / UPDATE / INSERT / COMMIT in order and reports committed=true', async () => {
    const { client, calls } = mockClient()
    const r = await persistInboundDeliveryOnClient(client, {
      receiverAgentId: 'probe',
      messageId: '00000000-0000-4000-8000-000000000001',
      mqPayloadJson: '{"channel_id":"c","content":"hi"}',
    })

    expect(r.committed).toBe(true)
    expect(r.duplicateDedup).toBe(false)
    expect(r.error).toBeUndefined()
    expect(calls).toHaveLength(4)
    expect(calls[0].sql).toBe('BEGIN')
    expect(calls[1].sql).toContain('UPDATE agent_messages')
    expect(calls[1].params).toEqual([
      'probe',
      '00000000-0000-4000-8000-000000000001',
    ])
    expect(calls[2].sql).toContain('INSERT INTO message_queue')
    expect(calls[3].sql).toBe('COMMIT')
  })

  test('duplicateDedup=true when INSERT rowCount=0 (ON CONFLICT DO NOTHING)', async () => {
    const { client } = mockClient({ insertRowCount: 0 })
    const r = await persistInboundDeliveryOnClient(client, {
      receiverAgentId: 'probe',
      messageId: '00000000-0000-4000-8000-000000000002',
      mqPayloadJson: '{}',
    })
    expect(r.committed).toBe(true)
    expect(r.duplicateDedup).toBe(true)
  })
})

// ----- 1b. BLOCKER 2 — stale messageId (UPDATE no match) -----------------

describe('persistInboundDelivery — UPDATE no match (stale messageId)', () => {
  test('rolls back with error=update_no_match and never runs the INSERT', async () => {
    const { client, calls } = mockClient({ updateRowCount: 0 })
    const r = await persistInboundDeliveryOnClient(client, {
      receiverAgentId: 'probe',
      messageId: '00000000-0000-4000-8000-0000deadbeef',
      mqPayloadJson: '{}',
    })
    expect(r.committed).toBe(false)
    expect(r.duplicateDedup).toBe(false)
    expect(r.error).toBe('update_no_match')
    const sqls = calls.map((c) => c.sql.split('\n')[0])
    expect(sqls[0]).toBe('BEGIN')
    expect(sqls[1]).toContain('UPDATE agent_messages')
    // INSERT must NOT have been attempted
    expect(sqls.some((s) => s.includes('INSERT INTO message_queue'))).toBe(
      false,
    )
    // Last call must be ROLLBACK
    expect(calls[calls.length - 1].sql).toBe('ROLLBACK')
  })
})

// ----- 2. Step 7b (UPDATE) failure ----------------------------------------

describe('persistInboundDelivery — 7b (UPDATE) failure', () => {
  test('rolls back and reports committed=false when the UPDATE throws', async () => {
    // BEGIN = call 1, UPDATE = call 2 — fail there.
    const { client, calls } = mockClient({ throwAt: 2 })
    const r = await persistInboundDeliveryOnClient(client, {
      receiverAgentId: 'probe',
      messageId: '00000000-0000-4000-8000-000000000003',
      mqPayloadJson: '{}',
    })

    expect(r.committed).toBe(false)
    expect(r.duplicateDedup).toBe(false)
    expect(r.error).toBeInstanceOf(Error)
    const sqls = calls.map((c) => c.sql.split('\n')[0])
    expect(sqls[0]).toBe('BEGIN')
    expect(sqls[1]).toContain('UPDATE agent_messages')
    // INSERT must NOT have been attempted
    expect(sqls).not.toContain(
      expect.stringContaining('INSERT INTO message_queue'),
    )
    // Last call must be ROLLBACK
    expect(calls[calls.length - 1].sql).toBe('ROLLBACK')
  })
})

// ----- 3. Step 7d (INSERT) failure ----------------------------------------

describe('persistInboundDelivery — 7d (INSERT) failure', () => {
  test('rolls back and reports committed=false when the INSERT throws', async () => {
    // BEGIN=1, UPDATE=2, INSERT=3 — fail at 3.
    const { client, calls } = mockClient({ throwAt: 3 })
    const r = await persistInboundDeliveryOnClient(client, {
      receiverAgentId: 'probe',
      messageId: '00000000-0000-4000-8000-000000000004',
      mqPayloadJson: '{}',
    })

    expect(r.committed).toBe(false)
    expect(r.error).toBeInstanceOf(Error)
    const sqls = calls.map((c) => c.sql.split('\n')[0])
    expect(sqls[0]).toBe('BEGIN')
    expect(sqls[1]).toContain('UPDATE agent_messages')
    expect(sqls[2]).toContain('INSERT INTO message_queue')
    // COMMIT must NOT have been reached
    expect(sqls).not.toContain('COMMIT')
    expect(calls[calls.length - 1].sql).toBe('ROLLBACK')
  })

  test('ROLLBACK failure is swallowed and does not mask the original error', async () => {
    // BEGIN=1, UPDATE=2, INSERT=3 fail, ROLLBACK=4 also fails.
    let n = 0
    const calls: Call[] = []
    const client: InboundDeliveryClient = {
      async query(sql: string, params?: any[]) {
        n++
        calls.push({ sql, params })
        if (n === 3) throw new Error('INSERT failed')
        if (n === 4) throw new Error('ROLLBACK failed')
        return { rows: [], rowCount: 1 }
      },
    }
    const r = await persistInboundDeliveryOnClient(client, {
      receiverAgentId: 'probe',
      messageId: '00000000-0000-4000-8000-000000000005',
      mqPayloadJson: '{}',
    })
    expect(r.committed).toBe(false)
    expect((r.error as Error).message).toBe('INSERT failed')
  })
})

// ----- 4. Retry idempotency (unit-level) -----------------------------------

describe('persistInboundDelivery — retry idempotency', () => {
  test('second call with rowCount=0 returns duplicateDedup=true (ON CONFLICT DO NOTHING)', async () => {
    const { client: c1 } = mockClient({ insertRowCount: 1 })
    const { client: c2 } = mockClient({ insertRowCount: 0 })
    const first = await persistInboundDeliveryOnClient(c1, {
      receiverAgentId: 'probe',
      messageId: '00000000-0000-4000-8000-000000000006',
      mqPayloadJson: '{}',
    })
    const second = await persistInboundDeliveryOnClient(c2, {
      receiverAgentId: 'probe',
      messageId: '00000000-0000-4000-8000-000000000006',
      mqPayloadJson: '{}',
    })
    expect(first).toEqual({ committed: true, duplicateDedup: false })
    expect(second).toEqual({ committed: true, duplicateDedup: true })
  })
})

// ----- 5. DB integration — round-trip with fetchNewMessages ----------------

const DATABASE_URL = process.env.DATABASE_URL
const dbDescribe = DATABASE_URL ? describe : describe.skip

dbDescribe('persistInboundDelivery — DB integration round-trip', () => {
  test('commit makes the row visible to fetchNewMessages (inbox-ghost repro)', async () => {
    const client = new Client({ connectionString: DATABASE_URL })
    await client.connect()
    const probeAgent = `probe-inbound-177-${process.pid}-${Date.now()}`
    const probeMessageId = crypto.randomUUID()
    try {
      // Seed an agent_messages row with metadata.to=NULL — the exact
      // pre-fix "inbox-ghost" state.
      await client.query(
        `INSERT INTO agent_messages (id, channel_id, author_id, content, message_type, metadata, source, direction, role)
         VALUES ($1::uuid, 'probe-channel', 'probe-sender', 'hi', 'chat', '{}'::jsonb, 'agent-comms', 'inbound', 'agent')`,
        [probeMessageId],
      )

      // Before the 7b+7d commit, fetchNewMessages for the receiver
      // must see **zero** rows — metadata.to is NULL.
      const before = await fetchNewMessages(probeAgent, 10, null, {
        query: (sql, params) => client.query(sql, params),
      })
      expect(before.rows).toHaveLength(0)

      // Commit 7b+7d atomically.
      const r = await persistInboundDeliveryOnClient(client, {
        receiverAgentId: probeAgent,
        messageId: probeMessageId,
        mqPayloadJson: JSON.stringify({
          channel_id: 'probe-channel',
          content: 'hi',
          message_id: probeMessageId,
        }),
      })
      expect(r.committed).toBe(true)
      expect(r.duplicateDedup).toBe(false)

      // After commit, fetchNewMessages must return the probe row; the
      // metadata.to field must equal the receiver.
      const after = await fetchNewMessages(probeAgent, 10, null, {
        query: (sql, params) => client.query(sql, params),
      })
      expect(after.rows).toHaveLength(1)
      expect(after.rows[0].id).toBe(probeMessageId)
      expect((after.rows[0].metadata as any)?.to).toBe(probeAgent)

      // message_queue must also hold the pending row.
      const mq = await client.query(
        `SELECT id, agent_id, message_id FROM message_queue WHERE agent_id = $1 AND message_id = $2`,
        [probeAgent, probeMessageId],
      )
      expect(mq.rows).toHaveLength(1)
    } finally {
      await client.query(
        `DELETE FROM message_queue WHERE agent_id = $1`,
        [probeAgent],
      )
      await client.query(`DELETE FROM agent_messages WHERE id = $1::uuid`, [
        probeMessageId,
      ])
      await client.end()
    }
  })

  test('second call with same (agent_id, message_id) dedups (ON CONFLICT DO NOTHING)', async () => {
    const client = new Client({ connectionString: DATABASE_URL })
    await client.connect()
    const probeAgent = `probe-inbound-177-retry-${process.pid}-${Date.now()}`
    const probeMessageId = crypto.randomUUID()
    try {
      await client.query(
        `INSERT INTO agent_messages (id, channel_id, author_id, content, message_type, metadata, source, direction, role)
         VALUES ($1::uuid, 'probe-channel', 'probe-sender', 'hi', 'chat', '{}'::jsonb, 'agent-comms', 'inbound', 'agent')`,
        [probeMessageId],
      )
      const first = await persistInboundDeliveryOnClient(client, {
        receiverAgentId: probeAgent,
        messageId: probeMessageId,
        mqPayloadJson: JSON.stringify({ message_id: probeMessageId }),
      })
      const second = await persistInboundDeliveryOnClient(client, {
        receiverAgentId: probeAgent,
        messageId: probeMessageId,
        mqPayloadJson: JSON.stringify({ message_id: probeMessageId }),
      })
      expect(first).toEqual({ committed: true, duplicateDedup: false })
      expect(second).toEqual({ committed: true, duplicateDedup: true })

      const mq = await client.query(
        `SELECT id FROM message_queue WHERE agent_id = $1 AND message_id = $2`,
        [probeAgent, probeMessageId],
      )
      expect(mq.rows).toHaveLength(1)
    } finally {
      await client.query(`DELETE FROM message_queue WHERE agent_id = $1`, [
        probeAgent,
      ])
      await client.query(`DELETE FROM agent_messages WHERE id = $1::uuid`, [
        probeMessageId,
      ])
      await client.end()
    }
  })

  test('persistInboundDelivery(databaseUrl, …) owns a dedicated client (transaction-private)', async () => {
    // Exercise the primary entry point: pass a databaseUrl and let the
    // helper instantiate / teardown its own pg.Client. Confirms the
    // connection is owned for the call's lifetime so concurrent callers
    // cannot share a connection (auditor BLOCKER 1).
    const seedClient = new Client({ connectionString: DATABASE_URL })
    await seedClient.connect()
    const probeAgent = `probe-inbound-177-dbUrl-${process.pid}-${Date.now()}`
    const probeMessageId = crypto.randomUUID()
    try {
      await seedClient.query(
        `INSERT INTO agent_messages (id, channel_id, author_id, content, message_type, metadata, source, direction, role)
         VALUES ($1::uuid, 'probe-channel', 'probe-sender', 'hi', 'chat', '{}'::jsonb, 'agent-comms', 'inbound', 'agent')`,
        [probeMessageId],
      )
      const r = await persistInboundDelivery(DATABASE_URL!, {
        receiverAgentId: probeAgent,
        messageId: probeMessageId,
        mqPayloadJson: JSON.stringify({ message_id: probeMessageId }),
      })
      expect(r.committed).toBe(true)
      expect(r.duplicateDedup).toBe(false)

      // metadata.to visible on a fresh connection → transaction committed.
      const after = await seedClient.query(
        `SELECT metadata->>'to' AS t FROM agent_messages WHERE id = $1::uuid`,
        [probeMessageId],
      )
      expect(after.rows[0].t).toBe(probeAgent)
      const mq = await seedClient.query(
        `SELECT id FROM message_queue WHERE agent_id = $1 AND message_id = $2`,
        [probeAgent, probeMessageId],
      )
      expect(mq.rows).toHaveLength(1)
    } finally {
      await seedClient.query(`DELETE FROM message_queue WHERE agent_id = $1`, [
        probeAgent,
      ])
      await seedClient.query(`DELETE FROM agent_messages WHERE id = $1::uuid`, [
        probeMessageId,
      ])
      await seedClient.end()
    }
  })

  test('persistInboundDelivery(databaseUrl, …) with stale messageId rolls back (update_no_match)', async () => {
    // Exercise BLOCKER 2 fix end-to-end: a messageId that doesn't exist in
    // agent_messages must not leave a queue row behind.
    const seedClient = new Client({ connectionString: DATABASE_URL })
    await seedClient.connect()
    const probeAgent = `probe-inbound-177-stale-${process.pid}-${Date.now()}`
    const staleMessageId = crypto.randomUUID() // never INSERTed
    try {
      const r = await persistInboundDelivery(DATABASE_URL!, {
        receiverAgentId: probeAgent,
        messageId: staleMessageId,
        mqPayloadJson: JSON.stringify({ message_id: staleMessageId }),
      })
      expect(r.committed).toBe(false)
      expect(r.error).toBe('update_no_match')

      const mq = await seedClient.query(
        `SELECT id FROM message_queue WHERE agent_id = $1 AND message_id = $2`,
        [probeAgent, staleMessageId],
      )
      expect(mq.rows).toHaveLength(0)
    } finally {
      await seedClient.query(`DELETE FROM message_queue WHERE agent_id = $1`, [
        probeAgent,
      ])
      await seedClient.end()
    }
  })
})
