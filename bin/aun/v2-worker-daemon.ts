// AUN V2 worker daemon — the piece that makes the receive side LIVE:
// "a row lands in the queue → the seat processes it with zero terminal
// input", continuously, for every allowlisted seat.
//
// Tick loop (poll; wake is only ever a hint in V2):
//   1. import pending V1 rows for allowlisted seats into the V2 log
//      (M1-bridge until listeners restart on dual-write code; same
//      deterministic ids, so both paths converge)
//   2. per seat: pull-claim → real engine (per-seat runtime_engine from
//      agents.metadata; codex exec / claude -p) → terminal-close with reply
//   3. drain the outbox through the typed notify path (full ACLs, V1
//      outbound machinery, Discord projection)
//   4. close answered V1 rows with an evidence reason (typed skip
//      semantics) so nothing double-answers
//
// Ownership: each daemon process owns its own DB connections (see
// worker.ts CONNECTION OWNERSHIP). Crash-safe by construction: state is
// the log; on restart, identity-based recovery releases dead claims.
//
// Usage:
//   AUN_V2_WORKER_SEATS=spec,suite-lead,dev-001 \
//   DATABASE_URL=postgresql:///agent_comms?host=/tmp \
//   bun bin/aun/v2-worker-daemon.ts [--once] [--interval-ms 5000]

import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { PgAdapter } from '../../core/db/pg-adapter'
import type { DbAdapter } from '../../core/db/adapter'
import { dispatchOutboxOnce, recoverDispatcherClaims } from '../../core/eventlog/outbox'
import { parseEventPayload, type OutboxDelivery, type OutboxTransport } from '../../core/eventlog/types'
import { recoverSeat, runSeatWorkerOnce } from '../../core/eventlog/worker'
import { runtimeForEngine, V2_TURN_RESULT_SCHEMA } from '../../core/eventlog/runtimes'
import { closeAnsweredV1Row, findUnclosedAnsweredRows, importPendingV1Rows } from '../../core/eventlog/v1-import'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql:///agent_comms?host=/tmp'
const SEATS = (process.env.AUN_V2_WORKER_SEATS ?? '').split(',').map(s => s.trim()).filter(Boolean)
const ONCE = process.argv.includes('--once')
const intervalIdx = process.argv.indexOf('--interval-ms')
const INTERVAL_MS = intervalIdx > -1 ? Number.parseInt(process.argv[intervalIdx + 1], 10) : 5000
const INSTANCE = `v2wd-${randomUUID().slice(0, 8)}`

// GARBAGE BARRIER (owner directive 2026-07-10): V1's historic pending
// residue must NEVER cross into V2. Only rows created after this fence are
// imported; everything older stays in V1 for explicit typed disposition.
// Default = daemon boot time (V2 sees only NEW work). Backfilling anything
// older requires the operator to set AUN_V2_IMPORT_CREATED_AFTER on
// purpose — there is no "import everything" mode.
const IMPORT_CREATED_AFTER = process.env.AUN_V2_IMPORT_CREATED_AFTER ?? new Date().toISOString()
if (Number.isNaN(Date.parse(IMPORT_CREATED_AFTER))) {
  console.error('AUN_V2_IMPORT_CREATED_AFTER must be a valid ISO timestamp')
  process.exit(1)
}

if (SEATS.length === 0) {
  console.error('AUN_V2_WORKER_SEATS is required (comma-separated seat ids)')
  process.exit(1)
}

const SCHEMA_PATH = `/tmp/v2-turn-result-v1.${INSTANCE}.schema.json`
writeFileSync(SCHEMA_PATH, JSON.stringify(V2_TURN_RESULT_SCHEMA, null, 2))

const db: DbAdapter = new PgAdapter(DATABASE_URL)

/** Typed notify transport: replies ride the existing outbound machinery. */
class NotifyTransport implements OutboxTransport {
  constructor(private cliPath: string) {}
  async send(delivery: OutboxDelivery) {
    const parts = delivery.replyId.split(':') // reply:turn:<seat>:<messageId>:<i>
    const seat = parts[1] === 'turn' ? parts[2] : 'aun'
    const payload = parseEventPayload<Record<string, unknown>>(delivery.payload as never)
    const mention = (payload.reply_to_author as string | undefined) ?? undefined
    const cmd = ['bun', this.cliPath, 'notify',
      '--channel-id', delivery.channelExternalId ?? '',
      '--content', delivery.content,
      '--message-type', 'chat']
    if (mention) cmd.push('--mention', mention)
    const proc = Bun.spawn({
      cmd,
      env: { ...process.env, AGENT_ID: seat, DATABASE_URL },
      stdout: 'pipe', stderr: 'pipe',
    })
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ])
    if (code !== 0) throw new Error(`notify failed (seat=${seat}): ${(err || out).slice(0, 400)}`)
    const idMatch = out.match(/id:\s*([0-9a-f-]{36})/i)
    return { transportMessageId: idMatch?.[1] ?? `notify-${Date.now()}` }
  }
}

async function seatEngine(seatId: string): Promise<string> {
  const row = await db.queryOne<{ engine: string | null }>(
    `SELECT metadata->'companyDevOs'->>'runtime_engine' AS engine FROM agents WHERE agent_id = $1`,
    [seatId],
  )
  return row?.engine ?? 'claude-code'
}

const cliPath = new URL('../../cli/index.ts', import.meta.url).pathname
const transport = new NotifyTransport(cliPath)

// startup recovery: this instance releases its seats' dead predecessors
for (const seat of SEATS) {
  const released = await recoverSeat(db, { seatId: seat, seatInstanceId: INSTANCE })
  if (released.length > 0) console.log(`[${INSTANCE}] recovered ${released.length} stale claim(s) for ${seat}`)
}
await recoverDispatcherClaims(db, { dispatcherId: 'v2-outbox', activeInstanceId: INSTANCE })

console.log(`[${INSTANCE}] v2 worker daemon up — seats=${SEATS.join(',')} interval=${INTERVAL_MS}ms once=${ONCE} import_fence=${IMPORT_CREATED_AFTER}`)

let stopping = false
process.on('SIGTERM', () => { stopping = true })
process.on('SIGINT', () => { stopping = true })

do {
  try {
    const imported = await importPendingV1Rows(db, { seats: SEATS, createdAfter: IMPORT_CREATED_AFTER })
    if (imported.length > 0) console.log(`[${INSTANCE}] imported ${imported.length} pending V1 row(s)`)

    for (const seat of SEATS) {
      const engine = await seatEngine(seat)
      const runtime = runtimeForEngine(engine, { db, schemaPath: SCHEMA_PATH })
      const r = await runSeatWorkerOnce(db, {
        seatId: seat, seatInstanceId: INSTANCE, runtime, maxTurns: 3,
      })
      if (r.claimed > 0) console.log(`[${INSTANCE}] ${seat} (${engine}): claimed=${r.claimed} completed=${r.completed} failed=${r.failed}`)
    }

    const dispatch = await dispatchOutboxOnce(db, transport, {
      dispatcherId: 'v2-outbox', dispatcherInstanceId: INSTANCE,
    })
    if (dispatch.delivered.length + dispatch.failedRetryable.length + dispatch.failedPermanent.length > 0) {
      console.log(`[${INSTANCE}] outbox: delivered=${dispatch.delivered.length} retryable=${dispatch.failedRetryable.length} permanent=${dispatch.failedPermanent.length}`)
    }

    // close answered V1 rows (typed terminal with evidence reason) —
    // DURABLE recovery (audit 4931107358): the set is derived by joining
    // committed V2 completions to still-open V1 rows, so a crash between
    // the completion event and the V1 close is healed on ANY later tick,
    // no matter how much time passed. Not a time window.
    const unclosed = await findUnclosedAnsweredRows(db, { seats: SEATS })
    for (const u of unclosed) {
      await closeAnsweredV1Row(db, {
        seatId: u.seatId, messageId: u.messageId,
        evidenceRef: `event_log turn ${u.turnId}`,
      })
    }
  } catch (err) {
    console.error(`[${INSTANCE}] tick error (continuing): ${err instanceof Error ? err.message : err}`)
  }
  if (!ONCE && !stopping) await new Promise(r => setTimeout(r, INTERVAL_MS))
} while (!ONCE && !stopping)

console.log(`[${INSTANCE}] stopped`)
await db.close()
