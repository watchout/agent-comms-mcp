/**
 * Server-side send claim decision.
 *
 * `mcp__agent-comms__send` requires a `reply_to` UUID and must only
 * project Discord output while it owns an active queue claim for that
 * UUID. Issue #580 retired the previous claim-less notify fallback
 * because it let stale/closed claims post duplicate Discord output and
 * then report `claim_missing` after projection evidence already existed.
 *
 * The decision shape used by `server.ts`:
 *
 *   - `claim_present` → use the existing reply path; `claimedMqId`
 *     identifies the row to mark `'replied'` after the outbound INSERT.
 *     Both `received` and `in_progress` are active claims only while
 *     their `claim_expires_at` TTL is present and still in the future:
 *     `processing` advances a claimed row to `in_progress` before the
 *     LLM replies, and the heartbeat path extends live TTLs.
 *   - `claim_unavailable` → refuse before projection. The caller can
 *     surface an already-closed no-op, an expired-claim error, or a
 *     missing-claim error, but it must not write `agent_messages`,
 *     `message_queue`, or `outbound_queue`.
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
 *   - #580 (claim missing/closed → pre-projection refusal/no-op) →
 *     `claim_unavailable`
 *   - §2 B-4 (channel lookup) → enforced via the `channel_id` filter
 *     in the §B-5 check below
 *   - §2 B-5 (UUID DB 不存在 → reject) → `invalid_reply_to`
 *   - §5 Open (helper 統合範囲) — extraction lives here so unit tests
 *     can exercise the decision tree without spinning up the MCP
 *     server.
 */

export type SendFallbackDecision =
  | { kind: 'claim_present'; claimedMqId: number | string }
  | {
      kind: 'claim_unavailable'
      reason: 'claim_closed' | 'claim_expired' | 'claim_fenced' | 'claim_missing'
      queueId?: number | string
      status?: string
      claimedAt?: string | Date | null
      claimExpiresAt?: string | Date | null
      claimedRuntimeInstanceId?: string | null
    }
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
  runtimeInstanceId?: string | null,
): Promise<SendFallbackDecision> {
  // 1. Strict claim probe (FOR UPDATE so the caller can rely on the
  //    row lock for the remainder of the handler).
  //
  // `processing` changes a claimed row from received -> in_progress.
  // A subsequent `send` must still close the same claim as replied;
  // otherwise the normal next -> processing -> send path would be refused
  // as missing and leave the queue row open.
  const claimRow = await txClient.query<{ id: number | string }>(
    `SELECT id FROM message_queue
        WHERE message_id = $1
          AND claimed_by = $2
          AND status IN ('received', 'in_progress')
          AND claim_expires_at IS NOT NULL
          AND claim_expires_at > now()
          AND (($3::text IS NULL AND claimed_runtime_instance_id IS NULL)
               OR ($3::text IS NOT NULL AND (
                 claimed_runtime_instance_id IS NULL
                 OR claimed_runtime_instance_id::text = $3
               )))
        FOR UPDATE`,
    [reply_to, agentId, runtimeInstanceId ?? null],
  )
  if (claimRow.rows.length > 0) {
    return { kind: 'claim_present', claimedMqId: claimRow.rows[0].id }
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

  // 3. Missing or closed claims must stop before projection. Probe by
  //    (message_id, agent_id) rather than claimed_by: terminal sends
  //    clear claimed_by, and #580 needs that closed evidence surfaced as
  //    an explicit no-op instead of a duplicate notify-style post.
  const queueRow = await txClient.query<{
    id: number | string
    status: string
    claimed_by: string | null
    claimed_at: string | Date | null
    claim_expires_at: string | Date | null
    claimed_runtime_instance_id: string | null
  }>(
    `SELECT id, status, claimed_by, claimed_at, claim_expires_at,
            claimed_runtime_instance_id::text AS claimed_runtime_instance_id
       FROM message_queue
      WHERE message_id = $1 AND agent_id = $2
      ORDER BY created_at ASC, id ASC
      LIMIT 1`,
    [reply_to, agentId],
  )
  if (queueRow.rows.length > 0) {
    const row = queueRow.rows[0]
    const reason = ['replied', 'done', 'skipped', 'failed'].includes(row.status)
      ? 'claim_closed'
      : row.claimed_by === agentId && ['received', 'in_progress'].includes(row.status)
        ? row.claimed_runtime_instance_id && row.claimed_runtime_instance_id !== (runtimeInstanceId ?? null)
          ? 'claim_fenced'
          : 'claim_expired'
        : 'claim_missing'
    return {
      kind: 'claim_unavailable',
      reason,
      queueId: row.id,
      status: row.status,
      claimedAt: row.claimed_at,
      claimExpiresAt: row.claim_expires_at,
      claimedRuntimeInstanceId: row.claimed_runtime_instance_id,
    }
  }
  return {
    kind: 'claim_unavailable',
    reason: 'claim_missing',
  }
}
