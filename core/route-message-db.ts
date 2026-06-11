/**
 * core/route-message-db.ts — DB-bound helpers used by routing
 *
 * Extracted from server.ts (PR-A, ADR-041 step 1/2). Each function takes a
 * `dbQuery` injection so it can be shared between server.ts (which wraps
 * `tryGetDb()`) and the future receiver process (PR-B) without dragging the
 * pg client across module boundaries.
 *
 * Behavioural contract: identical to the in-server.ts versions before this
 * extraction. PR-A is a pure refactor.
 */

import { parseMentions, emitSendReject } from './route-message.js'
import type { AgentInfo } from './route-message.js'
import {
  getAgentDiscordUiId,
  resolveAgentFromDiscordUiId,
  resolveAgentFromDiscordUiIdInMembers,
} from './ui-bindings'

/**
 * Minimal DB adapter shape — anything that can run a parameterised query
 * and return rows.  server.ts injects a wrapper around `tryGetDb()`,
 * tests inject a `pg` Client directly.
 */
export interface DbAdapter {
  query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }>
}

/** A minimal "DB unavailable" sentinel — caller decides what to do. */
export type DbResult<T> = T | null

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string' && v.length > 0)
  if (typeof value !== 'string' || value.length === 0) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string' && v.length > 0) : []
  } catch {
    return []
  }
}

/** Get a message by ID from agent_messages */
export async function getMessageById(
  db: DbAdapter | null,
  messageId: string,
): Promise<{
  author_id: string
  content: string
  message_type: string
  metadata: Record<string, unknown> | null
  thread_id: string | null
  channel_id: string | null
  input_mentions: string[]
} | null> {
  if (!db) return null
  const r = await db.query(
    'SELECT author_id, content, message_type, metadata, thread_id, channel_id, input_mentions FROM agent_messages WHERE id = $1',
    [messageId],
  )
  if (r.rows.length === 0) return null
  const row = r.rows[0]
  return {
    author_id: row.author_id,
    content: row.content,
    message_type: row.message_type ?? 'chat',
    metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
    thread_id: row.thread_id ?? null,
    channel_id: row.channel_id ?? null,
    input_mentions: asStringArray(row.input_mentions),
  }
}

function parseMetadataObject(raw: unknown): Record<string, unknown> {
  if (!raw) return {}
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

export async function resolveReplyRecipientAgentId(
  db: DbAdapter | null,
  replyTo: string,
  senderAgentId: string,
): Promise<string | null> {
  if (!db) return null
  const original = await getMessageById(db, replyTo)
  if (!original?.author_id) return null

  const resolved = await resolveAgentFromDiscordId(db, original.author_id)
  const candidate = resolved ?? original.author_id
  if (!candidate || candidate === senderAgentId) return null

  const exists = await db.query(
    'SELECT agent_id FROM agents WHERE agent_id = $1 LIMIT 1',
    [candidate],
  )
  return exists.rows.length > 0 ? candidate : null
}

export async function resolveReplyToDiscordMessageId(
  db: DbAdapter | null,
  replyTo: string,
): Promise<string | null> {
  if (!db) return null
  const r = await db.query(
    'SELECT discord_message_id, metadata FROM agent_messages WHERE id = $1 LIMIT 1',
    [replyTo],
  )
  if (r.rows.length === 0) return null
  const direct = r.rows[0].discord_message_id
  if (typeof direct === 'string' && direct.trim().length > 0) return direct.trim()
  const metadata = parseMetadataObject(r.rows[0].metadata)
  const fromMetadata = metadata.discord_message_id
  return typeof fromMetadata === 'string' && fromMetadata.trim().length > 0
    ? fromMetadata.trim()
    : null
}

/**
 * Check if sender is a human agent (agent_type='human').
 *
 * ADR-040 D7 fix: the caller can pass either a core agent_id (e.g. 'ceo')
 * or a raw Discord user ID (e.g. '1227059781265653783'). Inbound messages
 * saved by the receiver store the *Discord* user ID in `agent_messages.author_id`,
 * so `resolveSendDestination`'s human bypass check would always fail when
 * trying to look up CEO by `agent_id = '1227...'`. Accepting both forms
 * closes the type-mismatch that caused today's multi-hop cascade.
 */
export async function isHumanAgent(db: DbAdapter | null, authorId: string): Promise<boolean> {
  if (!db) return false // safe default: don't assume human without DB
  const direct = await db.query(
    'SELECT agent_type FROM agents WHERE agent_id = $1 LIMIT 1',
    [authorId],
  )
  if (direct.rows.length > 0) return direct.rows[0].agent_type === 'human'

  const resolvedAgentId = await resolveAgentFromDiscordUiId(db, authorId)
  if (!resolvedAgentId) return false
  const resolved = await db.query(
    'SELECT agent_type FROM agents WHERE agent_id = $1 LIMIT 1',
    [resolvedAgentId],
  )
  return resolved.rows.length > 0 && resolved.rows[0].agent_type === 'human'
}

/** Resolve Discord user ID → core agent_id via agent_ui_bindings, then legacy metadata. */
export async function resolveAgentFromDiscordId(db: DbAdapter | null, discordId: string): Promise<string | null> {
  return resolveAgentFromDiscordUiId(db, discordId)
}

/**
 * Resolve an adapter external user ID only inside the DB-owned channel member set.
 *
 * Core routing is keyed by `agent_id`. Chat adapters may translate platform
 * IDs into agent IDs, but only against the channel membership selected from
 * the DB. A duplicate external ID must fail closed instead of letting a
 * global lookup pick an arbitrary agent.
 */
export async function resolveAgentFromDiscordIdInMembers(
  db: DbAdapter | null,
  discordId: string,
  members: readonly string[],
): Promise<{ agentId: string } | { error: 'not_found' | 'ambiguous'; candidates: string[] }> {
  return resolveAgentFromDiscordUiIdInMembers(db, discordId, members)
}

/**
 * ADR-040 D7: fetch Discord provider id for a given agent_id.
 * Used by `resolveSendDestination` to compare a bot's own Discord user ID
 * against `<@discord_user_id>` mentions in the original message. Without
 * this the bot can't see that it was mentioned by its Discord identity.
 */
export async function getAgentDiscordId(db: DbAdapter | null, agentId: string): Promise<string | null> {
  return getAgentDiscordUiId(db, agentId)
}

/** Resolve inbound channel: find core channel_id and members from Discord channel/thread ID */
export async function resolveInboundChannel(
  db: DbAdapter | null,
  externalChannelId: string,
): Promise<{ channelId: string; threadId?: string; members: string[]; type?: string } | null> {
  if (!db) return null

  // Direct channel match
  const r = await db.query('SELECT id, members, type FROM channels WHERE id = $1', [externalChannelId])
  if (r.rows.length > 0) {
    return { channelId: externalChannelId, members: r.rows[0].members ?? [], type: r.rows[0].type }
  }

  // Thread match: check thread_adapters → threads → parent channel
  const tr = await db.query(
    `SELECT t.id, t.channel_id FROM threads t
     JOIN thread_adapters ta ON ta.thread_id = t.id
     WHERE ta.external_id = $1 AND ta.platform = 'discord'`,
    [externalChannelId],
  )
  if (tr.rows.length > 0) {
    const parentId = tr.rows[0].channel_id
    const cr = await db.query('SELECT members FROM channels WHERE id = $1', [parentId])
    if (cr.rows.length > 0) {
      return { channelId: parentId, threadId: tr.rows[0].id, members: cr.rows[0].members ?? [] }
    }
  }

  // Also check if the external_channel_id is registered via channel_adapters
  const ca = await db.query(
    `SELECT channel_id FROM channel_adapters WHERE external_id = $1 AND platform = 'discord'`,
    [externalChannelId],
  )
  if (ca.rows.length > 0) {
    const cr = await db.query('SELECT members FROM channels WHERE id = $1', [ca.rows[0].channel_id])
    if (cr.rows.length > 0) {
      return { channelId: ca.rows[0].channel_id, members: cr.rows[0].members ?? [] }
    }
  }

  return null // channel not registered in core DB
}

/**
 * Load agent info for pure routeInbound.
 * Adapter metadata is included for diagnostics and existing type shape, but
 * routeInbound/routeMessage only matches individual mentions by agent_id.
 */
export async function loadAgentInfo(db: DbAdapter | null, agentId: string): Promise<AgentInfo | null> {
  if (!db) return { agentId, agentType: 'dev', observerMode: false, discordId: null }  // fallback
  const r = await db.query(
    `SELECT agent_id, agent_type, observer_mode
       FROM agents WHERE agent_id = $1`,
    [agentId],
  )
  if (r.rows.length === 0) return null
  const discordId = await getAgentDiscordId(db, agentId)
  return {
    agentId: r.rows[0].agent_id,
    agentType: r.rows[0].agent_type ?? 'dev',
    observerMode: r.rows[0].observer_mode === true,
    discordId,
  }
}

/**
 * Resolve send destination (§4.2 — reply_to required, fully deterministic)
 * reply_to → original message's location (only path)
 * no reply_to → NO_REPLY_TO error
 */
export async function resolveSendDestination(
  db: DbAdapter | null,
  agentId: string,
  replyTo: string | undefined,
): Promise<{ channelId: string; threadId: string | null } | { error: string; code: string }> {
  if (!replyTo) {
    return { error: 'reply_toは必須です。返信先メッセージIDを指定してください。定期タスクの場合は agent-com notify --channel <id> を使用してください', code: 'NO_REPLY_TO' }
  }

  const original = await getMessageById(db, replyTo)
  if (!original) {
    return { error: `reply_to '${replyTo}' が見つかりません`, code: 'MESSAGE_NOT_FOUND' }
  }

  // reply_to mention guard
  // ADR-040 D7: `allMentions` may contain core agent_ids (from parseMentions
  // and agent_messages.input_mentions) AND raw Discord user IDs (from
  // metadata.mentions written by the receiver). We must compare against BOTH
  // the caller's agent_id and its Discord user ID so a human who writes
  // `<@1487367645933211699>` (raw Discord ID) still counts as mentioning the
  // bot whose agent_id is `agent-com-dev`.
  const contentMentions = parseMentions(original.content)
  const inputMentions: string[] = original.input_mentions
  const metaMentions: string[] = asStringArray((original.metadata as any)?.mentions)
  const allMentions = [...contentMentions, ...inputMentions, ...metaMentions]
  const myDiscordId = await getAgentDiscordId(db, agentId)
  const mentionedInOriginal =
    allMentions.includes(agentId) ||
    (myDiscordId != null && allMentions.includes(myDiscordId))
  // `isOwnMessage` has to cover both author_id shapes too (agent_id for
  // self-saved outbound rows, Discord user ID for inbound rows that the
  // receiver saved with the raw Discord author).
  const isOwnMessage =
    original.author_id === agentId ||
    (myDiscordId != null && original.author_id === myDiscordId)
  const isEmergencyMsg = original.message_type === 'emergency' || original.content.startsWith('!stop')
  // `isHumanAgent` now accepts either form, so passing the raw author_id
  // (which is a Discord user ID for inbound rows) correctly identifies CEO.
  const originalSenderIsHuman = await isHumanAgent(db, original.author_id)

  if (!mentionedInOriginal && !isOwnMessage && !isEmergencyMsg && !originalSenderIsHuman) {
    // Issue #351 Phase A: structured warn-log + counter on every reject.
    // Without this the rejection was silent for the caller and invisible
    // to operators; CTO bug report msg `3b65e0cf` traced the cascade to
    // exactly this path firing without a trail.
    emitSendReject('not_mentioned_in_original', {
      callerAgentId: agentId,
      originalAuthor: original.author_id ?? null,
      originalId: replyTo,
      hasParsedMentions: contentMentions.length > 0,
      hasMetadataMentions: metaMentions.length > 0,
    })
    return { error: '元メッセージであなたはメンションされていません。応答権限がありません', code: 'NOT_MENTIONED_IN_ORIGINAL' }
  }

  // Per SSOT §4.2: channel_id is read directly from the agent_messages row.
  // Inbound messages save metadata under platform-prefixed keys (discord_channel_id,
  // telegram_channel_id, ...), so falling back to metadata.channel_id alone is brittle.
  // Priority: row.channel_id → metadata.channel_id → metadata.<platform>_channel_id → thread_id → ''
  const meta = (original.metadata ?? {}) as Record<string, unknown>
  const platformChannelId =
    (meta.channel_id as string | undefined) ??
    (meta.discord_channel_id as string | undefined) ??
    (meta.telegram_channel_id as string | undefined) ??
    (meta.slack_channel_id as string | undefined)
  return {
    channelId: original.thread_id
      ? (await (async () => {
          if (!db) return original.thread_id!
          const r = await db.query('SELECT channel_id FROM threads WHERE id = $1', [original.thread_id])
          return r.rows.length > 0 ? r.rows[0].channel_id : original.thread_id!
        })())
      : original.channel_id ?? platformChannelId ?? original.thread_id ?? '',
    threadId: original.thread_id,
  }
}
