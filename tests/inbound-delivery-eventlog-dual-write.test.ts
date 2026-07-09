#!/usr/bin/env bun
/**
 * V2 cutover M1 fixtures — EventLogCore dual-write inside the inbound
 * delivery transaction (owner GO: #794 comment 4923054432).
 *
 * Pins:
 *   1. With conversationId set, the transaction order is
 *      BEGIN / UPDATE / INSERT message_queue / INSERT event_log
 *      (message.received) / COMMIT — the event append is INSIDE the txn.
 *   2. Auto-skip deliveries also append turn.completed(outcome=skipped)
 *      so the V2 queue_view never reports them as open work.
 *   3. Without conversationId, NO event_log statement runs (legacy
 *      callers/tests bit-for-bit unaffected).
 *   4. Deterministic event ids: recv:<seat>:<messageId> / done:turn:… with
 *      ON CONFLICT (event_id) DO NOTHING → redelivery appends nothing.
 *   5. An event_log INSERT failure rolls back the WHOLE delivery
 *      (one-transaction dual-write per Option B: no window where V1 has
 *      the row and V2 does not).
 *
 * DB integration (real PG event_log round-trip incl. the append-only
 * trigger) runs only when DATABASE_URL is set.
 */
import { describe, test, expect } from 'bun:test'
import {
  persistInboundDeliveryOnClient,
  type InboundDeliveryClient,
} from '../core/inbound-delivery'

type Call = { sql: string; params?: any[] }

function mockClient(behavior: { throwOnEventLog?: boolean } = {}) {
  const calls: Call[] = []
  const client: InboundDeliveryClient = {
    async query(sql: string, params?: any[]) {
      calls.push({ sql, params })
      const stmt = sql.trim()
      if (/^INSERT INTO event_log/.test(stmt) && behavior.throwOnEventLog) {
        throw new Error('event_log insert boom')
      }
      if (/^UPDATE agent_messages/.test(stmt)) return { rows: [], rowCount: 1 }
      if (/^INSERT INTO message_queue/.test(stmt)) return { rows: [{ id: 1 }], rowCount: 1 }
      if (/^INSERT INTO event_log/.test(stmt)) return { rows: [], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    },
  }
  return { client, calls }
}

const BASE = {
  receiverAgentId: 'kodama',
  messageId: 'aaaaaaaa-0000-0000-0000-000000000001',
  mqPayloadJson: JSON.stringify({ channel_id: 'chan-1', content: 'hi', message_id: 'aaaaaaaa-0000-0000-0000-000000000001' }),
}

describe('M1 dual-write sequencing (mock client)', () => {
  test('event_log append runs INSIDE the transaction, before COMMIT', async () => {
    const { client, calls } = mockClient()
    const r = await persistInboundDeliveryOnClient(client, {
      ...BASE,
      conversationId: 'chan-1',
    })
    expect(r.committed).toBe(true)
    const kinds = calls.map(c => c.sql.trim().split(/[\s(]/)[0] + ':' + (c.sql.match(/event_log|message_queue|agent_messages/)?.[0] ?? c.sql.trim()))
    expect(kinds[0]).toStartWith('BEGIN')
    expect(calls[calls.length - 1].sql).toBe('COMMIT')
    const eventIdx = calls.findIndex(c => /INSERT INTO event_log/.test(c.sql))
    const commitIdx = calls.findIndex(c => c.sql === 'COMMIT')
    const mqIdx = calls.findIndex(c => /INSERT INTO message_queue/.test(c.sql))
    expect(eventIdx).toBeGreaterThan(mqIdx)
    expect(eventIdx).toBeLessThan(commitIdx)
    // deterministic ids + conflict-target dedup
    const ev = calls[eventIdx]
    expect(ev.params?.[0]).toBe('recv:kodama:aaaaaaaa-0000-0000-0000-000000000001')
    expect(ev.sql).toContain('ON CONFLICT (event_id) DO NOTHING')
    expect(ev.params?.[4]).toBe('turn:kodama:aaaaaaaa-0000-0000-0000-000000000001')
  })

  test('auto-skip also appends turn.completed(outcome=skipped)', async () => {
    const { client, calls } = mockClient()
    const r = await persistInboundDeliveryOnClient(client, {
      ...BASE,
      conversationId: 'chan-1',
      skipReason: 'AUTO_SKIP_PATTERN:test',
    })
    expect(r.committed).toBe(true)
    const eventCalls = calls.filter(c => /INSERT INTO event_log/.test(c.sql))
    expect(eventCalls.length).toBe(2)
    expect(eventCalls[0].sql).toContain("'message.received'")
    expect(eventCalls[1].sql).toContain("'turn.completed'")
    const donePayload = JSON.parse(eventCalls[1].params?.[6])
    expect(donePayload.outcome).toBe('skipped')
    // causation chains the completion to the receive event
    expect(eventCalls[1].params?.[3]).toBe('recv:kodama:aaaaaaaa-0000-0000-0000-000000000001')
  })

  test('WITHOUT conversationId no event_log statement runs (legacy path unchanged)', async () => {
    const { client, calls } = mockClient()
    const r = await persistInboundDeliveryOnClient(client, { ...BASE })
    expect(r.committed).toBe(true)
    expect(calls.some(c => /event_log/.test(c.sql))).toBe(false)
  })

  test('event_log failure rolls back the WHOLE delivery (one-txn dual-write)', async () => {
    const { client, calls } = mockClient({ throwOnEventLog: true })
    const r = await persistInboundDeliveryOnClient(client, {
      ...BASE,
      conversationId: 'chan-1',
    })
    expect(r.committed).toBe(false)
    expect(calls.some(c => c.sql === 'ROLLBACK')).toBe(true)
    expect(calls.some(c => c.sql === 'COMMIT')).toBe(false)
  })
})

const DATABASE_URL = process.env.DATABASE_URL

describe.if(!!DATABASE_URL)('M1 dual-write DB integration (PostgreSQL)', () => {
  test('event_log row lands with the delivery, dedups on retry, and rejects UPDATE/DELETE', async () => {
    const { Client } = await import('pg')
    const client = new Client({ connectionString: DATABASE_URL })
    await client.connect()
    const probeAgent = `m1-probe-${Date.now()}`
    try {
      // probe agent_messages row (7b target)
      const msg = await client.query(
        `INSERT INTO agent_messages (channel_id, author_id, content, metadata) VALUES ('m1-chan', 'm1-sender', 'm1 probe', '{}'::jsonb) RETURNING id`,
      )
      const messageId = msg.rows[0].id as string
      const params = {
        receiverAgentId: probeAgent,
        messageId,
        mqPayloadJson: JSON.stringify({ channel_id: 'm1-chan', content: 'm1 probe', message_id: messageId }),
        conversationId: 'm1-chan',
      }
      const first = await persistInboundDeliveryOnClient(client, params)
      expect(first.committed).toBe(true)
      const ev = await client.query(
        `SELECT event_type, seat_id, conversation_id, turn_id FROM event_log WHERE event_id = $1`,
        [`recv:${probeAgent}:${messageId}`],
      )
      expect(ev.rowCount).toBe(1)
      expect(ev.rows[0].event_type).toBe('message.received')
      expect(ev.rows[0].conversation_id).toBe('m1-chan')

      // redelivery: V1 dedups via uq_mq_agent_message, V2 via event_id
      const second = await persistInboundDeliveryOnClient(client, params)
      expect(second.committed).toBe(true)
      expect(second.duplicateDedup).toBe(true)
      const evCount = await client.query(
        `SELECT COUNT(*)::int AS n FROM event_log WHERE event_id = $1`,
        [`recv:${probeAgent}:${messageId}`],
      )
      expect(evCount.rows[0].n).toBe(1)

      // append-only trigger enforced in PG
      await expect(
        client.query(`UPDATE event_log SET payload = '{}'::jsonb WHERE event_id = $1`, [`recv:${probeAgent}:${messageId}`]),
      ).rejects.toThrow(/append-only/)
      await expect(
        client.query(`DELETE FROM event_log WHERE event_id = $1`, [`recv:${probeAgent}:${messageId}`]),
      ).rejects.toThrow(/append-only/)
    } finally {
      await client.query(`DELETE FROM message_queue WHERE agent_id = $1`, [probeAgent]).catch(() => {})
      await client.end().catch(() => {})
    }
  })
})
