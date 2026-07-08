// EventLogCore/v1 — AUN V2 durable core public surface.
//
// Design: agent-comms-mcp#794 + EventLogCore/v1 Option B (approved
// 2026-07-05) + SPEC-AUN-002. Build handoff: #794 comment 4911246042.

export * from './types'
export { ensureEventLogSchema } from './schema'
export { EventLog } from './store'
export {
  queueView,
  inboxView,
  openTurns,
  openTurnCount,
  claimableTurns,
  outboxView,
  pendingDeliveries,
  threadView,
} from './views'
export {
  receiveMessage,
  claimNextTurn,
  presentTurn,
  completeTurn,
  releaseClaim,
  recoverSeatClaims,
  turnIdFor,
  StaleClaimError,
  type ReceiveMessageInput,
  type ReplyInput,
  type CompleteTurnInput,
} from './turns'
export {
  dispatchOutboxOnce,
  recoverDispatcherClaims,
  deliveryNonce,
  PermanentDeliveryError,
  DEFAULT_MAX_DELIVERY_ATTEMPTS,
  type DispatchResult,
} from './outbox'
