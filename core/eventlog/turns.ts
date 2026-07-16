// EventLogCore/v1 turn lifecycle.
//
// message.received (idempotent) → turn.claimed (pull-claim, conditional
// insert wins) → turn.presented → turn.completed (typed outcome) with
// reply.enqueued* in the SAME transaction (transactional outbox).
//
// No push delivery: an idle seat calls claimNextTurn itself. Wake signals
// are optimization hints elsewhere in the system — nothing here depends on
// them. Recovery is identity-based: a restarting seat instance releases the
// claims of its dead predecessors; no elapsed-time timer decides truth.

import { randomUUID } from 'node:crypto'
import type { DbAdapter } from '../db/adapter'
import { EventLog } from './store'
import { claimableTurns, inboxView } from './views'
import {
  ClaimLostError,
  parseEventPayload,
  type ClaimedTurn,
  type QueueViewRow,
  type StoredEvent,
  type TurnOutcome,
} from './types'

export class StaleClaimError extends Error {}

export interface ReceiveMessageInput {
  messageId: string
  seatId: string
  conversationId?: string | null
  correlationId?: string | null
  causationId?: string | null
  payload?: Record<string, unknown>
}

export interface ReplyInput {
  replyId?: string
  channelExternalId?: string | null
  content: string
  payload?: Record<string, unknown>
}

export interface CompleteTurnInput {
  turnId: string
  seatId: string
  seatInstanceId: string
  claimEventId: string
  outcome: TurnOutcome
  conversationId?: string | null
  correlationId?: string | null
  payload?: Record<string, unknown>
  replies?: ReplyInput[]
}

export function turnIdFor(seatId: string, messageId: string): string {
  return `turn:${seatId}:${messageId}`
}

/**
 * Ingest one inbound message for one seat. Deterministic event_id makes
 * redelivery a no-op: the same message never opens two turns and is never
 * double-processed.
 */
export async function receiveMessage(db: DbAdapter, input: ReceiveMessageInput, transaction?: DbAdapter) {
  const log = new EventLog(db)
  const turnId = turnIdFor(input.seatId, input.messageId)
  return log.append({
    eventId: `recv:${input.seatId}:${input.messageId}`,
    eventType: 'message.received',
    seatId: input.seatId,
    conversationId: input.conversationId ?? null,
    correlationId: input.correlationId ?? null,
    causationId: input.causationId ?? null,
    turnId,
    payload: { message_id: input.messageId, ...(input.payload ?? {}) },
  }, transaction)
}

async function nextClaimEpoch(db: DbAdapter, turnId: string): Promise<number> {
  const row = await db.queryOne<{ max_epoch: number | null }>(
    `SELECT MAX(claim_epoch) AS max_epoch FROM event_log
     WHERE event_type = 'turn.claimed' AND turn_id = $1`,
    [turnId],
  )
  return row?.max_epoch === null || row?.max_epoch === undefined ? 0 : row.max_epoch + 1
}

/**
 * Pull-claim: try to claim the next claimable turn for this seat.
 * Claim = appending turn.claimed; the (turn_id, claim_epoch) unique index
 * arbitrates races — losers get ClaimLostError, back off to the next
 * candidate, and return null when nothing is claimable.
 */
export async function claimNextTurn(
  db: DbAdapter,
  opts: { seatId: string; seatInstanceId: string },
): Promise<ClaimedTurn | null> {
  const log = new EventLog(db)
  const candidates = await claimableTurns(db, opts.seatId)
  for (const turn of candidates) {
    const epoch = await nextClaimEpoch(db, turn.turn_id)
    try {
      const result = await log.append({
        eventId: randomUUID(),
        eventType: 'turn.claimed',
        seatId: opts.seatId,
        seatInstanceId: opts.seatInstanceId,
        conversationId: turn.conversation_id,
        causationId: turn.received_event_id,
        turnId: turn.turn_id,
        claimEpoch: epoch,
      })
      return { turn, claimEventId: result.event.event_id, claimEpoch: epoch }
    } catch (err) {
      if (err instanceof ClaimLostError) continue
      throw err
    }
  }
  return null
}

export interface ExactTurnTarget {
  turnId: string
  seatId: 'aun'
  queueId: number
  messageId: string
  createdAfter: string
}

export function exactCanaryCrashInstanceId(queueId: number): string {
  return `ecan-crash-${queueId}`
}

async function exactReceivedAuthority(
  db: DbAdapter,
  opts: ExactTurnTarget,
): Promise<{ event: StoredEvent; payload: Record<string, unknown> } | null> {
  const received = await db.queryOne<StoredEvent>(
    `SELECT * FROM event_log
     WHERE event_type = 'message.received'
       AND turn_id = $1
       AND seat_id = $2`,
    [opts.turnId, opts.seatId],
  )
  if (!received) return null
  const payload = parseEventPayload<Record<string, unknown>>(received.payload)
  if (
    payload.message_id !== opts.messageId ||
    payload.v1_queue_id !== opts.queueId ||
    payload.v1_created_after !== opts.createdAfter ||
    typeof payload.v1_created_at !== 'string' ||
    Number.isNaN(Date.parse(payload.v1_created_at)) ||
    Date.parse(payload.v1_created_at) <= Date.parse(opts.createdAfter) ||
    turnIdFor(opts.seatId, opts.messageId) !== opts.turnId
  ) return null
  return { event: received, payload }
}

async function exactOpenTurn(
  db: DbAdapter,
  opts: ExactTurnTarget,
): Promise<QueueViewRow | null> {
  const authority = await exactReceivedAuthority(db, opts)
  if (!authority) return null
  const received = authority.event

  const completed = await db.queryOne<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM event_log
     WHERE event_type = 'turn.completed' AND turn_id = $1`,
    [opts.turnId],
  )
  if (Number(completed?.n ?? 0) !== 0) return null

  const activeClaim = await db.queryOne<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM event_log c
     WHERE c.event_type = 'turn.claimed'
       AND c.turn_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM event_log rel
         WHERE rel.event_type = 'turn.claim_released'
           AND rel.turn_id = c.turn_id
           AND rel.claim_epoch = c.claim_epoch
       )`,
    [opts.turnId],
  )
  if (Number(activeClaim?.n ?? 0) !== 0) return null

  if (received.conversation_id) {
    const earlier = await db.queryOne<{ n: number | string }>(
      `SELECT COUNT(*) AS n FROM event_log r
       WHERE r.event_type = 'message.received'
         AND r.seat_id = $1
         AND r.conversation_id = $2
         AND r.seq < $3
         AND NOT EXISTS (
           SELECT 1 FROM event_log done
           WHERE done.event_type = 'turn.completed'
             AND done.turn_id = r.turn_id
         )`,
      [opts.seatId, received.conversation_id, received.seq],
    )
    if (Number(earlier?.n ?? 0) !== 0) return null
  }

  return {
    turn_id: opts.turnId,
    seat_id: opts.seatId,
    conversation_id: received.conversation_id,
    received_seq: Number(received.seq),
    received_event_id: received.event_id,
    received_at: received.occurred_at,
    message_id: opts.messageId,
    claim_event_id: null,
    claim_epoch: null,
    claimed_by_seat: null,
    claimed_by_instance: null,
    claim_seq: null,
  }
}

/**
 * Claim one exact turn without consulting the seat-wide next-turn list.
 * The target predicate and claim append are enclosed by one transaction;
 * the existing (turn_id, claim_epoch) arbiter still decides races.
 */
export async function claimExactTurn(
  db: DbAdapter,
  opts: ExactTurnTarget & { seatInstanceId: string },
): Promise<ClaimedTurn | null> {
  try {
    return await db.transaction(async tx => {
      const turn = await exactOpenTurn(tx, opts)
      if (!turn) return null
      const epoch = await nextClaimEpoch(tx, opts.turnId)
      const result = await new EventLog(tx).append({
        eventId: randomUUID(),
        eventType: 'turn.claimed',
        seatId: opts.seatId,
        seatInstanceId: opts.seatInstanceId,
        conversationId: turn.conversation_id,
        causationId: turn.received_event_id,
        turnId: opts.turnId,
        claimEpoch: epoch,
        payload: {
          claim_scope: 'exact_canary',
          queue_id: opts.queueId,
          message_id: opts.messageId,
          created_after: opts.createdAfter,
        },
      }, tx)
      return { turn, claimEventId: result.event.event_id, claimEpoch: epoch }
    })
  } catch (err) {
    if (err instanceof ClaimLostError) return null
    throw err
  }
}

export async function presentTurn(
  db: DbAdapter,
  claimed: ClaimedTurn,
  opts: { seatId: string; seatInstanceId: string },
) {
  const log = new EventLog(db)
  return log.append({
    eventId: `present:${claimed.turn.turn_id}:${claimed.claimEpoch}`,
    eventType: 'turn.presented',
    seatId: opts.seatId,
    seatInstanceId: opts.seatInstanceId,
    conversationId: claimed.turn.conversation_id,
    causationId: claimed.claimEventId,
    turnId: claimed.turn.turn_id,
    claimEpoch: claimed.claimEpoch,
  })
}

async function assertActiveClaim(
  db: DbAdapter,
  turnId: string,
  claimEventId: string,
): Promise<StoredEvent> {
  const claim = await db.queryOne<StoredEvent>(
    `SELECT * FROM event_log WHERE event_id = $1 AND event_type = 'turn.claimed'`,
    [claimEventId],
  )
  if (!claim || claim.turn_id !== turnId) {
    throw new StaleClaimError(`claim ${claimEventId} does not hold turn ${turnId}`)
  }
  const newer = await db.queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM event_log
     WHERE event_type = 'turn.claimed' AND turn_id = $1 AND claim_epoch > $2`,
    [turnId, claim.claim_epoch],
  )
  if ((newer?.n ?? 0) > 0) {
    throw new StaleClaimError(`claim ${claimEventId} superseded by a newer epoch (fenced out)`)
  }
  const released = await db.queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM event_log
     WHERE event_type = 'turn.claim_released' AND turn_id = $1 AND claim_epoch = $2`,
    [turnId, claim.claim_epoch],
  )
  if ((released?.n ?? 0) > 0) {
    throw new StaleClaimError(`claim ${claimEventId} was released (fenced out)`)
  }
  return claim
}

/**
 * Complete a turn with a typed outcome, enqueuing outbound replies in the
 * same transaction (transactional outbox — no window where the outcome
 * exists without the outbound work).
 *
 * Fencing: the caller's claim must still be the active claim; a released or
 * superseded claim is rejected (StaleClaimError). A crash-retry of an
 * already-committed completion is idempotent (deterministic event ids).
 * A competing completion from a different claim is rejected mechanically by
 * the uq_el_turn_completed index.
 */
export async function completeTurn(db: DbAdapter, input: CompleteTurnInput) {
  const log = new EventLog(db)
  return db.transaction(async tx => {
    await assertActiveClaim(tx, input.turnId, input.claimEventId)
    const existing = await tx.queryOne<StoredEvent>(
      `SELECT * FROM event_log WHERE event_type = 'turn.completed' AND turn_id = $1`,
      [input.turnId],
    )
    if (existing && existing.causation_id !== input.claimEventId) {
      throw new StaleClaimError(`turn ${input.turnId} already completed by another claim`)
    }
    const completion = await log.append(
      {
        eventId: `done:${input.turnId}`,
        eventType: 'turn.completed',
        seatId: input.seatId,
        seatInstanceId: input.seatInstanceId,
        conversationId: input.conversationId ?? null,
        correlationId: input.correlationId ?? null,
        causationId: input.claimEventId,
        turnId: input.turnId,
        payload: { outcome: input.outcome, ...(input.payload ?? {}) },
      },
      tx,
    )
    const replies = []
    for (const [i, reply] of (input.replies ?? []).entries()) {
      const replyId = reply.replyId ?? `reply:${input.turnId}:${i}`
      replies.push(
        await log.append(
          {
            eventId: `enq:${replyId}`,
            eventType: 'reply.enqueued',
            seatId: input.seatId,
            seatInstanceId: input.seatInstanceId,
            conversationId: input.conversationId ?? null,
            correlationId: input.correlationId ?? null,
            causationId: completion.event.event_id,
            turnId: input.turnId,
            replyId,
            payload: {
              content: reply.content,
              channel_external_id: reply.channelExternalId ?? null,
              ...(reply.payload ?? {}),
            },
          },
          tx,
        ),
      )
    }
    return { completion, replies }
  })
}

/** Voluntarily release a held claim (backoff). Idempotent. */
export async function releaseClaim(
  db: DbAdapter,
  opts: {
    turnId: string
    claimEpoch: number
    claimEventId: string
    seatId: string
    seatInstanceId: string
    reason: string
  },
) {
  const log = new EventLog(db)
  return log.append({
    eventId: `release:${opts.turnId}:${opts.claimEpoch}`,
    eventType: 'turn.claim_released',
    seatId: opts.seatId,
    seatInstanceId: opts.seatInstanceId,
    causationId: opts.claimEventId,
    turnId: opts.turnId,
    claimEpoch: opts.claimEpoch,
    payload: { reason: opts.reason },
  })
}

/**
 * Identity-based claim recovery: when a seat instance starts, it releases
 * claims held by OTHER instances of the same seat (its dead predecessors).
 * This is how fleet-kill recovery works without elapsed-time timers: the
 * restart itself is the evidence that the old instance is gone.
 */
export async function recoverSeatClaims(
  db: DbAdapter,
  opts: { seatId: string; activeInstanceId: string },
): Promise<QueueViewRow[]> {
  const rows = await inboxView(db, opts.seatId)
  const stale = rows.filter(
    r =>
      r.claim_event_id !== null &&
      r.claimed_by_seat === opts.seatId &&
      r.claimed_by_instance !== null &&
      r.claimed_by_instance !== opts.activeInstanceId,
  )
  for (const row of stale) {
    await releaseClaim(db, {
      turnId: row.turn_id,
      claimEpoch: row.claim_epoch!,
      claimEventId: row.claim_event_id!,
      seatId: opts.seatId,
      seatInstanceId: opts.activeInstanceId,
      reason: 'seat_instance_recovery',
    })
  }
  return stale
}

export interface RecoveredExactClaim {
  turnId: string
  claimEventId: string
  claimEpoch: number
  previousInstanceId: string
  releaseEventId: string
}

function hasExactCanaryClaimProvenance(
  claim: StoredEvent,
  opts: ExactTurnTarget,
  receivedEventId: string,
): boolean {
  let payload: Record<string, unknown>
  try {
    payload = parseEventPayload<Record<string, unknown>>(claim.payload)
  } catch {
    return false
  }
  if (payload === null || Array.isArray(payload)) return false

  const payloadKeys = Object.keys(payload).sort()
  const expectedKeys = ['claim_scope', 'created_after', 'message_id', 'queue_id']
  return (
    claim.seat_instance_id === exactCanaryCrashInstanceId(opts.queueId) &&
    claim.causation_id === receivedEventId &&
    payloadKeys.length === expectedKeys.length &&
    payloadKeys.every((key, index) => key === expectedKeys[index]) &&
    payload.claim_scope === 'exact_canary' &&
    payload.queue_id === opts.queueId &&
    payload.message_id === opts.messageId &&
    payload.created_after === opts.createdAfter
  )
}

/** Release only the exact target's stale claim; never scans or recovers a seat. */
export async function recoverExactTurnClaim(
  db: DbAdapter,
  opts: ExactTurnTarget & { activeInstanceId: string },
): Promise<RecoveredExactClaim | null> {
  return db.transaction(async tx => {
    const received = await exactReceivedAuthority(tx, opts)
    if (!received) throw new StaleClaimError(`exact target authority ${opts.turnId} is missing or mismatched`)
    const completed = await tx.queryOne<{ n: number | string }>(
      `SELECT COUNT(*) AS n FROM event_log
       WHERE event_type = 'turn.completed' AND turn_id = $1`,
      [opts.turnId],
    )
    if (Number(completed?.n ?? 0) !== 0) return null

    const active = await tx.query<StoredEvent>(
      `SELECT c.* FROM event_log c
       WHERE c.event_type = 'turn.claimed'
         AND c.turn_id = $1
         AND c.seat_id = $2
         AND NOT EXISTS (
           SELECT 1 FROM event_log rel
           WHERE rel.event_type = 'turn.claim_released'
             AND rel.turn_id = c.turn_id
             AND rel.claim_epoch = c.claim_epoch
         )
       ORDER BY c.claim_epoch DESC`,
      [opts.turnId, opts.seatId],
    )
    if (active.length === 0) return null
    if (active.length !== 1) {
      throw new StaleClaimError(`exact target ${opts.turnId} has ${active.length} active claims`)
    }
    const claim = active[0]
    if (!claim.seat_instance_id) throw new StaleClaimError('exact target claim has no instance identity')
    if (claim.seat_instance_id === opts.activeInstanceId) return null
    if (claim.claim_epoch === null) throw new StaleClaimError('exact target claim has no epoch')
    if (!hasExactCanaryClaimProvenance(claim, opts, received.event.event_id)) {
      throw new StaleClaimError('exact target claim does not match planned exact-canary provenance')
    }

    const release = await new EventLog(tx).append({
      eventId: `release:${opts.turnId}:${claim.claim_epoch}`,
      eventType: 'turn.claim_released',
      seatId: opts.seatId,
      seatInstanceId: opts.activeInstanceId,
      causationId: claim.event_id,
      turnId: opts.turnId,
      claimEpoch: Number(claim.claim_epoch),
      payload: {
        reason: 'exact_target_recovery',
        queue_id: opts.queueId,
        message_id: opts.messageId,
        created_after: opts.createdAfter,
      },
    }, tx)
    return {
      turnId: opts.turnId,
      claimEventId: claim.event_id,
      claimEpoch: Number(claim.claim_epoch),
      previousInstanceId: claim.seat_instance_id,
      releaseEventId: release.event.event_id,
    }
  })
}
