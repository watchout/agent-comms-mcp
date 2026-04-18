import type { DbAdapter } from './db/adapter'

export interface ReplyChainEntry {
  id: string
  from: string
  content: string
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
): Promise<ReplyChainEntry[]> {
  if (!messageId) return []
  if (depth <= 0) return []

  const rows = await db.query<{
    id: string
    author_id: string
    content: string
    created_at: string
  }>(
    `WITH RECURSIVE chain(id, channel_id, author_id, content, reply_to, created_at, depth) AS (
       SELECT id, channel_id, author_id, content, reply_to, created_at, 0
       FROM agent_messages WHERE id = $1
       UNION ALL
       SELECT m.id, m.channel_id, m.author_id, m.content, m.reply_to, m.created_at, c.depth + 1
       FROM agent_messages m JOIN chain c ON m.id = c.reply_to
       WHERE c.depth + 1 < $2
     )
     SELECT id, author_id, content, created_at FROM chain ORDER BY created_at ASC`,
    [messageId, depth],
  )

  return rows.map((row) => ({
    id: row.id,
    from: row.author_id,
    content: row.content,
    created_at:
      row.created_at instanceof Date
        ? (row.created_at as Date).toISOString()
        : String(row.created_at),
  }))
}

export function parseReplyChainDepth(raw: string | undefined): number {
  const parsed = parseInt(raw ?? '5', 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return 5
  return parsed
}
