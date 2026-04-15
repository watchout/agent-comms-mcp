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
 * explicit expansion of the composite `>` comparison:
 *
 *   AND (created_at > $3::timestamptz
 *        OR (created_at = $3::timestamptz AND id > $4::uuid))
 *   ORDER BY created_at ASC, id ASC
 *
 * Expanded form (not PG's row-value `(a, b) > ROW(...)`) because
 * node-postgres hits PG 42P18 "could not determine data type of
 * parameter" on anonymous record comparison, even with explicit
 * `::type` casts. The two forms are semantically identical; the
 * expanded form anchors each parameter to a single-column compare
 * which the planner types unambiguously.
 *
 * ### Precision (PR #182 cycle 3 — auditor Layer 2 feedback)
 *
 * The cursor is **µs-precise** to match `agent_messages.created_at`
 * (PG timestamptz holds microseconds). node-postgres's default OID
 * 1184 parser converts the column to a JS `Date` which only holds
 * milliseconds; using that parsed value as the cursor would truncate
 * `.123456Z` to `.123000Z` and the next WHERE (`created_at >
 * .123000Z`) would match the same row again — duplicate delivery.
 *
 * Rather than override the global `pg.types.setTypeParser(1184, …)`
 * (which would affect every other timestamptz consumer in this
 * process) or route this path through a scoped `pg.Client`, the
 * SELECT adds a companion column `created_at::text AS created_at_text`.
 * The text-cast round-trip retains the precision the cursor needs
 * (concrete form under the default PG DateStyle resembles
 * `'2026-04-15 07:15:00.123456+00'`, carrying the sub-millisecond
 * portion); passing that value back through `$3::timestamptz`
 * parses it correctly on the next call. The `created_at` Date
 * column stays available for row-level UI / sorting in the caller;
 * it is NOT the cursor value.
 *
 * #### `created_at_text` observability note
 *
 * `InboxRow.created_at_text` is an optional public field on every
 * row this function returns. Callers that JSON.stringify / snapshot
 * rows will observe it in their output — it is not an internal
 * scratch column. Tidying it up (hiding, renaming, moving to a
 * parallel object) is deliberately out of scope for Issue #179 and
 * is marked as future cleanup.
 *
 * The `id` UUID tiebreaker covers the exact µs-tied case where two
 * rows share `.123456+00` — strict `>` excludes the first row and the
 * OR branch with `created_at = cursor AND id > cursor_id` advances
 * past the id that was just consumed.
 *
 * ### Semantics (SSOT: docs/agent-com-message-queue-spec.md §4.8.1)
 *   - cursor is per-process (one inbox reader = one bot's server.ts)
 *   - advancing the cursor is side-effect of reading; if the caller
 *     does not persist it, duplicate delivery is possible on retry
 *   - when no rows are returned, the cursor is *not* advanced so a
 *     subsequent call with the same cursor still sees newer rows
 */
export interface InboxCursor {
  /**
   * PG timestamptz serialized as text. Concrete format under the
   * default DateStyle resembles `'2026-04-15 07:15:00.123456+00'`
   * and preserves the sub-millisecond portion that the cursor
   * round-trip needs. This is the value returned from
   * `created_at::text` in the SELECT, NOT a JS `Date.toISOString()`
   * (which would drop µs to ms).
   */
  createdAt: string
  /** UUID v4; deterministic tiebreaker for µs-tied inserts. */
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
  /**
   * Populated by the SELECT's `created_at::text AS created_at_text`
   * companion column — the cursor-round-trip-precision text form
   * used as the cursor anchor. Optional so unit tests that don't
   * simulate the column still compile; the runtime fetch path
   * always populates it.
   *
   * NOTE: publicly observable on every returned row (see the
   * `created_at_text` observability note in the module docstring).
   * Callers that serialize rows (JSON.stringify, snapshot tests)
   * will see this field; hiding/renaming/segregating it is deferred
   * as future cleanup outside Issue #179's scope.
   */
  created_at_text?: string
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
  // `created_at::text AS created_at_text` preserves µs precision for
  // cursor advancement — see the Precision section in the module
  // docstring for why this is required to avoid duplicate delivery.
  const r = await deps.query(
    `SELECT id, channel_id, author_id, content, message_type, reply_to, metadata, depth,
            created_at, created_at::text AS created_at_text
     FROM agent_messages WHERE ${whereClause}
     ORDER BY created_at ASC, id ASC LIMIT $2`,
    params,
  )
  if (r.rows.length === 0) {
    return { rows: [], nextCursor: cursor }
  }
  const last = r.rows[r.rows.length - 1]
  // Prefer the µs-precise text column for the cursor. Fallback to the
  // Date/string form of `created_at` only if the companion column is
  // missing (unit-test fixtures that don't simulate it); in that case
  // ms precision is all we have, which is fine for mocks that don't
  // exercise µs semantics.
  const createdAtCursor =
    last.created_at_text ??
    (last.created_at instanceof Date
      ? last.created_at.toISOString()
      : String(last.created_at))
  return {
    rows: r.rows,
    nextCursor: { createdAt: createdAtCursor, id: last.id },
  }
}
