// V2-native internal reply placement.
//
// This is deliberately not an OutboxTransport: it never owns a provider
// port.  Routing authority comes from the immutable inbound message, while
// the runtime controls reply content only.  Recipient placement and
// reply.handoff_accepted commit atomically with one delivery identity.

import { randomUUID } from 'node:crypto'
import type { DbAdapter } from '../db/adapter'
import { EventLog } from './store'
import { outboxView, pendingDeliveries } from './views'
import { ClaimLostError, parseEventPayload, type OutboxViewRow, type StoredEvent } from './types'
import { canonicalJson, sha256Utf8, type ReplyHandoffAcceptedPayloadV1 } from './transport-contract'
import {
  appendV2NativeInbound,
  assertV2NativeMeshExecutionFence,
  decodeV2NativeInboundPayload,
  v2NativeMeshScopeSha256,
  type V2NativeInboundPayloadV1,
  type V2NativeMeshExecutionFence,
  type V2NativeMeshScopeV1,
} from './v2-native-ingress'

export type InternalHandoffCommitPoint =
  | 'after_delivery_claimed'
  | 'before_atomic_placement'
  | 'after_atomic_placement_before_return'

export interface InternalHandoffDispatchResult {
  accepted: string[]
  lostClaims: string[]
  ignoredExternal: string[]
  providerInvocations: 0
  externalSendAttempts: 0
  V1Invocations: 0
}

interface NativeReplyAuthority {
  row: OutboxViewRow
  received: StoredEvent
  inbound: V2NativeInboundPayloadV1
  content: string
}

async function nativeAuthorityForReply(
  db: DbAdapter,
  row: OutboxViewRow,
  scope: V2NativeMeshScopeV1,
): Promise<NativeReplyAuthority | null> {
  const receivedRows = await db.query<StoredEvent>(
    `SELECT received.* FROM event_log received
      JOIN event_log enqueued ON enqueued.turn_id = received.turn_id
     WHERE enqueued.event_type = 'reply.enqueued'
       AND enqueued.reply_id = $1
       AND received.event_type = 'message.received'
       AND received.seat_id = enqueued.seat_id
     ORDER BY received.seq ASC`,
    [row.reply_id],
  )
  if (receivedRows.length !== 1) return null
  const raw = parseEventPayload<Record<string, unknown>>(receivedRows[0].payload)
  if (raw.mesh_native !== true) return null
  const inbound = decodeV2NativeInboundPayload(raw)
  const enqueued = parseEventPayload<Record<string, unknown>>(row.payload)
  if (typeof enqueued.content !== 'string') throw new Error(`native reply ${row.reply_id} has no typed content`)
  if (
    inbound.run_id !== scope.run_id ||
    inbound.scope_sha256 !== v2NativeMeshScopeSha256(scope) ||
    row.seat_id !== inbound.recipient_agent_id
  ) throw new Error(`native reply ${row.reply_id} disagrees with frozen inbound authority`)
  return { row, received: receivedRows[0], inbound, content: enqueued.content }
}

async function nextInternalEpoch(db: DbAdapter, replyId: string): Promise<number> {
  const row = await db.queryOne<{ max_epoch: number | null }>(
    `SELECT MAX(claim_epoch) AS max_epoch FROM event_log
      WHERE event_type = 'reply.delivery_claimed' AND reply_id = $1`,
    [replyId],
  )
  return row?.max_epoch === null || row?.max_epoch === undefined ? 0 : Number(row.max_epoch) + 1
}

function deliveryId(replyId: string): string {
  return `mesh-internal:${replyId}`
}

function acceptedPayload(replyId: string, recipientAgentId: string, receivedEventId: string): ReplyHandoffAcceptedPayloadV1 {
  const id = deliveryId(replyId)
  return {
    reply_id: replyId,
    delivery_id: id,
    recipient_seat_id: recipientAgentId,
    receipt_digest: sha256Utf8(canonicalJson({
      schema_version: 'aun-v2-native-handoff-receipt/v1',
      delivery_id: id,
      reply_id: replyId,
      recipient_agent_id: recipientAgentId,
      recipient_received_event_id: receivedEventId,
    })),
    fanout_child_provenance_digest: null,
  }
}

export async function dispatchV2NativeInternalHandoffs(
  db: DbAdapter,
  scopeValue: unknown,
  fence: V2NativeMeshExecutionFence,
  options: {
    dispatcherInstanceId: string
    maxReplies?: number
    onCommitPoint?: (point: InternalHandoffCommitPoint, replyId: string) => void | Promise<void>
  },
): Promise<InternalHandoffDispatchResult> {
  const scope = assertV2NativeMeshExecutionFence(scopeValue, fence)
  const result: InternalHandoffDispatchResult = {
    accepted: [],
    lostClaims: [],
    ignoredExternal: [],
    providerInvocations: 0,
    externalSendAttempts: 0,
    V1Invocations: 0,
  }
  let considered = 0
  for (const row of await pendingDeliveries(db)) {
    if (considered >= (options.maxReplies ?? Number.MAX_SAFE_INTEGER)) break
    const authority = await nativeAuthorityForReply(db, row, scope)
    if (!authority) {
      result.ignoredExternal.push(row.reply_id)
      continue
    }
    considered += 1
    const epoch = await nextInternalEpoch(db, row.reply_id)
    let claim: StoredEvent
    try {
      claim = (await new EventLog(db).append({
        eventId: randomUUID(),
        eventType: 'reply.delivery_claimed',
        seatId: 'v2-native-internal-handoff',
        seatInstanceId: options.dispatcherInstanceId,
        conversationId: row.conversation_id,
        causationId: row.enqueued_event_id,
        turnId: row.turn_id,
        replyId: row.reply_id,
        claimEpoch: epoch,
        payload: { kind: 'v2_native_internal_handoff', run_id: scope.run_id },
      })).event
    } catch (error) {
      if (error instanceof ClaimLostError) {
        result.lostClaims.push(row.reply_id)
        continue
      }
      throw error
    }
    await options.onCommitPoint?.('after_delivery_claimed', row.reply_id)
    await options.onCommitPoint?.('before_atomic_placement', row.reply_id)
    await db.transaction(async tx => {
      const placed = await appendV2NativeInbound(db, scope, fence, {
        message_id: `mesh-reply-message:${row.reply_id}`,
        delivery_id: deliveryId(row.reply_id),
        route_id: `mesh-reply-route:${row.reply_id}`,
        route_kind: 'reply',
        source_agent_id: authority.inbound.recipient_agent_id,
        recipient_agent_id: authority.inbound.source_agent_id,
        content: authority.content,
        conversation_id: row.conversation_id ?? `mesh:${scope.run_id}:${row.reply_id}`,
        correlation_id: authority.received.correlation_id ?? `mesh-correlation:${scope.run_id}:${row.reply_id}`,
        causation_id: row.enqueued_event_id,
      }, tx)
      const terminal = acceptedPayload(row.reply_id, authority.inbound.source_agent_id, placed.event.event_id)
      await new EventLog(db).append({
        eventId: `mesh-handoff-accepted:${row.reply_id}`,
        eventType: 'reply.handoff_accepted',
        seatId: 'v2-native-internal-handoff',
        seatInstanceId: options.dispatcherInstanceId,
        conversationId: row.conversation_id,
        causationId: claim.event_id,
        turnId: row.turn_id,
        replyId: row.reply_id,
        claimEpoch: epoch,
        payload: terminal as unknown as Record<string, unknown>,
      }, tx)
    })
    result.accepted.push(row.reply_id)
    await options.onCommitPoint?.('after_atomic_placement_before_return', row.reply_id)
  }
  return result
}

/** Identity-based restart recovery for claims that never reached placement. */
export async function recoverV2NativeInternalHandoffClaims(
  db: DbAdapter,
  scopeValue: unknown,
  fence: V2NativeMeshExecutionFence,
  activeInstanceId: string,
): Promise<string[]> {
  const scope = assertV2NativeMeshExecutionFence(scopeValue, fence)
  const released: string[] = []
  for (const row of await outboxView(db)) {
    if (
      row.delivery_claim_event_id === null ||
      row.claimed_by_dispatcher !== 'v2-native-internal-handoff' ||
      row.claimed_by_instance === activeInstanceId
    ) continue
    const authority = await nativeAuthorityForReply(db, row, scope)
    if (!authority) continue
    await new EventLog(db).append({
      eventId: `mesh-handoff-recover:${row.reply_id}:${row.delivery_claim_epoch}`,
      eventType: 'reply.failed',
      seatId: 'v2-native-internal-handoff',
      seatInstanceId: activeInstanceId,
      conversationId: row.conversation_id,
      causationId: row.delivery_claim_event_id,
      turnId: row.turn_id,
      replyId: row.reply_id,
      claimEpoch: row.delivery_claim_epoch,
      payload: { kind: 'retryable', reason: 'internal_handoff_instance_recovery', run_id: scope.run_id },
    })
    released.push(row.reply_id)
  }
  return released
}

export async function pendingV2NativeInternalHandoffs(
  db: DbAdapter,
  scopeValue: unknown,
  fence: V2NativeMeshExecutionFence,
): Promise<string[]> {
  const scope = assertV2NativeMeshExecutionFence(scopeValue, fence)
  const result: string[] = []
  for (const row of await outboxView(db)) {
    if (await nativeAuthorityForReply(db, row, scope)) result.push(row.reply_id)
  }
  return result.sort()
}
