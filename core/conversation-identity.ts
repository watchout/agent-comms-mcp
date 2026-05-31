import { createHash } from 'node:crypto'

export const CONVERSATION_KINDS = ['request', 'audit', 'handoff', 'fanout_child', 'system'] as const

export type ConversationKind = (typeof CONVERSATION_KINDS)[number]

export type ConversationIdentityErrorCode =
  | 'INVALID_SURFACE'
  | 'INVALID_CHANNEL_ID'
  | 'INVALID_THREAD_SCOPE_ID'
  | 'INVALID_CONVERSATION_KIND'
  | 'CONVERSATION_ROOT_REQUIRED'
  | 'CONVERSATION_ROOT_AMBIGUOUS'
  | 'FANOUT_PARENT_REQUIRED'
  | 'PARENT_FOR_NON_CHILD_UNSUPPORTED'
  | 'CONVERSATION_PARENT_AMBIGUOUS'
  | 'ORPHAN_PARENT_UNRESOLVED'

export interface ConversationKeyInput {
  surface: string
  channel_id: string
  thread_scope_id?: string | null
  thread_id?: string | null
  root_message_id?: string | null
  root_request_id?: string | null
  parent_conversation_id?: string | null
  conversation_kind?: string | null
}

export interface ConversationKey {
  surface: string
  channel_id: string
  thread_scope_id: string
  conversation_kind: ConversationKind
  root_message_id?: string
  root_request_id?: string
  parent_conversation_id?: string
}

export interface ConversationKeyOk {
  ok: true
  key: ConversationKey
  key_json: string
  key_hash: string
}

export interface ConversationIdentityErr {
  ok: false
  error: ConversationIdentityErrorCode
  detail?: string
}

export type ConversationKeyResult = ConversationKeyOk | ConversationIdentityErr

export type ConversationResolutionReason =
  | 'reply_to'
  | 'provider_parent'
  | 'new_root'
  | 'child_request'
  | 'orphan_isolated'

export interface ConversationIdentityResolveInput extends ConversationKeyInput {
  reply_to_conversation_id?: string | null
  provider_parent_conversation_id?: string | null
  provider_parent_reference?: string | null
  orphan_policy?: 'isolate' | 'reject'
}

export interface ConversationContinueResolution {
  ok: true
  action: 'continue'
  conversation_id: string
  reason: Extract<ConversationResolutionReason, 'reply_to' | 'provider_parent'>
}

export interface ConversationCreateResolution extends ConversationKeyOk {
  action: 'create'
  reason: Extract<ConversationResolutionReason, 'new_root' | 'child_request' | 'orphan_isolated'>
}

export type ConversationIdentityResolution =
  | ConversationContinueResolution
  | ConversationCreateResolution
  | ConversationIdentityErr

function trimOrNull(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function err(error: ConversationIdentityErrorCode, detail?: string): ConversationIdentityErr {
  return detail ? { ok: false, error, detail } : { ok: false, error }
}

function normalizeConversationKind(value: string | null | undefined): ConversationKind | null {
  if (!value) return 'request'
  return (CONVERSATION_KINDS as readonly string[]).includes(value) ? value : null
}

export function normalizeThreadScopeId(input: {
  channel_id: string
  thread_scope_id?: string | null
  thread_id?: string | null
}): string | null {
  const threadScopeId = trimOrNull(input.thread_scope_id)
  if (threadScopeId) return threadScopeId
  const threadId = trimOrNull(input.thread_id)
  if (threadId) return threadId
  return trimOrNull(input.channel_id)
}

export function serializeConversationKey(key: ConversationKey): string {
  const serialized: Record<string, string> = {
    surface: key.surface,
    channel_id: key.channel_id,
    thread_scope_id: key.thread_scope_id,
  }
  if (key.root_message_id) serialized.root_message_id = key.root_message_id
  if (key.root_request_id) serialized.root_request_id = key.root_request_id
  if (key.parent_conversation_id) serialized.parent_conversation_id = key.parent_conversation_id
  serialized.conversation_kind = key.conversation_kind
  return JSON.stringify(serialized)
}

export function conversationKeyHash(key: ConversationKey): string {
  return createHash('sha256').update(serializeConversationKey(key)).digest('hex')
}

export function buildConversationKey(input: ConversationKeyInput): ConversationKeyResult {
  const surface = trimOrNull(input.surface)
  if (!surface) return err('INVALID_SURFACE')

  const channelId = trimOrNull(input.channel_id)
  if (!channelId) return err('INVALID_CHANNEL_ID')

  const threadScopeId = normalizeThreadScopeId({ ...input, channel_id: channelId })
  if (!threadScopeId) return err('INVALID_THREAD_SCOPE_ID')

  const rootMessageId = trimOrNull(input.root_message_id)
  const rootRequestId = trimOrNull(input.root_request_id)
  if (rootMessageId && rootRequestId) return err('CONVERSATION_ROOT_AMBIGUOUS')
  if (!rootMessageId && !rootRequestId) return err('CONVERSATION_ROOT_REQUIRED')

  const conversationKind = normalizeConversationKind(input.conversation_kind)
  if (!conversationKind) return err('INVALID_CONVERSATION_KIND')

  const parentConversationId = trimOrNull(input.parent_conversation_id)
  if (conversationKind === 'fanout_child' && !parentConversationId) {
    return err('FANOUT_PARENT_REQUIRED')
  }
  if (conversationKind !== 'fanout_child' && parentConversationId) {
    return err('PARENT_FOR_NON_CHILD_UNSUPPORTED')
  }

  const key: ConversationKey = {
    surface,
    channel_id: channelId,
    thread_scope_id: threadScopeId,
    conversation_kind: conversationKind,
  }
  if (rootMessageId) key.root_message_id = rootMessageId
  if (rootRequestId) key.root_request_id = rootRequestId
  if (parentConversationId) key.parent_conversation_id = parentConversationId
  return {
    ok: true,
    key,
    key_json: serializeConversationKey(key),
    key_hash: conversationKeyHash(key),
  }
}

export function resolveConversationIdentity(
  input: ConversationIdentityResolveInput,
): ConversationIdentityResolution {
  const replyToConversationId = trimOrNull(input.reply_to_conversation_id)
  const providerParentConversationId = trimOrNull(input.provider_parent_conversation_id)
  if (replyToConversationId && providerParentConversationId && replyToConversationId !== providerParentConversationId) {
    return err('CONVERSATION_PARENT_AMBIGUOUS')
  }
  if (replyToConversationId) {
    return { ok: true, action: 'continue', conversation_id: replyToConversationId, reason: 'reply_to' }
  }
  if (providerParentConversationId) {
    return { ok: true, action: 'continue', conversation_id: providerParentConversationId, reason: 'provider_parent' }
  }

  const providerParentReference = trimOrNull(input.provider_parent_reference)
  if (providerParentReference && input.orphan_policy === 'reject') {
    return err('ORPHAN_PARENT_UNRESOLVED', providerParentReference)
  }

  const keyResult = buildConversationKey(input)
  if (!keyResult.ok) return keyResult

  const reason =
    providerParentReference && input.orphan_policy === 'isolate'
      ? 'orphan_isolated'
      : keyResult.key.conversation_kind === 'fanout_child'
        ? 'child_request'
        : 'new_root'

  return {
    ok: true,
    action: 'create',
    reason,
    key: keyResult.key,
    key_json: keyResult.key_json,
    key_hash: keyResult.key_hash,
  }
}
