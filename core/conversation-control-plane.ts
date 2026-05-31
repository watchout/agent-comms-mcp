import type { DbAdapter } from './db/adapter'
import {
  resolveConversationIdentity,
  type ConversationIdentityResolveInput,
} from './conversation-identity'
import {
  findActiveConversationBaton,
  createConversationBatonInTransaction,
  type ActiveBatonState,
  type BatonStoreError,
  type ConversationBaton,
} from './conversation-baton-store'
import {
  persistConversationResolutionInTransaction,
  stampAgentMessageConversation,
  stampQueueConversation,
  type ConversationPersistError,
} from './conversation-store'

export type ConversationControlPlaneError =
  | ConversationPersistError
  | BatonStoreError
  | 'ACTIVE_BATON_OWNER_MISMATCH'
  | 'CONVERSATION_RESOLUTION_ACTION_UNSUPPORTED'

export interface ConversationRootAllocationInput extends ConversationIdentityResolveInput {
  owner_agent_id: string
  source_queue_id?: number | string | null
  message_id?: string | null
  claim_id?: string | null
  lease_id?: string | null
  baton_state?: ActiveBatonState
}

export interface ConversationRootAllocationOk {
  ok: true
  conversation_id: string
  baton_id: string
  conversation_action: 'created' | 'reused' | 'continued'
  baton_action: 'created' | 'reused'
  baton: ConversationBaton
}

export interface ConversationRootAllocationErr {
  ok: false
  error: ConversationControlPlaneError
  detail?: string
}

export type ConversationRootAllocationResult = ConversationRootAllocationOk | ConversationRootAllocationErr

function err(error: ConversationControlPlaneError, detail?: string): ConversationRootAllocationErr {
  return detail ? { ok: false, error, detail } : { ok: false, error }
}

class ConversationAllocationRollback extends Error {
  constructor(readonly result: ConversationRootAllocationErr) {
    super(result.error)
  }
}

function rollback(result: ConversationRootAllocationErr): never {
  throw new ConversationAllocationRollback(result)
}

async function stampAllocationRows(
  db: DbAdapter,
  input: ConversationRootAllocationInput,
  conversationId: string,
  batonId: string,
): Promise<ConversationRootAllocationErr | null> {
  if (input.message_id) {
    const stamped = await stampAgentMessageConversation(db, {
      message_id: input.message_id,
      conversation_id: conversationId,
      baton_id: batonId,
    })
    if (!stamped.ok) return stamped
  }
  if (input.source_queue_id !== undefined && input.source_queue_id !== null) {
    const stamped = await stampQueueConversation(db, {
      queue_id: input.source_queue_id,
      conversation_id: conversationId,
      baton_id: batonId,
    })
    if (!stamped.ok) return stamped
  }
  return null
}

export async function allocateConversationRoot(
  db: DbAdapter,
  input: ConversationRootAllocationInput,
): Promise<ConversationRootAllocationResult> {
  const resolution = resolveConversationIdentity(input)
  if (!resolution.ok) return err('CONVERSATION_RESOLUTION_FAILED', resolution.error)

  try {
    return await db.transaction(async (tx) => {
      let conversationId: string
      let conversationAction: ConversationRootAllocationOk['conversation_action']
      if (resolution.action === 'continue') {
        conversationId = resolution.conversation_id
        conversationAction = 'continued'
      } else if (resolution.action === 'create') {
        const persisted = await persistConversationResolutionInTransaction(tx, resolution)
        if (!persisted.ok) rollback(persisted)
        conversationId = persisted.conversation_id
        conversationAction = persisted.action
      } else {
        rollback(err('CONVERSATION_RESOLUTION_ACTION_UNSUPPORTED'))
      }

      const active = await findActiveConversationBaton(tx, conversationId)
      if (active) {
        if (active.owner_agent_id !== input.owner_agent_id) {
          rollback(err('ACTIVE_BATON_OWNER_MISMATCH', active.baton_id))
        }
        const stampError = await stampAllocationRows(tx, input, conversationId, active.baton_id)
        if (stampError) rollback(stampError)
        return {
          ok: true,
          conversation_id: conversationId,
          baton_id: active.baton_id,
          conversation_action: conversationAction,
          baton_action: 'reused',
          baton: active,
        }
      }

      const createdBaton = await createConversationBatonInTransaction(tx, {
        conversation_id: conversationId,
        owner_agent_id: input.owner_agent_id,
        state: input.baton_state ?? 'active',
        source_queue_id: input.source_queue_id ?? null,
        lease_id: input.lease_id ?? null,
        claim_id: input.claim_id ?? null,
      })
      if (!createdBaton.ok) rollback(createdBaton)

      const stampError = await stampAllocationRows(tx, input, conversationId, createdBaton.baton.baton_id)
      if (stampError) rollback(stampError)
      return {
        ok: true,
        conversation_id: conversationId,
        baton_id: createdBaton.baton.baton_id,
        conversation_action: conversationAction,
        baton_action: 'created',
        baton: createdBaton.baton,
      }
    })
  } catch (e) {
    if (e instanceof ConversationAllocationRollback) return e.result
    throw e
  }
}
