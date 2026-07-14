// EventLogCore/v1 — AUN V2 durable core public surface.
//
// Design: agent-comms-mcp#794 + EventLogCore/v1 Option B (approved
// 2026-07-05) + SPEC-AUN-002. Build handoff: #794 comment 4911246042.

export * from './types'
export { ensureEventLogSchema } from './schema'
export {
  EventLog,
  appendEventConflictMaterial,
  storedEventConflictMaterial,
  assertByteIdenticalEvent,
  type AppendEventConflictMaterialV1,
  type AppendFanoutAtomicInputV1,
  type AppendFanoutAtomicResultV1,
  type CommitReconciliationTerminalCASInputV1,
  type CommitReconciliationTerminalCASResultV1,
} from './store'
export * from './transport-contract'
export {
  queueView,
  inboxView,
  openTurns,
  openTurnCount,
  claimableTurns,
  outboxView,
  pendingDeliveries,
  fanoutParentAggregate,
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
  AmbiguousDeliveryOutcomeError,
  reserveProviderNonce,
  startProviderInvocation,
  DEFAULT_MAX_DELIVERY_ATTEMPTS,
  type DispatchResult,
} from './outbox'
