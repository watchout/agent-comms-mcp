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
export async function receiveMessage(db: DbAdapter, input: ReceiveMessageInput) {
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
  })
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
