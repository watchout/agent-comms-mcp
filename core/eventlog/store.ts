// EventLogCore/v1 generic store — the caller-visible write path into event_log.
// Legacy authority rows remain forbidden at this surface after removal of
// the dormant registered-loader composition root.
//
// Writes are INSERTs only. event_id conflicts are idempotent only when the
// complete canonical conflict material is byte-identical. Conflicts on the claim arbiters (uq_el_turn_claim /
// uq_el_delivery_claim / uq_el_turn_completed / uq_el_reply_delivered)
// surface as ClaimLostError so callers back off — that IS the pull-claim
// protocol: claim = appending the claim event, conditional insert wins.

import type { DbAdapter } from '../db/adapter'
import { ensureEventLogSchema } from './schema'
import {
  ClaimLostError,
  EVENT_TYPES,
  EventIdCanonicalMaterialCollisionError,
  ProtectedAuthorityAppendForbiddenError,
  ReconciliationTransitionCollisionError,
  ReopenNotAuthorizedError,
  parseEventPayload,
  type AppendEvent,
  type AppendResult,
  type StoredEvent,
} from './types'
import {
  canonicalJson,
  decodeReconciliationObservation,
  decodeReconciliationResolvedPayload,
  decodeReplyDeliveredPayload,
  decodeReplyFailedPayload,
  decodeReconciliationRequest,
  decodeReplyDeliveryUnknownPayload,
  isProtectedAuthorityEventType,
  reconciliationOutcomeEventId,
  reconciliationOutcomeKey,
  reconciliationObservationEventId,
  sha256Utf8,
  type DeliveryUnknownReconciliationObservationV1,
  type DeliveryUnknownReconciliationRequestV1,
  type ReplyDeliveryReconciliationResolvedPayloadV1,
  type ReplyDeliveryUnknownPayloadV1,
  type ReplyDeliveredPayloadV1,
  type ReplyFailedPayloadV1,
} from './transport-contract'

const INSERT_SQL = `
  INSERT INTO event_log (
    event_id, event_type, seat_id, seat_instance_id, conversation_id,
    causation_id, correlation_id, turn_id, reply_id, claim_epoch, payload
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
  ON CONFLICT(event_id) DO NOTHING
`

// bun:sqlite exposes one connection per adapter and rejects overlapping
// BEGIN IMMEDIATE calls. Serialize top-level EventLog transactions per
// adapter while still allowing explicitly supplied transaction adapters to
// recurse through append()/appendBatch() without a nested BEGIN.
const transactionTails = new WeakMap<DbAdapter, Promise<void>>()

async function serializedTransaction<T>(db: DbAdapter, fn: (tx: DbAdapter) => Promise<T>): Promise<T> {
  const previous = transactionTails.get(db) ?? Promise.resolve()
  let release!: () => void
  const mine = new Promise<void>(resolve => { release = resolve })
  const tail = previous.then(() => mine)
  transactionTails.set(db, tail)
  await previous
  try {
    return await db.transaction(fn)
  } finally {
    release()
    if (transactionTails.get(db) === tail) transactionTails.delete(db)
  }
}

function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /UNIQUE constraint failed|duplicate key value/i.test(msg)
}

function validate(input: AppendEvent): void {
  if (!input.eventId) throw new Error('eventId is required')
  if (!EVENT_TYPES.includes(input.eventType)) {
    throw new Error(`unknown event_type: ${input.eventType}`)
  }
}

function assertCallerAppendAllowed(input: AppendEvent): void {
  if (isProtectedAuthorityEventType(input.eventType)) {
    throw new ProtectedAuthorityAppendForbiddenError(
      `${input.eventType} is owned by the private registered-loader boundary`,
    )
  }
}

export interface AppendEventConflictMaterialV1 {
  schema_version: 'aun-append-event-conflict-material/v1'
  event_id: string
  event_type: string
  seat_id: string | null
  seat_instance_id: string | null
  conversation_id: string | null
  causation_id: string | null
  correlation_id: string | null
  turn_id: string | null
  reply_id: string | null
  claim_epoch: number | null
  payload: Record<string, unknown>
}

function normalizePayload(payload: unknown): Record<string, unknown> {
  const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new EventIdCanonicalMaterialCollisionError('event payload is not a canonical object')
  }
  return parsed as Record<string, unknown>
}

export function appendEventConflictMaterial(input: AppendEvent): AppendEventConflictMaterialV1 {
  return {
    schema_version: 'aun-append-event-conflict-material/v1',
    event_id: input.eventId,
    event_type: input.eventType,
    seat_id: input.seatId ?? null,
    seat_instance_id: input.seatInstanceId ?? null,
    conversation_id: input.conversationId ?? null,
    causation_id: input.causationId ?? null,
    correlation_id: input.correlationId ?? null,
    turn_id: input.turnId ?? null,
    reply_id: input.replyId ?? null,
    claim_epoch: input.claimEpoch ?? null,
    payload: normalizePayload(input.payload ?? {}),
  }
}

export function storedEventConflictMaterial(event: StoredEvent): AppendEventConflictMaterialV1 {
  return {
    schema_version: 'aun-append-event-conflict-material/v1',
    event_id: event.event_id,
    event_type: event.event_type,
    seat_id: event.seat_id,
    seat_instance_id: event.seat_instance_id,
    conversation_id: event.conversation_id,
    causation_id: event.causation_id,
    correlation_id: event.correlation_id,
    turn_id: event.turn_id,
    reply_id: event.reply_id,
    claim_epoch: event.claim_epoch === null ? null : Number(event.claim_epoch),
    payload: normalizePayload(event.payload),
  }
}

export function assertByteIdenticalEvent(input: AppendEvent, stored: StoredEvent): void {
  const submitted = canonicalJson(appendEventConflictMaterial(input))
  const persisted = canonicalJson(storedEventConflictMaterial(stored))
  if (submitted !== persisted) {
    throw new EventIdCanonicalMaterialCollisionError(
      `event_id ${input.eventId} already exists with different canonical material`,
    )
  }
}

export type ReconciliationTerminalCommitPoint =
  | 'before_transaction'
  | 'before_outcome_append'
  | 'after_outcome_append'
  | 'before_terminal_append'
  | 'after_terminal_append'
  | 'before_commit'
  | 'after_commit_before_return'

export type ReconciliationTerminalV1 =
  | { outcome: 'delivered'; event_id: string; payload: ReplyDeliveredPayloadV1 }
  | { outcome: 'permanent_failure'; event_id: string; payload: ReplyFailedPayloadV1 }

export interface CommitReconciliationTerminalCASInputV1 {
  unknown_event_id: string
  reconciliation_request_event_id: string
  reconciliation_observation_event_id: string
  terminal: ReconciliationTerminalV1
  /** Deterministic rollback fixture only; never provider authority. */
  on_commit_point?: (point: ReconciliationTerminalCommitPoint) => void | Promise<void>
}

export interface CommitReconciliationTerminalCASResultV1 {
  status: 'inserted' | 'byte_identical_existing'
  outcome: StoredEvent
  terminal: StoredEvent
  provider_invocations: 0
}

export class EventLog {
  constructor(private db: DbAdapter) {}

  async ensureSchema(): Promise<void> {
    await ensureEventLogSchema(this.db)
  }

  /**
   * Append one event. Idempotent on event_id: appending the same event
   * twice returns { inserted: false } with the original row.
   * Throws ClaimLostError when a claim-arbiter unique index rejects the row.
   */
  async append(input: AppendEvent, db?: DbAdapter): Promise<AppendResult> {
    assertCallerAppendAllowed(input)
    return this.#appendValidated(input, db)
  }

  async #appendValidated(input: AppendEvent, db?: DbAdapter): Promise<AppendResult> {
    if (!db) return serializedTransaction(this.db, tx => this.#appendValidated(input, tx))
    validate(input)
    const params = [
      input.eventId,
      input.eventType,
      input.seatId ?? null,
      input.seatInstanceId ?? null,
      input.conversationId ?? null,
      input.causationId ?? null,
      input.correlationId ?? null,
      input.turnId ?? null,
      input.replyId ?? null,
      input.claimEpoch ?? null,
      JSON.stringify(input.payload ?? {}),
    ]
    let inserted: boolean
    try {
      const result = await db.execute(INSERT_SQL, params)
      inserted = result.rowCount > 0
    } catch (err) {
      if (isUniqueViolation(err)) throw new ClaimLostError(String(err))
      throw err
    }
    const event = await db.queryOne<StoredEvent>(
      'SELECT * FROM event_log WHERE event_id = $1',
      [input.eventId],
    )
    if (!event) throw new Error(`event ${input.eventId} not found after append`)
    assertByteIdenticalEvent(input, event)
    return { inserted, event }
  }

  /**
   * Append several events atomically (all-or-nothing). Used by the
   * transactional-outbox path: turn.completed + reply.enqueued* commit in
   * one transaction, so there is no window where the outcome exists but the
   * outbound work does not (or vice versa).
   */
  async appendBatch(inputs: AppendEvent[]): Promise<AppendResult[]> {
    for (const input of inputs) {
      validate(input)
      assertCallerAppendAllowed(input)
    }
    return serializedTransaction(this.db, async tx => {
      const results: AppendResult[] = []
      for (const input of inputs) {
        results.push(await this.append(input, tx))
      }
      return results
    })
  }

  private async requireEvent(
    db: DbAdapter,
    eventId: string,
    eventType: AppendEvent['eventType'],
  ): Promise<StoredEvent> {
    const event = await db.queryOne<StoredEvent>('SELECT * FROM event_log WHERE event_id = $1', [eventId])
    if (!event || event.event_type !== eventType) {
      throw new ReopenNotAuthorizedError(`required ${eventType} event ${eventId} is missing`)
    }
    return event
  }

  async commitReconciliationTerminalCAS(
    input: CommitReconciliationTerminalCASInputV1,
  ): Promise<CommitReconciliationTerminalCASResultV1> {
    await input.on_commit_point?.('before_transaction')
    const result = await serializedTransaction(this.db, async tx => {
      const unknownEvent = await this.requireEvent(tx, input.unknown_event_id, 'reply.delivery_unknown')
      const requestEvent = await this.requireEvent(tx, input.reconciliation_request_event_id, 'reply.delivery_reconciliation_requested')
      const observationEvent = await this.requireEvent(tx, input.reconciliation_observation_event_id, 'reply.delivery_reconciliation_observed')
      let unknown: ReplyDeliveryUnknownPayloadV1
      let request: DeliveryUnknownReconciliationRequestV1
      let observation: DeliveryUnknownReconciliationObservationV1
      try {
        unknown = decodeReplyDeliveryUnknownPayload(parseEventPayload(unknownEvent.payload))
        request = decodeReconciliationRequest(parseEventPayload(requestEvent.payload))
        observation = decodeReconciliationObservation(parseEventPayload(observationEvent.payload))
      } catch (error) {
        throw new ReconciliationTransitionCollisionError(`persisted reconciliation source failed strict decode: ${String(error)}`)
      }
      const unknownDigest = sha256Utf8(canonicalJson(storedEventConflictMaterial(unknownEvent)))
      if (
        unknownEvent.reply_id !== unknown.reply_id ||
        unknownEvent.claim_epoch === null ||
        Number(unknownEvent.claim_epoch) !== unknown.attempt_ordinal ||
        requestEvent.reply_id !== null && requestEvent.reply_id !== unknown.reply_id ||
        observationEvent.reply_id !== null && observationEvent.reply_id !== unknown.reply_id ||
        request.delivery_unknown_event_id !== unknownEvent.event_id ||
        request.delivery_unknown_event_digest !== unknownDigest ||
        request.reply_id !== unknown.reply_id ||
        request.delivery_id !== unknown.delivery_id ||
        request.recipient_seat_id !== unknown.recipient_seat_id ||
        request.attempt_ordinal !== unknown.attempt_ordinal ||
        request.connector_instance_id !== unknown.connector_instance_id ||
        request.resolved_binding_snapshot_digest !== unknown.resolved_binding_snapshot_digest ||
        request.resolved_delivery_decision_digest !== unknown.resolved_delivery_decision_digest ||
        request.delivery_digest !== unknown.delivery_digest ||
        request.provider_request_digest !== unknown.provider_request_digest ||
        request.business_nonce !== unknown.business_nonce ||
        request.provider_nonce !== unknown.provider_nonce ||
        request.capability_digest !== unknown.capability_digest ||
        request.reconciliation_mode !== unknown.reconciliation_mode ||
        request.reconciliation_mode === 'none' ||
        observation.reconciliation_request_digest !== request.request_digest ||
        reconciliationObservationEventId(unknownEvent.event_id, observation.observation_digest) !== observationEvent.event_id
      ) {
        throw new ReconciliationTransitionCollisionError('reconciliation request or observation differs from the persisted unknown delivery')
      }

      let eventType: 'reply.delivered' | 'reply.failed'
      let terminalPayload: ReplyDeliveredPayloadV1 | ReplyFailedPayloadV1
      if (input.terminal.outcome === 'delivered') {
        if (observation.observed_outcome !== 'validated_original_receipt' || observation.validated_receipt_digest === null) {
          throw new ReconciliationTransitionCollisionError('delivered terminal requires a validated original receipt observation')
        }
        const payload = decodeReplyDeliveredPayload(input.terminal.payload)
        if (
          payload.reply_id !== unknown.reply_id ||
          payload.delivery_id !== unknown.delivery_id ||
          payload.recipient_seat_id !== unknown.recipient_seat_id ||
          payload.receipt_digest !== observation.validated_receipt_digest ||
          payload.provider_request_digest !== unknown.provider_request_digest ||
          payload.resolved_delivery_decision_digest !== unknown.resolved_delivery_decision_digest ||
          payload.fanout_child_provenance_digest !== unknown.fanout_child_provenance_digest
        ) throw new ReconciliationTransitionCollisionError('delivered terminal differs from the validated original receipt observation')
        eventType = 'reply.delivered'
        terminalPayload = payload
      } else {
        if (observation.observed_outcome !== 'permanent_failure' || observation.permanent_failure_code === null) {
          throw new ReconciliationTransitionCollisionError('permanent terminal requires a permanent failure observation')
        }
        const payload = decodeReplyFailedPayload(input.terminal.payload)
        if (
          payload.reply_id !== unknown.reply_id ||
          payload.delivery_id !== unknown.delivery_id ||
          payload.recipient_seat_id !== unknown.recipient_seat_id ||
          payload.failure_code !== observation.permanent_failure_code ||
          payload.permanent !== true ||
          payload.fanout_child_provenance_digest !== unknown.fanout_child_provenance_digest
        ) throw new ReconciliationTransitionCollisionError('permanent terminal differs from the permanent failure observation')
        eventType = 'reply.failed'
        terminalPayload = payload
      }
      if (!input.terminal.event_id) throw new ReconciliationTransitionCollisionError('terminal event_id is required')

      const outcomeEventId = reconciliationOutcomeEventId(unknown.delivery_id, unknown.attempt_ordinal)
      const outcomePayload: ReplyDeliveryReconciliationResolvedPayloadV1 = {
        delivery_unknown_event_id: unknownEvent.event_id,
        reconciliation_observation_event_id: observationEvent.event_id,
        reconciliation_request_digest: request.request_digest,
        observation_digest: observation.observation_digest,
        reply_id: unknown.reply_id,
        delivery_id: unknown.delivery_id,
        recipient_seat_id: unknown.recipient_seat_id,
        attempt_ordinal: unknown.attempt_ordinal,
        reconciliation_outcome_key: reconciliationOutcomeKey(unknown.delivery_id, unknown.attempt_ordinal),
        outcome: input.terminal.outcome,
        resulting_event_id: input.terminal.event_id,
      }
      decodeReconciliationResolvedPayload(outcomePayload)
      const group: AppendEvent[] = [
        {
          eventId: outcomeEventId,
          eventType: 'reply.delivery_reconciliation_resolved',
          conversationId: unknownEvent.conversation_id,
          causationId: observationEvent.event_id,
          correlationId: unknownEvent.correlation_id,
          turnId: unknownEvent.turn_id,
          replyId: unknown.reply_id,
          claimEpoch: unknown.attempt_ordinal,
          payload: outcomePayload as unknown as Record<string, unknown>,
        },
        {
          eventId: input.terminal.event_id,
          eventType,
          conversationId: unknownEvent.conversation_id,
          causationId: outcomeEventId,
          correlationId: unknownEvent.correlation_id,
          turnId: unknownEvent.turn_id,
          replyId: unknown.reply_id,
          claimEpoch: unknown.attempt_ordinal,
          payload: terminalPayload as unknown as Record<string, unknown>,
        },
      ]
      const existing = await Promise.all(group.map(item => tx.queryOne<StoredEvent>(
        'SELECT * FROM event_log WHERE event_id = $1',
        [item.eventId],
      )))
      const existingCount = existing.filter(Boolean).length
      if (existingCount === 2) {
        try {
          group.forEach((item, index) => assertByteIdenticalEvent(item, existing[index]!))
        } catch (error) {
          throw new ReconciliationTransitionCollisionError(String(error))
        }
        return {
          status: 'byte_identical_existing' as const,
          outcome: existing[0]!,
          terminal: existing[1]!,
          provider_invocations: 0 as const,
        }
      }
      if (existingCount !== 0) throw new ReconciliationTransitionCollisionError(`terminal outcome atomic set has ${existingCount}/2 durable members`)

      const priorTerminal = await tx.queryOne<StoredEvent>(
        `SELECT * FROM event_log
         WHERE reply_id = $1
           AND claim_epoch = $2
           AND event_type IN ('reply.delivered', 'reply.failed', 'reply.delivery_reopened')
         ORDER BY seq ASC LIMIT 1`,
        [unknown.reply_id, unknown.attempt_ordinal],
      )
      if (priorTerminal) throw new ReconciliationTransitionCollisionError(`outcome already has terminal event ${priorTerminal.event_id}`)

      await input.on_commit_point?.('before_outcome_append')
      let outcomeResult: AppendResult
      try {
        outcomeResult = await this.append(group[0]!, tx)
      } catch (error) {
        if (error instanceof EventIdCanonicalMaterialCollisionError || error instanceof ClaimLostError) {
          throw new ReconciliationTransitionCollisionError(String(error))
        }
        throw error
      }
      await input.on_commit_point?.('after_outcome_append')
      await input.on_commit_point?.('before_terminal_append')
      let terminalResult: AppendResult
      try {
        terminalResult = await this.append(group[1]!, tx)
      } catch (error) {
        if (error instanceof EventIdCanonicalMaterialCollisionError || error instanceof ClaimLostError) {
          throw new ReconciliationTransitionCollisionError(String(error))
        }
        throw error
      }
      await input.on_commit_point?.('after_terminal_append')
      const readback = await Promise.all(group.map(item => tx.queryOne<StoredEvent>(
        'SELECT * FROM event_log WHERE event_id = $1',
        [item.eventId],
      )))
      if (readback.some(row => !row)) throw new ReconciliationTransitionCollisionError('terminal outcome readback is incomplete')
      group.forEach((item, index) => assertByteIdenticalEvent(item, readback[index]!))
      await input.on_commit_point?.('before_commit')
      return {
        status: outcomeResult.inserted || terminalResult.inserted ? 'inserted' as const : 'byte_identical_existing' as const,
        outcome: readback[0]!,
        terminal: readback[1]!,
        provider_invocations: 0 as const,
      }
    })
    await input.on_commit_point?.('after_commit_before_return')
    return result
  }

  /** Read events in replay order, strictly after `afterSeq`. */
  async readSince(afterSeq: number, limit = 1000): Promise<StoredEvent[]> {
    return this.db.query<StoredEvent>(
      'SELECT * FROM event_log WHERE seq > $1 ORDER BY seq ASC LIMIT $2',
      [afterSeq, limit],
    )
  }

  async readConversation(conversationId: string): Promise<StoredEvent[]> {
    return this.db.query<StoredEvent>(
      'SELECT * FROM event_log WHERE conversation_id = $1 ORDER BY seq ASC',
      [conversationId],
    )
  }

  async getByEventId(eventId: string): Promise<StoredEvent | null> {
    return this.db.queryOne<StoredEvent>(
      'SELECT * FROM event_log WHERE event_id = $1',
      [eventId],
    )
  }

  async count(): Promise<number> {
    const row = await this.db.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM event_log')
    return row?.n ?? 0
  }
}
