// EventLogCore/v1 — runtime-switch continuity fixture (owner addendum
// 2026-07-08, #794 comment 4911839638 / SPEC-AUN-002 updated criterion).
//
// Mid-work, a seat's runtime engine is switched codex ↔ claude-code (one
// seat, new runtime instance — structurally a one-seat fleet-kill). Proves,
// FROM THE LOG ALONE:
//   - the new runtime instance resumes from the event log,
//   - the old runtime instance's claim is auto-released (identity-based),
//   - the in-flight turn completes exactly once, order preserved,
//   - outbox delivered exactly once — zero loss,
//   - a lingering old runtime is fenced out (its late write cannot land).
//
// The runtime engine is identity data on the seat instance
// (seat_instance_id = "<engine>-<generation>"), not behavior — which is
// exactly why switching the model "just works": the log does not care what
// engine holds the baton, only which instance identity does.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { spawn } from 'bun'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import {
  ensureEventLogSchema,
  receiveMessage,
  claimNextTurn,
  completeTurn,
  recoverSeatClaims,
  openTurnCount,
  pendingDeliveries,
  dispatchOutboxOnce,
  StaleClaimError,
  type OutboxDelivery,
  type OutboxTransport,
  type StoredEvent,
} from '../../core/eventlog'

const WORKER = join(import.meta.dir, 'fixtures', 'eventlog-worker.ts')
const SEAT = 'kodama'
const MESSAGES = 12

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

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

let dir: string
let dbPath: string
let db: SqliteAdapter

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'eventlog-rtswitch-'))
  dbPath = join(dir, 'switch.db')
  db = new SqliteAdapter(dbPath)
  await ensureEventLogSchema(db)
})

afterEach(async () => {
  await db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('runtime-switch continuity (codex ↔ claude-code)', () => {
  test(
    'switch mid-work: new runtime resumes from the log, old claim auto-released, zero loss',
    async () => {
      // seed a serialized conversation plus independent work orders
      for (let i = 0; i < MESSAGES; i++) {
        await receiveMessage(db, {
          messageId: `m${i}`,
          seatId: SEAT,
          conversationId: i % 2 === 0 ? 'conv-main' : null,
        })
      }

      // old runtime (engine: codex) works part of the backlog, then is
      // mid-turn — holding a live claim — when the switch happens
      const codex = { seatId: SEAT, seatInstanceId: 'codex-1' }
      for (let i = 0; i < 3; i++) {
        const c = await claimNextTurn(db, codex)
        await completeTurn(db, {
          turnId: c!.turn.turn_id,
          seatId: SEAT,
          seatInstanceId: codex.seatInstanceId,
          claimEventId: c!.claimEventId,
          outcome: 'replied',
          conversationId: c!.turn.conversation_id,
          replies: [{ content: `by codex-1: ${c!.turn.message_id}`, channelExternalId: 'chan-1' }],
        })
      }
      const inFlight = await claimNextTurn(db, codex)
      expect(inFlight).not.toBeNull() // codex-1 holds this turn when the swap lands
      const openAtSwitch = await openTurnCount(db, { seatId: SEAT })
      expect(openAtSwitch).toBe(MESSAGES - 3)

      // THE SWITCH: runtime_engine_preference flips; the supervisor tears
      // down codex-1 and starts a claude-code instance for the same seat.
      // The new instance is a real subprocess whose ONLY input is the log.
      const claude = spawn({
        cmd: ['bun', WORKER, '--db', dbPath, '--seat', SEAT, '--instance', 'claude-code-1'],
        stdout: 'inherit',
        stderr: 'inherit',
      })
      const deadline = Date.now() + 30_000
      while ((await openTurnCount(db, { seatId: SEAT })) > 0) {
        if (Date.now() > deadline) throw new Error('new runtime did not drain the seat')
        await sleep(25)
      }
      await claude.exited // worker exits 0 when the inbox is empty

      // OLD CLAIM AUTO-RELEASED, identity-based: the release was appended by
      // the NEW instance, names the old instance's claim as causation, and
      // carries the recovery reason — all read from the log alone
      const release = await db.queryOne<StoredEvent>(
        `SELECT * FROM event_log
         WHERE event_type = 'turn.claim_released' AND turn_id = $1 AND claim_epoch = $2`,
        [inFlight!.turn.turn_id, inFlight!.claimEpoch],
      )
      expect(release).not.toBeNull()
      expect(release!.causation_id).toBe(inFlight!.claimEventId)
      expect(release!.seat_instance_id).toBe('claude-code-1')
      expect(JSON.parse(release!.payload).reason).toBe('seat_instance_recovery')

      // IN-FLIGHT TURN COMPLETED EXACTLY ONCE — by the new engine
      const inFlightDone = await db.query<StoredEvent>(
        `SELECT * FROM event_log WHERE event_type = 'turn.completed' AND turn_id = $1`,
        [inFlight!.turn.turn_id],
      )
      expect(inFlightDone.length).toBe(1)
      expect(inFlightDone[0].seat_instance_id).toBe('claude-code-1')

      // ZERO LOSS: every seeded turn completed exactly once, split across
      // exactly the two engine instances
      const completions = await db.query<{ turn_id: string; n: number }>(
        `SELECT turn_id, COUNT(*) AS n FROM event_log
         WHERE event_type = 'turn.completed' GROUP BY turn_id`,
      )
      expect(completions.length).toBe(MESSAGES)
      expect(completions.every(c => c.n === 1)).toBe(true)
      const byInstance = await db.query<{ seat_instance_id: string; n: number }>(
        `SELECT seat_instance_id, COUNT(*) AS n FROM event_log
         WHERE event_type = 'turn.completed' GROUP BY seat_instance_id`,
      )
      expect(new Map(byInstance.map(r => [r.seat_instance_id, r.n])).get('codex-1')).toBe(3)
      expect(new Map(byInstance.map(r => [r.seat_instance_id, r.n])).get('claude-code-1')).toBe(MESSAGES - 3)

      // ORDER PRESERVED across the engine boundary: conv-main completions
      // happened in received order even though two engines processed them
      const order = await db.query<{ recv_seq: number; done_seq: number }>(
        `SELECT r.seq AS recv_seq, d.seq AS done_seq
         FROM event_log r
         JOIN event_log d ON d.event_type = 'turn.completed' AND d.turn_id = r.turn_id
         WHERE r.event_type = 'message.received' AND r.conversation_id = 'conv-main'
         ORDER BY r.seq ASC`,
      )
      const doneSeqs = order.map(o => o.done_seq)
      expect([...doneSeqs].sort((a, b) => a - b)).toEqual(doneSeqs)

      // OUTBOX DELIVERED EXACTLY ONCE — including replies enqueued by the
      // old engine before the switch
      const transport = new NonceDedupTransport()
      let guard = 0
      while ((await pendingDeliveries(db)).length > 0) {
        if (++guard > 20) throw new Error('outbox did not drain')
        await dispatchOutboxOnce(db, transport, {
          dispatcherId: 'outbox', dispatcherInstanceId: 'd1',
        })
      }
      expect(transport.sends.length).toBe(MESSAGES)
      const delivered = await db.query<{ reply_id: string; n: number }>(
        `SELECT reply_id, COUNT(*) AS n FROM event_log
         WHERE event_type = 'reply.delivered' GROUP BY reply_id`,
      )
      expect(delivered.length).toBe(MESSAGES)
      expect(delivered.every(r => r.n === 1)).toBe(true)

      // LINGERING OLD RUNTIME IS FENCED: codex-1 comes back from the dead
      // and tries to land its stale completion — rejected, log unchanged
      expect(
        completeTurn(db, {
          turnId: inFlight!.turn.turn_id,
          seatId: SEAT,
          seatInstanceId: 'codex-1',
          claimEventId: inFlight!.claimEventId,
          outcome: 'replied',
          replies: [{ content: 'stale duplicate from the old engine' }],
        }),
      ).rejects.toThrow(StaleClaimError)
      const stillOne = await db.query(
        `SELECT * FROM event_log WHERE event_type = 'turn.completed' AND turn_id = $1`,
        [inFlight!.turn.turn_id],
      )
      expect(stillOne.length).toBe(1)
    },
    60_000,
  )

  test('reverse switch (claude-code → codex) is symmetric: engine is identity data, not behavior', async () => {
    await receiveMessage(db, { messageId: 'm1', seatId: SEAT, conversationId: 'c1' })
    const claude = { seatId: SEAT, seatInstanceId: 'claude-code-7' }
    const inFlight = await claimNextTurn(db, claude)
    expect(inFlight).not.toBeNull()

    // switch back to codex: new instance recovers the baton and finishes
    const released = await recoverSeatClaims(db, { seatId: SEAT, activeInstanceId: 'codex-8' })
    expect(released.length).toBe(1)
    const reclaimed = await claimNextTurn(db, { seatId: SEAT, seatInstanceId: 'codex-8' })
    expect(reclaimed?.turn.turn_id).toBe(inFlight!.turn.turn_id)
    await completeTurn(db, {
      turnId: reclaimed!.turn.turn_id,
      seatId: SEAT,
      seatInstanceId: 'codex-8',
      claimEventId: reclaimed!.claimEventId,
      outcome: 'replied',
      conversationId: 'c1',
      replies: [{ content: 'finished on codex' }],
    })
    expect(await openTurnCount(db, { seatId: SEAT })).toBe(0)

    // and the superseded claude-code claim is fenced
    expect(
      completeTurn(db, {
        turnId: inFlight!.turn.turn_id,
        seatId: SEAT,
        seatInstanceId: 'claude-code-7',
        claimEventId: inFlight!.claimEventId,
        outcome: 'replied',
      }),
    ).rejects.toThrow(StaleClaimError)
  })
})
