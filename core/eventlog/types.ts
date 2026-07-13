// EventLogCore/v1 — AUN V2 durable core types.
//
// Design authority: agent-comms-mcp#794 (Reboot Architecture) +
// EventLogCore/v1 Option B owner decision (approved 2026-07-05,
// #794 comment 4884040411) + SPEC-AUN-002-durable-core-build-target.
//
// Invariants:
// - The log is append-only. No UPDATE, no DELETE (enforced by triggers).
// - event_id is the idempotency key: the same event is never written twice.
// - Every event carries conversation_id / causation_id / correlation_id /
//   seat identity — field-compatible with SuiteEvent/v1 (iyasaka-arc D2-2).
// - State (queue / inbox / thread) is a projection over the log, always
//   rebuildable by replay. Nothing in V2 holds directly-mutable status.

export const EVENT_TYPES = [
  // turn lifecycle
  'message.received', // opens a turn for a seat; deterministic event_id dedups redelivery
  'turn.claimed', // pull-claim: conditional insert wins, losers back off
  'turn.claim_released', // claim released (seat-instance recovery / voluntary backoff)
  'turn.presented', // turn content handed to the seat runtime
  'turn.completed', // typed outcome: replied | no_reply | skipped | failed
  // outbox lifecycle
  'reply.enqueued', // written atomically with turn.completed (transactional outbox)
  'reply.delivery_claimed', // outbox consumer claims one delivery attempt
  'reply.delivered', // terminal: carries transport message id
  'reply.handoff_accepted', // terminal placement truth; never provider-delivered
  'reply.failed', // retryable → next delivery epoch claimable; permanent → terminal
  // Transport-Neutral Contract r1.1.4 lifecycle and authority records.
  // These remain payload contracts over the existing append-only event_log;
  // no physical schema object is introduced by the contract layer.
  'reply.provider_nonce_reserved',
  'reply.provider_invocation_started',
  'reply.delivery_unknown',
  'reply.delivery_reconciliation_requested',
  'reply.delivery_reconciliation_observed',
  'reply.delivery_reconciliation_resolved',
  'reply.delivery_reopened',
  'reply.fanout_planned',
  'reply.zero_external_effect_evidence_recorded',
  'reply.zero_external_effect_attested',
  'reply.zero_external_effect_attestation_consumed',
  'reply.retry_budget_snapshot',
  'authority.loaded_connector_registered',
  'authority.zero_effect_producer_registered',
  'authority.retry_budget_issuer_registered',
  // conversation metadata
  'conversation.linked',
] as const

export type EventType = (typeof EVENT_TYPES)[number]

export type TurnOutcome = 'replied' | 'no_reply' | 'skipped' | 'failed'

export interface AppendEvent {
  eventId: string
  eventType: EventType
  seatId?: string | null
  /** Runtime instance of the seat (process incarnation). Fencing/recovery signal. */
  seatInstanceId?: string | null
  conversationId?: string | null
  /** Parent event_id — the event that caused this one (thread/causation chain). */
  causationId?: string | null
  correlationId?: string | null
  turnId?: string | null
  replyId?: string | null
  /** Claim attempt number for turn.claimed / reply.delivery_claimed rows. */
  claimEpoch?: number | null
  payload?: Record<string, unknown>
}

export interface StoredEvent {
  seq: number
  event_id: string
  event_type: EventType
  occurred_at: string
  seat_id: string | null
  seat_instance_id: string | null
  conversation_id: string | null
  causation_id: string | null
  correlation_id: string | null
  turn_id: string | null
  reply_id: string | null
  claim_epoch: number | null
  payload: string
}

/**
 * payload column is TEXT on SQLite (string) and JSONB on PostgreSQL (the
 * driver returns a parsed object). Consumers must use this instead of
 * JSON.parse directly.
 */
export function parseEventPayload<T = Record<string, unknown>>(payload: unknown): T {
  return typeof payload === 'string' ? JSON.parse(payload) : (payload as T)
}

export interface AppendResult {
  /** false when event_id already existed (idempotent duplicate — not an error). */
  inserted: boolean
  event: StoredEvent
}

/** One open turn in queue_view: received, no terminal completion yet. */
export interface QueueViewRow {
  turn_id: string
  seat_id: string
  conversation_id: string | null
  received_seq: number
  received_event_id: string
  received_at: string
  message_id: string | null
  /** Active claim (claimed and not released, turn not completed), if any. */
  claim_event_id: string | null
  claim_epoch: number | null
  claimed_by_seat: string | null
  claimed_by_instance: string | null
  claim_seq: number | null
}

export interface ThreadViewNode {
  event: StoredEvent
  children: ThreadViewNode[]
}

export interface ClaimedTurn {
  turn: QueueViewRow
  claimEventId: string
  claimEpoch: number
}

export interface OutboxViewRow {
  reply_id: string
  seat_id: string | null
  conversation_id: string | null
  turn_id: string | null
  enqueued_seq: number
  enqueued_event_id: string
  enqueued_at: string
  payload: string
  attempts: number
  /** Active delivery claim, if a consumer is mid-attempt. */
  delivery_claim_event_id: string | null
  delivery_claim_epoch: number | null
  claimed_by_dispatcher: string | null
  claimed_by_instance: string | null
}

export interface OutboxDelivery {
  replyId: string
  channelExternalId: string | null
  content: string
  /** Stable transport nonce; nonce errors are never delivery evidence. */
  nonce: string
  payload: Record<string, unknown>
}

export interface TransportSendResult {
  transportMessageId: string
}

/**
 * Transport adapter consumed by the outbox dispatcher. Discord/Slack/CLI
 * adapters implement this at cutover; fixtures inject fakes.
 * Legacy compatibility transport. The Transport-Neutral direct adapter uses
 * frozen request/ack envelopes; a thrown nonce error never means delivered.
 */
export interface OutboxTransport {
  send(delivery: OutboxDelivery): Promise<TransportSendResult>
}

export class AppendOnlyViolationError extends Error {}

/** Same event_id was reused with different canonical conflict material. */
export class EventIdCanonicalMaterialCollisionError extends Error {
  readonly code = 'EVENT_ID_CANONICAL_MATERIAL_COLLISION' as const
}

/** A deterministic atomic group was only partly durable. */
export class ReopenAtomicSetIncompleteError extends Error {
  readonly code = 'REOPEN_ATOMIC_SET_INCOMPLETE' as const
}

/** Persisted evidence does not authorize a reopened provider attempt. */
export class ReopenNotAuthorizedError extends Error {
  readonly code = 'REOPEN_NOT_AUTHORIZED' as const
}

/** A different outcome already won for the same delivery attempt. */
export class ReconciliationTransitionCollisionError extends Error {
  readonly code = 'RECONCILIATION_TRANSITION_COLLISION' as const
}

/** A fan-out event or child set disagrees with its deterministic plan. */
export class FanoutCollisionError extends Error {
  readonly code = 'FANOUT_COLLISION' as const
}

/** Terminal evidence cannot be joined to the persisted fan-out child. */
export class FanoutParentLinkMismatchError extends Error {
  readonly code = 'FANOUT_PARENT_LINK_MISMATCH' as const
}

/** A provider nonce was already reserved for different canonical material. */
export class ProviderNonceCollisionError extends Error {
  readonly code = 'PROVIDER_NONCE_COLLISION' as const
}

/** Persisted loaded connector authority is absent, stale, or unverifiable. */
export class LoadedRegistrationUnprovenError extends Error {
  readonly code = 'LOADED_REGISTRATION_UNPROVEN' as const
}

/** One invocation-start CAS already exists with different attempt material. */
export class InvocationStartCollisionError extends Error {
  readonly code = 'INVOCATION_START_COLLISION' as const
}

/** Thrown internally when a conditional claim insert loses the race. */
export class ClaimLostError extends Error {
  constructor(message = 'claim lost: conditional insert conflicted') {
    super(message)
  }
}
