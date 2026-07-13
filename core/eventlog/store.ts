// EventLogCore/v1 store — the only write path into event_log.
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
  FanoutCollisionError,
  ReconciliationTransitionCollisionError,
  ReopenAtomicSetIncompleteError,
  ReopenNotAuthorizedError,
  parseEventPayload,
  type AppendEvent,
  type AppendResult,
  type StoredEvent,
} from './types'
import {
  PRODUCER_KIND_TO_EVIDENCE_KIND,
  attestationConsumptionEventId,
  canonicalJson,
  decodeAttestation,
  decodeAttestationConsumption,
  decodeEvidenceRecord,
  decodeFanoutPlan,
  decodeFanoutRequest,
  decodeIssuerRegistration,
  decodeProducerRegistration,
  decodeReconciliationObservation,
  decodeReconciliationResolvedPayload,
  decodeReplyDeliveredPayload,
  decodeReplyFailedPayload,
  decodeReconciliationRequest,
  decodeReplyDeliveryReopenedPayload,
  decodeReplyDeliveryUnknownPayload,
  decodeRetryBudgetAuthority,
  decodeRetryBudgetSnapshot,
  issuerRegistrationEventId,
  buildFanoutProvenance,
  producerRegistrationEventId,
  reconciliationOutcomeEventId,
  reconciliationOutcomeKey,
  reconciliationObservationEventId,
  reopenEventId,
  retryBudgetSnapshotEventId,
  sha256Utf8,
  validateDeliveryUnit,
  type DeliveryUnknownReconciliationObservationV1,
  type DeliveryUnknownReconciliationRequestV1,
  type DeliveryUnitV1,
  type FanoutPlanV1,
  type FanoutRequestV1,
  type LoadedConnectorRegistrationV1,
  type ReplyDeliveryReconciliationResolvedPayloadV1,
  type ReplyDeliveryReopenedPayloadV1,
  type ReplyDeliveryUnknownPayloadV1,
  type ReplyDeliveredPayloadV1,
  type ReplyFailedPayloadV1,
  type RetryBudgetAuthorityV1,
  type RetryBudgetSnapshotV1,
  type ZeroEffectProducerRegistrationV1,
  type ZeroExternalEffectAttestationConsumptionV1,
  type ZeroExternalEffectAttestationV1,
  type ZeroExternalEffectEvidenceRecordV1,
  type RetryBudgetIssuerRegistrationV1,
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

export type ReopenAuthorizationCommitPoint =
  | 'before_transaction'
  | 'before_outcome_append'
  | 'after_outcome_append'
  | 'before_consumption_append'
  | 'after_consumption_append'
  | 'before_budget_snapshot_append'
  | 'after_budget_snapshot_append'
  | 'before_reopen_append'
  | 'after_reopen_append'
  | 'before_commit'
  | 'after_commit_before_return'

export interface CommitReopenAuthorizationCASInput {
  unknown_event_id: string
  reconciliation_request_event_id: string
  reconciliation_observation_event_id: string
  evidence_event_id: string
  attestation_event_id: string
  producer_registration_event_id: string
  issuer_registration_event_id: string
  budget_snapshot_event_id: string
  retry_budget_authority: RetryBudgetAuthorityV1
  intended_next_attempt_ordinal: number
  /** Deterministic crash fixture only; never provider authority. */
  on_commit_point?: (point: ReopenAuthorizationCommitPoint) => void | Promise<void>
}

export interface CommitReopenAuthorizationCASResult {
  status: 'inserted' | 'byte_identical_existing'
  outcome: StoredEvent
  consumption: StoredEvent
  generation_after_snapshot: StoredEvent
  reopen: StoredEvent
  provider_invocations: 0
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

export type FanoutAtomicCommitPoint =
  | { point: 'before_transaction' }
  | { point: 'before_plan_append' }
  | { point: 'after_plan_append' }
  | { point: 'before_child_append'; child_index: number }
  | { point: 'after_child_append'; child_index: number }
  | { point: 'before_commit' }
  | { point: 'after_commit_before_return' }

export interface FanoutAtomicChildInputV1 {
  delivery_unit: DeliveryUnitV1
  loaded_registration: LoadedConnectorRegistrationV1
}

export interface AppendFanoutAtomicInputV1 {
  request: FanoutRequestV1
  plan: FanoutPlanV1
  children: FanoutAtomicChildInputV1[]
  /** Deterministic rollback fixture only; never routing or provider authority. */
  on_commit_point?: (point: FanoutAtomicCommitPoint) => void | Promise<void>
}

export interface AppendFanoutAtomicResultV1 {
  status: 'inserted' | 'byte_identical_existing'
  plan_event: StoredEvent
  child_events: StoredEvent[]
  provider_invocations: 0
}

interface ReopenSources {
  unknownEvent: StoredEvent
  unknown: ReplyDeliveryUnknownPayloadV1
  requestEvent: StoredEvent
  request: DeliveryUnknownReconciliationRequestV1
  observationEvent: StoredEvent
  observation: DeliveryUnknownReconciliationObservationV1
  evidenceEvent: StoredEvent
  evidence: ZeroExternalEffectEvidenceRecordV1
  attestationEvent: StoredEvent
  attestation: ZeroExternalEffectAttestationV1
  producerEvent: StoredEvent
  producer: ZeroEffectProducerRegistrationV1
  issuerEvent: StoredEvent
  issuer: RetryBudgetIssuerRegistrationV1
  budgetEvent: StoredEvent
  budget: RetryBudgetSnapshotV1
}

function transactionTime(value: unknown): number {
  const millis = value instanceof Date ? value.getTime() : Date.parse(String(value))
  if (!Number.isFinite(millis)) throw new ReopenNotAuthorizedError('transaction time is unreadable')
  return millis
}

function intervalContains(now: number, start: string, end: string): boolean {
  return Date.parse(start) <= now && now < Date.parse(end)
}

function payloadDeliveryIdentity(body: Record<string, unknown>): {
  delivery_id: unknown
  attempt_ordinal: unknown
  provider_request_digest: unknown
  provider_nonce: unknown
} {
  return {
    delivery_id: body.delivery_id,
    attempt_ordinal: body.attempt_ordinal,
    provider_request_digest: body.provider_request_digest,
    provider_nonce: body.provider_nonce,
  }
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
    if (!db) return serializedTransaction(this.db, tx => this.append(input, tx))
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
    for (const input of inputs) validate(input)
    return serializedTransaction(this.db, async tx => {
      const results: AppendResult[] = []
      for (const input of inputs) {
        results.push(await this.append(input, tx))
      }
      return results
    })
  }

  /**
   * FanoutAtomicAppendPort: persist the immutable plan and every child in one
   * transaction. A partial pre-existing set is corruption, never a prefix to
   * complete. This method owns no provider port and invokes no external effect.
   */
  async appendFanoutAtomic(input: AppendFanoutAtomicInputV1): Promise<AppendFanoutAtomicResultV1> {
    const request = decodeFanoutRequest(input.request)
    const plan = decodeFanoutPlan(input.plan)
    const planEventId = `fanout-planned:${request.fanout_id}`
    if (
      plan.fanout_id !== request.fanout_id ||
      plan.fanout_digest !== request.fanout_digest ||
      plan.parent_reply_id !== request.parent_reply_id ||
      plan.authority_snapshot_digest !== request.authority_snapshot_digest ||
      plan.resolver_version !== request.resolver_version ||
      plan.children.length !== request.recipient_seat_ids.length ||
      plan.children.length !== input.children.length
    ) throw new FanoutCollisionError('fanout request, plan, or child cardinality differs')

    const expectedProvenance = buildFanoutProvenance(planEventId, request)
    const events: AppendEvent[] = [{
      eventId: planEventId,
      eventType: 'reply.fanout_planned',
      seatId: request.sender_seat_id,
      conversationId: request.conversation_id,
      causationId: request.causation_id,
      correlationId: request.correlation_id,
      turnId: request.turn_id,
      replyId: request.parent_reply_id,
      payload: plan as unknown as Record<string, unknown>,
    }]

    for (let index = 0; index < plan.children.length; index += 1) {
      const planned = plan.children[index]!
      const child = input.children[index]!
      const unit = child.delivery_unit
      if (planned.recipient_seat_id !== request.recipient_seat_ids[index]) throw new FanoutCollisionError('fanout plan recipient order differs from normalized request')
      validateDeliveryUnit(unit, child.loaded_registration)
      if (
        unit.recipient_seat_id !== planned.recipient_seat_id ||
        unit.reply_id !== planned.child_reply_id ||
        unit.delivery_id !== planned.delivery_id ||
        unit.destination_ref !== planned.destination_ref ||
        unit.resolved_binding_snapshot_digest !== planned.resolved_binding_snapshot_digest ||
        unit.resolved_delivery_decision.resolved_delivery_decision_digest !== planned.resolved_delivery_decision_digest ||
        unit.sender_seat_id !== request.sender_seat_id ||
        unit.conversation_id !== request.conversation_id ||
        unit.turn_id !== request.turn_id ||
        unit.correlation_id !== request.correlation_id ||
        unit.causation_id !== request.causation_id ||
        canonicalJson(unit.content) !== canonicalJson(request.content) ||
        unit.fanout_child_provenance === null ||
        canonicalJson(unit.fanout_child_provenance) !== canonicalJson(expectedProvenance) ||
        planned.fanout_child_provenance_digest !== expectedProvenance.provenance_digest
      ) throw new FanoutCollisionError(`fanout child ${index} differs from persisted-plan authority`)
      events.push({
        eventId: `fanout-child-enqueued:${planned.child_reply_id}`,
        eventType: 'reply.enqueued',
        seatId: request.sender_seat_id,
        conversationId: request.conversation_id,
        causationId: planEventId,
        correlationId: request.correlation_id,
        turnId: request.turn_id,
        replyId: planned.child_reply_id,
        payload: unit as unknown as Record<string, unknown>,
      })
    }

    await input.on_commit_point?.({ point: 'before_transaction' })
    const result = await serializedTransaction(this.db, async tx => {
      const existing = await Promise.all(events.map(event => tx.queryOne<StoredEvent>(
        'SELECT * FROM event_log WHERE event_id = $1',
        [event.eventId],
      )))
      const existingCount = existing.filter(Boolean).length
      if (existingCount > 0 && existingCount < events.length) {
        throw new FanoutCollisionError(`fanout atomic set has ${existingCount}/${events.length} durable members`)
      }
      if (existingCount === events.length) {
        try {
          events.forEach((event, index) => assertByteIdenticalEvent(event, existing[index]!))
        } catch (error) {
          throw new FanoutCollisionError(String(error))
        }
        return {
          status: 'byte_identical_existing' as const,
          plan_event: existing[0]!,
          child_events: existing.slice(1) as StoredEvent[],
          provider_invocations: 0 as const,
        }
      }

      await input.on_commit_point?.({ point: 'before_plan_append' })
      let inserted = false
      try {
        inserted = (await this.append(events[0]!, tx)).inserted
      } catch (error) {
        if (error instanceof EventIdCanonicalMaterialCollisionError) throw new FanoutCollisionError(error.message)
        throw error
      }
      await input.on_commit_point?.({ point: 'after_plan_append' })
      for (let index = 1; index < events.length; index += 1) {
        await input.on_commit_point?.({ point: 'before_child_append', child_index: index - 1 })
        try {
          inserted = (await this.append(events[index]!, tx)).inserted || inserted
        } catch (error) {
          if (error instanceof EventIdCanonicalMaterialCollisionError || error instanceof ClaimLostError) throw new FanoutCollisionError(String(error))
          throw error
        }
        await input.on_commit_point?.({ point: 'after_child_append', child_index: index - 1 })
      }
      const readback = await Promise.all(events.map(event => tx.queryOne<StoredEvent>(
        'SELECT * FROM event_log WHERE event_id = $1',
        [event.eventId],
      )))
      if (readback.some(event => !event)) throw new FanoutCollisionError('fanout atomic readback is incomplete')
      try {
        events.forEach((event, index) => assertByteIdenticalEvent(event, readback[index]!))
      } catch (error) {
        throw new FanoutCollisionError(String(error))
      }
      await input.on_commit_point?.({ point: 'before_commit' })
      return {
        status: inserted ? 'inserted' as const : 'byte_identical_existing' as const,
        plan_event: readback[0]!,
        child_events: readback.slice(1) as StoredEvent[],
        provider_invocations: 0 as const,
      }
    })
    await input.on_commit_point?.({ point: 'after_commit_before_return' })
    return result
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

  private async readReopenSources(db: DbAdapter, input: CommitReopenAuthorizationCASInput): Promise<ReopenSources> {
    const unknownEvent = await this.requireEvent(db, input.unknown_event_id, 'reply.delivery_unknown')
    const requestEvent = await this.requireEvent(db, input.reconciliation_request_event_id, 'reply.delivery_reconciliation_requested')
    const observationEvent = await this.requireEvent(db, input.reconciliation_observation_event_id, 'reply.delivery_reconciliation_observed')
    const evidenceEvent = await this.requireEvent(db, input.evidence_event_id, 'reply.zero_external_effect_evidence_recorded')
    const attestationEventRow = await this.requireEvent(db, input.attestation_event_id, 'reply.zero_external_effect_attested')
    const producerEvent = await this.requireEvent(db, input.producer_registration_event_id, 'authority.zero_effect_producer_registered')
    const issuerEvent = await this.requireEvent(db, input.issuer_registration_event_id, 'authority.retry_budget_issuer_registered')
    const budgetEvent = await this.requireEvent(db, input.budget_snapshot_event_id, 'reply.retry_budget_snapshot')
    try {
      return {
        unknownEvent,
        unknown: decodeReplyDeliveryUnknownPayload(parseEventPayload(unknownEvent.payload)),
        requestEvent,
        request: decodeReconciliationRequest(parseEventPayload(requestEvent.payload)),
        observationEvent,
        observation: decodeReconciliationObservation(parseEventPayload(observationEvent.payload)),
        evidenceEvent,
        evidence: decodeEvidenceRecord(parseEventPayload(evidenceEvent.payload)),
        attestationEvent: attestationEventRow,
        attestation: decodeAttestation(parseEventPayload(attestationEventRow.payload)),
        producerEvent,
        producer: decodeProducerRegistration(parseEventPayload(producerEvent.payload)),
        issuerEvent,
        issuer: decodeIssuerRegistration(parseEventPayload(issuerEvent.payload)),
        budgetEvent,
        budget: decodeRetryBudgetSnapshot(parseEventPayload(budgetEvent.payload)),
      }
    } catch (error) {
      throw new ReopenNotAuthorizedError(`persisted reopen source failed strict decode: ${String(error)}`)
    }
  }

  private async assertCurrentRegistrationGenerations(db: DbAdapter, sources: ReopenSources): Promise<void> {
    const producerRows = await db.query<StoredEvent>(
      `SELECT * FROM event_log WHERE event_type = 'authority.zero_effect_producer_registered' ORDER BY seq ASC`,
    )
    const issuerRows = await db.query<StoredEvent>(
      `SELECT * FROM event_log WHERE event_type = 'authority.retry_budget_issuer_registered' ORDER BY seq ASC`,
    )
    let producers: ZeroEffectProducerRegistrationV1[]
    let issuers: RetryBudgetIssuerRegistrationV1[]
    try {
      producers = producerRows.map(row => decodeProducerRegistration(parseEventPayload(row.payload)))
      issuers = issuerRows.map(row => decodeIssuerRegistration(parseEventPayload(row.payload)))
    } catch (error) {
      throw new ReopenNotAuthorizedError(`registration projection is unverifiable: ${String(error)}`)
    }
    const sameProducer = producers.filter(item => item.registration_id === sources.producer.registration_id)
    const sameIssuer = issuers.filter(item => item.registration_id === sources.issuer.registration_id)
    if (
      sameProducer.length === 0 ||
      Math.max(...sameProducer.map(item => item.registry_generation)) !== sources.producer.registry_generation ||
      sameIssuer.length === 0 ||
      Math.max(...sameIssuer.map(item => item.registry_generation)) !== sources.issuer.registry_generation
    ) {
      throw new ReopenNotAuthorizedError('producer or issuer registration generation is retired')
    }
  }

  private async reverifyReopenSources(
    db: DbAdapter,
    sources: ReopenSources,
    input: CommitReopenAuthorizationCASInput,
  ): Promise<void> {
    const authority = decodeRetryBudgetAuthority(input.retry_budget_authority)
    const nowRow = await db.queryOne<{ transaction_now: unknown }>('SELECT CURRENT_TIMESTAMP AS transaction_now')
    const now = transactionTime(nowRow?.transaction_now)
    const { unknown, request, observation, evidence, attestation, producer, issuer, budget } = sources

    if (
      sources.unknownEvent.reply_id !== unknown.reply_id ||
      sources.unknownEvent.claim_epoch === null ||
      Number(sources.unknownEvent.claim_epoch) !== unknown.attempt_ordinal ||
      sources.requestEvent.reply_id !== null && sources.requestEvent.reply_id !== unknown.reply_id ||
      sources.observationEvent.reply_id !== null && sources.observationEvent.reply_id !== unknown.reply_id
    ) {
      throw new ReopenNotAuthorizedError('persisted EventLog identity differs from unknown delivery')
    }
    const unknownDigest = sha256Utf8(canonicalJson(storedEventConflictMaterial(sources.unknownEvent)))
    if (
      request.delivery_unknown_event_id !== sources.unknownEvent.event_id ||
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
      request.reconciliation_mode !== unknown.reconciliation_mode
    ) {
      throw new ReopenNotAuthorizedError('reconciliation request does not bind the persisted unknown delivery')
    }
    if (
      observation.reconciliation_request_digest !== request.request_digest ||
      observation.observed_outcome !== 'proven_zero_external_effect' ||
      observation.zero_external_effect_attestation_digest !== attestation.attestation_digest ||
      observation.evidence_digest !== evidence.evidence_digest
    ) {
      throw new ReopenNotAuthorizedError('observation is not exact proven-zero-effect evidence')
    }

    const evidenceIdentity = payloadDeliveryIdentity(evidence.evidence_body as unknown as Record<string, unknown>)
    if (
      evidenceIdentity.delivery_id !== unknown.delivery_id ||
      evidenceIdentity.attempt_ordinal !== unknown.attempt_ordinal ||
      evidenceIdentity.provider_request_digest !== unknown.provider_request_digest ||
      evidenceIdentity.provider_nonce !== unknown.provider_nonce ||
      attestation.delivery_id !== unknown.delivery_id ||
      attestation.attempt_ordinal !== unknown.attempt_ordinal ||
      attestation.connector_instance_id !== unknown.connector_instance_id ||
      attestation.provider_request_digest !== unknown.provider_request_digest ||
      attestation.provider_nonce !== unknown.provider_nonce ||
      attestation.evidence_kind !== evidence.evidence_kind ||
      attestation.evidence_digest !== evidence.evidence_digest ||
      attestation.producer_registration_digest !== producer.registration_digest
    ) {
      throw new ReopenNotAuthorizedError('evidence or attestation identity differs from unknown delivery')
    }
    const mappedEvidenceKind = PRODUCER_KIND_TO_EVIDENCE_KIND[producer.producer_kind]
    if (
      mappedEvidenceKind !== evidence.evidence_kind ||
      producer.authorized_evidence_kinds.length !== 1 ||
      producer.authorized_evidence_kinds[0] !== mappedEvidenceKind ||
      producer.connector_instance_id !== unknown.connector_instance_id ||
      producer.capability_digest !== unknown.capability_digest ||
      producer.status !== 'active' ||
      !intervalContains(now, producer.valid_from, producer.expires_at) ||
      !intervalContains(now, attestation.issued_at, attestation.expires_at) ||
      Date.parse(attestation.issued_at) < Date.parse(producer.valid_from) ||
      Date.parse(attestation.expires_at) > Date.parse(producer.expires_at)
    ) {
      throw new ReopenNotAuthorizedError('producer mapping, scope, status, or interval is unauthorized')
    }

    if (
      producerRegistrationEventId(producer.registration_id, producer.registry_generation) !== sources.producerEvent.event_id ||
      issuerRegistrationEventId(issuer.registration_id, issuer.registry_generation) !== sources.issuerEvent.event_id ||
      retryBudgetSnapshotEventId(budget.delivery_id, budget.generation) !== sources.budgetEvent.event_id
    ) {
      throw new ReopenNotAuthorizedError('registration or budget event identity does not recompute')
    }
    if (
      issuer.status !== 'active' ||
      !intervalContains(now, issuer.valid_from, issuer.expires_at) ||
      !intervalContains(now, authority.issued_at, authority.expires_at) ||
      Date.parse(authority.issued_at) < Date.parse(issuer.valid_from) ||
      Date.parse(authority.expires_at) > Date.parse(issuer.expires_at) ||
      issuer.registration_digest !== authority.authority_registration_digest ||
      issuer.capability_digest !== unknown.capability_digest ||
      issuer.budget_policy_digest !== budget.budget_policy_digest ||
      authority.delivery_id !== unknown.delivery_id ||
      authority.capability_digest !== unknown.capability_digest ||
      authority.budget_policy_digest !== budget.budget_policy_digest ||
      authority.current_attempt_ordinal !== unknown.attempt_ordinal ||
      authority.remaining_before !== budget.remaining ||
      authority.remaining_after !== budget.remaining - 1 ||
      authority.generation_before !== budget.generation ||
      authority.generation_after !== budget.generation + 1 ||
      budget.reply_id !== unknown.reply_id ||
      budget.delivery_id !== unknown.delivery_id ||
      budget.capability_digest !== unknown.capability_digest ||
      budget.authority_registration_digest !== issuer.registration_digest ||
      input.intended_next_attempt_ordinal !== unknown.attempt_ordinal + 1
    ) {
      throw new ReopenNotAuthorizedError('issuer, authority, budget, or next attempt is unauthorized')
    }
    await this.assertCurrentRegistrationGenerations(db, sources)

    const priorConsumption = await db.queryOne<StoredEvent>(
      'SELECT * FROM event_log WHERE event_id = $1',
      [attestationConsumptionEventId(attestation.attestation_digest)],
    )
    if (priorConsumption) {
      const expectedOutcomeId = reconciliationOutcomeEventId(unknown.delivery_id, unknown.attempt_ordinal)
      const expectedReopenId = reopenEventId(sources.unknownEvent.event_id, unknown.delivery_id, input.intended_next_attempt_ordinal)
      const payload = parseEventPayload<Record<string, unknown>>(priorConsumption.payload)
      if (payload.reconciliation_resolved_event_id !== expectedOutcomeId || payload.reopen_event_id !== expectedReopenId) {
        throw new ReopenNotAuthorizedError('attestation was already consumed by another transition')
      }
    }

    const terminals = await db.query<StoredEvent>(
      `SELECT * FROM event_log
       WHERE reply_id = $1 AND event_type IN ('reply.delivered', 'reply.failed')
       ORDER BY seq ASC`,
      [unknown.reply_id],
    )
    for (const terminal of terminals) {
      const payload = parseEventPayload<Record<string, unknown>>(terminal.payload)
      const sameDelivery = payload.delivery_id === unknown.delivery_id || (
        payload.delivery_id === undefined && Number(terminal.claim_epoch) === unknown.attempt_ordinal
      )
      const permanent = terminal.event_type === 'reply.delivered' || payload.permanent === true || payload.kind === 'permanent'
      if (sameDelivery && permanent) throw new ReopenNotAuthorizedError('delivery already has a terminal outcome')
    }
  }

  /**
   * Atomic EventLogReopenAuthorizationPersistencePortV1. This method has no
   * provider port and therefore cannot invoke or retry an external effect.
   */
  async commitReopenAuthorizationCAS(input: CommitReopenAuthorizationCASInput): Promise<CommitReopenAuthorizationCASResult> {
    await input.on_commit_point?.('before_transaction')
    const result = await serializedTransaction(this.db, async tx => {
      const firstRead = await this.readReopenSources(tx, input)
      const lockIds = [
        firstRead.producerEvent.event_id,
        firstRead.issuerEvent.event_id,
        firstRead.budgetEvent.event_id,
      ].sort()
      const locked = await tx.query<{ event_id: string }>(
        `SELECT event_id FROM event_log
         WHERE event_id IN ($1, $2, $3)
         ORDER BY event_id ASC
         FOR UPDATE`,
        lockIds,
      )
      if (locked.length !== 3 || locked.some((row, index) => row.event_id !== lockIds[index])) {
        throw new ReopenNotAuthorizedError('ordered authority lock set is incomplete')
      }

      const sources = await this.readReopenSources(tx, input)
      await this.reverifyReopenSources(tx, sources, input)
      const { unknown, request, observation, evidence, attestation, producer, issuer, budget } = sources
      const authority = decodeRetryBudgetAuthority(input.retry_budget_authority)
      const outcomeKey = reconciliationOutcomeKey(unknown.delivery_id, unknown.attempt_ordinal)
      const outcomeEventId = reconciliationOutcomeEventId(unknown.delivery_id, unknown.attempt_ordinal)
      const reopenId = reopenEventId(sources.unknownEvent.event_id, unknown.delivery_id, input.intended_next_attempt_ordinal)
      const consumptionId = attestationConsumptionEventId(attestation.attestation_digest)
      const afterSnapshotId = retryBudgetSnapshotEventId(unknown.delivery_id, authority.generation_after)

      const outcomePayload: ReplyDeliveryReconciliationResolvedPayloadV1 = {
        delivery_unknown_event_id: sources.unknownEvent.event_id,
        reconciliation_observation_event_id: sources.observationEvent.event_id,
        reconciliation_request_digest: request.request_digest,
        observation_digest: observation.observation_digest,
        reply_id: unknown.reply_id,
        delivery_id: unknown.delivery_id,
        recipient_seat_id: unknown.recipient_seat_id,
        attempt_ordinal: unknown.attempt_ordinal,
        reconciliation_outcome_key: outcomeKey,
        outcome: 'reopened',
        resulting_event_id: reopenId,
      }
      decodeReconciliationResolvedPayload(outcomePayload)
      const consumptionPayload: ZeroExternalEffectAttestationConsumptionV1 = {
        schema_version: 'aun-zero-external-effect-attestation-consumption/v1',
        reply_id: unknown.reply_id,
        delivery_id: unknown.delivery_id,
        attempt_ordinal: unknown.attempt_ordinal,
        attestation_digest: attestation.attestation_digest,
        evidence_digest: evidence.evidence_digest,
        producer_registration_digest: producer.registration_digest,
        reconciliation_outcome_key: outcomeKey,
        reconciliation_resolved_event_id: outcomeEventId,
        reopen_event_id: reopenId,
      }
      decodeAttestationConsumption(consumptionPayload)
      const afterSnapshot: RetryBudgetSnapshotV1 = {
        schema_version: 'aun-retry-budget-snapshot/v1',
        reply_id: unknown.reply_id,
        delivery_id: unknown.delivery_id,
        capability_digest: unknown.capability_digest,
        budget_policy_digest: budget.budget_policy_digest,
        authority_registration_digest: issuer.registration_digest,
        generation: authority.generation_after,
        remaining: authority.remaining_after,
        prior_snapshot_event_id: sources.budgetEvent.event_id,
        transition_authority_digest: authority.authority_digest,
      }
      decodeRetryBudgetSnapshot(afterSnapshot)
      const reopenPayload: ReplyDeliveryReopenedPayloadV1 = {
        reply_id: unknown.reply_id,
        delivery_id: unknown.delivery_id,
        recipient_seat_id: unknown.recipient_seat_id,
        causation_delivery_unknown_event_id: sources.unknownEvent.event_id,
        reconciliation_request_digest: request.request_digest,
        reconciliation_observation_digest: observation.observation_digest,
        prior_attempt_ordinal: unknown.attempt_ordinal,
        next_attempt_ordinal: input.intended_next_attempt_ordinal,
        provider_request_digest: unknown.provider_request_digest,
        capability_digest: unknown.capability_digest,
        attestation_digest: attestation.attestation_digest,
        producer_registration_digest: producer.registration_digest,
        retry_budget_before_reopen: authority.remaining_before,
        retry_budget_after_reopen: authority.remaining_after,
        retry_budget_generation_before: authority.generation_before,
        retry_budget_generation_after: authority.generation_after,
        authority_digest: authority.authority_digest,
        authority_registration_digest: authority.authority_registration_digest,
        fanout_child_provenance_digest: unknown.fanout_child_provenance_digest,
      }
      decodeReplyDeliveryReopenedPayload(reopenPayload)

      const group: AppendEvent[] = [
        {
          eventId: outcomeEventId,
          eventType: 'reply.delivery_reconciliation_resolved',
          conversationId: sources.unknownEvent.conversation_id,
          causationId: sources.observationEvent.event_id,
          correlationId: sources.unknownEvent.correlation_id,
          turnId: sources.unknownEvent.turn_id,
          replyId: unknown.reply_id,
          claimEpoch: unknown.attempt_ordinal,
          payload: outcomePayload as unknown as Record<string, unknown>,
        },
        {
          eventId: consumptionId,
          eventType: 'reply.zero_external_effect_attestation_consumed',
          conversationId: sources.unknownEvent.conversation_id,
          causationId: outcomeEventId,
          correlationId: sources.unknownEvent.correlation_id,
          turnId: sources.unknownEvent.turn_id,
          replyId: unknown.reply_id,
          claimEpoch: unknown.attempt_ordinal,
          payload: consumptionPayload as unknown as Record<string, unknown>,
        },
        {
          eventId: afterSnapshotId,
          eventType: 'reply.retry_budget_snapshot',
          conversationId: sources.unknownEvent.conversation_id,
          causationId: outcomeEventId,
          correlationId: sources.unknownEvent.correlation_id,
          turnId: sources.unknownEvent.turn_id,
          replyId: unknown.reply_id,
          claimEpoch: input.intended_next_attempt_ordinal,
          payload: afterSnapshot as unknown as Record<string, unknown>,
        },
        {
          eventId: reopenId,
          eventType: 'reply.delivery_reopened',
          conversationId: sources.unknownEvent.conversation_id,
          causationId: outcomeEventId,
          correlationId: sources.unknownEvent.correlation_id,
          turnId: sources.unknownEvent.turn_id,
          replyId: unknown.reply_id,
          claimEpoch: input.intended_next_attempt_ordinal,
          payload: reopenPayload as unknown as Record<string, unknown>,
        },
      ]

      const existing = await Promise.all(group.map(item => tx.queryOne<StoredEvent>(
        'SELECT * FROM event_log WHERE event_id = $1',
        [item.eventId],
      )))
      const existingCount = existing.filter(Boolean).length
      if (existingCount > 0 && existingCount < 4) {
        existing.forEach((row, index) => {
          if (!row) return
          try {
            assertByteIdenticalEvent(group[index], row)
          } catch (error) {
            if (index === 0) throw new ReconciliationTransitionCollisionError(String(error))
            throw error
          }
        })
        throw new ReopenAtomicSetIncompleteError(`reopen atomic set has ${existingCount}/4 durable members`)
      }

      if (existingCount === 4) {
        group.forEach((item, index) => assertByteIdenticalEvent(item, existing[index]!))
        return {
          status: 'byte_identical_existing' as const,
          outcome: existing[0]!,
          consumption: existing[1]!,
          generation_after_snapshot: existing[2]!,
          reopen: existing[3]!,
          provider_invocations: 0 as const,
        }
      }

      await input.on_commit_point?.('before_outcome_append')
      let outcomeResult: AppendResult
      try {
        outcomeResult = await this.append(group[0], tx)
      } catch (error) {
        if (error instanceof EventIdCanonicalMaterialCollisionError) {
          throw new ReconciliationTransitionCollisionError(error.message)
        }
        throw error
      }
      await input.on_commit_point?.('after_outcome_append')
      await input.on_commit_point?.('before_consumption_append')
      const consumptionResult = await this.append(group[1], tx)
      await input.on_commit_point?.('after_consumption_append')
      await input.on_commit_point?.('before_budget_snapshot_append')
      const snapshotResult = await this.append(group[2], tx)
      await input.on_commit_point?.('after_budget_snapshot_append')
      await input.on_commit_point?.('before_reopen_append')
      const reopenResult = await this.append(group[3], tx)
      await input.on_commit_point?.('after_reopen_append')

      const readback = await Promise.all(group.map(item => tx.queryOne<StoredEvent>(
        'SELECT * FROM event_log WHERE event_id = $1',
        [item.eventId],
      )))
      if (readback.some(row => !row)) throw new ReopenAtomicSetIncompleteError('four-member readback is incomplete')
      group.forEach((item, index) => assertByteIdenticalEvent(item, readback[index]!))
      await input.on_commit_point?.('before_commit')
      return {
        status: [outcomeResult, consumptionResult, snapshotResult, reopenResult].some(item => item.inserted)
          ? 'inserted' as const
          : 'byte_identical_existing' as const,
        outcome: readback[0]!,
        consumption: readback[1]!,
        generation_after_snapshot: readback[2]!,
        reopen: readback[3]!,
        provider_invocations: 0 as const,
      }
    })
    await input.on_commit_point?.('after_commit_before_return')
    return result
  }

  /**
   * Single outcome CAS for conclusive read-only reconciliation. The persisted
   * observation is the authority for either a validated original receipt or
   * a proven permanent failure. No provider port exists at this boundary.
   */
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
