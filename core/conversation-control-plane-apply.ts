import type { DbAdapter } from './db/adapter'
import {
  allocateConversationRoot,
  type ConversationRootAllocationInput,
  type ConversationRootAllocationResult,
  type ConversationRootAllocationErr,
} from './conversation-control-plane'
import {
  conversationControlPlaneMetadata,
  resolveConversationControlPlaneGate,
  type ConversationControlPlaneEnv,
  type ConversationControlPlaneGate,
  type ConversationControlPlaneGateErr,
  type ConversationControlPlaneSurface,
} from './conversation-control-plane-rollout'

export type ConversationControlPlaneApplyAction =
  | 'skipped'
  | 'allocated'
  | 'shadow_failed'
  | 'enforce_failed'

export interface ConversationControlPlaneApplyOk {
  ok: true
  action: Exclude<ConversationControlPlaneApplyAction, 'enforce_failed'>
  gate: ConversationControlPlaneGate
  allocation?: ConversationRootAllocationResult
  allocation_error?: ConversationRootAllocationErr
  metadata: ReturnType<typeof conversationControlPlaneMetadata>
}

export interface ConversationControlPlaneApplyErr {
  ok: false
  action: 'enforce_failed'
  gate: ConversationControlPlaneGate
  allocation_error: ConversationRootAllocationErr
  metadata: ReturnType<typeof conversationControlPlaneMetadata>
}

export type ConversationControlPlaneApplyResult =
  | ConversationControlPlaneApplyOk
  | ConversationControlPlaneApplyErr
  | ConversationControlPlaneGateErr

export interface ConversationControlPlaneApplyOptions {
  env?: ConversationControlPlaneEnv
  allocator?: (
    db: DbAdapter,
    input: ConversationRootAllocationInput,
  ) => Promise<ConversationRootAllocationResult>
}

export async function applyConversationControlPlaneAllocation(
  db: DbAdapter,
  surface: ConversationControlPlaneSurface,
  input: ConversationRootAllocationInput,
  options: ConversationControlPlaneApplyOptions = {},
): Promise<ConversationControlPlaneApplyResult> {
  const gate = resolveConversationControlPlaneGate(surface, options.env)
  if (!gate.ok) return gate

  const metadata = conversationControlPlaneMetadata(gate)
  if (!gate.allocate) {
    return {
      ok: true,
      action: 'skipped',
      gate,
      metadata,
    }
  }

  const allocator = options.allocator ?? allocateConversationRoot
  const allocation = await allocator(db, input)
  if (allocation.ok) {
    return {
      ok: true,
      action: 'allocated',
      gate,
      allocation,
      metadata,
    }
  }

  if (gate.audit_only) {
    return {
      ok: true,
      action: 'shadow_failed',
      gate,
      allocation_error: allocation,
      metadata,
    }
  }

  return {
    ok: false,
    action: 'enforce_failed',
    gate,
    allocation_error: allocation,
    metadata,
  }
}
