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
import { dispatchOutboxOnce, PermanentDeliveryError, recoverDispatcherClaims } from '../../core/eventlog/outbox'
import { parseEventPayload, type OutboxDelivery, type OutboxTransport } from '../../core/eventlog/types'
import { recoverSeat, runSeatWorkerOnce } from '../../core/eventlog/worker'
import { runtimeForEngine, V2_TURN_RESULT_SCHEMA } from '../../core/eventlog/runtimes'
import { closeAnsweredV1Row, findUnclosedAnsweredRows, importPendingV1Rows } from '../../core/eventlog/v1-import'

const DEFAULT_DATABASE_URL = 'postgresql:///agent_comms?host=/tmp'

export interface NotifyAuthority {
  senderSeatId: string
  recipientAgentId: string
  channelId: string
  threadId: string | null
}

export interface NotifyCommandResult {
  stdout: string
  stderr: string
  exitCode: number
}

export type NotifyCommandRunner = (
  cmd: string[],
  env: Record<string, string | undefined>,
) => Promise<NotifyCommandResult>

async function runNotifyCommand(
  cmd: string[],
  env: Record<string, string | undefined>,
): Promise<NotifyCommandResult> {
  const proc = Bun.spawn({ cmd, env, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

/**
 * Bind a delivery to the append-only inbound authority that opened its turn.
 * Nothing is inferred from reply-id text or a mutable runtime default.
 */
export async function resolveNotifyAuthority(
  db: DbAdapter,
  delivery: OutboxDelivery,
): Promise<NotifyAuthority> {
  const rows = await db.query<{ seat_id: string | null; received_payload: unknown }>(
    `SELECT enqueued.seat_id, received.payload AS received_payload
     FROM event_log enqueued
     JOIN event_log received
       ON received.turn_id = enqueued.turn_id
      AND received.event_type = 'message.received'
      AND received.seat_id = enqueued.seat_id
     WHERE enqueued.event_type = 'reply.enqueued'
       AND enqueued.reply_id = $1
     ORDER BY received.seq ASC`,
    [delivery.replyId],
  )
  if (rows.length !== 1) {
    throw new PermanentDeliveryError(`notify authority missing or ambiguous for reply ${delivery.replyId}`)
  }

  const senderSeatId = rows[0].seat_id
  const inbound = parseEventPayload<Record<string, unknown>>(rows[0].received_payload)
  const recipientAgentId = inbound.author_id
  const channelId = inbound.channel_id
  const threadId = inbound.thread_id
  if (typeof senderSeatId !== 'string' || senderSeatId.trim() === '' || senderSeatId !== senderSeatId.trim()) {
    throw new PermanentDeliveryError(`notify sender authority missing for reply ${delivery.replyId}`)
  }
  if (typeof recipientAgentId !== 'string' || recipientAgentId.trim() === '' || recipientAgentId !== recipientAgentId.trim()) {
    throw new PermanentDeliveryError(`notify recipient authority missing for reply ${delivery.replyId}`)
  }
  if (typeof channelId !== 'string' || channelId.trim() === '' || channelId !== channelId.trim()) {
    throw new PermanentDeliveryError(`notify channel authority missing for reply ${delivery.replyId}`)
  }
  if (
    threadId !== null && threadId !== undefined &&
    (typeof threadId !== 'string' || threadId.trim() === '' || threadId !== threadId.trim())
  ) {
    throw new PermanentDeliveryError(`notify thread authority malformed for reply ${delivery.replyId}`)
  }
  const normalizedThreadId = typeof threadId === 'string' ? threadId : null
  const expectedDestination = normalizedThreadId ?? channelId
  if (delivery.channelExternalId !== expectedDestination) {
    throw new PermanentDeliveryError(`notify destination disagrees with inbound authority for reply ${delivery.replyId}`)
  }
  return {
    senderSeatId,
    recipientAgentId,
    channelId,
    threadId: normalizedThreadId,
  }
}

/** Typed notify transport: replies ride the existing outbound machinery. */
export class NotifyTransport implements OutboxTransport {
  constructor(
    private db: DbAdapter,
    private cliPath: string,
    private options: {
      env?: Record<string, string | undefined>
      runner?: NotifyCommandRunner
    } = {},
  ) {}

  async send(delivery: OutboxDelivery) {
    const authority = await resolveNotifyAuthority(this.db, delivery)
    const cmd = [process.execPath, this.cliPath, 'notify',
      '--channel-id', authority.channelId,
      '--content', delivery.content,
      '--message-type', 'chat',
      '--mention', authority.recipientAgentId]
    if (authority.threadId) cmd.push('--thread-id', authority.threadId)
    const runner = this.options.runner ?? runNotifyCommand
    const result = await runner(cmd, {
      ...process.env,
      ...(this.options.env ?? {}),
      AGENT_ID: authority.senderSeatId,
    })
    if (result.exitCode !== 0) {
      throw new Error(`notify failed (seat=${authority.senderSeatId}): ${(result.stderr || result.stdout).slice(0, 400)}`)
    }
    let receipt: unknown
    try {
      receipt = JSON.parse(result.stdout.trim())
    } catch {
      throw new PermanentDeliveryError(`notify returned non-JSON evidence (seat=${authority.senderSeatId})`)
    }
    const messageId = receipt && typeof receipt === 'object'
      ? (receipt as Record<string, unknown>).message_id
      : undefined
    if (
      (receipt as Record<string, unknown> | null)?.ok !== true ||
      typeof messageId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(messageId)
    ) {
      throw new PermanentDeliveryError(`notify response missing exact message_id evidence (seat=${authority.senderSeatId})`)
    }
    return { transportMessageId: messageId }
  }
}

async function seatEngine(db: DbAdapter, seatId: string): Promise<string> {
  const row = await db.queryOne<{ engine: string | null }>(
    `SELECT metadata->'companyDevOs'->>'runtime_engine' AS engine FROM agents WHERE agent_id = $1`,
    [seatId],
  )
  return row?.engine ?? 'claude-code'
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL
  const seats = (process.env.AUN_V2_WORKER_SEATS ?? '').split(',').map(s => s.trim()).filter(Boolean)
  const once = process.argv.includes('--once')
  const intervalIdx = process.argv.indexOf('--interval-ms')
  const intervalMs = intervalIdx > -1 ? Number.parseInt(process.argv[intervalIdx + 1], 10) : 5000
  const instance = `v2wd-${randomUUID().slice(0, 8)}`

  // GARBAGE BARRIER (owner directive 2026-07-10): V1's historic pending
  // residue must NEVER cross into V2. Only rows created after this fence are
  // imported; everything older stays in V1 for explicit typed disposition.
  const importCreatedAfter = process.env.AUN_V2_IMPORT_CREATED_AFTER ?? new Date().toISOString()
  if (Number.isNaN(Date.parse(importCreatedAfter))) {
    throw new Error('AUN_V2_IMPORT_CREATED_AFTER must be a valid ISO timestamp')
  }
  if (seats.length === 0) {
    throw new Error('AUN_V2_WORKER_SEATS is required (comma-separated seat ids)')
  }

  const schemaPath = `/tmp/v2-turn-result-v1.${instance}.schema.json`
  writeFileSync(schemaPath, JSON.stringify(V2_TURN_RESULT_SCHEMA, null, 2))
  const db: DbAdapter = new PgAdapter(databaseUrl)
  const cliPath = new URL('../../cli/index.ts', import.meta.url).pathname
  const transport = new NotifyTransport(db, cliPath, { env: { DATABASE_URL: databaseUrl } })

  // startup recovery: this instance releases its seats' dead predecessors
  for (const seat of seats) {
    const released = await recoverSeat(db, { seatId: seat, seatInstanceId: instance })
    if (released.length > 0) console.log(`[${instance}] recovered ${released.length} stale claim(s) for ${seat}`)
  }
  await recoverDispatcherClaims(db, { dispatcherId: 'v2-outbox', activeInstanceId: instance })

  console.log(`[${instance}] v2 worker daemon up — seats=${seats.join(',')} interval=${intervalMs}ms once=${once} import_fence=${importCreatedAfter}`)

  let stopping = false
  process.on('SIGTERM', () => { stopping = true })
  process.on('SIGINT', () => { stopping = true })

  do {
    try {
      const imported = await importPendingV1Rows(db, { seats, createdAfter: importCreatedAfter })
      if (imported.length > 0) console.log(`[${instance}] imported ${imported.length} pending V1 row(s)`)

      for (const seat of seats) {
        const engine = await seatEngine(db, seat)
        const runtime = runtimeForEngine(engine, { db, schemaPath })
        const r = await runSeatWorkerOnce(db, {
          seatId: seat, seatInstanceId: instance, runtime, maxTurns: 3,
        })
        if (r.claimed > 0) console.log(`[${instance}] ${seat} (${engine}): claimed=${r.claimed} completed=${r.completed} failed=${r.failed}`)
      }

      const dispatch = await dispatchOutboxOnce(db, transport, {
        dispatcherId: 'v2-outbox', dispatcherInstanceId: instance,
      })
      if (dispatch.delivered.length + dispatch.failedRetryable.length + dispatch.failedPermanent.length > 0) {
        console.log(`[${instance}] outbox: delivered=${dispatch.delivered.length} retryable=${dispatch.failedRetryable.length} permanent=${dispatch.failedPermanent.length}`)
      }

      // close answered V1 rows (typed terminal with evidence reason) —
      // DURABLE recovery (audit 4931107358): the set is derived by joining
      // committed V2 completions to still-open V1 rows, so a crash between
      // the completion event and the V1 close is healed on ANY later tick.
      const unclosed = await findUnclosedAnsweredRows(db, { seats })
      for (const u of unclosed) {
        await closeAnsweredV1Row(db, {
          seatId: u.seatId, messageId: u.messageId,
          evidenceRef: `event_log turn ${u.turnId}`,
        })
      }
    } catch (err) {
      console.error(`[${instance}] tick error (continuing): ${err instanceof Error ? err.message : err}`)
    }
    if (!once && !stopping) await new Promise(r => setTimeout(r, intervalMs))
  } while (!once && !stopping)

  console.log(`[${instance}] stopped`)
  await db.close()
}

if (import.meta.main) await main()
