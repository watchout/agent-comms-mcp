// V2 receive-side LIVE PILOT (owner-GOed cutover, #794 comment 4923054432).
//
// Proves on PRODUCTION: pending V1 queue rows → imported as V2
// message.received events (same deterministic ids the M1 dual-write uses,
// so a later real dual-write dedups) → the V2 pull-claim worker processes
// them with REAL engines (claude-code AND codex — live engine symmetry) →
// replies delivered through the EXISTING typed notify path (full V1
// outbound machinery incl. Discord projection and ACLs).
//
// Bounded fail-closed scope: ONLY the queue rows whose ids are passed on
// the command line. Nothing else is read from or written to V1 tables.
//
// Usage: bun scripts/v2-live-pilot.ts <queue_id> [<queue_id> ...]

import { PgAdapter } from '../core/db/pg-adapter'
import { receiveMessage, openTurnCount, pendingDeliveries, dispatchOutboxOnce } from '../core/eventlog'
import { runSeatWorkerOnce } from '../core/eventlog/worker'
import { runtimeForEngine } from '../core/eventlog/runtimes'
import type { OutboxDelivery, OutboxTransport } from '../core/eventlog'
import { writeFileSync } from 'node:fs'

const queueIds = process.argv.slice(2).map(s => Number.parseInt(s, 10)).filter(n => Number.isInteger(n) && n > 0)
if (queueIds.length === 0) {
  console.error('usage: bun scripts/v2-live-pilot.ts <queue_id> ...')
  process.exit(1)
}

const db = new PgAdapter('postgresql:///agent_comms?host=/tmp')
const SCHEMA_PATH = '/tmp/v2-turn-result-v1.schema.json'
writeFileSync(SCHEMA_PATH, JSON.stringify({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'AUN v2_turn_result_v1',
  type: 'object',
  required: ['ok', 'outcome', 'reply'],
  properties: {
    ok: { type: 'boolean' },
    outcome: { type: 'string', enum: ['replied', 'no_reply'] },
    reply: { type: ['string', 'null'] },
  },
  additionalProperties: false,
}, null, 2))

// ── import: exact fenced V1 rows → V2 receive events (deterministic ids) ──
const rows = await db.query<{
  id: number; agent_id: string; message_id: string; payload: string
  channel_id: string | null; thread_id: string | null; author_id: string; content: string
}>(
  `SELECT mq.id, mq.agent_id, mq.message_id, mq.payload::text AS payload,
          am.channel_id, am.thread_id, am.author_id, am.content
   FROM message_queue mq JOIN agent_messages am ON am.id::text = mq.message_id
   WHERE mq.id = ANY($1) AND mq.status = 'pending'`,
  [queueIds],
)
console.log(`importing ${rows.length}/${queueIds.length} pending rows into V2`)
const t0 = performance.now()
for (const row of rows) {
  await receiveMessage(db, {
    messageId: row.message_id,
    seatId: row.agent_id,
    conversationId: row.thread_id ?? row.channel_id ?? 'unknown',
    payload: {
      channel_id: row.channel_id, thread_id: row.thread_id,
      author_id: row.author_id, content: row.content,
      v1_queue_id: row.id, pilot: 'v2-live-pilot',
    },
  })
}

// ── transport: existing typed notify path (V1 outbound + Discord + ACLs) ──
const CLI = new URL('../cli/index.ts', import.meta.url).pathname
class NotifyTransport implements OutboxTransport {
  sends: OutboxDelivery[] = []
  async send(delivery: OutboxDelivery) {
    const seat = delivery.replyId.split(':')[1] === 'turn' ? delivery.replyId.split(':')[2] : 'aun'
    const payload = typeof delivery.payload === 'string' ? JSON.parse(delivery.payload as any) : delivery.payload
    const proc = Bun.spawn({
      cmd: ['bun', CLI, 'notify',
        '--channel-id', delivery.channelExternalId ?? '1487368919613444156',
        '--mention', (payload.reply_to_author as string) ?? 'aun',
        '--content', delivery.content,
        '--message-type', 'chat'],
      env: { ...process.env, AGENT_ID: seat, DATABASE_URL: 'postgresql:///agent_comms?host=/tmp' },
      stdout: 'pipe', stderr: 'pipe',
    })
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ])
    if (code !== 0) throw new Error(`notify failed (${seat}): ${err || out}`)
    this.sends.push(delivery)
    const idMatch = out.match(/id:\s*([0-9a-f-]{36})/i)
    return { transportMessageId: idMatch?.[1] ?? `notify-${this.sends.length}` }
  }
}

// ── process: real engines, per-seat symmetry (claude-code AND codex) ──────
const engineBySeat: Record<string, string> = {
  'suite-lead': 'claude-code',
  'spec': 'claude-code',
  'dev-001': 'codex',
}
const transport = new NotifyTransport()
const results: Record<string, unknown> = {}
for (const row of rows) {
  const engine = engineBySeat[row.agent_id] ?? 'claude-code'
  const runtime = runtimeForEngine(engine, { db, schemaPath: SCHEMA_PATH })
  const t = performance.now()
  const r = await runSeatWorkerOnce(db, {
    seatId: row.agent_id,
    seatInstanceId: `v2-pilot-${engine}`,
    runtime,
    maxTurns: 1,
  })
  results[row.agent_id] = { engine, ...r, ms: Math.round(performance.now() - t) }
}
const dispatch = await dispatchOutboxOnce(db, transport, {
  dispatcherId: 'v2-pilot-outbox', dispatcherInstanceId: 'p1',
})

console.log(JSON.stringify({
  imported: rows.length,
  per_seat: results,
  dispatch: { delivered: dispatch.delivered, failed: [...dispatch.failedRetryable, ...dispatch.failedPermanent] },
  open_turns_left: await openTurnCount(db),
  pending_deliveries_left: (await pendingDeliveries(db)).length,
  total_ms: Math.round(performance.now() - t0),
}, null, 2))
await db.close()
