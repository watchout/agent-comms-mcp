/**
 * CEO P1 — server-side send → notify silent fallback decision.
 *
 * `mcp__agent-comms__send` requires a `reply_to` UUID. The original
 * spec rejected calls when no in-flight claim was held for that UUID,
 * which forced LLMs to alternate between `send` and `notify` based on
 * claim TTL state. The CEO P1 directive eliminates that judgment by
 * letting the server promote a claim-less call to a notify-equivalent
 * dispatch automatically.
 *
 * The decision shape used by `server.ts`:
 *
 *   - `claim_present` → use the existing reply path; `claimedMqId`
 *     identifies the row to mark `'replied'` after the outbound INSERT.
 *     Both `received` and `in_progress` are active claims: `processing`
 *     advances a claimed row to `in_progress` before the LLM replies.
 *   - `already_closed` → reject a stale second send for a queue row
 *     already closed by an earlier reply/done/skip/fail transition.
 *   - `fallback` (claim_expired | claim_missing) → skip the
 *     `message_queue` UPDATE and emit
 *     `| fallback: notify (reason: ...)` on the success return.
 *   - `invalid_reply_to` → the §B-5 invariant fires; reject so we
 *     never broadcast on a UUID with no resolvable channel.
 *
 * Caller responsibility: open the transaction (BEGIN), pass its
 * `txClient`, and route the decision into the existing send flow.
 * This helper does NOT mutate state — every query is read-only,
 * including the SELECT FOR UPDATE that the caller still needs to
 * hold the claim row lock for the rest of the handler.
 *
 * Spec correspondence:
 *   - §1 Error taxonomy → `invalid_reply_to`
 *   - §2 B-2 (claim 有効 → reply path) → `claim_present`
 *   - §2 B-3 (claim missing/expired → fallback) → `fallback`
 *   - §2 B-4 (channel lookup) → enforced via the `channel_id` filter
 *     in the §B-5 check below
 *   - §2 B-5 (UUID DB 不存在 → reject) → `invalid_reply_to`
 *   - §5 Open (helper 統合範囲) — extraction lives here so unit tests
 *     can exercise the decision tree without spinning up the MCP
 *     server.
 */

export type SendFallbackDecision =
  | { kind: 'claim_present'; claimedMqId: number | string }
  | { kind: 'already_closed'; queueId: number | string; status: string; repliedWith: string | null }
  | { kind: 'fallback'; reason: 'claim_expired' | 'claim_missing' }
  | { kind: 'invalid_reply_to' }

/** Minimal pg-style client interface used by the decision helper. */
export interface FallbackQueryClient {
  query<T = unknown>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>
}

/**
 * Decide which path the `send` handler should take for a given
 * (reply_to, agentId) pair. Pure read-only — the caller still holds
 * the txClient and should issue any subsequent INSERT/UPDATE.
 *
 * For `claim_present`, the SELECT acquires `FOR UPDATE` so the caller
 * may skip a second lock acquisition and reuse the returned id.
 */
export async function decideSendFallback(
  txClient: FallbackQueryClient,
  reply_to: string,
  agentId: string,
): Promise<SendFallbackDecision> {
  // 1. Strict claim probe (FOR UPDATE so the caller can rely on the
  //    row lock for the remainder of the handler).
  //
  // `processing` changes a claimed row from received -> in_progress.
  // A subsequent `send` must still close the same claim as replied;
  // otherwise the normal next -> processing -> send path falls back to
  // notify and leaves the queue row open.
  const claimRow = await txClient.query<{ id: number | string }>(
    `SELECT id FROM message_queue
        WHERE message_id = $1 AND claimed_by = $2 AND status IN ('received', 'in_progress')
        FOR UPDATE`,
    [reply_to, agentId],
  )
  if (claimRow.rows.length > 0) {
    return { kind: 'claim_present', claimedMqId: claimRow.rows[0].id }
  }

  // A closed queue row for this (reply_to, agent) pair means a previous
  // send/done/skip/fail already consumed the work. This must not fall
  // through to notify-style fallback: doing so re-broadcasts duplicate
  // human-visible replies after the original queue was terminally closed.
  const terminalRow = await txClient.query<{
    id: number | string
    status: string
    replied_with: string | null
  }>(
    `SELECT id, status, replied_with
       FROM message_queue
      WHERE message_id = $1
        AND agent_id = $2
        AND status IN ('done', 'replied', 'skipped', 'failed')
      ORDER BY created_at DESC, id DESC
      LIMIT 1
      FOR UPDATE`,
    [reply_to, agentId],
  )
  if (terminalRow.rows.length > 0) {
    const row = terminalRow.rows[0]
    return {
      kind: 'already_closed',
      queueId: row.id,
      status: row.status,
      repliedWith: row.replied_with ?? null,
    }
  }

  // 2. §B-5 invariant — reply_to must exist in agent_messages AND
  //    resolve to a non-empty channel. If either is missing, reject
  //    rather than fall back; otherwise we'd broadcast onto thin air.
  const msgRow = await txClient.query<{ channel_id: string | null }>(
    `SELECT channel_id FROM agent_messages WHERE id = $1 LIMIT 1`,
    [reply_to],
  )
  if (msgRow.rows.length === 0 || !msgRow.rows[0].channel_id) {
    return { kind: 'invalid_reply_to' }
  }

  // 3. Differentiate `claim_expired` (a claim once existed for this
  //    (msg, agent) pair, just no longer 'read') from `claim_missing`
  //    (no claim ever existed — typically a self-originated dispatch
  //    or replying to a message the bot never claimed).
  const everClaimed = await txClient.query<{ exists: number }>(
    `SELECT 1 AS exists FROM message_queue WHERE message_id = $1 AND claimed_by = $2 LIMIT 1`,
    [reply_to, agentId],
  )
  return {
    kind: 'fallback',
    reason: everClaimed.rows.length > 0 ? 'claim_expired' : 'claim_missing',
  }
}
