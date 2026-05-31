import type { DbAdapter } from './db/adapter'
import type {
  ConversationCreateResolution,
  ConversationIdentityResolution,
  ConversationKey,
  ConversationKeyOk,
} from './conversation-identity'

export type ConversationPersistError =
  | 'CONVERSATION_RESOLUTION_FAILED'
  | 'CONVERSATION_INSERT_CONFLICT_UNRESOLVED'
  | 'MESSAGE_CONVERSATION_STAMP_NOT_FOUND'
  | 'QUEUE_CONVERSATION_STAMP_NOT_FOUND'

export interface StoredConversation {
  conversation_id: string
  conversation_key_hash: string
  conversation_key_json: string
  key: ConversationKey
  surface: string
  channel_id: string
  thread_scope_id: string
  root_message_id: string | null
  root_request_id: string | null
  parent_conversation_id: string | null
  conversation_kind: string
  status: string
}

export interface ConversationPersistOk {
  ok: true
  action: 'created' | 'reused' | 'continued'
  conversation_id: string
  conversation?: StoredConversation
}

export interface ConversationPersistErr {
  ok: false
  error: ConversationPersistError
  detail?: string
}

export type ConversationPersistResult = ConversationPersistOk | ConversationPersistErr

export interface ConversationStampOk {
  ok: true
  conversation_id: string
  baton_id: string | null
}

export type ConversationStampResult = ConversationStampOk | ConversationPersistErr

function err(error: ConversationPersistError, detail?: string): ConversationPersistErr {
  return detail ? { ok: false, error, detail } : { ok: false, error }
}

function parseConversationKey(raw: unknown): ConversationKey {
  if (typeof raw === 'string') return JSON.parse(raw) as ConversationKey
  if (raw && typeof raw === 'object') return raw as ConversationKey
  return JSON.parse(String(raw ?? '{}')) as ConversationKey
}

function mapStoredConversation(row: any): StoredConversation {
  const conversationKeyJson = typeof row.conversation_key_json === 'string'
    ? row.conversation_key_json
    : JSON.stringify(row.conversation_key ?? {})
  return {
    conversation_id: String(row.conversation_id),
    conversation_key_hash: String(row.conversation_key_hash),
    conversation_key_json: conversationKeyJson,
    key: parseConversationKey(row.conversation_key ?? conversationKeyJson),
    surface: String(row.surface),
    channel_id: String(row.channel_id),
    thread_scope_id: String(row.thread_scope_id),
    root_message_id: row.root_message_id == null ? null : String(row.root_message_id),
    root_request_id: row.root_request_id == null ? null : String(row.root_request_id),
    parent_conversation_id: row.parent_conversation_id == null ? null : String(row.parent_conversation_id),
    conversation_kind: String(row.conversation_kind),
    status: String(row.status),
  }
}

const CONVERSATION_SELECT = `
  SELECT
    conversation_id::text AS conversation_id,
    conversation_key_hash,
    conversation_key::text AS conversation_key_json,
    conversation_key,
    surface,
    channel_id,
    thread_scope_id,
    root_message_id::text AS root_message_id,
    root_request_id,
    parent_conversation_id::text AS parent_conversation_id,
    conversation_kind,
    status
  FROM conversations
`

export async function findConversationByKeyHash(
  db: DbAdapter,
  conversationKeyHash: string,
): Promise<StoredConversation | null> {
  const row = await db.queryOne(`${CONVERSATION_SELECT} WHERE conversation_key_hash = $1`, [conversationKeyHash])
  return row ? mapStoredConversation(row) : null
}

async function insertConversation(
  db: DbAdapter,
  resolution: ConversationCreateResolution | ConversationKeyOk,
): Promise<StoredConversation | null> {
  const key = resolution.key
  const row = await db.queryOne(`
    INSERT INTO conversations (
      conversation_key_hash,
      conversation_key,
      surface,
      channel_id,
      thread_scope_id,
      root_message_id,
      root_request_id,
      parent_conversation_id,
      conversation_kind
    ) VALUES (
      $1,
      $2::jsonb,
      $3,
      $4,
      $5,
      $6,
      $7,
      $8,
      $9
    )
    ON CONFLICT (conversation_key_hash) DO NOTHING
    RETURNING
      conversation_id::text AS conversation_id,
      conversation_key_hash,
      conversation_key::text AS conversation_key_json,
      conversation_key,
      surface,
      channel_id,
      thread_scope_id,
      root_message_id::text AS root_message_id,
      root_request_id,
      parent_conversation_id::text AS parent_conversation_id,
      conversation_kind,
      status
  `, [
    resolution.key_hash,
    resolution.key_json,
    key.surface,
    key.channel_id,
    key.thread_scope_id,
    key.root_message_id ?? null,
    key.root_request_id ?? null,
    key.parent_conversation_id ?? null,
    key.conversation_kind,
  ])
  return row ? mapStoredConversation(row) : null
}

export async function persistConversationResolution(
  db: DbAdapter,
  resolution: ConversationIdentityResolution,
): Promise<ConversationPersistResult> {
  if (!resolution.ok) return err('CONVERSATION_RESOLUTION_FAILED', resolution.error)
  if (resolution.action === 'continue') {
    return { ok: true, action: 'continued', conversation_id: resolution.conversation_id }
  }

  return db.transaction((tx) => persistConversationResolutionInTransaction(tx, resolution))
}

export async function persistConversationResolutionInTransaction(
  db: DbAdapter,
  resolution: ConversationCreateResolution | ConversationKeyOk,
): Promise<ConversationPersistResult> {
  const inserted = await insertConversation(db, resolution)
  if (inserted) {
    return {
      ok: true,
      action: 'created',
      conversation_id: inserted.conversation_id,
      conversation: inserted,
    }
  }

  const existing = await findConversationByKeyHash(db, resolution.key_hash)
  if (!existing) return err('CONVERSATION_INSERT_CONFLICT_UNRESOLVED', resolution.key_hash)
  return {
    ok: true,
    action: 'reused',
    conversation_id: existing.conversation_id,
    conversation: existing,
  }
}

export async function stampAgentMessageConversation(
  db: DbAdapter,
  input: { message_id: string; conversation_id: string; baton_id?: string | null },
): Promise<ConversationStampResult> {
  const row = await db.queryOne(`
    UPDATE agent_messages
       SET conversation_id = $2,
           baton_id = COALESCE($3, baton_id)
     WHERE id = $1
     RETURNING conversation_id::text AS conversation_id, baton_id::text AS baton_id
  `, [input.message_id, input.conversation_id, input.baton_id ?? null])
  if (!row) return err('MESSAGE_CONVERSATION_STAMP_NOT_FOUND', input.message_id)
  return {
    ok: true,
    conversation_id: String((row as any).conversation_id),
    baton_id: (row as any).baton_id == null ? null : String((row as any).baton_id),
  }
}

export async function stampQueueConversation(
  db: DbAdapter,
  input: { queue_id: number | string; conversation_id: string; baton_id?: string | null },
): Promise<ConversationStampResult> {
  const row = await db.queryOne(`
    UPDATE message_queue
       SET conversation_id = $2,
           baton_id = COALESCE($3, baton_id)
     WHERE id = $1
     RETURNING conversation_id::text AS conversation_id, baton_id::text AS baton_id
  `, [input.queue_id, input.conversation_id, input.baton_id ?? null])
  if (!row) return err('QUEUE_CONVERSATION_STAMP_NOT_FOUND', String(input.queue_id))
  return {
    ok: true,
    conversation_id: String((row as any).conversation_id),
    baton_id: (row as any).baton_id == null ? null : String((row as any).baton_id),
  }
}
