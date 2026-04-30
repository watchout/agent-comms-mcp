/**
 * Issue #278 (F-4) — shared "drain pending with auto-skip" helper.
 *
 * Extracted from `hooks/session-start-drain.ts` so the upcoming
 * Stop hook v8 (Issue #278 component C, sprint follow-up) can reuse
 * the same predicate / mutation / summary contract without
 * duplicating the SQL or the auto-skip integration logic.
 *
 * Contract:
 *   - SELECT the latest `limit` pending rows for `agentId`
 *     (`ORDER BY created_at DESC`).
 *   - For each row: hydrate content + message_type + author_id from
 *     `message_queue.payload`, run `matchesAutoSkipPattern` from
 *     `config/auto-skip-patterns.ts` (the same matcher the receiver
 *     applies at INSERT, so the rules are guaranteed in sync).
 *   - Matched rows → UPDATE status='skipped' with
 *     `failed_reason='AUTO_SKIP_PATTERN:<reason>'`. Unmatched rows
 *     stay pending so the LLM turn can claim them via `next` in the
 *     normal flow.
 *
 * Why a separate module:
 *   - SessionStart hook (F-1) and Stop hook v8 both need the same
 *     "drain bounded N + auto-skip filter" behavior. Duplicating it
 *     diverges the two paths over time (and was the historical
 *     pattern that the spec §F-4 explicitly calls out as redundant).
 *   - Tests can target this module directly without spawning a
 *     child process for every assertion.
 */

import type { Client } from 'pg'
import { matchesAutoSkipPattern } from '../config/auto-skip-patterns'

export interface DrainSummary {
  /** Number of rows the helper iterated over (≤ limit). */
  drained: number
  /** Of the drained rows, how many were flipped to status='skipped'. */
  skipped: number
}

/**
 * Drain up to `limit` newest pending rows for `agentId`, applying
 * the auto-skip matcher. Returns counts; the caller is expected to
 * surface them (stderr line, log, or test assertion) — this helper
 * does no logging on its own.
 *
 * Errors thrown by the DB are propagated; callers (e.g. the
 * SessionStart wrapper) wrap with try/catch to honour the
 * fail-safe-exit-0 contract.
 */
export async function drainPendingWithAutoSkip(
  client: Client,
  agentId: string,
  limit: number,
): Promise<DrainSummary> {
  if (limit === 0) return { drained: 0, skipped: 0 }
  const pending = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM message_queue
      WHERE agent_id = $1 AND status = 'pending'`,
    [agentId],
  )
  const pendingCount = pending.rows[0]?.n ?? 0
  if (pendingCount === 0) return { drained: 0, skipped: 0 }

  const rows = await client.query<{ id: number | string; payload: string }>(
    `SELECT id, payload FROM message_queue
      WHERE agent_id = $1 AND status = 'pending'
      ORDER BY created_at DESC
      LIMIT $2`,
    [agentId, limit],
  )

  let drained = 0
  let skipped = 0
  for (const row of rows.rows) {
    drained++
    let payload: Record<string, unknown> = {}
    try { payload = JSON.parse(row.payload) } catch {}
    const content = typeof payload.content === 'string' ? payload.content : ''
    const messageType = typeof payload.message_type === 'string' ? payload.message_type : 'chat'
    const authorAgentId = typeof payload.author_id === 'string' ? payload.author_id : null

    const m = matchesAutoSkipPattern({ content, messageType, authorAgentId, recipientAgentId: agentId })
    if (m.matched) {
      await client.query(
        `UPDATE message_queue
            SET status = 'skipped', failed_reason = $1
          WHERE id = $2 AND status = 'pending'`,
        [`AUTO_SKIP_PATTERN:${m.reason ?? 'unknown'}`, row.id],
      )
      skipped++
    }
  }
  return { drained, skipped }
}
