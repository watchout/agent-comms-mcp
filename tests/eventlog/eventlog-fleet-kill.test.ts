// EventLogCore/v1 — fleet-kill recovery fixture (the killer demo).
//
// Proves the SPEC-AUN-002 headline criterion: kill the WHOLE fleet with
// SIGKILL mid-work, restart it, and state is fully rebuilt from the log
// with zero lost work, zero double-processing, and zero double-sends.
//
// Real subprocesses, real SIGKILL, one shared SQLite file. No mocks in the
// crash path.

import { describe, test, expect } from 'bun:test'
import { spawn, type Subprocess } from 'bun'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import {
  ensureEventLogSchema,
  receiveMessage,
  openTurnCount,
  queueView,
  pendingDeliveries,
  dispatchOutboxOnce,
  recoverDispatcherClaims,
  type OutboxDelivery,
  type OutboxTransport,
} from '../../core/eventlog'

const WORKER = join(import.meta.dir, 'fixtures', 'eventlog-worker.ts')
const SEATS = ['kodama', 'lead'] as const
const MESSAGES_PER_SEAT = 30
const TOTAL_TURNS = SEATS.length * MESSAGES_PER_SEAT

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function spawnWorker(dbPath: string, seat: string, instance: string): Subprocess {
  return spawn({
    cmd: ['bun', WORKER, '--db', dbPath, '--seat', seat, '--instance', instance],
    stdout: 'inherit',
    stderr: 'inherit',
  })
}

class NonceDedupTransport implements OutboxTransport {
  sends: OutboxDelivery[] = []
  private byNonce = new Map<string, string>()
  async send(delivery: OutboxDelivery) {
    const existing = this.byNonce.get(delivery.nonce)
    if (existing) return { transportMessageId: existing }
    const id = `wire-${this.sends.length + 1}`
    this.sends.push(delivery)
    this.byNonce.set(delivery.nonce, id)
    return { transportMessageId: id }
  }
}

describe('fleet-kill recovery', () => {
  test(
    'SIGKILL the whole fleet twice mid-work → restart → zero lost work, zero duplicates',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'eventlog-fleetkill-'))
      const dbPath = join(dir, 'fleet.db')
      const db = new SqliteAdapter(dbPath)
      await ensureEventLogSchema(db)

      // seed the work: conversations force serialized turns, plus loose ones
      for (const seat of SEATS) {
        for (let i = 0; i < MESSAGES_PER_SEAT; i++) {
          await receiveMessage(db, {
            messageId: `m-${seat}-${i}`,
            seatId: seat,
            // 3 conversations per seat + independent work orders
            conversationId: i % 2 === 0 ? `conv-${seat}-${i % 3}` : null,
          })
        }
      }
      expect(await openTurnCount(db)).toBe(TOTAL_TURNS)

      // generations 1 and 2: let the fleet work, then SIGKILL everything
      for (const gen of [1, 2]) {
        const fleet = SEATS.map(seat => spawnWorker(dbPath, seat, `${seat}-gen${gen}`))
        await sleep(120) // mid-work: some turns done, some claimed, some untouched
        for (const p of fleet) p.kill('SIGKILL')
        await Promise.all(fleet.map(p => p.exited))
      }
      const doneAfterKills = TOTAL_TURNS - (await openTurnCount(db))
      // sanity: the kills landed mid-stream, not after all work finished
      expect(doneAfterKills).toBeLessThan(TOTAL_TURNS)

      // final generation: restart and let it drain to zero
      const fleet = SEATS.map(seat => spawnWorker(dbPath, seat, `${seat}-gen3`))
      const deadline = Date.now() + 60_000
      while ((await openTurnCount(db)) > 0) {
        if (Date.now() > deadline) throw new Error('fleet did not drain in time')
        await sleep(50)
      }
      for (const p of fleet) p.kill('SIGKILL')
      await Promise.all(fleet.map(p => p.exited))

      // ZERO LOST WORK: every seeded turn has exactly one completion
      const completions = await db.query<{ turn_id: string; n: number }>(
        `SELECT turn_id, COUNT(*) AS n FROM event_log
         WHERE event_type = 'turn.completed' GROUP BY turn_id`,
      )
      expect(completions.length).toBe(TOTAL_TURNS)
      expect(completions.every(c => c.n === 1)).toBe(true)

      // ZERO DOUBLE-PROCESSING: one reply enqueued per turn, no extras
      const enqueued = await db.query<{ turn_id: string; n: number }>(
        `SELECT turn_id, COUNT(*) AS n FROM event_log
         WHERE event_type = 'reply.enqueued' GROUP BY turn_id`,
      )
      expect(enqueued.length).toBe(TOTAL_TURNS)
      expect(enqueued.every(c => c.n === 1)).toBe(true)

      // PER-CONVERSATION ORDER survived the kills: completions in a
      // conversation happened in received order
      const convs = await db.query<{ conversation_id: string }>(
        `SELECT DISTINCT conversation_id FROM event_log
         WHERE event_type = 'message.received' AND conversation_id IS NOT NULL`,
      )
      for (const { conversation_id } of convs) {
        const order = await db.query<{ turn_id: string; recv_seq: number; done_seq: number }>(
          `SELECT r.turn_id, r.seq AS recv_seq, d.seq AS done_seq
           FROM event_log r
           JOIN event_log d ON d.event_type = 'turn.completed' AND d.turn_id = r.turn_id
           WHERE r.event_type = 'message.received' AND r.conversation_id = $1
           ORDER BY r.seq ASC`,
          [conversation_id],
        )
        const doneSeqs = order.map(o => o.done_seq)
        expect([...doneSeqs].sort((a, b) => a - b)).toEqual(doneSeqs)
      }

      // OUTBOX after the crashes: a fresh dispatcher instance recovers any
      // stale delivery claims and drains — every reply delivered exactly once
      const transport = new NonceDedupTransport()
      await recoverDispatcherClaims(db, { dispatcherId: 'outbox', activeInstanceId: 'd-final' })
      let guard = 0
      while ((await pendingDeliveries(db)).length > 0) {
        if (++guard > 20) throw new Error('outbox did not drain')
        await dispatchOutboxOnce(db, transport, {
          dispatcherId: 'outbox', dispatcherInstanceId: 'd-final',
        })
      }
      expect(transport.sends.length).toBe(TOTAL_TURNS) // ZERO DOUBLE-SEND
      const deliveredRows = await db.query<{ reply_id: string; n: number }>(
        `SELECT reply_id, COUNT(*) AS n FROM event_log
         WHERE event_type = 'reply.delivered' GROUP BY reply_id`,
      )
      expect(deliveredRows.length).toBe(TOTAL_TURNS)
      expect(deliveredRows.every(r => r.n === 1)).toBe(true)

      // STATE FULLY REBUILT FROM THE LOG: replay into a virgin DB and
      // compare projections — identical
      const rebuilt = new SqliteAdapter(join(dir, 'rebuilt.db'))
      await ensureEventLogSchema(rebuilt)
      const events = await db.query('SELECT * FROM event_log ORDER BY seq ASC')
      for (const e of events) {
        await rebuilt.execute(
          `INSERT INTO event_log (seq, event_id, event_type, occurred_at, seat_id,
             seat_instance_id, conversation_id, causation_id, correlation_id,
             turn_id, reply_id, claim_epoch, payload)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [e.seq, e.event_id, e.event_type, e.occurred_at, e.seat_id,
           e.seat_instance_id, e.conversation_id, e.causation_id, e.correlation_id,
           e.turn_id, e.reply_id, e.claim_epoch, e.payload],
        )
      }
      expect(await queueView(rebuilt)).toEqual(await queueView(db))
      expect(await openTurnCount(rebuilt)).toBe(0)
      expect((await pendingDeliveries(rebuilt)).length).toBe(0)

      await rebuilt.close()
      await db.close()
      rmSync(dir, { recursive: true, force: true })
    },
    120_000,
  )
})
