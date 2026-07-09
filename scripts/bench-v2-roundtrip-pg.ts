// One-off honest benchmark: the SAME bot↔bot round-trip as the SQLite
// fixture, against a REAL local PostgreSQL (throwaway bench DB — never the
// production database). First live-PG execution of the whole EventLogCore
// stack (store / claim / views / outbox on the postgres dialect path).
//
// Usage: bun scripts/bench-v2-roundtrip-pg.ts postgresql:///aun_v2_bench?host=/tmp

import { PgAdapter } from '../core/db/pg-adapter'
import {
  receiveMessage,
  openTurnCount,
  pendingDeliveries,
  dispatchOutboxOnce,
  type OutboxDelivery,
  type OutboxTransport,
} from '../core/eventlog'
import { runSeatWorkerOnce, type TurnRuntime } from '../core/eventlog/worker'

const url = process.argv[2]
if (!url || url.includes('agent_comms?') || url.endsWith('/agent_comms')) {
  console.error('refusing: pass an explicit THROWAWAY bench database url')
  process.exit(1)
}
const db = new PgAdapter(url)

function p95(samples: number[]): number {
  const s = [...samples].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]
}

class LoopbackTransport implements OutboxTransport {
  sends: OutboxDelivery[] = []
  private byNonce = new Map<string, string>()
  async send(delivery: OutboxDelivery) {
    const existing = this.byNonce.get(delivery.nonce)
    if (existing) return { transportMessageId: existing }
    const id = `loop-${this.sends.length + 1}`
    this.sends.push(delivery)
    this.byNonce.set(delivery.nonce, id)
    const toSeat = delivery.replyId.includes('turn:bot-b:') ? 'bot-a' : 'bot-b'
    await receiveMessage(db, {
      messageId: `${delivery.replyId}#delivered`,
      seatId: toSeat,
      conversationId: delivery.channelExternalId ?? 'loop',
      payload: { content: delivery.content, author_id: 'peer', channel_id: delivery.channelExternalId },
    })
    return { transportMessageId: id }
  }
}

const ROUNDS = 50
let pongs = 0
const botB: TurnRuntime = {
  async runTurn() {
    return { outcome: 'replied', replies: [{ content: 'pong', channelExternalId: 'chan-ab' }] }
  },
}
const botA: TurnRuntime = {
  async runTurn() {
    pongs++
    if (pongs >= ROUNDS) return { outcome: 'no_reply' }
    return { outcome: 'replied', replies: [{ content: 'ping', channelExternalId: 'chan-ab' }] }
  },
}

const transport = new LoopbackTransport()
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

const dup = await db.queryOne<{ n: string }>(
  `SELECT COUNT(*) AS n FROM (
     SELECT turn_id FROM event_log WHERE event_type = 'turn.completed' GROUP BY turn_id HAVING COUNT(*) > 1
   ) d`,
)
const delivered = await db.queryOne<{ n: string }>(`SELECT COUNT(*) AS n FROM event_log WHERE event_type = 'reply.delivered'`)
const enqueued = await db.queryOne<{ n: string }>(`SELECT COUNT(*) AS n FROM event_log WHERE event_type = 'reply.enqueued'`)

console.log(JSON.stringify({
  db: 'postgres(local socket, throwaway bench db)',
  rounds: ROUNDS,
  total_ms: Math.round(totalMs),
  round_p95_ms: Number(p95(roundTimes).toFixed(1)),
  per_leg_avg_ms: Number((totalMs / (ROUNDS * 2)).toFixed(1)),
  duplicate_completions: Number(dup?.n ?? -1),
  delivered: Number(delivered?.n ?? -1),
  enqueued: Number(enqueued?.n ?? -1),
  double_sends: transport.sends.length - Number(enqueued?.n ?? 0),
}, null, 2))
await db.close()
