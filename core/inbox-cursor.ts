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

/**
 * Generic db handle accepted by the reclaim/persist helpers below.
 * `query()` returns a `{rows}` shape so the helpers can interrogate
 * `RETURNING` output uniformly across the pg and sqlite adapters.
 */
export interface ReclaimDb {
  query: (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }>
}

/**
 * Issue #287 — startup self-reclaim. Rolls THIS agent's `status='read'`
 * rows back to `pending` so the new session re-receives them via the
 * normal `next` path. Idempotent.
 *
 * PR-0 cycle 5 (auditor BLOCK axis 1) — TTL 経過確認必須化:
 *   `claim_expires_at IS NULL OR claim_expires_at < now()`. A claim
 *   still WITHIN TTL is left alone — a delayed/duplicate process must
 *   not yank a row from the legitimate active worker. NULL is treated
 *   as "no TTL set" → eligible for reclaim (covers the legacy rows
 *   where claim_expires_at was never written).
 *
 * Conflict with `core/claim-ttl.ts` `sweepExpiredClaims` is resolved
 * by predicate ordering: self-reclaim runs first (startup + 60s
 * periodic) and flips own expired/null-TTL rows from `read` → `pending`,
 * after which the claim-ttl sweeper's predicate (`status='read' AND
 * claim_expires_at < now()`) no longer matches them. Other agents'
 * truly-abandoned claims still flow through claim-ttl → `failed`.
 */
/**
 * PR-0 cycle 8 axis 3 BLOCK fix — fail-closed on DB errors. The cycle
 * 7 implementation swallowed any error and returned 0, leaving
 * orphaned own claims permanently in `status='read'` (claim-ttl
 * sweeper excludes self via `selfAgentId`, so nothing else recovers
 * them). Per CTO directive 2026-05-01 + governance-flow.md fail-closed
 * principle, the function now throws; the server startup caller
 * catches and exits with code 1, surfacing the failure loudly so
 * launchd/systemd can restart and persistent failures stay visible
 * instead of silently rotting the queue.
 */
export async function reclaimSelfOrphanedClaims(
  db: ReclaimDb,
  agentId: string,
): Promise<number> {
  const r: any = await db.query(
    `UPDATE message_queue
       SET status = 'pending',
           claimed_by = NULL,
           claimed_at = NULL,
           claim_expires_at = NULL,
           read_at = NULL
     WHERE agent_id = $1
       AND claimed_by = $1
       AND status = 'read'
       AND (claim_expires_at IS NULL OR claim_expires_at < now())
     RETURNING id`,
    [agentId],
  )
  const rows = r?.rows ?? []
  if (rows.length > 0) {
    process.stderr.write(`agent-comms: startup self-reclaim — ${rows.length} orphaned claims rolled back to 'pending' for ${agentId}\n`)
  }
  // PR-0 cycle 7 axis 2/3 BLOCK fix — derive agents.status from the
  // post-reclaim claim set so callers (sender-feedback busy/idle
  // branch) see consistent state. Mirrors the pattern in next/send/
  // fail/skip/manual-reclaim handlers (server.ts:1735 / :2897).
  await syncAgentStatusFromClaims(db, agentId)
  return rows.length
}

/**
 * PR-0 cycle 7 axis 2/3 BLOCK fix — derive `agents.status` from the
 * agent's open-claim set. Idempotent: callers should invoke after any
 * status='read' transition (claim or reclaim).
 *
 * PR-0 cycle 14 axis 1/2/3/5/6 BLOCK fix — try/catch removed.
 * `reclaimSelfOrphanedClaims` and the periodic sweepers must surface
 * a status-sync failure rather than masking it as success: a stale
 * `agents.status` causes sender-feedback's busy/idle branch to
 * misroute notifications, so the right move is fail-closed
 * propagation, not non-fatal log.
 */
async function syncAgentStatusFromClaims(db: ReclaimDb, agentId: string): Promise<void> {
  await db.query(
    `UPDATE agents SET
       status = CASE WHEN EXISTS(SELECT 1 FROM message_queue WHERE claimed_by = $1 AND status = 'read') THEN 'busy' ELSE 'idle' END,
       status_detail = CASE WHEN EXISTS(SELECT 1 FROM message_queue WHERE claimed_by = $1 AND status = 'read') THEN 'メッセージ処理中' ELSE NULL END,
       status_updated_at = now()
     WHERE agent_id = $1`,
    [agentId],
  )
}

/**
 * Issue #287 — periodic self-reclaim sweeper. Same predicate as the
 * startup hook but stricter on `claim_expires_at` (must be set + past),
 * so mid-session claims still in flight (NULL TTL → pending was never
 * `next`'d) are not yanked.
 */
export function startSelfReclaimSweeper(
  db: ReclaimDb,
  agentId: string,
  opts: { intervalMs?: number; onError?: (err: Error) => void } = {},
): NodeJS.Timer {
  const intervalMs = opts.intervalMs ?? 60_000  // 60s
  const fire = async () => {
    try {
      const r: any = await db.query(
        `UPDATE message_queue
           SET status = 'pending',
               claimed_by = NULL,
               claimed_at = NULL,
               claim_expires_at = NULL,
               read_at = NULL
         WHERE agent_id = $1
           AND claimed_by = $1
           AND status = 'read'
           AND claim_expires_at IS NOT NULL
           AND claim_expires_at < now()
         RETURNING id`,
        [agentId],
      )
      const n = r?.rows?.length ?? 0
      if (n > 0) {
        process.stderr.write(`agent-comms: periodic self-reclaim — ${n} expired claims for ${agentId} → 'pending'\n`)
      }
      // PR-0 cycle 7 axis 2/3 — derive agents.status whether or not rows
      // were reclaimed: even an idempotent zero-row sweep should leave
      // the cached agents.status in sync with the live claim set.
      await syncAgentStatusFromClaims(db, agentId)
    } catch (err) {
      // PR-0 cycle 14 axis 2/3/4/5/6 BLOCK fix — fail-closed instead
      // of swallowing. With self-claim excluded from the claim-TTL
      // sweep (`selfAgentId` predicate), a continuously-failing
      // periodic self-reclaim leaves own expired claims stuck in
      // `read` forever. Surface the failure: tests can inject
      // `onError` to inspect; production logs the error and exits
      // with code 1 so run-bot.sh / launchd / systemd restart cycles
      // the bot into a clean state.
      const e = err instanceof Error ? err : new Error(String(err))
      process.stderr.write(`agent-comms: periodic self-reclaim FAILED for ${agentId}: ${e.message}\n`)
      if (opts.onError) {
        opts.onError(e)
      } else {
        process.exit(1)
      }
    }
  }
  const timer = setInterval(fire, intervalMs)
  ;(timer as unknown as { unref?: () => void }).unref?.()
  return timer
}

/**
 * Issue #287 — load `agents.inbox_cursor_{at,id}` from the DB.
 *
 * PR-0 cycle 11 axis 1+5+6 BLOCK fix — fail-closed contract: SELECT
 * errors propagate via throw (no swallow), so the wrapper can avoid
 * latching `inboxCursorLoadedFromDb = true` on failure and keep
 * retrying on subsequent calls. The previous cycle-10 implementation
 * caught the error and returned null, which the wrapper could not
 * distinguish from "row absent (legitimate first boot)" — once
 * latched the process never re-attempted restore, indefinitely
 * replaying stale rows after a transient DB blip.
 *
 * Return semantics:
 *   - `InboxCursor` — row + cursor columns populated; restore from DB.
 *   - `null` — row absent OR cursor columns NULL; legitimate first
 *     boot for this agent. Caller MAY latch.
 *   - `throw` — DB query error; caller MUST NOT latch. Re-attempt on
 *     the next call so a transient failure doesn't permanently kill
 *     restore.
 */
export async function loadInboxCursorFromDb(
  db: ReclaimDb | null | undefined,
  agentId: string,
): Promise<InboxCursor | null> {
  if (!db) return null
  const r: any = await db.query(
    `SELECT inbox_cursor_at::text AS inbox_cursor_at, inbox_cursor_id
       FROM agents WHERE agent_id = $1`,
    [agentId],
  )
  const row = r?.rows?.[0]
  if (row?.inbox_cursor_at && row?.inbox_cursor_id) {
    return {
      createdAt: String(row.inbox_cursor_at),
      id: String(row.inbox_cursor_id),
    }
  }
  return null
}

/**
 * PR-0 cycle 7+10 — write the cursor atomically with a monotonic guard.
 * Earlier `cursor20` UPDATEs that arrive after a `cursor40` UPDATE
 * (concurrent reads) are no-ops because the `WHERE` clause demands
 * strictly-greater composite (at, id) than what is already stored.
 * NULL stored cursor = first write wins unconditionally.
 *
 * Cycle 10 axis 1+5+6 BLOCK fix — the helper now returns
 * `{ updated: boolean }` and propagates query errors via throw
 * (no more error-swallowing try/catch). Callers use the boolean to
 * gate any in-memory cache update so that:
 *   - DB UPDATE no-op (older cursor monotonic-rejected) ⇒
 *     `updated === false` ⇒ caller leaves cache unchanged.
 *   - DB query error ⇒ helper throws ⇒ caller never reaches the
 *     cache write path; the rejection bubbles up to the top-level
 *     startup catch (`mcp.connect(...).catch(err => process.exit(1))`)
 *     for fail-closed behaviour.
 *
 * `rowCount` semantics:
 *   - `pg`'s node-postgres returns rows-affected via `result.rowCount`.
 *   - SQLite via `core/db/sqlite-adapter.ts` exposes the same field
 *     (the adapter's `query` wraps `Database.prepare(sql).run()` for
 *     non-SELECTs; `pgWrap` in tests promotes the rows array to
 *     `{ rows, rowCount: rows.length }`). For UPDATE returning no
 *     rows, both engines yield rowCount 0 / falsy, which we treat as
 *     `updated: false`.
 */
export async function persistInboxCursorToDb(
  db: ReclaimDb | null | undefined,
  agentId: string,
  cursor: InboxCursor | null,
): Promise<{ updated: boolean }> {
  if (!db || !cursor) return { updated: false }
  // `RETURNING agent_id` lets both pg (rowCount) and SQLite (rows
  // array via .all()) report success uniformly: the row is in the
  // result iff the monotonic guard accepted the write. Without
  // RETURNING the SQLite adapter's `.all()` always returns `[]` for
  // an UPDATE and we could not distinguish "guard rejected" from
  // "row updated".
  const result: any = await db.query(
    `UPDATE agents SET
       inbox_cursor_at = $1::timestamptz,
       inbox_cursor_id = $2::uuid
     WHERE agent_id = $3
       AND (
         inbox_cursor_at IS NULL
         OR inbox_cursor_at < $1::timestamptz
         OR (inbox_cursor_at = $1::timestamptz
             AND (inbox_cursor_id IS NULL OR inbox_cursor_id < $2::uuid))
       )
     RETURNING agent_id`,
    [cursor.createdAt, cursor.id, agentId],
  )
  const rowCount: number | null | undefined = result?.rowCount
  if (typeof rowCount === 'number') {
    return { updated: rowCount > 0 }
  }
  // Fallback: count rows when adapter doesn't surface rowCount.
  const rows = result?.rows
  return { updated: Array.isArray(rows) && rows.length > 0 }
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
