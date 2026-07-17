// K3 delivery truth boundary.
//
// A provider invocation is authorized only after the immutable delivery unit,
// loaded registration, frozen request, nonce reservation, and invocation-start
// record agree.  A missing or ambiguous receipt is delivery_unknown; it is
// never converted into success and never retried by this module.

import type { DbAdapter } from '../db/adapter'
import { EventLog, assertByteIdenticalEvent, type CommitReconciliationTerminalCASInputV1, type CommitReconciliationTerminalCASResultV1 } from './store'
import { ClaimLostError, EventIdCanonicalMaterialCollisionError, type StoredEvent } from './types'
import {
  buildReplyDeliveryUnknownPayload,
  decodeFrozenProviderRequestEnvelope,
  decodeReplyFailedPayload,
  decodeReplyHandoffAcceptedPayload,
  decodeReplyDeliveredPayload,
  validateDeliveryUnit,
  validateTransportReceiptForDelivery,
  type DeliveryUnitV1,
  type DurableHandoffTransportReceiptV1,
  type FrozenProviderRequestEnvelopeV1,
  type LoadedConnectorRegistrationV1,
  type ProviderAckTransportReceiptV1,
  type ProviderInvocationStartPayloadV1,
  type ReplyDeliveryUnknownPayloadV1,
  type ReplyDeliveredPayloadV1,
  type ReplyFailedPayloadV1,
  type ReplyHandoffAcceptedPayloadV1,
  type Sha256,
} from './transport-contract'

export type DeliveryTruthErrorCode =
  | 'STRICT_DECODE_FAILED'
  | 'DELIVERY_AUTHORITY_MISMATCH'
  | 'LOADED_REGISTRATION_UNPROVEN'
  | 'PROVIDER_REQUEST_DIGEST_MISMATCH'
  | 'PROVIDER_NONCE_COLLISION'
  | 'PROVIDER_INVOCATION_ALREADY_STARTED'
  | 'RECEIPT_INVALID'
  | 'DELIVERY_TRUTH_COLLISION'
  | 'DELIVERY_TRUTH_TERMINAL_EXISTS'
  | 'FAILED_RETRYABLE'
  | 'FAILED_PERMANENT'

export class DeliveryTruthViolationError extends Error {
  constructor(
    readonly code: DeliveryTruthErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'DeliveryTruthViolationError'
  }
}

/** A pure preparation result. Creating it must not invoke a provider. */
export interface V2DeliveryPreparedAttempt {
  request: FrozenProviderRequestEnvelopeV1
  /** Adapter-owned concrete identity for its declared provider dedupe scope. */
  concrete_dedupe_scope_identity: Sha256
}

export type V2DeliveryAttemptResult =
  | {
      outcome: 'provider_ack'
      request: FrozenProviderRequestEnvelopeV1
      receipt: ProviderAckTransportReceiptV1
    }
  | {
      outcome: 'durable_handoff'
      receipt: DurableHandoffTransportReceiptV1
    }
  | {
      outcome: 'delivery_unknown'
      request: FrozenProviderRequestEnvelopeV1
      failure_code: string
    }
  | { outcome: 'failed_retryable'; failure_code: string }
  | { outcome: 'failed_permanent'; failure_code: string }

/**
 * K3 direct transport surface. prepare() is effect-free; sendPrepared() is
 * the sole provider-effect boundary and receives only a frozen request.
 */
export interface V2DeliveryTransportAdapter {
  prepare(
    unit: DeliveryUnitV1,
    loadedRegistration: LoadedConnectorRegistrationV1,
  ): V2DeliveryPreparedAttempt | Promise<V2DeliveryPreparedAttempt>
  sendPrepared(
    prepared: V2DeliveryPreparedAttempt,
    unit: DeliveryUnitV1,
    loadedRegistration: LoadedConnectorRegistrationV1,
  ): Promise<V2DeliveryAttemptResult>
}

export type V2DeliveryCommitPoint =
  | 'before_terminal_check'
  | 'before_terminal_append'
  | 'after_terminal_append'
  | 'after_commit_before_return'

export interface DeliveryTruthCommitContext {
  dispatcherId: string
  dispatcherInstanceId: string
  conversationId: string | null
  correlationId: string | null
  turnId: string | null
  claimEventId: string
  claimEpoch: number
  invocationStart: ProviderInvocationStartPayloadV1
  invocationStartedEventId: string
  onCommitPoint?: (point: V2DeliveryCommitPoint) => void | Promise<void>
}

export type DeliveryTruthCommitResult =
  | { outcome: 'delivered' | 'handoff_accepted' | 'delivery_unknown' | 'failed_retryable' | 'failed_permanent'; event: StoredEvent }
  | { outcome: 'existing'; event: StoredEvent }

function fanoutDigest(unit: DeliveryUnitV1): string | null {
  return unit.fanout_child_provenance?.provenance_digest ?? null
}

function deliveredPayload(unit: DeliveryUnitV1, receipt: ProviderAckTransportReceiptV1): ReplyDeliveredPayloadV1 {
  return decodeReplyDeliveredPayload({
    reply_id: unit.reply_id,
    delivery_id: unit.delivery_id,
    recipient_seat_id: unit.recipient_seat_id,
    receipt_digest: receipt.receipt_digest,
    provider_request_digest: receipt.provider_request_digest,
    resolved_delivery_decision_digest: unit.resolved_delivery_decision.resolved_delivery_decision_digest,
    fanout_child_provenance_digest: fanoutDigest(unit),
  })
}

function handoffPayload(unit: DeliveryUnitV1, receipt: DurableHandoffTransportReceiptV1): ReplyHandoffAcceptedPayloadV1 {
  return decodeReplyHandoffAcceptedPayload({
    reply_id: unit.reply_id,
    delivery_id: unit.delivery_id,
    recipient_seat_id: unit.recipient_seat_id,
    receipt_digest: receipt.receipt_digest,
    fanout_child_provenance_digest: fanoutDigest(unit),
  })
}

function failedPayload(unit: DeliveryUnitV1, failureCode: string, permanent: boolean): ReplyFailedPayloadV1 {
  return decodeReplyFailedPayload({
    reply_id: unit.reply_id,
    delivery_id: unit.delivery_id,
    recipient_seat_id: unit.recipient_seat_id,
    failure_code: failureCode,
    permanent,
    fanout_child_provenance_digest: fanoutDigest(unit),
  })
}

function sameRequest(expected: FrozenProviderRequestEnvelopeV1, actual: FrozenProviderRequestEnvelopeV1): void {
  const expectedDecoded = decodeFrozenProviderRequestEnvelope(expected)
  const actualDecoded = decodeFrozenProviderRequestEnvelope(actual)
  if (
    actualDecoded.connector_instance_id !== expectedDecoded.connector_instance_id ||
    actualDecoded.adapter_contract_version !== expectedDecoded.adapter_contract_version ||
    actualDecoded.adapter_build_digest !== expectedDecoded.adapter_build_digest ||
    actualDecoded.provider_request_digest !== expectedDecoded.provider_request_digest
  ) {
    throw new DeliveryTruthViolationError('PROVIDER_REQUEST_DIGEST_MISMATCH', 'transport result differs from the frozen provider request')
  }
}

/** Invoke the already-authorized provider attempt exactly once. */
export async function dispatchV2DeliveryOnce(
  adapter: V2DeliveryTransportAdapter,
  prepared: V2DeliveryPreparedAttempt,
  unit: DeliveryUnitV1,
  loadedRegistration: LoadedConnectorRegistrationV1,
): Promise<V2DeliveryAttemptResult> {
  validateDeliveryUnit(unit, loadedRegistration)
  const request = decodeFrozenProviderRequestEnvelope(prepared.request)
  if (
    request.connector_instance_id !== unit.destination.connector_instance_id ||
    request.connector_kind !== unit.connector_capability.connector_kind ||
    request.adapter_contract_version !== unit.capability_authority.adapter_contract_version ||
    request.adapter_build_digest !== unit.capability_authority.adapter_build_digest ||
    prepared.concrete_dedupe_scope_identity.trim() === ''
  ) throw new DeliveryTruthViolationError('DELIVERY_AUTHORITY_MISMATCH', 'prepared provider request differs from delivery authority')

  const result = await adapter.sendPrepared({ ...prepared, request }, unit, loadedRegistration)
  if (result.outcome === 'provider_ack') {
    sameRequest(request, result.request)
    const receipt = validateTransportReceiptForDelivery(result.receipt, unit, loadedRegistration)
    if (receipt.receipt_mode !== 'provider_ack') throw new DeliveryTruthViolationError('RECEIPT_INVALID', 'provider acknowledgement result carried a non-ack receipt')
    return { outcome: 'provider_ack', request, receipt }
  }
  if (result.outcome === 'durable_handoff') {
    const receipt = validateTransportReceiptForDelivery(result.receipt, unit, loadedRegistration)
    if (receipt.receipt_mode !== 'durable_handoff') throw new DeliveryTruthViolationError('RECEIPT_INVALID', 'durable handoff result carried a non-handoff receipt')
    return { outcome: 'durable_handoff', receipt }
  }
  if (result.outcome === 'delivery_unknown') sameRequest(request, result.request)
  return result
}

/**
 * Persist one typed truth for an invocation attempt. The terminal check and
 * append share one transaction so delivered/handoff/unknown/permanent truth
 * cannot race into conflicting durable outcomes.
 */
export async function commitValidatedDeliveryTruth(
  db: DbAdapter,
  unit: DeliveryUnitV1,
  loadedRegistration: LoadedConnectorRegistrationV1,
  result: V2DeliveryAttemptResult,
  context: DeliveryTruthCommitContext,
): Promise<DeliveryTruthCommitResult> {
  validateDeliveryUnit(unit, loadedRegistration)
  if (
    context.invocationStart.delivery_id !== unit.delivery_id ||
    context.invocationStart.reply_id !== unit.reply_id ||
    context.invocationStart.recipient_seat_id !== unit.recipient_seat_id ||
    context.invocationStart.attempt_ordinal !== context.claimEpoch ||
    context.invocationStart.provider_nonce !== unit.idempotency.provider_nonce ||
    context.invocationStart.delivery_digest !== unit.idempotency.delivery_digest
  ) throw new DeliveryTruthViolationError('DELIVERY_AUTHORITY_MISMATCH', 'invocation start differs from delivery unit or active claim')

  let eventType: 'reply.delivered' | 'reply.handoff_accepted' | 'reply.delivery_unknown' | 'reply.failed'
  let eventId: string
  let payload: Record<string, unknown>
  let outcome: Exclude<DeliveryTruthCommitResult['outcome'], 'existing'>
  if (result.outcome === 'provider_ack') {
    sameRequest(result.request, result.request)
    const receipt = validateTransportReceiptForDelivery(result.receipt, unit, loadedRegistration)
    if (receipt.receipt_mode !== 'provider_ack' || receipt.provider_request_digest !== context.invocationStart.provider_request_digest) {
      throw new DeliveryTruthViolationError('RECEIPT_INVALID', 'validated acknowledgement does not bind the invocation start')
    }
    eventType = 'reply.delivered'
    eventId = `delivered:${unit.delivery_id}:${context.claimEpoch}`
    payload = deliveredPayload(unit, receipt) as unknown as Record<string, unknown>
    outcome = 'delivered'
  } else if (result.outcome === 'durable_handoff') {
    const receipt = validateTransportReceiptForDelivery(result.receipt, unit, loadedRegistration)
    if (receipt.receipt_mode !== 'durable_handoff') throw new DeliveryTruthViolationError('RECEIPT_INVALID', 'validated receipt is not durable handoff')
    eventType = 'reply.handoff_accepted'
    eventId = `handoff-accepted:${unit.delivery_id}:${context.claimEpoch}`
    payload = handoffPayload(unit, receipt) as unknown as Record<string, unknown>
    outcome = 'handoff_accepted'
  } else if (result.outcome === 'delivery_unknown') {
    if (decodeFrozenProviderRequestEnvelope(result.request).provider_request_digest !== context.invocationStart.provider_request_digest) {
      throw new DeliveryTruthViolationError('PROVIDER_REQUEST_DIGEST_MISMATCH', 'unknown result differs from invocation-start request')
    }
    eventType = 'reply.delivery_unknown'
    eventId = `delivery-unknown:${unit.delivery_id}:${context.claimEpoch}`
    payload = buildReplyDeliveryUnknownPayload(unit, context.invocationStart, context.invocationStartedEventId) as unknown as Record<string, unknown>
    outcome = 'delivery_unknown'
  } else {
    const permanent = result.outcome === 'failed_permanent'
    eventType = 'reply.failed'
    eventId = `delivery-failed:${unit.delivery_id}:${context.claimEpoch}:${permanent ? 'permanent' : 'retryable'}`
    payload = failedPayload(unit, result.failure_code, permanent) as unknown as Record<string, unknown>
    outcome = permanent ? 'failed_permanent' : 'failed_retryable'
  }

  const eventInput = {
    eventId,
    eventType,
    seatId: context.dispatcherId,
    seatInstanceId: context.dispatcherInstanceId,
    conversationId: context.conversationId,
    correlationId: context.correlationId,
    causationId: context.invocationStartedEventId,
    turnId: context.turnId,
    replyId: unit.reply_id,
    claimEpoch: context.claimEpoch,
    payload,
  } as const

  await context.onCommitPoint?.('before_terminal_check')
  const event = await db.transaction(async tx => {
    const prior = await tx.queryOne<StoredEvent>(
      `SELECT * FROM event_log
       WHERE reply_id = $1 AND claim_epoch = $2
         AND event_type IN ('reply.delivered','reply.handoff_accepted','reply.delivery_unknown','reply.failed')
       ORDER BY seq ASC LIMIT 1`,
      [unit.reply_id, context.claimEpoch],
    )
    if (prior) {
      if (prior.event_id === eventId) {
        assertByteIdenticalEvent(eventInput, prior)
        return prior
      }
      throw new DeliveryTruthViolationError('DELIVERY_TRUTH_TERMINAL_EXISTS', `attempt already has truth ${prior.event_id}`)
    }
    await context.onCommitPoint?.('before_terminal_append')
    try {
      const appended = await new EventLog(db).append(eventInput, tx)
      await context.onCommitPoint?.('after_terminal_append')
      return appended.event
    } catch (error) {
      if (error instanceof ClaimLostError || error instanceof EventIdCanonicalMaterialCollisionError) {
        throw new DeliveryTruthViolationError('DELIVERY_TRUTH_COLLISION', String(error), { cause: error })
      }
      throw error
    }
  })
  await context.onCommitPoint?.('after_commit_before_return')
  return { outcome: event.event_id === eventId ? outcome : 'existing', event } as DeliveryTruthCommitResult
}

/** Reconciliation owns no provider-send port and can only use the existing CAS. */
export async function reconcileUnknownDeliveryOnce(
  db: DbAdapter,
  input: CommitReconciliationTerminalCASInputV1,
): Promise<CommitReconciliationTerminalCASResultV1> {
  return new EventLog(db).commitReconciliationTerminalCAS(input)
}
