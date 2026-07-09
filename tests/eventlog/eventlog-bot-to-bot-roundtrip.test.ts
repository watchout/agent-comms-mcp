// V2 bot↔bot round-trip fixture — the owner's isolation question made
// executable: can two seats exchange messages FAST with ZERO Discord?
//
// A "loopback transport" plays the delivery role the Discord bridge will
// play later: when seat B's reply is dispatched from the outbox, it lands
// as seat A's next inbound (receiveMessage). Everything else is the real
// V2 machinery — dual-written receive events, pull-claim, transactional
// outbox, delivery evidence. No Discord, no daemon, no terminal input.
//
// Measures and fail-closes on:
//   - full conversation round-trip latency (A sends → B claims → B replies
//     → delivery → A receives → A claims), p95 budget
//   - burst throughput (N messages drained end-to-end)
//   - integrity: every turn exactly once, every reply delivered exactly
//     once, causation traceable — at speed, not just in single-shot tests

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import {
  ensureEventLogSchema,
  receiveMessage,
  openTurnCount,
  pendingDeliveries,
  dispatchOutboxOnce,
  type OutboxDelivery,
  type OutboxTransport,
} from '../../core/eventlog'
import { runSeatWorkerOnce, type TurnRuntime } from '../../core/eventlog/worker'

function p95(samples: number[]): number {
  const s = [...samples].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]
}

/** Delivers B's outbound reply as A's inbound — the Discord seam, minus Discord. */
class LoopbackTransport implements OutboxTransport {
  sends: OutboxDelivery[] = []
  private byNonce = new Map<string, string>()
  constructor(
    private db: SqliteAdapter,
    private route: (delivery: OutboxDelivery) => { toSeat: string } | null,
  ) {}
  async send(delivery: OutboxDelivery) {
    const existing = this.byNonce.get(delivery.nonce)
    if (existing) return { transportMessageId: existing }
    const id = `loop-${this.sends.length + 1}`
    this.sends.push(delivery)
    this.byNonce.set(delivery.nonce, id)
    const target = this.route(delivery)
    if (target) {
      await receiveMessage(this.db, {
        messageId: `${delivery.replyId}#delivered`,
        seatId: target.toSeat,
        conversationId: delivery.channelExternalId ?? 'loop',
        payload: { content: delivery.content, author_id: 'peer', channel_id: delivery.channelExternalId },
      })
    }
    return { transportMessageId: id }
  }
}

describe('bot↔bot round-trip with zero Discord', () => {
  test('50-round ping-pong: full conversation cycle, measured, exactly-once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eventlog-b2b-'))
    const db = new SqliteAdapter(join(dir, 'b2b.db'))
    await ensureEventLogSchema(db)

    const ROUNDS = 50
    let pongs = 0
    // seat B: replies "pong <n>" to every ping
    const botB: TurnRuntime = {
      async runTurn({ turn }) {
        return {
          outcome: 'replied',
          replies: [{ content: `pong`, channelExternalId: 'chan-ab' }],
        }
      },
    }
    // seat A: counts pongs, replies "ping" until ROUNDS reached
    const botA: TurnRuntime = {
      async runTurn() {
        pongs++
        if (pongs >= ROUNDS) return { outcome: 'no_reply' }
        return { outcome: 'replied', replies: [{ content: 'ping', channelExternalId: 'chan-ab' }] }
      },
    }
    // replies from B route to A's inbox; replies from A route to B's
    const transport = new LoopbackTransport(db, d =>
      d.replyId.includes(':turn:bot-b:') || d.replyId.startsWith('reply:turn:bot-b')
        ? { toSeat: 'bot-a' }
        : { toSeat: 'bot-b' },
    )

    // kick off: A pings B
    await receiveMessage(db, {
      messageId: 'kick', seatId: 'bot-b', conversationId: 'chan-ab',
      payload: { content: 'ping', author_id: 'bot-a', channel_id: 'chan-ab' },
    })

    const roundTimes: number[] = []
    const started = performance.now()
    let guard = 0
    for (;;) {
      const t0 = performance.now()
      const b = await runSeatWorkerOnce(db, { seatId: 'bot-b', seatInstanceId: 'wb', runtime: botB, maxTurns: 5 })
      await dispatchOutboxOnce(db, transport, { dispatcherId: 'loop', dispatcherInstanceId: 'd1' })
      const a = await runSeatWorkerOnce(db, { seatId: 'bot-a', seatInstanceId: 'wa', runtime: botA, maxTurns: 5 })
      await dispatchOutboxOnce(db, transport, { dispatcherId: 'loop', dispatcherInstanceId: 'd1' })
      if (b.claimed + a.claimed > 0) roundTimes.push(performance.now() - t0)
      if (pongs >= ROUNDS && (await openTurnCount(db)) === 0 && (await pendingDeliveries(db)).length === 0) break
      if (++guard > ROUNDS * 4) throw new Error(`did not converge: pongs=${pongs}`)
    }
    const totalMs = performance.now() - started

    // exactly-once at speed
    const dup = await db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM (
         SELECT turn_id FROM event_log WHERE event_type = 'turn.completed' GROUP BY turn_id HAVING COUNT(*) > 1
       )`,
    )
    expect(dup[0].n).toBe(0)
    const delivered = await db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM event_log WHERE event_type = 'reply.delivered'`,
    )
    const enqueued = await db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM event_log WHERE event_type = 'reply.enqueued'`,
    )
    expect(delivered[0].n).toBe(enqueued[0].n) // zero lost sends
    expect(transport.sends.length).toBe(enqueued[0].n) // zero double sends
    expect(pongs).toBe(ROUNDS)

    const rtP95 = p95(roundTimes)
    const perLeg = totalMs / (ROUNDS * 2) // one leg = one bot processing + delivery
    console.log(
      `[b2b] ${ROUNDS} full rounds in ${totalMs.toFixed(0)}ms — ` +
      `round p95=${rtP95.toFixed(1)}ms, per-leg avg=${perLeg.toFixed(1)}ms, ` +
      `turns=${ROUNDS * 2} deliveries=${delivered[0].n}`,
    )
    // fail-closed budgets (generous vs observed; catch structural regressions)
    expect(rtP95).toBeLessThan(100)
    expect(totalMs).toBeLessThan(15_000)

    await db.close()
    rmSync(dir, { recursive: true, force: true })
  }, 60_000)

  test('burst: 100 inbound messages drain end-to-end with integrity', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eventlog-b2b-burst-'))
    const db = new SqliteAdapter(join(dir, 'burst.db'))
    await ensureEventLogSchema(db)

    const N = 100
    const t0 = performance.now()
    for (let i = 0; i < N; i++) {
      await receiveMessage(db, {
        messageId: `burst-${i}`, seatId: 'bot-b',
        conversationId: null, // independent work orders: freely claimable
        payload: { content: `job ${i}`, channel_id: 'chan-x' },
      })
    }
    const enqueueMs = performance.now() - t0

    const echo: TurnRuntime = {
      async runTurn({ turn }) {
        return { outcome: 'replied', replies: [{ content: `done ${turn.message_id}`, channelExternalId: 'chan-x' }] }
      },
    }
    const transport = new LoopbackTransport(db, () => null) // deliver only, no loop
    const t1 = performance.now()
    let guard = 0
    while ((await openTurnCount(db)) > 0 || (await pendingDeliveries(db)).length > 0) {
      await runSeatWorkerOnce(db, { seatId: 'bot-b', seatInstanceId: 'w1', runtime: echo, maxTurns: 25 })
      await dispatchOutboxOnce(db, transport, { dispatcherId: 'loop', dispatcherInstanceId: 'd1' })
      if (++guard > 50) throw new Error('burst did not drain')
    }
    const drainMs = performance.now() - t1

    expect(transport.sends.length).toBe(N)
    const completions = await db.query<{ n: number }>(
      `SELECT COUNT(DISTINCT turn_id) AS n FROM event_log WHERE event_type = 'turn.completed'`,
    )
    expect(completions[0].n).toBe(N)
    console.log(
      `[b2b-burst] enqueue ${N} in ${enqueueMs.toFixed(0)}ms (${(enqueueMs / N).toFixed(2)}ms/msg), ` +
      `process+deliver all in ${drainMs.toFixed(0)}ms (${(drainMs / N).toFixed(2)}ms/msg)`,
    )
    expect(drainMs).toBeLessThan(20_000)

    await db.close()
    rmSync(dir, { recursive: true, force: true })
  }, 60_000)
})
