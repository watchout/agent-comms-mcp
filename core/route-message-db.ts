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
} | null> {
  if (!db) return null
  const r = await db.query(
    'SELECT author_id, content, message_type, metadata, thread_id, channel_id FROM agent_messages WHERE id = $1',
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
  }
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
  const r = await db.query(
    `SELECT agent_type FROM agents
     WHERE agent_id = $1 OR metadata->>'discord_id' = $1`,
    [authorId],
  )
  return r.rows.length > 0 && r.rows[0].agent_type === 'human'
}

/** Resolve Discord user ID → core agent_id via agents.metadata.discord_id */
export async function resolveAgentFromDiscordId(db: DbAdapter | null, discordId: string): Promise<string | null> {
  if (!db) return null
  const r = await db.query(
    "SELECT agent_id FROM agents WHERE metadata->>'discord_id' = $1",
    [discordId],
  )
  return r.rows.length > 0 ? r.rows[0].agent_id : null
}

/**
 * ADR-040 D7: fetch `agents.metadata.discord_id` for a given agent_id.
 * Used by `resolveSendDestination` to compare a bot's own Discord user ID
 * against `<@discord_user_id>` mentions in the original message. Without
 * this the bot can't see that it was mentioned by its Discord identity.
 */
export async function getAgentDiscordId(db: DbAdapter | null, agentId: string): Promise<string | null> {
  if (!db) return null
  const r = await db.query(
    "SELECT metadata->>'discord_id' AS discord_id FROM agents WHERE agent_id = $1",
    [agentId],
  )
  return r.rows.length > 0 ? r.rows[0].discord_id ?? null : null
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
 * ADR-040 D7: also read `metadata->>'discord_id'` so routeInbound can match
 * raw Discord user IDs in `msg.mentions` when extractDiscordMentions failed
 * to resolve them ahead of time.
 */
export async function loadAgentInfo(db: DbAdapter | null, agentId: string): Promise<AgentInfo | null> {
  if (!db) return { agentId, agentType: 'dev', observerMode: false, discordId: null }  // fallback
  const r = await db.query(
    `SELECT agent_id, agent_type, observer_mode, metadata->>'discord_id' AS discord_id
       FROM agents WHERE agent_id = $1`,
    [agentId],
  )
  if (r.rows.length === 0) return null
  return {
    agentId: r.rows[0].agent_id,
    agentType: r.rows[0].agent_type ?? 'dev',
    observerMode: r.rows[0].observer_mode === true,
    discordId: r.rows[0].discord_id ?? null,
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
  // ADR-040 D7: `allMentions` may contain core agent_ids (from parseMentions)
  // AND raw Discord user IDs (from metadata.mentions written by the receiver).
  // We must compare against BOTH the caller's agent_id and its Discord user ID
  // so a human who writes `<@1487367645933211699>` (raw Discord ID) still
  // counts as mentioning the bot whose agent_id is `agent-com-dev`.
  const contentMentions = parseMentions(original.content)
  const metaMentions: string[] = (original.metadata as any)?.mentions ?? []
  const allMentions = [...contentMentions, ...metaMentions]
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
