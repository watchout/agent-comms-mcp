// V2 cutover M3 fixtures — the pull-claim seat worker.
//
// Proves the owner's definition of receive-side health on the V2 design:
// a row lands (message.received) → an idle seat AUTOMATICALLY claims,
// runs its runtime, terminal-closes with replies, and the outbox delivers
// — zero terminal input anywhere, no push, no wake dependency.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import {
  ensureEventLogSchema,
  receiveMessage,
  openTurnCount,
  pendingDeliveries,
  type OutboxDelivery,
  type OutboxTransport,
} from '../../core/eventlog'
import {
  recoverSeat,
  runSeatWorkerOnce,
  runV2Tick,
  turnInboundPayload,
  type TurnRuntime,
} from '../../core/eventlog/worker'

let dir: string
let db: SqliteAdapter

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'eventlog-m3-'))
  db = new SqliteAdapter(join(dir, 'v2.db'))
  await ensureEventLogSchema(db)
})

afterEach(async () => {
  await db.close()
  rmSync(dir, { recursive: true, force: true })
})

class RecordingTransport implements OutboxTransport {
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

const echoRuntime: TurnRuntime = {
  async runTurn({ turn }) {
    return {
      outcome: 'replied',
      replies: [{ content: `echo:${turn.message_id}`, channelExternalId: 'chan-1' }],
    }
  },
}

describe('M3 pull-claim seat worker', () => {
  test('row lands → worker claims, completes, outbox delivers — zero manual steps', async () => {
    for (const m of ['m1', 'm2', 'm3']) {
      await receiveMessage(db, { messageId: m, seatId: 'kodama', conversationId: 'chan-1' })
    }
    const transport = new RecordingTransport()
    const tick = await runV2Tick(db, {
      seats: [{ seatId: 'kodama', runtime: echoRuntime }],
      instanceId: 'w1',
      transport,
    })
    expect(tick.seatResults.kodama.completed).toBe(3)
    expect(await openTurnCount(db)).toBe(0)
    expect(transport.sends.map(s => s.content).sort()).toEqual(['echo:m1', 'echo:m2', 'echo:m3'])
    expect((await pendingDeliveries(db)).length).toBe(0)
  })

  test('two worker instances hand over a seat without double-processing (claim arbiter)', async () => {
    // NOTE: true same-instant concurrency on one seat is proven by the
    // SUBPROCESS fixtures (fleet-kill / runtime-switch) — in-process
    // parallel SQLite transactions on one event loop would deadlock on the
    // sync BEGIN IMMEDIATE busy-wait, which is not the production shape
    // (separate processes / async PG driver). This case pins the arbiter
    // across a bounded-pass handover between two instances.
    for (let i = 0; i < 6; i++) {
      await receiveMessage(db, { messageId: `m${i}`, seatId: 'kodama' })
    }
    const a = await runSeatWorkerOnce(db, {
      seatId: 'kodama', seatInstanceId: 'wA', runtime: echoRuntime, maxTurns: 3,
    })
    const b = await runSeatWorkerOnce(db, {
      seatId: 'kodama', seatInstanceId: 'wB', runtime: echoRuntime,
    })
    expect(a.completed).toBe(3)
    expect(b.completed).toBe(3)
    const completions = await db.query<{ turn_id: string; n: number }>(
      `SELECT turn_id, COUNT(*) AS n FROM event_log WHERE event_type = 'turn.completed' GROUP BY turn_id`,
    )
    expect(completions.length).toBe(6)
    expect(completions.every(c => c.n === 1)).toBe(true)
  })

  test('runtime crash → turn closes as failed, worker keeps going (no stall)', async () => {
    await receiveMessage(db, { messageId: 'boom', seatId: 'kodama' })
    await receiveMessage(db, { messageId: 'ok', seatId: 'kodama' })
    const flaky: TurnRuntime = {
      async runTurn({ turn }) {
        if (turn.message_id === 'boom') throw new Error('runtime crashed')
        return { outcome: 'no_reply' }
      },
    }
    const r = await runSeatWorkerOnce(db, { seatId: 'kodama', seatInstanceId: 'w1', runtime: flaky })
    expect(r.failed).toBe(1)
    expect(r.completed).toBe(1)
    expect(await openTurnCount(db)).toBe(0) // failed is TERMINAL, not stuck
  })

  test('worker restart resumes mid-inbox via identity recovery (no timers)', async () => {
    for (let i = 0; i < 4; i++) {
      await receiveMessage(db, { messageId: `m${i}`, seatId: 'kodama' })
    }
    // gen1 claims one turn and dies before completing
    const { claimNextTurn } = await import('../../core/eventlog')
    const orphan = await claimNextTurn(db, { seatId: 'kodama', seatInstanceId: 'gen1' })
    expect(orphan).not.toBeNull()

    // gen2 starts: recover → drain
    await recoverSeat(db, { seatId: 'kodama', seatInstanceId: 'gen2' })
    const r = await runSeatWorkerOnce(db, { seatId: 'kodama', seatInstanceId: 'gen2', runtime: echoRuntime })
    expect(r.completed).toBe(4)
    expect(await openTurnCount(db)).toBe(0)
  })

  test('multi-seat tick: each seat gets its own runtime; one outbox drain', async () => {
    await receiveMessage(db, { messageId: 'a1', seatId: 'kodama', conversationId: 'c1' })
    await receiveMessage(db, { messageId: 'b1', seatId: 'kusabi', conversationId: 'c2' })
    const transport = new RecordingTransport()
    const tick = await runV2Tick(db, {
      seats: [
        { seatId: 'kodama', runtime: echoRuntime },
        { seatId: 'kusabi', runtime: echoRuntime },
      ],
      instanceId: 'w1',
      transport,
    })
    expect(tick.seatResults.kodama.completed).toBe(1)
    expect(tick.seatResults.kusabi.completed).toBe(1)
    expect(tick.dispatch.delivered.length).toBe(2)
  })

  test('turnInboundPayload exposes the dual-written inbound envelope to the runtime', async () => {
    await receiveMessage(db, {
      messageId: 'm1', seatId: 'kodama', conversationId: 'thread-9',
      payload: { channel_id: 'chan-1', thread_id: 'thread-9', author_id: 'ceo', content: 'やって' },
    })
    let seen: Record<string, unknown> = {}
    const inspecting: TurnRuntime = {
      async runTurn({ turn }) {
        seen = await turnInboundPayload(db, turn)
        return { outcome: 'no_reply' }
      },
    }
    await runSeatWorkerOnce(db, { seatId: 'kodama', seatInstanceId: 'w1', runtime: inspecting })
    expect(seen.content).toBe('やって')
    expect(seen.author_id).toBe('ceo')
    expect(seen.thread_id).toBe('thread-9')
  })
})
