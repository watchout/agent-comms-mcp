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
  V2NativeMeshFenceError,
  type V2NativeInboundPayloadV1,
  type V2NativeMeshExecutionFence,
  type V2NativeMeshScopeV1,
} from './v2-native-ingress'

export type InternalHandoffCommitPoint =
  | 'after_delivery_claimed'
  | 'before_atomic_placement'
  | 'after_atomic_placement_before_return'

export type InternalHandoffMutationBoundary =
  | 'before_delivery_claimed_append'
  | 'after_delivery_claimed_append'
  | 'after_injected_delivery_claimed_commit_point'
  | 'after_injected_before_atomic_placement_commit_point'
  | 'before_reply_placement_append'
  | 'after_reply_placement_append'
  | 'before_handoff_accepted_append'
  | 'after_handoff_accepted_append'
  | 'after_injected_atomic_placement_commit_point'

export interface InternalHandoffDispatchResult {
  accepted: string[]
  lostClaims: string[]
  ignoredExternal: string[]
  providerInvocations: 0
  externalSendAttempts: 0
  V1Invocations: 0
}

export class InternalHandoffStaleClaimError extends Error {
  readonly code = 'V2_NATIVE_INTERNAL_HANDOFF_STALE_CLAIM' as const
}

export class InternalHandoffRecoveryFenceError extends Error {
  readonly code = 'V2_NATIVE_INTERNAL_HANDOFF_RECOVERY_FENCE_FAILED' as const
}

export interface InternalHandoffPredecessorDeathEvidenceV1 {
  schema_version: 'aun-v2-native-predecessor-death-evidence/v1'
  run_id: string
  scope_sha256: string
  predecessor_dispatcher_instance_id: string
  observed_state: 'dead'
  supervisor_evidence_ref: string
  observed_at: string
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

interface ActiveInternalHandoffClaim {
  replyId: string
  claimEventId: string
  claimEpoch: number
  dispatcherInstanceId: string
}

async function assertActiveInternalHandoffClaim(
  db: DbAdapter,
  expected: ActiveInternalHandoffClaim,
): Promise<StoredEvent> {
  const claim = await db.queryOne<StoredEvent>(
    `SELECT * FROM event_log
      WHERE event_id = $1 AND event_type = 'reply.delivery_claimed'
      FOR UPDATE`,
    [expected.claimEventId],
  )
  if (
    !claim ||
    claim.reply_id !== expected.replyId ||
    Number(claim.claim_epoch) !== expected.claimEpoch ||
    claim.seat_id !== 'v2-native-internal-handoff' ||
    claim.seat_instance_id !== expected.dispatcherInstanceId
  ) {
    throw new InternalHandoffStaleClaimError(`internal handoff claim ${expected.claimEventId} identity drift`)
  }
  const released = await db.queryOne<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM event_log
      WHERE event_type = 'reply.failed' AND reply_id = $1 AND claim_epoch = $2`,
    [expected.replyId, expected.claimEpoch],
  )
  const newer = await db.queryOne<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM event_log
      WHERE event_type = 'reply.delivery_claimed' AND reply_id = $1 AND claim_epoch > $2`,
    [expected.replyId, expected.claimEpoch],
  )
  const terminal = await db.queryOne<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM event_log
      WHERE reply_id = $1 AND event_type IN ('reply.handoff_accepted', 'reply.delivered')`,
    [expected.replyId],
  )
  if (Number(released?.n ?? 0) > 0 || Number(newer?.n ?? 0) > 0 || Number(terminal?.n ?? 0) > 0) {
    throw new InternalHandoffStaleClaimError(`internal handoff claim ${expected.claimEventId} is no longer active`)
  }
  return claim
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
    mutationFence?: (boundary: InternalHandoffMutationBoundary, replyId: string) => void | Promise<void>
  },
): Promise<InternalHandoffDispatchResult> {
  const scope = assertV2NativeMeshExecutionFence(scopeValue, fence)
  if (scope.stage_id !== 'S0_IMPLEMENTATION' && !options.mutationFence) {
    throw new V2NativeMeshFenceError('native activation internal handoff requires a mutation revalidation callback')
  }
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
    let claim: StoredEvent
    let epoch: number
    try {
      const claimed = await db.transaction(async tx => {
        assertV2NativeMeshExecutionFence(scopeValue, fence)
        const nextEpoch = await nextInternalEpoch(tx, row.reply_id)
        await options.mutationFence?.('before_delivery_claimed_append', row.reply_id)
        const event = (await new EventLog(db).append({
          eventId: randomUUID(),
          eventType: 'reply.delivery_claimed',
          seatId: 'v2-native-internal-handoff',
          seatInstanceId: options.dispatcherInstanceId,
          conversationId: row.conversation_id,
          causationId: row.enqueued_event_id,
          turnId: row.turn_id,
          replyId: row.reply_id,
          claimEpoch: nextEpoch,
          payload: { kind: 'v2_native_internal_handoff', run_id: scope.run_id },
        }, tx)).event
        await options.mutationFence?.('after_delivery_claimed_append', row.reply_id)
        assertV2NativeMeshExecutionFence(scopeValue, fence)
        return { event, epoch: nextEpoch }
      })
      claim = claimed.event
      epoch = claimed.epoch
    } catch (error) {
      if (error instanceof ClaimLostError) {
        result.lostClaims.push(row.reply_id)
        continue
      }
      throw error
    }
    await options.onCommitPoint?.('after_delivery_claimed', row.reply_id)
    await options.mutationFence?.('after_injected_delivery_claimed_commit_point', row.reply_id)
    await options.onCommitPoint?.('before_atomic_placement', row.reply_id)
    await options.mutationFence?.('after_injected_before_atomic_placement_commit_point', row.reply_id)
    await db.transaction(async tx => {
      assertV2NativeMeshExecutionFence(scopeValue, fence)
      const activeClaim = {
        replyId: row.reply_id,
        claimEventId: claim.event_id,
        claimEpoch: epoch,
        dispatcherInstanceId: options.dispatcherInstanceId,
      }
      await assertActiveInternalHandoffClaim(tx, activeClaim)
      assertV2NativeMeshExecutionFence(scopeValue, fence)
      await options.mutationFence?.('before_reply_placement_append', row.reply_id)
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
      await options.mutationFence?.('after_reply_placement_append', row.reply_id)
      assertV2NativeMeshExecutionFence(scopeValue, fence)
      await assertActiveInternalHandoffClaim(tx, activeClaim)
      const terminal = acceptedPayload(row.reply_id, authority.inbound.source_agent_id, placed.event.event_id)
      await options.mutationFence?.('before_handoff_accepted_append', row.reply_id)
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
      await options.mutationFence?.('after_handoff_accepted_append', row.reply_id)
      // If the deadline crosses after the terminal append, roll back both the
      // recipient placement and terminal instead of committing stale work.
      assertV2NativeMeshExecutionFence(scopeValue, fence)
    })
    result.accepted.push(row.reply_id)
    await options.onCommitPoint?.('after_atomic_placement_before_return', row.reply_id)
    await options.mutationFence?.('after_injected_atomic_placement_commit_point', row.reply_id)
  }
  return result
}

/** Record the durable supervisor observation required before claim recovery. */
export async function recordV2NativeInternalHandoffPredecessorDeath(
  db: DbAdapter,
  scopeValue: unknown,
  fence: V2NativeMeshExecutionFence,
  input: {
    predecessorDispatcherInstanceId: string
    observerInstanceId: string
    supervisorEvidenceRef: string
    observedAt?: string
  },
): Promise<StoredEvent> {
  const scope = assertV2NativeMeshExecutionFence(scopeValue, fence)
  if (
    input.predecessorDispatcherInstanceId.trim() === '' ||
    input.observerInstanceId.trim() === '' ||
    input.supervisorEvidenceRef.trim() === ''
  ) throw new InternalHandoffRecoveryFenceError('predecessor death evidence fields must be non-empty')
  const observedAt = input.observedAt ?? new Date().toISOString()
  if (Number.isNaN(Date.parse(observedAt))) {
    throw new InternalHandoffRecoveryFenceError('predecessor death observedAt must be RFC3339')
  }
  const payload: InternalHandoffPredecessorDeathEvidenceV1 = {
    schema_version: 'aun-v2-native-predecessor-death-evidence/v1',
    run_id: scope.run_id,
    scope_sha256: v2NativeMeshScopeSha256(scope),
    predecessor_dispatcher_instance_id: input.predecessorDispatcherInstanceId,
    observed_state: 'dead',
    supervisor_evidence_ref: input.supervisorEvidenceRef,
    observed_at: observedAt,
  }
  return db.transaction(async tx => {
    assertV2NativeMeshExecutionFence(scopeValue, fence)
    const event = (await new EventLog(db).append({
      eventId: `mesh-predecessor-dead:${scope.run_id}:${sha256Utf8(canonicalJson({
        predecessor: input.predecessorDispatcherInstanceId,
        evidence_ref: input.supervisorEvidenceRef,
      }))}`,
      eventType: 'runtime.predecessor_death_recorded',
      seatId: 'v2-native-supervisor',
      seatInstanceId: input.observerInstanceId,
      payload: payload as unknown as Record<string, unknown>,
    }, tx)).event
    assertV2NativeMeshExecutionFence(scopeValue, fence)
    return event
  })
}

async function assertPredecessorDeathEvidence(
  db: DbAdapter,
  scope: V2NativeMeshScopeV1,
  predecessorInstanceId: string,
  evidenceEventId: string | undefined,
): Promise<StoredEvent> {
  if (!evidenceEventId) {
    throw new InternalHandoffRecoveryFenceError(`missing durable predecessor-death evidence for ${predecessorInstanceId}`)
  }
  const event = await db.queryOne<StoredEvent>(
    `SELECT * FROM event_log WHERE event_id = $1 AND event_type = 'runtime.predecessor_death_recorded'`,
    [evidenceEventId],
  )
  if (!event) throw new InternalHandoffRecoveryFenceError(`predecessor-death evidence ${evidenceEventId} not found`)
  const payload = parseEventPayload<Partial<InternalHandoffPredecessorDeathEvidenceV1>>(event.payload)
  if (
    event.seat_id !== 'v2-native-supervisor' ||
    payload.schema_version !== 'aun-v2-native-predecessor-death-evidence/v1' ||
    payload.run_id !== scope.run_id ||
    payload.scope_sha256 !== v2NativeMeshScopeSha256(scope) ||
    payload.predecessor_dispatcher_instance_id !== predecessorInstanceId ||
    payload.observed_state !== 'dead' ||
    typeof payload.supervisor_evidence_ref !== 'string' ||
    payload.supervisor_evidence_ref.trim() === '' ||
    typeof payload.observed_at !== 'string' ||
    Number.isNaN(Date.parse(payload.observed_at))
  ) throw new InternalHandoffRecoveryFenceError(`predecessor-death evidence ${evidenceEventId} scope or identity mismatch`)
  return event
}

/** Recover only claims whose predecessor death is durably proven. */
export async function recoverV2NativeInternalHandoffClaims(
  db: DbAdapter,
  scopeValue: unknown,
  fence: V2NativeMeshExecutionFence,
  options: {
    activeInstanceId: string
    predecessorDeathEvidenceEventIds: Record<string, string>
  },
): Promise<string[]> {
  const scope = assertV2NativeMeshExecutionFence(scopeValue, fence)
  const stale: Array<{ row: OutboxViewRow; evidence: StoredEvent }> = []
  // Preflight the complete stale set before any release append. A missing or
  // mismatched proof therefore yields zero recovery mutation.
  for (const row of await outboxView(db)) {
    if (
      row.delivery_claim_event_id === null ||
      row.claimed_by_dispatcher !== 'v2-native-internal-handoff' ||
      row.claimed_by_instance === options.activeInstanceId
    ) continue
    const authority = await nativeAuthorityForReply(db, row, scope)
    if (!authority) continue
    const predecessor = row.claimed_by_instance
    if (!predecessor) throw new InternalHandoffRecoveryFenceError(`claim ${row.delivery_claim_event_id} has no predecessor identity`)
    stale.push({
      row,
      evidence: await assertPredecessorDeathEvidence(
        db,
        scope,
        predecessor,
        options.predecessorDeathEvidenceEventIds[predecessor],
      ),
    })
  }
  const released: string[] = []
  for (const { row, evidence } of stale) {
    try {
      await db.transaction(async tx => {
        assertV2NativeMeshExecutionFence(scopeValue, fence)
        await assertActiveInternalHandoffClaim(tx, {
          replyId: row.reply_id,
          claimEventId: row.delivery_claim_event_id!,
          claimEpoch: Number(row.delivery_claim_epoch),
          dispatcherInstanceId: row.claimed_by_instance!,
        })
        assertV2NativeMeshExecutionFence(scopeValue, fence)
        await new EventLog(db).append({
          eventId: `mesh-handoff-recover:${row.reply_id}:${row.delivery_claim_epoch}`,
          eventType: 'reply.failed',
          seatId: 'v2-native-internal-handoff',
          seatInstanceId: options.activeInstanceId,
          conversationId: row.conversation_id,
          causationId: row.delivery_claim_event_id,
          turnId: row.turn_id,
          replyId: row.reply_id,
          claimEpoch: row.delivery_claim_epoch,
          payload: {
            kind: 'retryable',
            reason: 'internal_handoff_proven_dead_predecessor_recovery',
            run_id: scope.run_id,
            predecessor_death_evidence_event_id: evidence.event_id,
          },
        }, tx)
        assertV2NativeMeshExecutionFence(scopeValue, fence)
      })
      released.push(row.reply_id)
    } catch (error) {
      // Placement and recovery serialize on the same claim row. If placement
      // won, recovery observes the terminal and releases nothing.
      if (error instanceof InternalHandoffStaleClaimError) continue
      throw error
    }
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
