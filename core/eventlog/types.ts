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
  'reply.failed', // retryable → next delivery epoch claimable; permanent → terminal
  // conversation metadata
  'conversation.linked',
  // SuiteEvent/v1 producer types (SPEC-4MCP-002 v0.2 Contract C; additive-within-version).
  // AUN is the suite identity minting authority; these are produced ONLY through
  // this log — no second event path (CELL-4MCP-AUN-001, #853).
  'suite.identity.agent_upserted',
  'suite.identity.agent_deactivated',
  'suite.identity.agent_retired',
  'suite.mcp_profile.aun_routing_changed',
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
  /** Idempotency nonce for the transport layer (V1 pattern: enforced nonce). */
  nonce: string
  payload: Record<string, unknown>
}

export interface TransportSendResult {
  transportMessageId: string
}

/**
 * Transport adapter consumed by the outbox dispatcher. Discord/Slack/CLI
 * adapters implement this at cutover; fixtures inject fakes.
 * Implementations MUST be idempotent on nonce (duplicate nonce = return the
 * original send's id, or throw DuplicateNonceError).
 */
export interface OutboxTransport {
  send(delivery: OutboxDelivery): Promise<TransportSendResult>
}

export class AppendOnlyViolationError extends Error {}

/** Thrown internally when a conditional claim insert loses the race. */
export class ClaimLostError extends Error {
  constructor(message = 'claim lost: conditional insert conflicted') {
    super(message)
  }
}
