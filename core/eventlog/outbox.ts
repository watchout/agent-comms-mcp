// EventLogCore/v1 transactional outbox dispatcher.
//
// reply.enqueued rows are written atomically with turn.completed (see
// turns.ts). This dispatcher drains them: claim one delivery attempt via
// conditional insert (losers back off), send through the injected transport,
// record reply.delivered (with the transport message id) or
// reply.failed(retryable|permanent).
//
// The r1.1.4 contract never infers delivery from a nonce error. Durable nonce
// reservation and invocation-start CAS happen before a provider call; an
// ambiguous started attempt becomes delivery_unknown and is excluded from
// ordinary pending delivery until explicit reconciliation reopens it.
//
// Crash recovery mirrors turns: a restarting dispatcher instance releases
// delivery claims held by its dead predecessors (identity, not timers).

import { randomUUID } from 'node:crypto'
import type { DbAdapter } from '../db/adapter'
import { EventLog } from './store'
import { outboxView, pendingDeliveries } from './views'
import {
  ClaimLostError,
  EventIdCanonicalMaterialCollisionError,
  InvocationStartCollisionError,
  ProviderNonceCollisionError,
  parseEventPayload,
  type OutboxTransport,
  type OutboxViewRow,
} from './types'
import {
  buildReplyDeliveryUnknownPayload,
  decodeProviderInvocationStart,
  decodeProviderNonceReservation,
  decodeReplyDeliveryUnknownPayload,
  providerInvocationStartEventId,
  providerNonceReservationEventId,
  type ProviderInvocationStartPayloadV1,
  type ProviderNonceReservationPayloadV1,
  type DeliveryUnitV1,
  type ReplyDeliveryUnknownPayloadV1,
} from './transport-contract'

export const DEFAULT_MAX_DELIVERY_ATTEMPTS = 5

export class PermanentDeliveryError extends Error {
  permanent = true as const
}

/** Provider invocation may have happened but no exact acknowledgement exists. */
export class AmbiguousDeliveryOutcomeError extends Error {
  ambiguous = true as const
}

export type ProviderNonceReservationResult = 'reserved' | 'same_delivery'
export type ProviderInvocationStartResult = 'started' | 'already_started'

export async function reserveProviderNonce(
  db: DbAdapter,
  reservation: ProviderNonceReservationPayloadV1,
): Promise<{ status: ProviderNonceReservationResult; eventId: string }> {
  decodeProviderNonceReservation(reservation)
  const eventId = providerNonceReservationEventId(reservation.key)
  try {
    const result = await new EventLog(db).append({
      eventId,
      eventType: 'reply.provider_nonce_reserved',
      payload: reservation as unknown as Record<string, unknown>,
    })
    return { status: result.inserted ? 'reserved' : 'same_delivery', eventId }
  } catch (error) {
    if (error instanceof EventIdCanonicalMaterialCollisionError) {
      throw new ProviderNonceCollisionError(error.message)
    }
    throw error
  }
}

export async function startProviderInvocation(
  db: DbAdapter,
  start: ProviderInvocationStartPayloadV1,
): Promise<{ status: ProviderInvocationStartResult; eventId: string; providerInvocationAuthorized: boolean }> {
  decodeProviderInvocationStart(start)
  const eventId = providerInvocationStartEventId(start.delivery_id, start.attempt_ordinal)
  try {
    const result = await new EventLog(db).append({
      eventId,
      eventType: 'reply.provider_invocation_started',
      replyId: start.reply_id,
      claimEpoch: start.attempt_ordinal,
      payload: start as unknown as Record<string, unknown>,
    })
    return {
      status: result.inserted ? 'started' : 'already_started',
      eventId,
      providerInvocationAuthorized: result.inserted,
    }
  } catch (error) {
    if (error instanceof EventIdCanonicalMaterialCollisionError) {
      throw new InvocationStartCollisionError(error.message)
    }
    throw error
  }
}

export function deliveryNonce(replyId: string): string {
  return `out-${replyId}`
}

export interface DispatchResult {
  delivered: string[]
  failedRetryable: string[]
  failedPermanent: string[]
  deliveryUnknown: string[]
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
    deliveryUnknown: [],
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
      const ambiguous = err instanceof AmbiguousDeliveryOutcomeError || (err as any)?.ambiguous === true
      if (ambiguous) {
        const unknown = payload.delivery_unknown_payload
        if (!unknown) throw new AmbiguousDeliveryOutcomeError('ambiguous provider outcome lacks a frozen delivery_unknown payload')
        const unknownPayload = decodeReplyDeliveryUnknownPayload(unknown) as ReplyDeliveryUnknownPayloadV1
        const invocationStart = await db.queryOne<{ event_id: string }>(
          `SELECT event_id FROM event_log
           WHERE event_id = $1 AND event_type = 'reply.provider_invocation_started'
             AND reply_id = $2 AND claim_epoch = $3`,
          [unknownPayload.invocation_started_event_id, row.reply_id, epoch],
        )
        if (unknownPayload.reply_id !== row.reply_id || unknownPayload.attempt_ordinal !== epoch || !invocationStart) {
          throw new AmbiguousDeliveryOutcomeError('frozen delivery_unknown payload does not bind the active attempt')
        }
        await log.append({
          eventId: `delivery-unknown:${unknownPayload.delivery_id}:${unknownPayload.attempt_ordinal}`,
          eventType: 'reply.delivery_unknown',
          seatId: opts.dispatcherId,
          seatInstanceId: opts.dispatcherInstanceId,
          conversationId: row.conversation_id,
          causationId: unknownPayload.invocation_started_event_id,
          turnId: row.turn_id,
          replyId: row.reply_id,
          claimEpoch: epoch,
          payload: unknownPayload as unknown as Record<string, unknown>,
        })
        result.deliveryUnknown.push(row.reply_id)
        continue
      }
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
 * Release only claims that provably never crossed invocation-start. A stale
 * claim with a persisted invocation-start or delivery_unknown is preserved
 * for explicit reconciliation; restart is not zero-effect evidence.
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
  const released: OutboxViewRow[] = []
  for (const row of stale) {
    const invocationStarted = await db.queryOne<{ event_id: string; payload: unknown }>(
      `SELECT event_id, payload FROM event_log
       WHERE event_type = 'reply.provider_invocation_started'
         AND reply_id = $1 AND claim_epoch = $2
       LIMIT 1`,
      [row.reply_id, row.delivery_claim_epoch],
    )
    const unknown = await db.queryOne<{ event_id: string }>(
      `SELECT event_id FROM event_log
       WHERE event_type = 'reply.delivery_unknown'
         AND reply_id = $1 AND claim_epoch = $2
       LIMIT 1`,
      [row.reply_id, row.delivery_claim_epoch],
    )
    if (invocationStarted || unknown) {
      if (invocationStarted && !unknown) {
        const enqueued = parseEventPayload<Record<string, unknown>>(row.payload)
        if (enqueued.schema_version === 'aun-delivery-unit/v1') {
          const start = decodeProviderInvocationStart(parseEventPayload(invocationStarted.payload))
          const unknownPayload = buildReplyDeliveryUnknownPayload(
            enqueued as unknown as DeliveryUnitV1,
            start,
            invocationStarted.event_id,
          )
          await log.append({
            eventId: `delivery-unknown:${unknownPayload.delivery_id}:${unknownPayload.attempt_ordinal}`,
            eventType: 'reply.delivery_unknown',
            seatId: opts.dispatcherId,
            seatInstanceId: opts.activeInstanceId,
            conversationId: row.conversation_id,
            causationId: invocationStarted.event_id,
            turnId: row.turn_id,
            replyId: row.reply_id,
            claimEpoch: row.delivery_claim_epoch,
            payload: unknownPayload as unknown as Record<string, unknown>,
          })
        }
      }
      continue
    }
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
    released.push(row)
  }
  return released
}
