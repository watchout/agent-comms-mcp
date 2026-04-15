/**
 * Inbox cursor — composite (created_at, id) pagination for
 * `fetchNewMessages` used by the MCP `inbox` tool.
 *
 * Previously the cursor was a bare UUID compared with `id > $3`,
 * which PostgreSQL resolves by lexicographic text ordering of the
 * UUID. UUID v4 is random, not monotonic, so a new row's UUID can
 * sort lexicographically *before* the previously-seen max, and the
 * next `inbox` call filters the new row out. See Issue #179.
 *
 * Fix: cursor is `{ createdAt, id }` and the WHERE clause uses the
 * PostgreSQL row-value comparison `(created_at, id) > ($3, $4)`.
 * Row-value `>` is lexicographic over the tuple, matching the
 * `ORDER BY created_at ASC, id ASC` ordering exactly. UUID is kept
 * as a deterministic tiebreaker for the µs-tied created_at case so
 * rows inserted in the same microsecond are not lost.
 *
 * Semantics (SSOT: docs/agent-com-message-queue-spec.md §9.4):
 *   - cursor is per-process (one inbox reader = one bot's server.ts)
 *   - advancing the cursor is side-effect of reading; if the caller
 *     does not persist it, duplicate delivery is possible on retry
 *   - when no rows are returned, the cursor is *not* advanced so a
 *     subsequent call with the same cursor still sees newer rows
 */
export interface InboxCursor {
  /** ISO-8601 timestamp with µs precision (PG timestamptz). */
  createdAt: string
  /** UUID v4; deterministic tiebreaker for same-µs inserts. */
  id: string
}

export interface InboxRow {
  id: string
  channel_id: string
  author_id: string
  content: string
  message_type: string | null
  reply_to: string | null
  metadata: Record<string, unknown> | null
  depth: number | null
  created_at: Date | string
}

export interface InboxQueryDeps {
  query: (sql: string, params: any[]) => Promise<{ rows: InboxRow[] }>
}

export interface FetchNewMessagesResult {
  rows: InboxRow[]
  /**
   * Cursor to pass to the next call. Equals the input cursor when
   * zero rows are returned (so the caller can keep polling without
   * accidentally skipping ahead).
   */
  nextCursor: InboxCursor | null
}

export async function fetchNewMessages(
  forAgent: string,
  limit: number,
  cursor: InboxCursor | null,
  deps: InboxQueryDeps,
): Promise<FetchNewMessagesResult> {
  const params: any[] = [forAgent, limit]
  let whereClause = `metadata->>'to' = $1 AND author_id != $1`
  if (cursor) {
    // Explicit expansion of the composite (created_at, id) > cursor
    // comparison. Row-value form `(created_at, id) > ROW($3, $4)`
    // (even with explicit ::type casts) hits PG 42P18 in the
    // node-postgres driver because anonymous record comparison does
    // not propagate parameter types reliably. This expanded form is
    // semantically identical and uses plain column comparisons that
    // the planner types unambiguously.
    whereClause +=
      ` AND (created_at > $3::timestamptz` +
      ` OR (created_at = $3::timestamptz AND id > $4::uuid))`
    params.push(cursor.createdAt, cursor.id)
  }
  const r = await deps.query(
    `SELECT id, channel_id, author_id, content, message_type, reply_to, metadata, depth, created_at
     FROM agent_messages WHERE ${whereClause}
     ORDER BY created_at ASC, id ASC LIMIT $2`,
    params,
  )
  if (r.rows.length === 0) {
    return { rows: [], nextCursor: cursor }
  }
  const last = r.rows[r.rows.length - 1]
  const createdAtStr = last.created_at instanceof Date
    ? last.created_at.toISOString()
    : String(last.created_at)
  return {
    rows: r.rows,
    nextCursor: { createdAt: createdAtStr, id: last.id },
  }
}
