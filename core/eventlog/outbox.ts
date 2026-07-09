// EventLogCore/v1 transactional outbox dispatcher.
//
// reply.enqueued rows are written atomically with turn.completed (see
// turns.ts). This dispatcher drains them: claim one delivery attempt via
// conditional insert (losers back off), send through the injected transport,
// record reply.delivered (with the transport message id) or
// reply.failed(retryable|permanent).
//
// Double-send is prevented by two independent layers:
//   1. the log: uq_el_reply_delivered allows one reply.delivered per reply,
//      and delivery attempts are epoch-claimed;
//   2. the transport: every attempt for a reply carries the SAME nonce
//      (`out-<reply_id>`), so a crash between send and the delivered event
//      is healed by the transport's nonce dedup on retry (the V1 Discord
//      40062-as-success pattern, made a contract here).
//
// Crash recovery mirrors turns: a restarting dispatcher instance releases
// delivery claims held by its dead predecessors (identity, not timers).

import { randomUUID } from 'node:crypto'
import type { DbAdapter } from '../db/adapter'
import { EventLog } from './store'
import { outboxView, pendingDeliveries } from './views'
import {
  ClaimLostError,
  parseEventPayload,
  type OutboxTransport,
  type OutboxViewRow,
} from './types'

export const DEFAULT_MAX_DELIVERY_ATTEMPTS = 5

export class PermanentDeliveryError extends Error {
  permanent = true as const
}

export function deliveryNonce(replyId: string): string {
  return `out-${replyId}`
}

export interface DispatchResult {
  delivered: string[]
  failedRetryable: string[]
  failedPermanent: string[]
  lostClaims: string[]
}

async function nextDeliveryEpoch(db: DbAdapter, replyId: string): Promise<number> {
  const row = await db.queryOne<{ max_epoch: number | null }>(
    `SELECT MAX(claim_epoch) AS max_epoch FROM event_log
     WHERE event_type = 'reply.delivery_claimed' AND reply_id = $1`,
    [replyId],
  )
  return row?.max_epoch === null || row?.max_epoch === undefined ? 0 : row.max_epoch + 1
}

/**
 * Drain currently pending deliveries once. Callers own pacing (poll loop /
 * wake hint); this function is safe to call from any number of concurrent
 * dispatchers — the delivery-claim arbiter serializes them per reply.
 */
export async function dispatchOutboxOnce(
  db: DbAdapter,
  transport: OutboxTransport,
  opts: {
    dispatcherId: string
    dispatcherInstanceId: string
    maxAttempts?: number
  },
): Promise<DispatchResult> {
  const log = new EventLog(db)
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_DELIVERY_ATTEMPTS
  const result: DispatchResult = {
    delivered: [],
    failedRetryable: [],
    failedPermanent: [],
    lostClaims: [],
  }

  for (const row of await pendingDeliveries(db)) {
    if (row.attempts >= maxAttempts) {
      await log.append({
        eventId: `perm-fail:${row.reply_id}`,
        eventType: 'reply.failed',
        seatId: opts.dispatcherId,
        seatInstanceId: opts.dispatcherInstanceId,
        conversationId: row.conversation_id,
        causationId: row.enqueued_event_id,
        turnId: row.turn_id,
        replyId: row.reply_id,
        payload: { kind: 'permanent', reason: 'max_attempts_exhausted', attempts: row.attempts },
      })
      result.failedPermanent.push(row.reply_id)
      continue
    }

    const epoch = await nextDeliveryEpoch(db, row.reply_id)
    let claimEventId: string
    try {
      const claim = await log.append({
        eventId: randomUUID(),
        eventType: 'reply.delivery_claimed',
        seatId: opts.dispatcherId,
        seatInstanceId: opts.dispatcherInstanceId,
        conversationId: row.conversation_id,
        causationId: row.enqueued_event_id,
        turnId: row.turn_id,
        replyId: row.reply_id,
        claimEpoch: epoch,
      })
      claimEventId = claim.event.event_id
    } catch (err) {
      if (err instanceof ClaimLostError) {
        result.lostClaims.push(row.reply_id)
        continue
      }
      throw err
    }

    const payload = parseEventPayload<Record<string, unknown>>(row.payload)
    try {
      const sent = await transport.send({
        replyId: row.reply_id,
        channelExternalId: (payload.channel_external_id as string | null) ?? null,
        content: (payload.content as string) ?? '',
        nonce: deliveryNonce(row.reply_id),
        payload,
      })
      await log.append({
        eventId: `delivered:${row.reply_id}`,
        eventType: 'reply.delivered',
        seatId: opts.dispatcherId,
        seatInstanceId: opts.dispatcherInstanceId,
        conversationId: row.conversation_id,
        causationId: claimEventId,
        turnId: row.turn_id,
        replyId: row.reply_id,
        claimEpoch: epoch,
        payload: { transport_message_id: sent.transportMessageId },
      })
      result.delivered.push(row.reply_id)
    } catch (err) {
      const permanent = err instanceof PermanentDeliveryError || (err as any)?.permanent === true
      await log.append({
        eventId: randomUUID(),
        eventType: 'reply.failed',
        seatId: opts.dispatcherId,
        seatInstanceId: opts.dispatcherInstanceId,
        conversationId: row.conversation_id,
        causationId: claimEventId,
        turnId: row.turn_id,
        replyId: row.reply_id,
        claimEpoch: epoch,
        payload: {
          kind: permanent ? 'permanent' : 'retryable',
          error: err instanceof Error ? err.message : String(err),
        },
      })
      if (permanent) result.failedPermanent.push(row.reply_id)
      else result.failedRetryable.push(row.reply_id)
    }
  }
  return result
}

/**
 * Release delivery claims held by dead predecessor instances of this
 * dispatcher. A retryable reply.failed on the stale epoch reopens the reply
 * for the next dispatch pass. Restart is the evidence; no timers.
 */
export async function recoverDispatcherClaims(
  db: DbAdapter,
  opts: { dispatcherId: string; activeInstanceId: string },
): Promise<OutboxViewRow[]> {
  const log = new EventLog(db)
  const rows = await outboxView(db)
  const stale = rows.filter(
    r =>
      r.delivery_claim_event_id !== null &&
      r.claimed_by_dispatcher === opts.dispatcherId &&
      r.claimed_by_instance !== null &&
      r.claimed_by_instance !== opts.activeInstanceId,
  )
  for (const row of stale) {
    await log.append({
      eventId: `dispatch-recover:${row.reply_id}:${row.delivery_claim_epoch}`,
      eventType: 'reply.failed',
      seatId: opts.dispatcherId,
      seatInstanceId: opts.activeInstanceId,
      conversationId: row.conversation_id,
      causationId: row.delivery_claim_event_id,
      turnId: row.turn_id,
      replyId: row.reply_id,
      claimEpoch: row.delivery_claim_epoch,
      payload: { kind: 'retryable', reason: 'dispatcher_instance_recovery' },
    })
  }
  return stale
}
