import type { DbAdapter } from './db/adapter'

/**
 * Issue #257 — light/full reply_chain shape (default break, route:ceo-approval).
 *
 * `light` (default): each entry carries an 80-char `preview` of the message
 *   content instead of the full body. Caller fetches full content on demand
 *   via the `expand_msg` MCP tool. Keeps `next` / `inbox` payload <2KB so
 *   18-bot Phase C wave does not exhaust the 200K context window.
 *
 * `full`: legacy shape — full `content` is included on every chain entry.
 *   Recovery path is *transport-asymmetric*:
 *     MCP  → `next({full: true})` / `inbox({full: true})` (arg only)
 *     CLI  → `AGENT_COM_REPLY_CHAIN_MODE=full` (env only)
 *   The asymmetry is intentional and documented in the PR migration note.
 */
export type ReplyChainMode = 'light' | 'full'

export const REPLY_CHAIN_PREVIEW_CHARS = 80

export interface ReplyChainEntry {
  /** Spec PR-α §1 — message's own UUID. Kept for run-bot.sh self-count. */
  id: string
  /** §2.2 — preserved across light/full so run-bot LOOP_DETECTED jq path still resolves. */
  from: string
  /** Spec §1.4 — `reply_to` of this entry, exposed under the canonical `parent_id` name. null at chain root. */
  parent_id: string | null
  /** Spec §1.4 — distance from the seed (current) message. seed = 0; each `reply_to` step toward older ancestors increments by 1. */
  depth: number
  /** Always present. First {@link REPLY_CHAIN_PREVIEW_CHARS} chars of content. */
  preview: string
  /** Only present in `full` mode (opt-in). */
  content?: string
  created_at: string
}

/**
 * Reply Chain Context (spec §18.1 / §1 原則 8).
 *
 * Given a starting `messageId` (the *current* message from `next`, i.e.
 * `agent_messages.id` of the row the caller just popped), walk
 * `agent_messages.reply_to` recursively up to `depth` steps and return the
 * full chain in chronological order (oldest first). The seed row is
 * INCLUDED in the return value so the response carries the current message
 * plus every ancestor in one object — spec §18.1 `$current_message_id` is
 * the seed, and the CTE's seed-inclusive behaviour is canonical.
 *
 * The CTE's `depth` counter + `depth + 1 < $depth` predicate doubles as a
 * cycle guard: a `reply_to` that points back into the chain (directly or
 * transitively) stops at the depth limit rather than looping forever.
 *
 * SQL invariant: WITH RECURSIVE is supported by both PostgreSQL ≥8.4 and
 * SQLite ≥3.8.3. The `$n` parameter placeholders are rewritten to `?` by
 * SqliteAdapter (core/db/sqlite-adapter.ts); PgAdapter passes them through.
 */
export async function fetchReplyChain(
  messageId: string | null | undefined,
  depth: number,
  db: DbAdapter,
  mode: ReplyChainMode = 'light',
): Promise<ReplyChainEntry[]> {
  if (!messageId) return []
  if (depth <= 0) return []

  const rows = await db.query<{
    id: string
    author_id: string
    content: string
    reply_to: string | null
    created_at: string
    depth: number
  }>(
    `WITH RECURSIVE chain(id, channel_id, author_id, content, reply_to, created_at, depth) AS (
       SELECT id, channel_id, author_id, content, reply_to, created_at, 0
       FROM agent_messages WHERE id = $1
       UNION ALL
       SELECT m.id, m.channel_id, m.author_id, m.content, m.reply_to, m.created_at, c.depth + 1
       FROM agent_messages m JOIN chain c ON m.id = c.reply_to
       WHERE c.depth + 1 < $2
     )
     SELECT id, author_id, content, reply_to, created_at, depth FROM chain ORDER BY created_at ASC`,
    [messageId, depth],
  )

  return rows.map((row) => {
    const content = String(row.content ?? '')
    const entry: ReplyChainEntry = {
      id: row.id,
      from: row.author_id,
      parent_id: row.reply_to ?? null,
      depth: typeof row.depth === 'number' ? row.depth : Number(row.depth),
      preview: content.slice(0, REPLY_CHAIN_PREVIEW_CHARS),
      created_at:
        row.created_at instanceof Date
          ? (row.created_at as Date).toISOString()
          : String(row.created_at),
    }
    if (mode === 'full') entry.content = content
    return entry
  })
}

/** Spec §18.1 / §19 — single SSOT default depth = 5. */
export const REPLY_CHAIN_DEFAULT_DEPTH = 5

export function parseReplyChainDepth(raw: string | undefined): number {
  const parsed = parseInt(raw ?? String(REPLY_CHAIN_DEFAULT_DEPTH), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return REPLY_CHAIN_DEFAULT_DEPTH
  return parsed
}
